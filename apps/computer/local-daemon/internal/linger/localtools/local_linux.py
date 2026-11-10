"""Bundled native X11 driver. Runs as the signed-in user, never via Control API.

It reads windows through AT-SPI and sends input through xdotool. No model code
or selectors are accepted. Native setTextContents is deliberately excluded: its
undo behavior differs from a user replacement in the pinned Mousepad capability
probe. The Computer owns this process and its selection children as one process
group. User apps are launched through the user's systemd manager and survive a
tool session ending.
"""
import base64
import ctypes
import json
import os
import shutil
import signal
import subprocess
import sys
import threading
import time
import uuid
from urllib.parse import urlsplit, unquote

# Answers go to a private copy of stdout; fd 1 becomes stderr, so a child
# such as xdotool never writes a line the daemon would take as an answer.
protocol = os.fdopen(os.dup(1), "w", buffering=1)
os.dup2(2, 1)


outcome = "unsupported"
stage = threading.Lock()
request_number = 0
finished = False


def screen_locked():
    # Input sent to a locked screen reaches the lock dialog, such as its
    # password field, never the Agent's window. Each desktop names its own
    # screen saver service; a desktop without one reads as unlocked.
    try:
        bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    except Exception:
        return False
    for service in ("org.gnome.ScreenSaver", "org.freedesktop.ScreenSaver", "org.cinnamon.ScreenSaver", "org.xfce.ScreenSaver"):
        try:
            active = bus.call_sync(service, "/" + service.replace(".", "/"), service, "GetActive", None, GLib.VariantType.new("(b)"), Gio.DBusCallFlags.NO_AUTO_START, 1000, None)
        except Exception:
            continue
        if active.unpack()[0]:
            return True
    return False


def begin_input():
    # From here on a failure leaves the input outcome unknown.
    global outcome
    if screen_locked():
        raise RuntimeError("SCREEN_LOCKED: the screen is locked, so no input was sent; ask the user to unlock it")
    with stage:
        outcome = "unknown"


def watchdog(number):
    # A hung accessibility bus blocks inside a D-Bus call. Report the current
    # stage before the daemon kills this process, which would read as an
    # unknown outcome even when no input was sent. Holding the lock until exit
    # keeps a later input from starting.
    stage.acquire()
    # The request may have been answered while this timer waited.
    if finished or number != request_number:
        stage.release()
        return
    reply({"status": outcome, "error": "The accessibility bus did not answer in time", "restart": True})
    exit_driver()


NODE_CAP, DEPTH_CAP = 1500, 30


def tree(root):
    """The window's shown nodes depth first, with the hidden ones that end a
    branch, and whether some were left out. The walk is bounded because each
    node costs a D-Bus call; a large web page still yields the browser toolbar
    and the top of the page."""
    result, seen, cut = [], set(), False
    def walk(node, depth):
        nonlocal cut
        identity = (node.app.bus_name, node.path)
        if identity in seen:
            return
        seen.add(identity)
        result.append(node)
        # A hidden node hides its subtree: SHOWING requires every ancestor to
        # show. Firefox keeps large hidden menus and panels ahead of the page.
        if depth > 0 and not node.getState().contains(pyatspi.STATE_SHOWING):
            return
        if depth >= DEPTH_CAP:
            cut = cut or node.childCount > 0
            return
        for child in node:
            if len(result) >= NODE_CAP:
                cut = True
                return
            walk(child, depth + 1)
    walk(root, 0)
    return result, cut


def active_window():
    """The active X11 window, or "" when the desktop has none, as right after
    a GNOME login before anything was clicked."""
    found = subprocess.run(["xdotool", "getactivewindow"], capture_output=True, text=True, timeout=5)
    return found.stdout.strip() if found.returncode == 0 else ""


def active_pid():
    """The process of the active window, or "" when there is none."""
    window = active_window()
    if not window:
        return ""
    found = subprocess.run(["xdotool", "getwindowpid", window], capture_output=True, text=True, timeout=5)
    return found.stdout.strip() if found.returncode == 0 else ""


def enabled(state):
    # GTK4 reports a usable control as SENSITIVE alone; GTK3, Qt and Firefox
    # set ENABLED with it, and a disabled control has neither.
    return state.contains(pyatspi.STATE_ENABLED) or state.contains(pyatspi.STATE_SENSITIVE)


