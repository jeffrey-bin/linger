# Local Computer Daemon

This Go module is the resident Local Computer Daemon.
It carries the frozen Linger execution implementation needed for local process,
provider, workspace, and daemon lifecycle behavior while adapting all product
control through Linger's Runner Gateway.

## Ownership

- `internal/daemon`: daemon lifecycle and local reconciliation loop.
- `internal/process`: process ownership, cancellation, and cleanup.
- `internal/provider`: Codex/Claude/Pi execution adapters.
- `internal/workspace`: local workspace and Runtime-home preparation.
- `internal/protocol`: the Daemon's routed command/event model. The wire shapes
  come from the generated `contracts/generated/go/runnergateway` module
  (Runner Gateway protocol 2).
- `internal/linger`: Linger Gateway, device identity, process-instance lease,
  Registration, Context, Local MCP Relay, and Local Skill catalog adapters.

The Go daemon must not own TeamHub records, Agent scheduling, Context authority,
MCP policy, or Artifact publication. Those remain in TeamHub and Agent Service.

## Control CLI

`linger-computer` (`cmd/linger-computer`, implemented in `internal/computercli`)
is the local control CLI: `login`, `auth status`, `daemon
start|stop|restart|status|logs|runners|service`, `runtime check`, `doctor`, and
`version`. It reads the config through `internal/computerconfig`, talks to the
Daemon through `internal/linger/control`, and diagnoses Runtimes with the same
`internal/provider` discovery the Daemon uses. It starts the Daemon found at
`../daemon/linger-computer-daemon` beside its own bundle directory, or at
`LINGER_GO_LOCAL_DAEMON_PATH` during source development.

When `login` switches the Computer to another account, it deletes the previous
enrollment's state except `state/workspaces`. On Windows, a program can keep a
file open inside a state directory, for example an editor that an Agent opened
in a Context workspace. Windows then refuses to delete or rename that
directory. `login` leaves that directory in place, warns with its path, and
completes enrollment. The state files the Daemon opens at startup must still
be removed. `doctor --prune` is an explicit request to delete everything, so it
stops and names the open file.

## Current entrypoint

`linger-computer-daemon --config <path>` reads the owner-only config emitted by
the `linger-computer login` flow. It discovers and version-gates the
configured Codex, Claude, and Pi installations.
It performs bounded protocol and authentication probes.
It periodically refreshes authentication and unavailable Runtimes without a restart.
The Claude check also probes idle Context homes, because each one can hold its
own refreshed login. It reconciles only the four most recently used homes and
runs `claude auth status` once per distinct credential, so its cost does not
grow with the number of Contexts. Only a definite logout in a Context home
changes the result. A slow or failed probe there, or a home the time budget
did not reach, leaves the Runtime ready; each Operation reconciles its own home
before Claude starts.

It opens owner-only local
identity/Registration/Assignment/Context/Operation stores, and connects only to
the configured Linger Runner Gateway. Runtime executable paths, process
environment, and physical workspace paths are resolved locally and never come
from an Operation wire request.

Opening the local Registration store deletes records of retired Runtimes such as
Hermes; connecting and reconnecting report Registration observations only for
Codex, Claude and Pi.

The owner-only control socket supports Runner inspection and local stop, plus
managed service start/list/stop. Managed services retain PID, process-group,
and start-token identity across daemon restarts, and stop succeeds only after
the recorded process group disappears.

## One-shot model calls

The Daemon accepts `execute` (kind `model_invoke`). `internal/daemon/model_invoke.go`
handles admission and a concurrency limit of 3 (beyond it the reply is `busy`;
`priority` only orders the Agent side's queue, and the Daemon accepts it without
distinguishing), cancels on disconnect and drain, and checks before sending that
the encoded `executed` (kind `model_invoke`) fits the 4 MiB frame limit (otherwise
it reports `failed`). `internal/provider/model_invoke.go` runs one `codex exec` or
`claude -p` in a temporary directory: the prompt goes through stdin, tools and
user customization are off, and it refuses workspace files at the root named
`AGENTS.md`, `AGENTS.override.md` or `CLAUDE.md` and anything under `.codex` or
`.claude` at any depth. `internal/workspace/codex_invoke_home.go` prepares a
temporary `CODEX_HOME` holding only an `auth.json` link, provider settings and
a seeded models cache (see below).
Claude uses the fixed `model-invoke/claude/.claude` under the state directory as
`CLAUDE_CONFIG_DIR`, so an OAuth login refreshed during a call is kept for the
next one. A model call does not enter the Operation ledger and takes no
execution slot.

