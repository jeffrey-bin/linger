//go:build windows

package localtools

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/mcpproxy"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider"
)

// TestWindowsDesktopLive drives the signed-in Windows desktop through the
// installed tool bundle. LINGER_WINDOWS_EXPECT selects the desktop state the
// operator prepared: ready, locked, or noninteractive (an SSH session).
func TestWindowsDesktopLive(t *testing.T) {
	expect := os.Getenv("LINGER_WINDOWS_EXPECT")
	if expect == "" {
		t.Skip("opt-in Windows desktop probe")
	}
	tools, evidence := os.Getenv("LINGER_COMPUTER_TOOLS"), os.Getenv("LINGER_PROBE_EVIDENCE")
	dir := t.TempDir()
	env := map[string]string{}
	for _, entry := range os.Environ() {
		if name, value, _ := strings.Cut(entry, "="); name != "" {
			env[name] = value
		}
	}
	m, err := New(Options{StateDirectory: filepath.Join(dir, "state"), NodePath: os.Getenv("LINGER_NODE"),
		PlaywrightEntry: filepath.Join(tools, "node_modules", "@playwright", "mcp", "cli.js"), CuaPath: filepath.Join(tools, "cua", "cua-driver.exe"), Environment: env})
	if err != nil {
		t.Fatal(err)
	}
	identity := mcpproxy.OperationIdentity{OperationID: "windows-desktop-probe", ExecutionLeaseID: "owned", RuntimeType: "codex"}
	set, err := mcpproxy.Open(t.Context(), json.RawMessage(`[]`), identity)
	if err != nil {
		t.Fatal(err)
	}
	defer set.Close()
	if err := m.Bind(t.Context(), provider.OperationSpec{AgentID: "windows-desktop-probe", WorkingDirectory: dir}, identity, set); err != nil {
		t.Fatal(err)
	}
	var op *operation
	for item := range m.operations {
		op = item
	}
	record := map[string]any{"expect": expect}
	timings := map[string]int64{}
	call := func(route, name string, args map[string]any) (map[string]any, error) {
		encoded, _ := json.Marshal(args)
		started := time.Now()
		var raw json.RawMessage
		if route == "computer" {
			raw, err = op.computerCall(t.Context(), name, encoded)
		} else {
			raw, err = op.browserCall(t.Context(), name, encoded)
		}
		timings[route+"."+name] += time.Since(started).Milliseconds()
		t.Logf("%s.%s %dms err=%v blocked=%v", route, name, time.Since(started).Milliseconds(), err, m.journal.blocked())
		var result map[string]any
		_ = json.Unmarshal(raw, &result)
		return result, err
	}
	text := func(result map[string]any) string {
		var parts []string
		items, _ := result["content"].([]any)
		for _, item := range items {
			if part, _ := item.(map[string]any); part["type"] == "text" {
				parts = append(parts, part["text"].(string))
			}
		}
		return strings.Join(parts, "\n")
	}
	saveImage := func(result map[string]any, name string) bool {
		items, _ := result["content"].([]any)
		for _, item := range items {
			if part, _ := item.(map[string]any); part["type"] == "image" && evidence != "" {
				data, err := base64.StdEncoding.DecodeString(part["data"].(string))
				if err == nil && os.WriteFile(filepath.Join(filepath.Dir(evidence), name), data, 0o600) == nil {
					return true
				}
			}
		}
		return false
	}
	closed := false
	defer func() {
		record["timings_ms"] = timings
		if evidence != "" {
			data, _ := json.MarshalIndent(record, "", "  ")
			_ = os.WriteFile(evidence, data, 0o600)
		}
		if !closed {
			if err := m.Close(); err != nil {
				t.Error(err)
			}
		}
	}()

	// Browser tools never depend on the desktop driver.
	browse := func(desktop bool) {
		page := "data:text/html;charset=utf-8,<title>Linger isolated browser</title><input id=q aria-label=Query>"
		if result, err := call("browser", "browser_navigate", map[string]any{"url": page}); err != nil || result["isError"] == true {
			t.Fatalf("browser_navigate: %s %v", text(result), err)
		}
		snapshot, err := call("browser", "browser_snapshot", map[string]any{})
		if err != nil {
			t.Fatal(err)
		}
		ref := ""
		for _, line := range strings.Split(text(snapshot), "\n") {
			if strings.Contains(line, "Query") {
				if _, after, ok := strings.Cut(line, "[ref="); ok {
					ref, _, _ = strings.Cut(after, "]")
				}
			}
		}
		if result, err := call("browser", "browser_type", map[string]any{"element": "Query", "target": ref, "text": "Saisie navigateur é"}); err != nil || result["isError"] == true {
			t.Fatalf("browser_type: %s %v", text(result), err)
		}
		value, err := call("browser", "browser_snapshot", map[string]any{})
		record["browser_value"] = strings.Contains(text(value), "Saisie navigateur é")
		if err != nil || record["browser_value"] != true {
			t.Fatalf("browser value: %s %v", text(value), err)
		}
		if !desktop {
			return
		}
		chrome, err := call("computer", "list_windows", map[string]any{"app": "chrome"})
		record["desktop_sees_browser"] = strings.Contains(text(chrome), "Linger isolated browser")
		if err != nil || record["desktop_sees_browser"] != true {
			all, _ := call("computer", "list_windows", map[string]any{})
			t.Fatalf("the desktop tools do not see the isolated browser: %s %v\nall windows: %s", text(chrome), err, text(all))
		}
	}

	switch expect {
	case "noninteractive":
		_, err := call("computer", "list_windows", map[string]any{})
		record["computer_error"] = errorText(err)
		if op.cua != nil || err == nil || !strings.Contains(err.Error(), "COMPUTER_SESSION_NONINTERACTIVE") {
			t.Fatalf("session 0 must report a non-interactive desktop: %v", err)
		}
		browse(false)
		return
	case "locked":
		_, err := call("computer", "list_windows", map[string]any{})
		record["computer_error"] = errorText(err)
		if err == nil || !strings.Contains(err.Error(), "COMPUTER_DESKTOP_LOCKED") {
			t.Fatalf("a locked desktop must refuse input: %v", err)
		}
		return
	}

	permissions, err := call("computer", "check_permissions", map[string]any{})
	if err != nil || permissions["structuredContent"].(map[string]any)["uia"] != true {
		t.Fatalf("UI Automation is unavailable: %v %v", permissions, err)
	}
	record["permissions"] = permissions["structuredContent"]
	screen, err := call("computer", "get_screen_size", map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	record["screen"] = screen["structuredContent"]
	fixture, err := os.CreateTemp(dir, "linger-desktop-*.txt")
	if err != nil {
		t.Fatal(err)
	}
	if err := fixture.Close(); err != nil {
		t.Fatal(err)
	}
	title := filepath.Base(fixture.Name()) + " - Notepad"
	launched, err := call("computer", "launch_app", map[string]any{"name": "notepad", "urls": []string{fixture.Name()}})
	if err != nil {
		t.Fatal(err)
	}
	pid := launched["structuredContent"].(map[string]any)["pid"].(float64)
	// Notepad may share a process with existing user tabs. Never kill it.
	time.Sleep(1500 * time.Millisecond)
	windows, err := call("computer", "list_windows", map[string]any{"pid": pid})
	if err != nil {
		t.Fatal(err)
	}
	listed, _ := windows["structuredContent"].(map[string]any)["windows"].([]any)
	var window any
	for _, entry := range listed {
		item, _ := entry.(map[string]any)
		if item["title"] == title {
			window = item["window_id"]
			break
		}
	}
	if window == nil {
		t.Fatal("disposable Notepad document is not the active window; no input sent")
	}
	target := map[string]any{"pid": pid, "window_id": window}
	with := func(extra map[string]any) map[string]any {
		merged := map[string]any{}
		for key, value := range target {
			merged[key] = value
		}
		for key, value := range extra {
			merged[key] = value
		}
		return merged
	}
	if _, err := call("computer", "bring_to_front", target); err != nil {
		t.Fatal(err)
	}
	state, err := call("computer", "get_window_state", with(map[string]any{"max_elements": 30}))
	if err != nil {
		t.Fatal(err)
	}

	// Window reads expose the same text contract the product Agent receives;
	// the proxy intentionally removes duplicate structuredContent.
	windowText := text(state)
	if !strings.Contains(windowText, `- Window "`+title+`"`) {
		t.Fatal("fixture window changed; no input sent")
	}
	fields := regexp.MustCompile(`(?m)^\s*- \[(\d+)\] Document `).FindAllStringSubmatch(windowText, -1)
	if len(fields) != 1 {
		t.Fatal("fixture has no unique editable Document; no input sent")
	}
	record["window_screenshot"] = saveImage(state, "notepad-before.png")
	_, afterSnapshot, _ := strings.Cut(windowText, "snapshot_id=")
	snapshotFields := strings.Fields(afterSnapshot)
	if len(snapshotFields) == 0 {
		t.Fatalf("window read has no snapshot token: %s", windowText)
	}
	snapshot := snapshotFields[0]
	const typed = "Ligne 1 : bonjour, le monde\nLigne 2 Second line\nFin ✓ çà"
	if result, err := call("computer", "type_text", with(map[string]any{"text": typed, "element_token": snapshot + ":" + fields[0][1], "delivery_mode": "foreground"})); err != nil || result["isError"] == true {
		t.Fatalf("type_text: %s %v", text(result), err)
	}
	state, err = call("computer", "get_window_state", with(map[string]any{"max_elements": 30}))
	if err != nil {
		t.Fatal(err)
	}
	tree := text(state)
	record["typed_readback"] = strings.Contains(tree, "Ligne 1 : bonjour, le monde\r\nLigne 2 Second line\r\nFin ✓ çà") && strings.Contains(tree, "Ln 3, Col 9")
	record["window_after_typing"] = saveImage(state, "notepad-typed.png")
	if record["typed_readback"] != true {
		t.Fatal("fixture did not contain the expected test text")
	}
	// Do not clear a foreground editor with Ctrl+A/Delete or close a shared process.
	if !strings.Contains(tree, filepath.Base(fixture.Name())) {
		t.Fatal("test tab changed after input")
	}
	desktop, err := call("computer", "get_desktop_state", map[string]any{})
	if err != nil || desktop["isError"] == true {
		t.Fatalf("desktop capture: %s %v", text(desktop), err)
	}
	record["desktop_screenshot"] = saveImage(desktop, "desktop.png")
	// The window tools keep working after a whole-screen capture.
	if _, err := call("computer", "get_window_state", with(map[string]any{"max_elements": 5})); err != nil {
		t.Fatal(err)
	}

	browse(true)

	// Applications the Agent launched belong to the user: closing the
	// Operation's driver must not end them.
	closed = true
	if err := m.Close(); err != nil {
		t.Fatal(err)
	}
	tasks, _ := exec.Command("tasklist", "/FI", "PID eq "+strconv.Itoa(int(pid)), "/NH").Output()
	record["launched_app_survives_close"] = strings.Contains(strings.ToLower(string(tasks)), "notepad")
	if record["launched_app_survives_close"] != true {
		t.Fatalf("closing the driver ended the launched app: %s", tasks)
	}
}

func errorText(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}