def window_origin(window):
    """The screen position of an X11 window's content: the window position
    plus the client-side shadow GTK draws inside it (_GTK_FRAME_EXTENTS)."""
    geometry = dict(line.split("=", 1) for line in command(["xdotool", "getwindowgeometry", "--shell", window]).decode().split())
    left = top = 0
    c = ctypes
    x11 = c.CDLL("libX11.so.6")
    x11.XOpenDisplay.argtypes, x11.XOpenDisplay.restype = [c.c_char_p], c.c_void_p
    x11.XInternAtom.argtypes, x11.XInternAtom.restype = [c.c_void_p, c.c_char_p, c.c_int], c.c_ulong
    x11.XGetWindowProperty.argtypes = [c.c_void_p, c.c_ulong, c.c_ulong, c.c_long, c.c_long, c.c_int, c.c_ulong,
                                       c.POINTER(c.c_ulong), c.POINTER(c.c_int), c.POINTER(c.c_ulong), c.POINTER(c.c_ulong), c.POINTER(c.c_void_p)]
    x11.XFree.argtypes = [c.c_void_p]
    x11.XCloseDisplay.argtypes = [c.c_void_p]
    display = x11.XOpenDisplay(None)
    if not display:
        raise RuntimeError("no X11 display")
    try:
        atom = x11.XInternAtom(display, b"_GTK_FRAME_EXTENTS", 1)
        kind, size, count, rest, data = c.c_ulong(), c.c_int(), c.c_ulong(), c.c_ulong(), c.c_void_p()
        # 6 is XA_CARDINAL; format-32 values arrive as C longs.
        if atom and x11.XGetWindowProperty(display, int(window), atom, 0, 4, 0, 6, c.byref(kind), c.byref(size), c.byref(count), c.byref(rest), c.byref(data)) == 0 and data.value:
            if size.value == 32 and count.value == 4:
                values = c.cast(data, c.POINTER(c.c_long))
                left, top = values[0], values[2]
            x11.XFree(data)
    finally:
        x11.XCloseDisplay(display)
    return int(geometry["X"]) + left, int(geometry["Y"]) + top


def desktop_box(node, frame):
    """The node's screen rectangle as (x, y, width, height)."""
    component = node.queryComponent()
    box = component.getExtents(pyatspi.DESKTOP_COORDS)
    top = frame.queryComponent().getExtents(pyatspi.DESKTOP_COORDS)
    if (top.x, top.y) != (0, 0):
        return box.x, box.y, box.width, box.height
    # GTK4 on X11 reports every control at the screen origin, so only its
    # position inside the window is real. A window that is truly at the
    # origin gets the same answer this way.
    window = active_window()
    if not window:
        raise RuntimeError("No active desktop window")
    x, y = window_origin(window)
    local = component.getExtents(pyatspi.WINDOW_COORDS)
    return x + local.x, y + local.y, local.width, local.height


def showing(node):
    state = node.getState()
    return state.contains(pyatspi.STATE_SHOWING) and enabled(state)


def focused(nodes):
    """The focused control and the end of its text, such as a field value or
    the last terminal output, so an input's effect reads back as text."""
    for node in nodes:
        if node.getState().contains(pyatspi.STATE_FOCUSED):
            item = {"role": node.getRoleName(), "name": node.name}
            try:
                text = node.queryText()
                tail = text.getText(max(0, text.characterCount - 1500), -1)
                # A document's final newline matters to the next edit; a
                # terminal's trailing blank screen does not.
                item["text_tail"] = tail.rstrip() if item["role"] == "terminal" else tail
            except NotImplementedError:
                pass
            return item
    return None


# Roles a person acts on. Their names and values make the window readable as
# text, so the Agent can act by element instead of by screenshot coordinates.
ACTIONABLE = {
    "push button", "toggle button", "check box", "radio button", "menu", "menu item",
    "check menu item", "radio menu item", "page tab", "link", "combo box", "list item",
    "table cell", "tree item", "spin button", "slider", "icon", "terminal",
}
TEXT_CAP, ELEMENT_CAP = 300, 250
MENU_ROLES = ("menu", "menu item", "check menu item")
DOCUMENT_ROLES = ("document web", "document frame")
# A request carries a value and the field's current value in one 64 KiB
# argument, and JSON can double each of them.
VALUE_CAP = 16000