Codex's workspace mode turns off the shell and unified exec and keeps only the
code-mode host's `apply_patch`, with the working directory as the only writable
root. It therefore reads no files, and the Daemon appends the workspace files'
contents to the end of the prompt, because the `workspace-write` sandbox limits
writes but not reads.

`go test -tags live_model_invoke ./internal/provider -run TestLiveCodex` runs one
structured call and one workspace call with the locally signed-in Codex (checking
that it writes the file and cannot read files outside the working directory). It
spends model quota and is not part of the default tests.

## Codex models cache

Signed in with ChatGPT, Codex blocks its first `thread/start` on a 4–5 s
download of the model catalog unless its `CODEX_HOME` holds a
`models_cache.json` fetched within five minutes. Every Context home, the model
session home (`model-invoke/codex-sessions/codex-home`), each one-shot call's
temporary home and the model-listing discovery probe's home are therefore
seeded by `internal/workspace/codex_models_cache.go`. It takes the newest
cache among the other Context homes, the model session home and the user's
source home that has the same `auth.json` account and the installed Codex
version, and writes it with `fetched_at` set to now. A home whose own cache is
still fresh is left alone. app-server refreshes the catalog online in the
background as soon as it starts, so the stamp only saves the blocking fetch.
API-key and signed-out homes have no account identity and are not seeded;
Codex does not fetch the catalog for them.

## Frozen source

The daemon implementation is intentionally maintained as a frozen in-repository
snapshot. It does not implement automatic upstream updates; changes are reviewed
and versioned as part of the Linger Computer daemon.

## Windows host boundary

On Windows a named pipe private to the current user carries the same HTTP control
interface. The pipe name comes from the state directory's absolute path, with
forward slashes, as a lowercase SHA-256 digest. Private files are checked against
the current SID and ACL, not POSIX permission bits. Writing a separate credential
does not change the permissions of an existing parent directory.

Process recovery uses the creation time and a held process handle, so a reused
process ID is never mistaken for the original. Ordinary tasks are held by a Job
Object; managed services are held by a separate supervisor process. An upgrade
must keep the old program directory that still hosts a supervisor.

`linger-computer-daemon.exe platform` reads one JSON request from standard input.
`action` selects a file-permission, process-recovery, service-cleanup or Runtime
diagnosis operation. Standard output returns only JSON; errors go to standard
error with a non-zero exit code. This entry does not start the Daemon, and
credentials never appear in command arguments.

Run native acceptance from the repository root with
`scripts/check-local-computer-windows.ps1`. Its fixtures cover ACLs, named pipes,
process trees, managed services and the three Runtime protocols. A cross build
only shows that the source compiles; it does not replace native Windows
acceptance. Multi-line arguments that the generic batch launcher cannot express
fail explicitly. The official npm launcher calls Node directly; prompts still go
through the standard-input protocol.

## Controlled desktop and browser tools

On macOS the Computer gives each Operation two MCP tool entries (MCP is the Model
Context Protocol). `computer` provides desktop screenshots and input. `browser`
uses a pinned Playwright MCP. After actions such as click and type, Playwright
writes the page snapshot to a file and returns only a link; the Daemon reads the
file, puts the snapshot back into the result and deletes the file, so the model
need not call `browser_snapshot` again. Only links under `.linger/browser-output/`
are replaced.

The tool catalog is cached per Computer installation; an Operation's tool service
expires as soon as it closes. After connecting to the Runner Gateway, the Daemon
discovers the catalog once in the background so the first run does not wait. On
macOS this starts the CuaDriver service in the background without requesting
system permissions or taking the foreground; an Agent that never uses the
computer tools pays only this one background start. Preparation only reads the
catalog; it opens no pages and sends no input.

macOS uses the signed CuaDriver.app. The Computer starts the service with the
automatic permission wizard off and sets `CUA_DRIVER_WINDOW_CHANGE_TIMEOUT_MS` to
0: by default Cua waits up to 1 second after each action for a window change,
adding 0.3–0.4 seconds to every click and key press, and the Agent reads the
window itself after a series of inputs. The service directory is a hash of the
state directory and driver path, and its `environment` file records the
service's start environment; when that differs from the current version, the
Daemon stops the old service before starting the new one. The Daemon takes the
service's pid from the socket peer rather than a file in /tmp, which macOS cleans
after 3 days unused.

