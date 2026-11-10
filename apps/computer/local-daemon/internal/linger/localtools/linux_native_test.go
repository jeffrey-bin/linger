package localtools

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"image"
	_ "image/jpeg"
	_ "image/png"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/mcpproxy"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider"
)

func TestNativeLinuxCatalogAndDragArguments(t *testing.T) {
	found := false
	for _, tool := range nativeLinuxTools() {
		if tool.Name == "drag" {
			found = true
		}
		if tool.Name == "open_application" && !bytes.Contains(tool.InputSchema, []byte("libreoffice-impress")) {
			t.Fatal("missing native office applications")
		}
	}
	if !found {
		t.Fatal("missing drag gesture")
	}
	action, err := parseDesktopAction("drag", json.RawMessage(`{"x":10,"y":20,"to_x":30,"to_y":40}`))
	if err != nil || strings.Join(action.values, ",") != "10,20,30,40" {
		t.Fatalf("drag: %v %v", action, err)
	}
	if _, err := parseDesktopAction("drag", json.RawMessage(`{"x":10,"y":20}`)); err == nil {
		t.Fatal("accepted incomplete drag")
	}
}

func TestNativeLinuxKeepsEverydayChromeUnsupported(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("Linux only")
	}
	manager, err := New(Options{StateDirectory: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	if manager.journal == nil {
		t.Fatal("native Linux desktop input has no action journal")
	}
	if status := manager.browserStatus(nil); status.State != browserUnsupported {
		t.Fatalf("browser status = %q", status.State)
	}
}

// liveLinux is a production Operation on the signed-in user's X11 desktop,
// for the live tests that run only in an explicitly selected desktop.
type liveLinux struct {
	op      *operation
	manager *Manager
	ctx     context.Context
	root    string
}

func newLiveLinux(t *testing.T, gate string) *liveLinux {
	t.Helper()
	if os.Getenv(gate) != "1" {
		t.Skip("requires an isolated native X11 desktop")
	}
	if runtime.GOOS != "linux" {
		t.Fatal("native Linux acceptance requires Linux")
	}
	env := map[string]string{}
	for _, entry := range os.Environ() {
		key, value, _ := strings.Cut(entry, "=")
		env[key] = value
	}
	root := t.TempDir()
	manager, err := New(Options{StateDirectory: filepath.Join(root, "state"), Environment: env})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	t.Cleanup(cancel)
	op := &operation{manager: manager, ctx: ctx, label: "native-live", spec: provider.OperationSpec{AgentID: "native-live", WorkingDirectory: root}, identity: mcpproxy.OperationIdentity{OperationID: "native-live"}}
	t.Cleanup(func() {
		if err := op.closeLinux(); err != nil {
			t.Error(err)
		}
	})
	return &liveLinux{op: op, manager: manager, ctx: ctx, root: root}
}

// call runs a computer tool and fails the test on an error result.
func (l *liveLinux) call(t *testing.T, name string, args any) json.RawMessage {
	t.Helper()
	encoded, _ := json.Marshal(args)
	value, err := l.op.computerCall(l.ctx, name, encoded)
	if err != nil {
		t.Fatalf("%s: %v", name, err)
	}
	var status struct {
		IsError bool `json:"isError"`
	}
	_ = json.Unmarshal(value, &status)
	if status.IsError {
		t.Fatalf("%s: %s", name, value)
	}
	return value
}

// This exercises the production MCP driver, accessibility state, Unicode
// clipboard and save.
func TestNativeLinuxDesktopLive(t *testing.T) {
	live := newLiveLinux(t, "LINGER_NATIVE_LINUX_LIVE")
	op, manager, ctx, root := live.op, live.manager, live.ctx, live.root
	call := func(name string, args any) json.RawMessage { t.Helper(); return live.call(t, name, args) }
	path := filepath.Join(root, "native-input.txt")
	if err := os.WriteFile(path, []byte("initial\n"), 0600); err != nil {
		t.Fatal(err)
	}
	call("open_application", map[string]any{"application": "mousepad", "path": path})
	call("press_key", map[string]any{"key": "ctrl+a"})
	text := "Native Linux input\nGröße prüfen — café\nlast line\n"
	call("type_text", map[string]any{"text": text})
	call("press_key", map[string]any{"key": "ctrl+s"})
	got, err := os.ReadFile(path)
	if err != nil || string(got) != text {
		t.Fatalf("saved Unicode bytes differ: %q, %v", got, err)
	}
	window := call("get_window_state", map[string]any{})
	if !bytes.Contains(window, []byte("native-input.txt")) {
		t.Fatalf("accessibility did not observe the opened document: %s", window)
	}
	screenshot := call("screenshot", map[string]any{})
	var shot struct{ Content []struct{ Type, Data string } }
	if json.Unmarshal(screenshot, &shot) != nil || len(shot.Content) != 1 {
		t.Fatal("invalid screenshot result")
	}
	data, err := base64.StdEncoding.DecodeString(shot.Content[0].Data)
	if err != nil {
		t.Fatal(err)
	}
	// The screen is sent as JPEG unless its PNG is smaller.
	if _, _, err := image.DecodeConfig(bytes.NewReader(data)); err != nil {
		t.Fatal("not an image", err)
	}
	refused, refusal := op.computerCall(ctx, "click", json.RawMessage(`{"x":999999,"y":999999}`))
	var refusedResult struct {
		IsError bool `json:"isError"`
	}
	_ = json.Unmarshal(refused, &refusedResult)
	if refusal == nil && !refusedResult.IsError {
		t.Fatal("outside-screen input was accepted")
	}
	if manager.journal.blocked() {
		t.Fatal("refused input left the action journal blocked")
	}
	refused, refusal = op.computerCall(ctx, "press_key", json.RawMessage(`{"key":"NotAnX11Key"}`))
	_ = json.Unmarshal(refused, &refusedResult)
	if refusal == nil && !refusedResult.IsError {
		t.Fatal("unknown key was accepted")
	}
	if manager.journal.blocked() {
		t.Fatal("unknown key left the action journal blocked")
	}
	refused, refusal = op.computerCall(ctx, "type_text", json.RawMessage(`{"text":"`+strings.Repeat("a", 65537)+`"}`))
	_ = json.Unmarshal(refused, &refusedResult)
	if refusal == nil && !refusedResult.IsError {
		t.Fatal("oversized text was accepted")
	}
	if manager.journal.blocked() {
		t.Fatal("oversized text left the action journal blocked")
	}
	call("press_key", map[string]any{"key": "PAGEDOWN"})
	call("get_window_state", map[string]any{})
	call("press_key", map[string]any{"key": "alt+F4"})
	// Cancel only after X11 has observed button-down. This catches drivers
	// that stop their process but leave a partially executed drag held down.
	dragCtx, cancelDrag := context.WithCancel(ctx)
	defer cancelDrag()
	dragDone := make(chan struct{})
	go func() {
		defer close(dragDone)
		_, _ = op.computerCall(dragCtx, "drag", json.RawMessage(`{"x":300,"y":300,"to_x":600,"to_y":350}`))
	}()
	deadline := time.Now().Add(5 * time.Second)
	for nativePointerMask(t)&256 == 0 {
		if time.Now().After(deadline) {
			t.Fatal("drag did not press the mouse button")
		}
		time.Sleep(10 * time.Millisecond)
	}
	cancelDrag()
	<-dragDone
	if err := op.closeLinux(); err != nil {
		t.Fatal(err)
	}
	if nativePointerMask(t)&256 != 0 {
		t.Fatal("canceled drag left the mouse button held")
	}
	if manager.journal.blocked() {
		t.Fatal("clean driver shutdown left pending input")
	}
}

// This runs on a GNOME X11 desktop. GTK4 windows must read as text, and
// input planned for one window must not reach another one the user brought
// forward.
func TestNativeLinuxGNOMELive(t *testing.T) {
	live := newLiveLinux(t, "LINGER_NATIVE_LINUX_GNOME_LIVE")
	path := filepath.Join(live.root, "gnome-input.txt")
	if err := os.WriteFile(path, []byte("initial\n"), 0600); err != nil {
		t.Fatal(err)
	}
	live.call(t, "open_application", map[string]any{"application": "gnome-terminal"})
	opened := live.call(t, "open_application", map[string]any{"application": "gnome-text-editor", "path": path})
	if !bytes.Contains(opened, []byte(`text = \"initial\"`)) {
		t.Fatalf("the GTK4 editor did not read as text: %s", opened)
	}
	if err := exec.Command("sh", "-c", "xdotool search --class gnome-terminal | tail -1 | xargs xdotool windowactivate --sync").Run(); err != nil {
		t.Fatal("activate the terminal:", err)
	}
	refused, err := live.op.computerCall(live.ctx, "type_text", json.RawMessage(`{"text":"must-not-reach-the-terminal"}`))
	if err != nil || !bytes.Contains(refused, []byte("WINDOW_CHANGED")) || !bytes.Contains(refused, []byte(`"isError":true`)) {
		t.Fatalf("input reached a window the Agent had not seen: %s %v", refused, err)
	}
	if live.manager.journal.blocked() {
		t.Fatal("refused input left the action journal blocked")
	}
	// The refusal showed the terminal, so input to it is now planned.
	live.call(t, "press_key", map[string]any{"key": "Escape"})

	// GTK4 reports its controls at the screen origin; clicks must still land
	// on them.
	if err := exec.Command("sh", "-c", "setsid gnome-calculator >/dev/null 2>&1 & xdotool search --sync --name '^Calculator$' windowactivate --sync").Run(); err != nil {
		t.Fatal("open the calculator:", err)
	}
	t.Cleanup(func() { _ = exec.Command("pkill", "-x", "gnome-calculato").Run() })
	state := live.call(t, "get_window_state", map[string]any{})
	for _, label := range []string{"7", "+", "8", "="} {
		match := regexp.MustCompile(`\[(\d+)\]\*? push button "` + regexp.QuoteMeta(label) + `"`).FindSubmatch(unescapeResult(t, state))
		if match == nil {
			t.Fatalf("no %q button: %s", label, state)
		}
		number, _ := strconv.Atoi(string(match[1]))
		state = live.call(t, "click_element", map[string]any{"element": number})
	}
	if !bytes.Contains(unescapeResult(t, state), []byte(`label "15"`)) {
		t.Fatalf("7+8= did not show 15: %s", state)
	}
}

// unescapeResult joins a tool result's text items.
func unescapeResult(t *testing.T, value json.RawMessage) []byte {
	t.Helper()
	var result struct{ Content []struct{ Text string } }
	if err := json.Unmarshal(value, &result); err != nil {
		t.Fatal(err)
	}
	var text []byte
	for _, item := range result.Content {
		text = append(text, item.Text...)
	}
	return text
}

func nativePointerMask(t *testing.T) int {
	t.Helper()
	output, err := exec.Command("/usr/bin/python3", "-c", `import ctypes as c
x=c.CDLL("libX11.so.6")
x.XOpenDisplay.argtypes=[c.c_char_p]; x.XOpenDisplay.restype=c.c_void_p
d=x.XOpenDisplay(None)
if not d: raise RuntimeError("no X11 display")
x.XDefaultRootWindow.argtypes=[c.c_void_p]; x.XDefaultRootWindow.restype=c.c_ulong
x.XQueryPointer.argtypes=[c.c_void_p,c.c_ulong,c.POINTER(c.c_ulong),c.POINTER(c.c_ulong),*[c.POINTER(c.c_int)]*4,c.POINTER(c.c_uint)]
root,child=c.c_ulong(),c.c_ulong()
rx,ry,wx,wy=c.c_int(),c.c_int(),c.c_int(),c.c_int()
mask=c.c_uint()
x.XQueryPointer(d,x.XDefaultRootWindow(d),c.byref(root),c.byref(child),c.byref(rx),c.byref(ry),c.byref(wx),c.byref(wy),c.byref(mask))
print(mask.value)
`).Output()
	if err != nil {
		t.Fatal("read native X11 pointer state", err)
	}
	value, err := strconv.Atoi(strings.TrimSpace(string(output)))
	if err != nil {
		t.Fatal(err)
	}
	return value
}

// This opens pages in the default browser of a GNOME desktop, where xdg-open
// hands the URL to gio, which exits as soon as it started the browser. The
// second URL goes to the browser the first one started.
func TestNativeLinuxOpenURLLive(t *testing.T) {
	live := newLiveLinux(t, "LINGER_NATIVE_LINUX_BROWSER_LIVE")
	home, err := os.UserHomeDir()
	if err != nil {
		t.Fatal(err)
	}
	// open_url accepts file URLs inside the home directory only.
	pages, err := os.MkdirTemp(home, ".linger-open-url-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(pages) })
	for _, name := range []string{"Linger open url first", "Linger open url second"} {
		path := filepath.Join(pages, strings.ReplaceAll(name, " ", "-")+".html")
		if err := os.WriteFile(path, []byte("<!doctype html><title>"+name+"</title><p>"+name+"</p>"), 0600); err != nil {
			t.Fatal(err)
		}
		result := live.call(t, "open_url", map[string]any{"url": "file://" + path})
		if !bytes.Contains(result, []byte(name)) {
			t.Fatalf("open_url did not show %q: %s", name, result)
		}
	}
	// A page that answers late is still loading when its tab appears; the
	// result must show the page, not the tab before it loaded.
	slow := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		time.Sleep(2 * time.Second)
		_, _ = w.Write([]byte("<!doctype html><title>Linger slow page</title><p>loaded</p>"))
	}))
	t.Cleanup(slow.Close)
	result := live.call(t, "open_url", map[string]any{"url": slow.URL + "/slow"})
	if !bytes.Contains(result, []byte("Linger slow page")) {
		t.Fatalf("open_url returned before the page loaded: %s", result)
	}
}