def child_label(node, depth=0):
    """GTK rows and sidebar items carry their text in a child label."""
    for child in node:
        if child.getRoleName() in ("label", "text") and child.name:
            return child.name
        if depth < 1:
            found = child_label(child, depth + 1)
            if found:
                return found
    return ""


def element(node, ref):
    role, name = node.getRoleName(), node.name
    state = node.getState()
    parent = node.parent
    if role == "label" and parent is not None and parent.getRoleName() in ACTIONABLE:
        return None  # Already the name of its control.
    if not name and role in ACTIONABLE and role != "terminal":
        name = child_label(node)
        if not name and not state.contains(pyatspi.STATE_EDITABLE):
            return None
    item = {"ref": ref, "role": role, "name": name}
    if state.contains(pyatspi.STATE_EDITABLE) or role == "terminal":
        try:
            text = node.queryText()
            value = text.getText(0, -1)
            if role == "terminal":
                value = value.rstrip()
            # A terminal's latest output is at its end.
            cut = "…" + value[-TEXT_CAP:].rstrip() if role == "terminal" else value[:TEXT_CAP] + "…"
            item["value"] = value if len(value) <= TEXT_CAP else cut
            item["value_complete"] = len(value) == text.characterCount and len(value) <= TEXT_CAP
            if role != "terminal":
                item["editable"] = True
        except NotImplementedError:
            pass
    elif role not in ACTIONABLE and not name:
        return None
    elif role not in ACTIONABLE and role not in ("label", "heading", "text", "status bar"):
        return None
    flags = [label for flag, label in ((pyatspi.STATE_FOCUSED, "focused"), (pyatspi.STATE_CHECKED, "checked"), (pyatspi.STATE_SELECTED, "selected"), (pyatspi.STATE_EXPANDED, "expanded")) if state.contains(flag)]
    if not enabled(state):
        flags.append("disabled")
    if flags:
        item["states"] = flags
    return item


def whole_selection(node):
    """Whether select-all took the field's whole text. Widgets that do not
    report selections count as selected; the exact readback still checks."""
    try:
        text = node.queryText()
        if text.characterCount == 0:
            return True
        return text.getNSelections() == 1 and tuple(text.getSelection(0)) == (0, text.characterCount)
    except NotImplementedError:
        return True