On one computer, a desktop call holds the screen and clipboard until it ends, and
other tasks' desktop calls queue. Browser calls run in lanes of their own, one
per Agent: the tasks of one Agent take turns in its browser, and different
Agents' browser calls run at the same time as each other and as desktop reads.
A desktop input that needs the front window or the clipboard waits for the
browser calls in flight. From the moment it starts waiting, new browser calls
wait for it, because a browser call can bring Chrome forward or copy and paste
in the page. A browser call holds its turn until it returns, so one long call,
such as a slow navigation or `browser_wait_for`, delays the waiting input and
with it every Agent's next browser call. These inputs are keys and text, foreground and modifier clicks,
double-clicks, which may fall back to the front app, drags, cursor moves,
scripts, batches, app launches, bringing a window to the front, window moves,
the clipboard tools, all native Linux input, every Windows input, and text
recognition on Windows or when it pages on macOS. A
macOS background click, right-click or scroll to a known app runs beside
browser calls, unless the app is a Chromium browser other than the Computer's
own Chrome. A queued call that is cancelled returns
`COMPUTER_BUSY` without sending input. `check_permissions` only reads permissions
and never requests them, and the permission answer must come from the Cua service
itself. Only the owner's Request on a permission card asks macOS: the Daemon runs
`cua-driver permissions grant` in the background, one at a time for at most 10
minutes, because CuaDriver refuses to prompt from its tools.

`launch_app` opens an application, with an optional file or URL, in the
background through LaunchServices without taking the foreground. With a file or
URL it waits for a new window or 5 seconds; without one it returns at once if the
application already has a window. The result lists the application's pid and
windows, marking new ones.

On macOS, key input means `press_key`, `hotkey` and `type_text` without an
`element_token` or coordinates. With only `pid`, keys go to that application's
current focus, as a person typing would. If the application is not frontmost, the
Daemon activates it once and sends keys through Cua's desktop session. With
`window_id` as well, that window must be the application's focused window, and
keys use Cua's exact-window foreground delivery; otherwise the call returns
`COMPUTER_INPUT_NOT_SENT`, names the window in front and suggests `bring_to_front`
first. When the application is already frontmost, the Daemon does not raise any
of its windows again, since re-raising would end a rename field or close a menu.
On macOS the key tools take no `scope` or `target`; `delivery_mode` applies only to
input with an element or coordinates.

Cua's `z_index` does not follow window switches inside an application, so the
Daemon tracks each application's focused window itself. After `bring_to_front`
confirms the foreground, or after the Daemon activates an application, it records
that window and all of the application's windows at that moment. A window that
appears later with a higher layer counts as frontmost, such as a new document, a
form or a panel. A new window with a title counts as frontmost even at a lower
layer, because TextEdit restores old documents at launch and Cua may give the new
one a lower layer than theirs; a new window without a title must have a higher
layer, because Finder briefly shows untitled windows. When activating a
background application, the Daemon brings along the window of that application
the Agent named last.

The Daemon remembers the application it raised last. When the user brings
another application forward, key input returns `COMPUTER_USER_TOOK_OVER` and the
Daemon does not take the foreground back. Before every key and every 16
characters of text, the Daemon checks the frontmost application; if it changed
midway, it stops and returns `COMPUTER_INPUT_PARTIAL` with the number of
characters typed.

`type_text` with only `pid` first asks Cua to insert into the focused element
through Accessibility, bypassing input methods and auto-capitalization. When Cua
refuses, for example with several Finder windows or focus in a save panel, the
Daemon writes the text to the clipboard and sends `cmd+v` to the frontmost
application. Before pasting it saves the whole clipboard and restores it 200 ms
after the paste, unless someone changed the clipboard in between. It also
restores on cancellation; saving and restoring each have a 5-second limit that
cancellation does not shorten. A file the Agent copied in Finder before typing a
path therefore stays on the clipboard. No browser call runs during the paste.

