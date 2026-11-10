//go:build darwin

package localtools

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/mcpproxy"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider"
)

// TestMacDesktopLive drives the signed-in Mac through the bundled Cua app and
// an isolated browser. Input may take focus. It targets only its uniquely named
// fixture window and never kills TextEdit, which can restore unrelated files.
func TestMacDesktopLive(t *testing.T) {
	if os.Getenv("LINGER_MAC_DESKTOP_PROBE") != "1" {
		t.Skip("opt-in macOS desktop probe")
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
		PlaywrightEntry: filepath.Join(tools, "node_modules", "@playwright", "mcp", "cli.js"), CuaPath: filepath.Join(tools, "cua", "cua-driver"), Environment: env})
	if err != nil {
		t.Fatal(err)
	}
	identity := mcpproxy.OperationIdentity{OperationID: "mac-desktop-probe", ExecutionLeaseID: "owned", RuntimeType: "codex"}
	set, err := mcpproxy.Open(t.Context(), json.RawMessage(`[]`), identity)
	if err != nil {
		t.Fatal(err)
	}
	defer set.Close()
	if err := m.Bind(t.Context(), provider.OperationSpec{AgentID: "mac-desktop-probe", WorkingDirectory: dir}, identity, set); err != nil {
		t.Fatal(err)
	}
	var op *operation
	for item := range m.operations {
		op = item
	}
	if op.computerErr != nil {
		t.Fatal(op.computerErr)
	}
	record := map[string]any{}
	timings := map[string]int64{}
	defer func() {
		record["timings_ms"] = timings
		if evidence != "" {
			data, _ := json.MarshalIndent(record, "", "  ")
			_ = os.WriteFile(evidence, data, 0o600)
		}
		if err := m.Close(); err != nil {
			t.Error(err)
		}
	}()
	call := func(route, name string, args map[string]any) (map[string]any, string) {
		encoded, _ := json.Marshal(args)
		started := time.Now()
		var raw json.RawMessage
		if route == "computer" {
			raw, err = op.computerCall(t.Context(), name, encoded)
		} else {
			raw, err = op.browserCall(t.Context(), name, encoded)
		}
		timings[route+"."+name] += time.Since(started).Milliseconds()
		var result map[string]any
		_ = json.Unmarshal(raw, &result)
		var parts []string
		items, _ := result["content"].([]any)
		for _, item := range items {
			if part, _ := item.(map[string]any); part["type"] == "text" {
				parts = append(parts, part["text"].(string))
			}
		}
		text := strings.Join(parts, "\n")
		if err != nil || result["isError"] == true {
			t.Fatalf("%s.%s: %s %v", route, name, text, err)
		}
		return result, text
	}

	fixture, err := os.CreateTemp(dir, "linger-mac-probe-*.txt")
	if err != nil {
		t.Fatal(err)
	}
	if err := fixture.Close(); err != nil {
		t.Fatal(err)
	}
	document := fixture.Name()
	documentName := filepath.Base(document)
	result, _ := call("computer", "launch_app", map[string]any{"bundle_id": "com.apple.TextEdit", "urls": []string{document}})
	pid := result["structuredContent"].(map[string]any)["pid"].(float64)
	var window any
	for attempt := 0; attempt < 20 && window == nil; attempt++ {
		listed, _ := call("computer", "list_windows", map[string]any{"pid": pid})
		if windows, _ := listed["structuredContent"].(map[string]any)["windows"].([]any); len(windows) > 0 {
			for _, candidate := range windows {
				item, _ := candidate.(map[string]any)
				if item["title"] == documentName {
					if window != nil {
						t.Fatal("multiple windows match the owned fixture")
					}
					window = item["window_id"]
				}
			}
		}
		if window == nil {
			time.Sleep(500 * time.Millisecond)
		}
	}
	if window == nil {
		t.Fatal("TextEdit did not expose the uniquely named fixture window; no input sent")
	}
	target := map[string]any{"pid": pid, "window_id": window}
	_, tree := call("computer", "get_window_state", target)
	if !strings.Contains(tree, documentName) {
		t.Fatal("fixture identity is missing from the window snapshot; no input sent")
	}
	field := ""
	for _, line := range strings.Split(tree, "\n") {
		if strings.Contains(line, "TextArea") || strings.Contains(line, "AXTextArea") {
			if open := strings.Index(line, "["); open >= 0 {
				if end := strings.Index(line[open:], "]"); end > 0 {
					field = line[open+1 : open+end]
					break
				}
			}
		}
	}
	snapshot := ""
	if _, after, ok := strings.Cut(tree, "snapshot_id="); ok {
		snapshot, _, _ = strings.Cut(after, "\n")
		snapshot = strings.Fields(snapshot)[0]
	}
	const typed = "Ligne 1 : bonjour, le monde\nLigne 2 Second line\nFin ✓ çà"
	if field == "" || snapshot == "" {
		t.Fatal("fixture text field has no current element token; no input sent")
	}
	args := map[string]any{"pid": pid, "window_id": window, "text": typed}
	args["element_token"] = fmt.Sprintf("%s:%s", snapshot, field)
	call("computer", "type_text", args)
	_, tree = call("computer", "get_window_state", target)
	record["typed_readback"] = strings.Contains(tree, "Ligne 1 : bonjour, le monde") && strings.Contains(tree, "Fin ✓ çà")
	if record["typed_readback"] != true {
		t.Fatalf("typed text did not land: %s", tree)
	}
	call("computer", "hotkey", map[string]any{"pid": pid, "window_id": window, "keys": []string{"cmd", "s"}})
	var content []byte
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); {
		content, err = os.ReadFile(document)
		if err == nil && string(content) == typed {
			break
		}
		time.Sleep(25 * time.Millisecond)
	}
	if err != nil || string(content) != typed {
		t.Fatalf("fixture save mismatch: err=%v content=%q", err, content)
	}
	// Close only the saved fixture, never the app or a restored tab.
	call("computer", "hotkey", map[string]any{"pid": pid, "window_id": window, "keys": []string{"cmd", "w"}})
	screen, _ := call("computer", "get_screen_size", map[string]any{})
	record["screen"] = screen["structuredContent"]
	desktop, _ := call("computer", "get_desktop_state", map[string]any{})
	record["desktop_capture"] = desktop["structuredContent"].(map[string]any)["screenshot_mime_type"]

	page := "data:text/html;charset=utf-8,<title>Linger isolated browser</title><input id=q aria-label=Query>"
	call("browser", "browser_navigate", map[string]any{"url": page})
	_, snapshotText := call("browser", "browser_snapshot", map[string]any{})
	ref := ""
	for _, line := range strings.Split(snapshotText, "\n") {
		if strings.Contains(line, "Query") {
			if _, after, ok := strings.Cut(line, "[ref="); ok {
				ref, _, _ = strings.Cut(after, "]")
			}
		}
	}
	call("browser", "browser_type", map[string]any{"element": "Query", "target": ref, "text": "Saisie navigateur é"})
	_, snapshotText = call("browser", "browser_snapshot", map[string]any{})
	record["browser_value"] = strings.Contains(snapshotText, "Saisie navigateur é")
	listed, _ := call("computer", "list_windows", map[string]any{"app": "Chrome"})
	structured, _ := json.Marshal(listed["structuredContent"])
	chrome := string(structured)
	record["desktop_sees_browser"] = strings.Contains(chrome, "Linger isolated browser")
	if record["browser_value"] != true || record["desktop_sees_browser"] != true {
		t.Fatalf("browser: %+v %s", record, chrome)
	}
}