def main(request):
    global outcome
    if set(request) - {"kind", "target", "ref", "value", "expected_value"}:
        raise RuntimeError("Unexpected UI driver argument")
    parts = request["target"].split(":")
    if len(parts) != 2 or parts[0] != "atspi" or not (parts[1].isdigit() or parts[1] == "active"):
        raise RuntimeError("Invalid AT-SPI target")
    if parts[1] == "active":
        # The Agent sees screenshots, not process IDs; resolve the focused window.
        found = subprocess.run(["xdotool", "getactivewindow", "getwindowpid"], capture_output=True, text=True, timeout=5)
        if found.returncode == 0:
            pid = int(found.stdout.strip())
        else:
            # A freshly opened window can lack X focus. Use the one application
            # whose accessible frame is active, then give its window focus.
            apps = list(pyatspi.Registry.getDesktop(0))
            active = [a for a in apps if any(w.getRoleName() == "frame" and w.getState().contains(pyatspi.STATE_ACTIVE) for w in a)]
            if not active:
                # Otherwise the one ordinary application with a visible frame.
                shell = {"xfdesktop", "xfce4-panel", "xfwm4", "xfce4-session", "xfsettingsd"}
                active = [a for a in apps if a.name not in shell and any(w.getRoleName() == "frame" and showing(w) for w in a)]
            if len(active) != 1:
                raise RuntimeError("No single active desktop window")
            pid = active[0].get_process_id()
            windows = subprocess.run(["xdotool", "search", "--onlyvisible", "--pid", str(pid)], capture_output=True, text=True, timeout=5).stdout.split()
            if len(windows) != 1:
                raise RuntimeError("Active desktop window is ambiguous")
            # A read never moves focus; only input claims the window.
            if request["kind"] not in ("state", "observe"):
                subprocess.run(["xdotool", "windowactivate", "--sync", windows[0]], check=True, timeout=5)
    else:
        pid = int(parts[1])
    apps = [a for a in pyatspi.Registry.getDesktop(0) if a.get_process_id() == pid]
    if len(apps) != 1:
        raise RuntimeError("AT-SPI process is unavailable or ambiguous")
    windows = [w for w in apps[0] if w.getRoleName() in ("frame", "dialog", "file chooser", "alert") and showing(w)]
    # The active window takes the input, such as an alert over Save As, or a
    # main window beside a Find dialog. One process can own several windows.
    frames = [w for w in windows if w.getState().contains(pyatspi.STATE_ACTIVE)]
    if not frames:
        # Without one, a modal dialog takes the input; otherwise the one frame.
        frames = [w for w in windows if w.getRoleName() != "frame"] or windows
    if len(frames) != 1:
        raise RuntimeError("AT-SPI window is unavailable or ambiguous")
    frame = frames[0]
    nodes, truncated = tree(frame)
    menu_open = any(n.getRoleName() in MENU_ROLES[1:] and showing(n) for n in nodes)
    def reference(node):
        return {"bus": node.app.bus_name, "window": frame.path, "path": node.path, "pid": pid}
    if request["kind"] == "observe":
        state, candidates = [], []
        for node in nodes:
            if not showing(node):
                continue
            role, name = node.getRoleName(), node.name
            if name:
                state.append(role + " " + name)
            candidate = {"ref": reference(node), "description": role + " " + name}
            if node.getState().contains(pyatspi.STATE_EDITABLE):
                if menu_open:
                    continue
                text = node.queryText()
                value = text.getText(0, -1)
                if len(value) != text.characterCount or len(value.encode()) > VALUE_CAP:
                    continue
                candidate.update(action="set_value", value=value, value_complete=True)
            elif role in MENU_ROLES + ("push button",):
                try:
                    action = node.queryAction()
                    indexes = [i for i in range(action.nActions) if action.getName(i) in ("click", "press", "activate")]
                    if len(indexes) != 1:
                        continue
                    candidate.update(action="click", action_index=indexes[0])
                except NotImplementedError:
                    continue
            else:
                continue
            candidates.append(candidate)
        return {"id": str(uuid.uuid4()), "target": request["target"], "window_ref": reference(frame), "window": frame.name, "focused": focused(nodes), "state_text": "\n".join(state), "candidates": candidates}
    if request["kind"] == "state":
        elements, omitted = [], 0
        for node in nodes:
            # Disabled controls stay listed so the Agent knows they exist.
            if node is frame or not node.getState().contains(pyatspi.STATE_SHOWING):
                continue
            item = element(node, reference(node))
            if item is None:
                continue
            if len(elements) >= ELEMENT_CAP:
                omitted += 1
                continue
            elements.append(item)
        # A page still loading has a busy document, or, while the browser waits
        # for the server, a shown tab frame with no document yet. Reading it
        # now would show the page before it.
        loading = any(n.getState().contains(pyatspi.STATE_SHOWING) and (
            (n.getRoleName() in DOCUMENT_ROLES and n.getState().contains(pyatspi.STATE_BUSY))
            or (n.getRoleName() == "internal frame" and not any(c.getRoleName() in DOCUMENT_ROLES for c in n))) for n in nodes)
        return {"window": frame.name, "app": apps[0].name, "focused": focused(nodes), "elements": elements, "omitted": omitted, "truncated": truncated, "loading": loading}
    def click_centre(node):
        # A centre click, like a person's, never blocks on a modal dialog the
        # control opens, unlike an AT-SPI doAction call on GTK. An open menu
        # covers other controls, so only a menu control may be clicked then.
        global outcome
        if menu_open and node.getRoleName() not in MENU_ROLES:
            return {"status": "stale_before_input"}
        x, y, width, height = desktop_box(node, frame)
        active = active_pid()
        if width <= 0 or height <= 0 or active != str(pid):
            return {"status": "stale_before_input"}
        begin_input()
        try:
            desktop_click(x + width // 2, y + height // 2)
        except Exception:
            return {"status": "unknown", "error": "Desktop click outcome is unknown"}
        outcome = "confirmed"
        return {"status": "confirmed"}
    if request["kind"] not in ("press", "apply"):
        raise RuntimeError("Unsupported UI driver method")
    matches = [n for n in nodes if reference(n) == request["ref"] and n.getState().contains(pyatspi.STATE_SHOWING)]
    if len(matches) != 1:
        return {"status": "stale_before_input"}
    node = matches[0]
    if not enabled(node.getState()):
        # Observations list disabled controls, so this is not a stale number.
        return {"status": "unsupported", "error": "the control is disabled; do the step that enables it first"}
    if request["kind"] == "press":
        return click_centre(node)
    if "value" in request:
        if menu_open:
            return {"status": "stale_before_input"}
        value = request["value"]
        if not isinstance(value, str) or len(value.encode()) > VALUE_CAP:
            return {"status": "unsupported", "error": "Desktop literal exceeds input capability"}
        if node.queryText().getText(0, -1) != request.get("expected_value"):
            return {"status": "stale_before_input"}
        # Pasting preserves Unicode and application undo.
        active = active_pid()
        if active != str(pid):
            return {"status": "stale_before_input"}
        if not node.getState().contains(pyatspi.STATE_FOCUSED):
            if not node.queryComponent().grabFocus():
                return {"status": "stale_before_input"}
            # GTK selects part of some fields just after focus arrives, such
            # as a file name without its extension; let that finish first.
            time.sleep(0.2)
        if len(value.encode()) > 65536:
            return {"status": "unsupported", "error": "text exceeds 64 KiB"}
        begin_input()
        try:
            desktop_key("ctrl+a", clear_modifiers=True)
            if not whole_selection(node):
                time.sleep(0.2)
                desktop_key("ctrl+a", clear_modifiers=True)
            if not whole_selection(node):
                # The GTK file chooser name field ignores select-all; typing
                # now would insert the value into the old name.
                desktop_key("End", "shift+Home", clear_modifiers=True)
            if not whole_selection(node):
                return {"status": "unsupported", "error": "the field's text could not be selected, so it was left unchanged; clear it with press_key and type_text"}
            if value:
                paste_text(value)
            else:
                desktop_key("BackSpace")
        except Exception:
            return {"status": "unknown", "error": "Desktop replacement outcome is unknown"}
        outcome = "confirmed"
        actual = node.queryText().getText(0, -1)
        if actual != value:
            return {"status": "confirmed", "error": "Exact readback failed after replacement; the field now reads " + json.dumps(actual[:TEXT_CAP], ensure_ascii=False)}
    elif node.getRoleName() in MENU_ROLES + ("push button",):
        return click_centre(node)
    else:
        return {"status": "unsupported"}
    return {"status": "confirmed"}


def answer(line):
    global outcome, finished, request_number
    with stage:
        outcome, finished = "unsupported", False
        request_number += 1
        timer = threading.Timer(40, watchdog, (request_number,))
    timer.daemon = True
    timer.start()
    restart = False
    try:
        # There is no event loop to keep the AT-SPI cache current, so
        # dispatch the signals queued since the last request, which would
        # otherwise pile up in this long-lived process, and clear the cache.
        events = GLib.MainContext.default()
        while events.pending():
            events.iteration(False)
        pyatspi.Registry.getDesktop(0).clearCache()
        result = main(json.loads(line))
    except RuntimeError as error:
        # This program's own refusals, such as an ambiguous active window.
        result = {"status": outcome, "error": str(error)}
    except Exception as error:
        # The bus connection may be gone, as after a session bus restart.
        # This process exits instead of answering later requests on it.
        result, restart = {"status": outcome, "error": str(error), "restart": True}, True
    with stage:
        timer.cancel()
        finished = True
        reply(result)
    if restart:
        exit_driver()


# Starting Python and importing pyatspi takes longer than most requests, so
# the daemon keeps this process for the whole Operation.
try:
    import pyatspi
    from gi.repository import Gio, GLib
    missing = None
except Exception as error:
    missing = str(error)


rpc_id = None
clipboards = []
held_button = None
held_keys = []


def normalize_key(chord):
    aliases = {"pagedown": "Next", "page_down": "Next", "pageup": "Prior", "page_up": "Prior",
               "enter": "Return", "return": "Return", "escape": "Escape", "esc": "Escape",
               "backspace": "BackSpace", "delete": "Delete", "tab": "Tab", "space": "space",
               "up": "Up", "down": "Down", "left": "Left", "right": "Right", "home": "Home", "end": "End"}
    aliases.update({"pgdn": "Next", "pgup": "Prior", "ins": "Insert", "del": "Delete"})
    modifiers = {"ctrl": "Control_L", "control": "Control_L", "alt": "Alt_L", "shift": "Shift_L", "super": "Super_L", "win": "Super_L", "meta": "Super_L"}
    x11 = ctypes.CDLL("libX11.so.6")
    x11.XStringToKeysym.argtypes = [ctypes.c_char_p]
    x11.XStringToKeysym.restype = ctypes.c_ulong
    parts = chord.split("+")
    normalized = []
    for part in parts:
        key = modifiers.get(part.lower(), aliases.get(part.lower(), part))
        if len(parts) > 1 and len(key) == 1 and key.isalpha():
            # In a chord a letter names its key: ctrl+A is ctrl+a, not
            # ctrl+shift+a.
            key = key.lower()
        # Key names are case-sensitive in X11: f5 is F5, insert is Insert.
        key = next((name for name in (key, key.capitalize(), key.upper()) if name and x11.XStringToKeysym(name.encode())), None)
        if not key:
            raise ValueError("unknown X11 key: " + part)
        normalized.append(key)
    return "+".join(normalized)


def send_rpc(value):
    protocol.write(json.dumps(value, ensure_ascii=False) + "\n")
    protocol.flush()


def reply(value):
    send_rpc({"jsonrpc": "2.0", "id": rpc_id, "result": {"content": [{"type": "text", "text": json.dumps(value, ensure_ascii=False)}]}})


def command(args, **kwargs):
    return subprocess.run(args, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=15, **kwargs).stdout


def release_input():
    global held_button, held_keys
    if held_button:
        subprocess.run(["xdotool", "mouseup", held_button], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=3)
        held_button = None
    if held_keys:
        subprocess.run(["xdotool", "keyup", "--", *held_keys], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=3)
        held_keys = []


def exit_driver():
    try:
        release_input()
    finally:
        os._exit(0)


def desktop_key(*keys, clear_modifiers=False):
    global held_keys
    held_keys = list(keys)
    try:
        result = subprocess.run(["xdotool", "key", *(["--clearmodifiers"] if clear_modifiers else []), "--", *keys], check=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=15)
        if b"No such key name" in result.stdout:
            raise ValueError("unknown key")
    finally:
        release_input()


def desktop_click(x, y):
    global held_button
    held_button = "1"
    try:
        command(["xdotool", "mousemove", str(x), str(y), "click", "1"])
    finally:
        release_input()


def stop_driver(*_):
    try:
        release_input()
    finally:
        raise SystemExit(0)


signal.signal(signal.SIGTERM, stop_driver)
signal.signal(signal.SIGINT, stop_driver)


# Window classes of terminal emulators, matched case-insensitively: xterm,
# GNOME Terminal, Ptyxis, Konsole, kitty, Alacritty, Tilix, Terminator,
# WezTerm, foot and rxvt.
TERMINAL_CLASSES = "term|ptyxis|konsole|kitty|alacritty|tilix|wezterm|^foot|rxvt"


def paste_text(value):
    global clipboards
    chord, final_return, selections = "ctrl+v", False, ("clipboard",)
    active = active_window()
    terminals = subprocess.run(["xdotool", "search", "--class", TERMINAL_CLASSES], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, timeout=5).stdout.split()
    if active and active in terminals:
        # Terminals differ in their paste chord, and ctrl+v in a shell inserts
        # the next key literally. Every one pastes on shift+Insert, some from
        # the primary selection, so both selections hold the text. Other
        # windows keep their primary selection: a GTK field that loses it
        # also drops the selected text that the paste should replace.
        chord, selections = "shift+Insert", ("clipboard", "primary")
        if value.endswith("\n"):
            value, final_return = value[:-1], True
    for owner in clipboards:
        owner.terminate()
        owner.wait(timeout=3)
    clipboards = []
    for selection in selections:
        # -quiet stays in the foreground: no detached selection owner escapes
        # the Computer-owned process tree. It stays alive until replacement or
        # cleanup.
        owner = subprocess.Popen(["xclip", "-quiet", "-selection", selection, "-in"], stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        owner.stdin.write(value.encode("utf-8"))
        owner.stdin.close()
        clipboards.append(owner)
    deadline = time.monotonic() + 3
    for selection in selections:
        while True:
            observed = subprocess.run(["xclip", "-selection", selection, "-out"], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=3)
            if observed.returncode == 0 and observed.stdout == value.encode("utf-8"):
                break
            if time.monotonic() > deadline:
                raise RuntimeError("clipboard readback mismatch; text was not pasted")
            time.sleep(.02)
    if value:
        desktop_key(chord, clear_modifiers=True)
    if final_return:
        desktop_key("Return", clear_modifiers=True)


APPS = {
    "firefox": ["firefox"], "libreoffice-writer": ["libreoffice", "--writer"],
    "libreoffice-calc": ["libreoffice", "--calc"], "libreoffice-impress": ["libreoffice", "--impress"],
    "gnome-text-editor": ["gnome-text-editor"], "gedit": ["gedit"], "nautilus": ["nautilus"],
    "gnome-terminal": ["gnome-terminal"], "mousepad": ["mousepad"], "thunar": ["thunar"], "xfce4-terminal": ["xfce4-terminal"],
}


def launch(args):
    desktop_env = ["--setenv=" + key + "=" + os.environ[key] for key in ("DISPLAY", "XAUTHORITY", "DBUS_SESSION_BUS_ADDRESS", "XDG_SESSION_TYPE") if key in os.environ]
    # KillMode=process: xdg-open hands the URL to gio, which starts the browser
    # and exits at once; the default control-group mode would then kill the
    # browser before it opened the page.
    command(["systemd-run", "--user", "--quiet", "--collect", "--service-type=exec", "--property=KillMode=process", "--unit=linger-app-" + uuid.uuid4().hex, *desktop_env, "--", *args])


def native_action(name, args):
    global outcome, held_button, held_keys
    if name == "probe":
        if os.environ.get("XDG_SESSION_TYPE") == "wayland":
            raise ValueError("Local Linux desktop requires the signed-in user's X11 session; Wayland is not supported")
        if not os.environ.get("DISPLAY"):
            raise ValueError("Local Linux desktop requires DISPLAY; start the Computer from the signed-in user's X11 session")
        for executable in ["xdotool", "import", "xclip", "systemd-run"]:
            if not shutil.which(executable):
                raise ValueError("Local Linux desktop dependency is missing: " + executable)
        if missing:
            raise ValueError("Local Linux AT-SPI is unavailable: " + missing)
        command(["xdotool", "getdisplaygeometry"])
        return b"ready"
    if name == "screenshot":
        return command(["import", "-window", "root", "png:-"])
    if name == "accessibility":
        # GNOME's switch, off by default: Firefox and Chrome then expose no
        # controls at all. Other desktops have no such setting to report.
        found = subprocess.run(["gsettings", "get", "org.gnome.desktop.interface", "toolkit-accessibility"], capture_output=True, text=True, timeout=5) if shutil.which("gsettings") else None
        return b"off" if found and found.returncode == 0 and found.stdout.strip() == "false" else b""
    if name in {"active-window", "window-title"}:
        # A desktop without an active window reads as empty, so a launch
        # from it can still be checked: any window that appears is new.
        window = active_window()
        if not window or name == "active-window":
            return window.encode()
        return command(["xdotool", "getwindowname", window])
    if name == "semantic-ui":
        answer(args[0])
        return None
    if name == "run":
        if not args or args[0] not in APPS or len(args) > 2:
            raise ValueError("unsupported application")
        argv = list(APPS[args[0]])
        if len(args) == 2:
            if not os.path.isabs(args[1]) or "\0" in args[1]: raise ValueError("application path must be absolute")
            argv.append(args[1])
        if not shutil.which(argv[0]): raise ValueError("application is not installed: " + args[0])
        begin_input(); launch(argv)
    elif name == "open":
        uri = urlsplit(args[0])
        if uri.scheme not in {"http", "https", "file"}: raise ValueError("unsupported URL scheme")
        if uri.scheme == "file":
            path = os.path.realpath(unquote(uri.path))
            if uri.netloc or os.path.commonpath([path, os.path.expanduser("~")]) != os.path.expanduser("~"):
                raise ValueError("local URL must be inside the user's home")
        elif not uri.netloc: raise ValueError("web URL must have a host")
        begin_input(); launch(["xdg-open", args[0]])
    elif name == "type":
        if len(args) != 1: raise ValueError("type requires text")
        # Refuse before begin_input: oversized text sends nothing.
        if len(args[0].encode()) > 65536: raise ValueError("text exceeds 64 KiB")
        begin_input(); paste_text(args[0])
    elif name in {"click", "move", "drag"}:
        width, height = map(int, command(["xdotool", "getdisplaygeometry"]).split())
        coordinates = list(map(int, args[:4] if name == "drag" else args[:2]))
        if len(coordinates) != (4 if name == "drag" else 2): raise ValueError("missing coordinates")
        if any(x < 0 or x >= (width if i % 2 == 0 else height) for i, x in enumerate(coordinates)):
            raise ValueError("coordinates are outside the screenshot")
        argv = ["xdotool", "mousemove", str(coordinates[0]), str(coordinates[1])]
        if name == "click":
            button = {"left": "1", "middle": "2", "right": "3"}.get(args[2] if len(args) == 3 else "left")
            if not button: raise ValueError("invalid button")
            argv += ["click", button]
        if name == "drag":
            argv += ["mousedown", "1", "sleep", "0.15"]
            for n in range(1, 21):
                argv += ["mousemove", str(round(coordinates[0]+(coordinates[2]-coordinates[0])*n/20)), str(round(coordinates[1]+(coordinates[3]-coordinates[1])*n/20)), "sleep", "0.02"]
            argv += ["mouseup", "1"]
        begin_input()
        held_button = "1" if name == "drag" else button if name == "click" else None
        try:
            command(argv)
        finally:
            release_input()
    elif name == "key":
        if len(args) != 1 or not args[0] or any(not part for part in args[0].split("+")): raise ValueError("invalid key")
        key = normalize_key(args[0])
        begin_input()
        desktop_key(key)
    elif name == "scroll":
        direction, count = args[0], int(args[1])
        if direction not in {"up", "down"} or not 1 <= count <= 100: raise ValueError("invalid scroll")
        # The wheel scrolls whatever is under the pointer; a pointer left on
        # the top bar or another window would scroll nothing the Agent sees.
        window = active_window()
        if window:
            geometry = dict(line.split("=", 1) for line in command(["xdotool", "getwindowgeometry", "--shell", window]).decode().split())
            pointer = dict(line.split("=", 1) for line in command(["xdotool", "getmouselocation", "--shell"]).decode().split())
            left, top, width, height = (int(geometry[k]) for k in ("X", "Y", "WIDTH", "HEIGHT"))
            x, y = int(pointer["X"]), int(pointer["Y"])
            if not (left <= x < left + width and top <= y < top + height):
                begin_input(); command(["xdotool", "mousemove", str(left + width // 2), str(top + height // 2)])
        begin_input(); command(["xdotool", "click", "--repeat", str(count), "4" if direction == "up" else "5"])
    else:
        raise ValueError("unsupported native desktop command")
    outcome = "confirmed"
    return b""


for line in sys.stdin:
    request = json.loads(line)
    if "id" not in request: continue
    rpc_id = request["id"]
    method = request.get("method")
    if method == "initialize":
        send_rpc({"jsonrpc":"2.0","id":rpc_id,"result":{"protocolVersion":"2024-11-05","capabilities":{"tools":{}},"serverInfo":{"name":"linger-native-linux","version":"1"}}})
    elif method == "tools/list":
        send_rpc({"jsonrpc":"2.0","id":rpc_id,"result":{"tools":[{"name":"action","inputSchema":{"type":"object"}}]}})
    elif method == "tools/call":
        outcome = "unsupported"
        try:
            if request["params"]["name"] != "action": raise ValueError("unknown tool")
            values = request["params"]["arguments"]
            result = native_action(values["command"], values.get("args", []))
            if result is not None: reply({"status":"confirmed","output_base64":base64.b64encode(result).decode()})
        except Exception as error:
            reply({"status":outcome,"error":str(error)})
    else:
        send_rpc({"jsonrpc":"2.0","id":rpc_id,"error":{"code":-32601,"message":"method not found"}})