A single macOS input tool reports only whether the input was delivered;
`run_actions` reads the window once after the last step. When a Finder list row
refuses `double_click`'s AXOpen, the Daemon brings the application forward and
double-clicks again, as a person would; if that still fails, the error suggests
`click` plus `cmd+down`. A click with a `modifier`, such as cmd-click to
multi-select in Finder, uses foreground delivery, because Cua holds modifier keys
only for foreground events. A `type_text` right after a shortcut in the same batch
waits 300 ms first, for cmd+shift+n or cmd+shift+g to open its field. An AX click
on a menu bar title (`AXMenuBarItem`, such as File) opens the menu, and the
application takes no other input until the menu closes; the Daemon then adds a
hint to click a menu item from the window read, or to press escape with only
`pid`. The tool descriptions also tell the model that cmd+delete on a file
selected in the Trash puts it back, and that context menus do not appear in
window reads.

The Agent calls `get_window_state` once at the end of a series of inputs, with
`since:"latest"` to see the effect. `get_window_state` may take only `pid`; the
Daemon then reads that application's focused window, such as a panel that just
opened. Choosing the focused window skips windows that are off screen, such as a
save panel's accessory view. When the focused window has no readable
accessibility tree, for example a save panel that forms an empty window of its
own, the Daemon reads the application's most recently used window instead, which
holds the panel in its tree; it does the same when the chosen window just closed,
such as the Go to Folder panel after Return.

A read without `max_elements` walks at most 500 nodes; Cua's default of 250 cuts
off deep files once Finder expands subfolders. The tool descriptions ask for
`max_depth:3` on save and open panels, where every control sits, because a deeper
read walks the panel's file list. Every Cua call writes one `cua.call.timing` log
with the raise, the Cua request and the total time. On Windows, after a successful
input with `pid` and `window_id`, the Daemon still reads that window's text diff
and appends it to the result. When the Agent calls `get_window_state` itself,
macOS reads text only, with no screenshot by default.

A read without `timeout_ms` gets a 4000 ms walk budget for the accessibility tree: Cua's own 1000 ms cuts a browser page of a thousand nodes, and a cut tree counts as unreadable.
A screenshot is attached only when the Agent passes `include_screenshot: true`. When a window's tree cannot be read, the Daemon waits 400 ms and reads the text again with a 6000 ms budget, and only then reads once more with a screenshot.
Screenshots become JPEG of the same size before they reach the Runtime: the Runtime resends earlier screenshots every turn, so a 1 MB PNG slows every later turn. Coordinate clicks keep the same pixel grid.
macOS also offers `run_script`: Cua runs one JavaScript program in a single call, with loops, waits, reads and input inside the driver, and returns only its value to the model.
The Daemon admits only background, output-file-free scripts, fits the time limit into the call's remaining time, and cuts the result to its text: the first and last call-log lines and 40000 characters, with no screenshots.
On macOS, `click` takes `delivery_mode: "foreground"` and `action`: the first for web controls that react only to a real pointer, the second for accessibility actions such as `show_alternate_ui`.

Every Operation's developer instructions carry a list of the Computer tools, so
the model need not search the tool catalog before its first call; macOS uses
`MacToolGuide`, with the call shapes of the browser tools. For Codex the Runtime
sets the Daemon's own `computer` and `browser` servers to
`omit_tools_from = ["code_mode", "deferred"]`, only on Codex 0.163.0 and later;
earlier Codex does not know the field and keeps the tools in code mode. The two
tool groups are therefore ordinary function tools, neither in code mode nor
deferred, like Codex's own `cua_repl` plugin: one model call is one JSON function
call, not a `text(await tools.mcp__computer__…)` script.

On macOS these tools show only the fields the Computer routes. They hide Cua's `scope` and `capture_id`; only `click` takes `delivery_mode`, as described above.
Codex does not see the single macOS input tools: the `computer` server hides them
with `disabled_tools`. All input goes through `run_actions`, with as many steps as
possible in one call, like consecutive operations in one Codex script.
`run_actions` sends each step as its own driver call, in order and without pauses, and stops at the first failed step.
On macOS it always reads the window once after the last step and returns only the
changes in the same result. By default it reads the last step's window, or the
application's focused window when that step gave no `window_id`; pass `read` to
read another window or add a `query`. When a step is refused or its result is
unknown, the result lists the completed, unsent and possibly applied steps.
An `element_token` from an older read is refused, never rebound to another element with the same role and label. A step can name its target by role and name instead; the Daemon finds it when the step runs.
On Windows, after a successful input the Daemon waits 100 ms before reading the
window diff, because Cua already waits for its own read-back after input. The MCP
initialize result carries no usage instructions, because Codex prepends them to
every tool description and the model's tool listing would be truncated.

When the default browser is not Chrome, the local browser uses a separate Agent
profile directory, stored under `computer-tools/browser-profiles/` in the state
directory. Cua can observe the native Chrome window that Playwright connects to.

On macOS, `launch_app` with `agent_browser: true` opens the Computer's own
browser for a site that watches for automated browsers. The Agent drives it
only with the computer tools, never through Playwright or a debugging port.
Chrome, Edge and Firefox each run as a separate instance with their own
profile under `computer-tools/agent-<browser>` in the state directory, so the
user signs in there once. Safari cannot run a second profile; the Computer
uses its own window in the user's Safari. Without a `bundle_id`, the Daemon
picks the first installed of Chrome, Edge, Firefox and Safari.
Input to that browser is paced: 600 to 1800 ms between inputs, at most 300
inputs per task and 1500 per day, and at most 20 inputs per `run_script`.
`report_blocker` with the page URL stops
the task; `rate_limited` also puts the site (its registrable domain) in a
60-minute cooldown. The record lives in `computer-tools/agent-chrome-pace.json`.
Once a task opens a site there, the browser tools refuse that site for the
rest of the task, and `launch_app` refuses to open it in another browser.
A change in the number of tabs between the task's inputs stops the task with
`COMPUTER_TAB_CHANGED`, because the next input could reach another page. A
tab that the task's own input or script opens or closes is the task's: the
task holds the browser's input lease, and the count is kept once the tab strip
settles, since the browser shows such a tab a moment later. Only the window
the task opened with `launch_app` is held. A script that names no window in
its `args` is taken to drive that window; a script to another app is neither
paced nor held, and a paced script may not call `launch_app`.

Desktop input keeps one persistent action record,
`computer-tools/action.json`. Each Agent's browser and each seat in the
everyday Chrome keep their own, `computer-tools/action-browser-<hash>.json`.
Each record file is removed once its action settles. An unknown record blocks its own desktop, Agent browser or seat,
and a Daemon restart reads every record again. The two sides also block each
other where one could still reach the other: an unknown browser action blocks
desktop input that needs the front window or the clipboard, and an unknown
desktop input of that kind blocks browser calls, so does a record that an
older Daemon left without saying which kind it was. Such a call returns
`COMPUTER_ACTION_UNKNOWN` and names the Agent and the record file that blocks it.
A record that an earlier Daemon left has no task here to settle it; the error
says so. Removing that file once the action is known to be finished frees its
desktop, Agent browser or seat at the next call, with no restart. A record of
this Daemon's own task still settles only through that task. An unknown action on a whole everyday Chrome profile, left before
the extension kept many clients, also blocks every seat of that profile. After a
cancellation, the original connection must confirm that the Cua session was
cleaned up; the exit of a shared service's proxy process does not count, and a
Daemon restart does not clear unknown actions. Without the original connection's
cleanup receipt, later input stays blocked. The exception is when the Cua service
process itself has exited, as macOS jetsam ends this background application under
memory pressure: when the connection is gone and the recorded service process no
longer exists, the action can no longer run, so the Daemon settles the record. That
call returns `COMPUTER_DRIVER_RESTARTED`, and the next call starts a new service
and session. A normal exit closes the Chrome the Computer started itself.

Windows uses the bundled `cua/cua-driver.exe` (Cua 0.35.4); the release manifest's
`cua_entry` points to it, and the installer refuses a bundle without it. Each
Operation starts its own `cua-driver.exe mcp --direct`. Only that driver enters
the Operation's Job Object; applications started by `launch_app` belong to the
user and stay after the task. The Daemon must run in the signed-in user's desktop
session: session 0 returns `COMPUTER_SESSION_NONINTERACTIVE`, the lock screen and
secure desktop return `COMPUTER_DESKTOP_LOCKED` without sending input, and an
unavailable UI Automation returns `COMPUTER_PERMISSION_REQUIRED` without
elevating. Whole-screen read-only tools use a separate desktop session, which
does not affect the window tools. Browser and file tools do not depend on Cua.

Linux controls the signed-in user's X11 desktop. The driver `local_linux.py` is
embedded in the Go binary; it reads windows through AT-SPI and sends input with
`xdotool`. The host needs `python3-pyatspi`, `xdotool`, ImageMagick, `xclip` and a
user systemd manager. The Daemon must run as the desktop user and inherit
`DISPLAY`, `XAUTHORITY`, `DBUS_SESSION_BUS_ADDRESS` and `XDG_SESSION_TYPE`. With a
missing dependency or under Wayland, `check_permissions` explains why; browser and
file tools still work.

`open_application` and `open_url` start the program through `systemd-run --user`
with `KillMode=process`, so it outlives the tool call. `xdg-open` hands a URL to
`gio`, which exits as soon as it started the browser; the default control-group
mode would kill the browser with it. `open_url` then waits up to 8 seconds for
the active window or its title to change, and fails when neither does. After
any input, a page that is still loading is read again until it loads, for at
most 8 seconds; the result marks `loading` when it has not. A desktop with no
active window, as right after a GNOME login, still launches: any window that
appears counts as opened.

`type_text` pastes the text. A terminal emulator gets it on both the clipboard
and the primary selection and receives `shift+Insert`, which every common
terminal pastes; any other window gets it on the clipboard and receives
`ctrl+v`, so a GTK field keeps the selection the paste replaces. `scroll` first moves the pointer to
the middle of the active window when the pointer is outside it, because the
wheel scrolls whatever is under the pointer. `press_key` accepts key names in any
case, such as `f5` or `insert`. Text over 64 KiB is refused before any input.

Input goes to the active window, so input planned for the window the Agent
last observed fails with `WINDOW_CHANGED` when another window, such as one the
user clicked, became active since. The result shows the active window, and the
next input to it goes through. `open_application` and `open_url` are not
checked, because they bring up a window of their own.

GTK4 applications report their controls as sensitive rather than enabled, and
on X11 report every control at the screen origin. The driver counts either
state as enabled, and clicks a GTK4 control at the X11 window position plus
its client-side shadow (`_GTK_FRAME_EXTENTS`) plus the control's position in
the window. A launched window that shows no controls yet is read again for up
to 3 seconds, because its X11 window appears before the application registers
with AT-SPI.

Input on a locked screen would reach the lock dialog, so every input first asks
the desktop's screen saver service (GNOME, freedesktop, Cinnamon or Xfce) and
fails with `SCREEN_LOCKED` while it is active. Only input enters the action
record; a screenshot or window read that a Daemon crash interrupts sent
nothing and leaves no block. When the driver exits, as after a lost
accessibility bus, the next call starts a new driver.

A window read walks at most 1,500 shown accessibility nodes, 30 levels deep, and
skips hidden subtrees such as closed menus. A larger page still returns the
browser toolbar and the top of the page, and the result says that part of the
window was left out. GNOME's `toolkit-accessibility` setting is off by default,
and then Firefox and Chrome expose no controls; a window without controls then
tells the Agent to ask the user to turn it on. Screenshots are sent as JPEG
unless the PNG is smaller, as on macOS and Windows.

The user attaches their everyday Chrome from Settings, Computers, or from the
card an Agent posts in a Room chat when it needs that browser. The connection uses the official Playwright Extension's token, stored
readable only by the current user under `computer-tools/browser-connections/`.
macOS and Windows support this mode; Linux returns `unsupported`. When the default
browser is Chrome and it is not connected, the status is `not_connected` and
browser calls wait for the user to connect rather than use a separate browser. A
Computer that can connect the everyday browser declares the host capability
`browser_connection`. A Linux Computer, or one without the local browser tools,
does not declare it, answers a connection request as unsupported, and does not
tell Agents to post a connection card.

On Linux the managed browser is the first Google Chrome or Chromium found in the
usual install folders, Snap included, and then on `PATH`. A Snap browser keeps
its Agent profiles under `~/snap/<name>/common/linger-browser-profiles/`,
because confinement denies the hidden state folder. Without `DISPLAY` or
`WAYLAND_DISPLAY` the browser tools fail with that reason before starting Chrome.
Before a launch, the Daemon stops a Chrome that an earlier Daemon left on the
same Agent profile, identified by the profile's `SingletonLock` and that
process's command line. Otherwise Chrome would hand every new launch to the
old process. A managed Chrome that exits during a task, closed by the user or
crashed, starts again on the next browser call. A cancelled browser call whose
outcome is unknown blocks that Agent's later browser calls until its task ends;
the task then stops the Agent Chrome, which proves no command still runs, and
settles the record. The owner's everyday Chrome is never stopped. A task holds
one seat in it. When every installed version of the Playwright Extension in
the profile is 0.5.0 or later, the extension keeps several Playwright clients
connected, each in its own tab group. Each Agent then has its own seat, and
Agents work in their own background tabs at once. An earlier extension may drop
one client when the next connects, so its whole profile is one seat. Release
bundles patch Playwright to keep focus emulation on its CDP connections, this
Chrome and the Agent Chrome alike. Without it a background tab is hidden: it
stops rendering, clicks wait for it, and mouse and key events are lost. One task or Live call holds a seat at a time, so tasks of
one Agent take turns. An unknown action blocks the calls to its seat and
settles once the task's Playwright child, the only sender, has stopped. A task
waits up to 40 seconds for a seat and a Live call up to 8 seconds; the call
then fails with `BROWSER_BUSY`, which Live reports as `browser_busy`. A task
passes the seat on when it ends and its Playwright child has stopped, even when
an unrelated part of its cleanup fails. The `computer` tool names are Cua 0.35.4's real names, such as
`move_cursor`, `press_key`, `launch_app` and `bring_to_front`. `doctor` reports
Chrome and the extension.

The release bundle pins Playwright MCP 0.0.83. Pi's MCP extension uses the
official 1.2.0 API. Cua is pinned to the official 0.35.4 release assets: the
signed macOS application and `cua-driver.exe` for Windows x64 and ARM64. The
bundle includes every dependency resource and a per-file SHA-256 manifest; the
installer refuses files outside the manifest, damaged resources and symlinks. The
runtime never runs `npx latest` or downloads tool dependencies. Pi still uses its
existing RPC executor, and images keep their native content types.

The compatibility probe of the pinned Playwright catalog is
`TestPinnedPlaywrightCatalog`; it needs `LINGER_PLAYWRIGHT_COMPAT_ENTRY` and
`LINGER_PLAYWRIGHT_COMPAT_NODE`. The macOS read-only probe is
`TestPinnedCuaReadOnlyPermissions`; point `LINGER_CUA_COMPAT_EXECUTABLE` at a
verified asset.

Real desktop probes run on demand and are skipped by default:

| Test                         | Switch                                                | Covers                                                                                                                   |
| ---------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `TestMacDesktopLive`         | `LINGER_MAC_DESKTOP_PROBE=1`                          | Non-Latin background input in TextEdit, whole-screen screenshot, separate browser                                        |
| `TestWindowsDesktopLive`     | `LINGER_WINDOWS_EXPECT=ready\|locked\|noninteractive` | Three lines of non-Latin text in Notepad, keys, whole-screen tools, lock screen, session 0, separate browser             |
| `TestUserChromeLive`         | `LINGER_USER_CHROME_PROBE=1`                          | Wrong token, connect, reconnect after restart, private storage, disconnect                                               |
| `TestNativeLinuxDesktopLive` | `LINGER_NATIVE_LINUX_LIVE=1`                          | Mousepad Unicode save, AT-SPI windows, screenshot, out-of-bounds, unknown-key and oversized-text refusal, cancelled drag |
| `TestNativeLinuxOpenURLLive` | `LINGER_NATIVE_LINUX_BROWSER_LIVE=1`                  | `open_url` in the default browser, a second URL in the running browser, a page that answers late                         |
| `TestNativeLinuxGNOMELive`   | `LINGER_NATIVE_LINUX_GNOME_LIVE=1`                    | GTK4 Text Editor read as text, `WINDOW_CHANGED` after the user activates another window, GTK4 Calculator clicks          |

The first three read `LINGER_COMPUTER_TOOLS` (the unpacked tool directory) and
`LINGER_NODE`; the Linux tests need only an isolated X11 session,
`TestNativeLinuxGNOMELive` a GNOME one, and
`TestNativeLinuxOpenURLLive` also a default browser.
`LINGER_PROBE_EVIDENCE` sets the evidence JSON path. `TestUserChromeLive` reads
the whole line the extension copied from `LINGER_USER_CHROME_TOKEN_FILE` or the
clipboard. Windows probes must run on the interactive desktop, for example started
with `schtasks /IT`.

During development, `LINGER_COMPUTER_CUA_PATH` makes the Daemon use an already
authorized Cua executable.

Before delivery, still run `make check BASE=<target-branch>` from the repository
root; it includes the Computer's fast checks.
