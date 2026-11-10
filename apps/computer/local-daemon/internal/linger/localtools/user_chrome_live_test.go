//go:build darwin || windows

package localtools

import (
	"bytes"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/mcpproxy"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/platform/privatefs"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider"
)

// TestUserChromeLive connects the signed-in user's everyday Chrome through
// the official Playwright Extension. The operator copies the extension's line
// to the clipboard first; the test reads it as pasted text, like the chat panel.
func TestUserChromeLive(t *testing.T) {
	if os.Getenv("LINGER_USER_CHROME_PROBE") != "1" {
		t.Skip("opt-in everyday Chrome probe")
	}
	// A private token file avoids touching an everyday clipboard.
	pasted, err := os.ReadFile(os.Getenv("LINGER_USER_CHROME_TOKEN_FILE"))
	if os.Getenv("LINGER_USER_CHROME_TOKEN_FILE") == "" {
		paste := exec.Command("pbpaste")
		if runtime.GOOS == "windows" {
			paste = exec.Command("powershell", "-NoProfile", "-Command", "Get-Clipboard")
		}
		pasted, err = paste.Output()
	}
	if err != nil {
		t.Fatal(err)
	}
	token := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(string(pasted)), "PLAYWRIGHT_MCP_EXTENSION_TOKEN="))
	if !extensionTokenPattern.MatchString(token) {
		t.Fatal("the clipboard does not hold the Playwright Extension line")
	}
	tools, evidence := os.Getenv("LINGER_COMPUTER_TOOLS"), os.Getenv("LINGER_PROBE_EVIDENCE")
	dir := t.TempDir()
	env := map[string]string{}
	for _, entry := range os.Environ() {
		if name, value, _ := strings.Cut(entry, "="); name != "" {
			env[name] = value
		}
	}
	options := Options{StateDirectory: filepath.Join(dir, "state"), NodePath: os.Getenv("LINGER_NODE"),
		PlaywrightEntry: filepath.Join(tools, "node_modules", "@playwright", "mcp", "cli.js"), Environment: env}
	options.CuaPath = filepath.Join(tools, "cua", "cua-driver")
	if runtime.GOOS == "windows" {
		options.CuaPath += ".exe"
	}
	record := map[string]any{}
	timings := map[string]int64{}
	defer func() {
		record["timings_ms"] = timings
		if evidence != "" {
			data, _ := json.MarshalIndent(record, "", "  ")
			_ = os.WriteFile(evidence, data, 0o600)
		}
	}()
	measure := func(name string, started time.Time) { timings[name] += time.Since(started).Milliseconds() }
	m, err := New(options)
	if err != nil {
		t.Fatal(err)
	}
	const tenant, owner = "live-tenant", "live-owner"

	// The wrong-token phase leaves a connect prompt in Chrome for 30 seconds.
	started := time.Now()
	_, err = m.BrowserConnection(t.Context(), tenant, owner, "configure", "", strings.Repeat("A", 43))
	measure("configure_wrong_token", started)
	var commandErr *BrowserCommandError
	if !errors.As(err, &commandErr) || commandErr.Code != "BROWSER_TOKEN_REJECTED" {
		t.Fatalf("a wrong token must be rejected: %v", err)
	}
	status, err := m.BrowserConnection(t.Context(), tenant, owner, "status", "", "")
	record["wrong_token"] = map[string]any{"error": commandErr.Code, "status_after": status}
	if err != nil || status.Mode != "isolated" {
		t.Fatalf("a rejected token must not be stored: %+v %v", status, err)
	}

	started = time.Now()
	status, err = m.BrowserConnection(t.Context(), tenant, owner, "configure", "", token)
	measure("configure", started)
	record["configured"] = status
	if err != nil || status.Mode != "user_chrome" || status.State != browserConnected {
		t.Fatalf("configure: %+v %v", status, err)
	}

	// Chrome refuses data: navigations from an extension debugger.
	page, title := "https://example.com/", "Example Domain"
	runTask := func(m *Manager, operationID string) map[string]any {
		identity := mcpproxy.OperationIdentity{OperationID: operationID, ExecutionLeaseID: "owned", RuntimeType: "codex"}
		set, err := mcpproxy.Open(t.Context(), json.RawMessage(`[]`), identity)
		if err != nil {
			t.Fatal(err)
		}
		defer set.Close()
		if err := m.Bind(t.Context(), provider.OperationSpec{TenantID: tenant, OwnerActorID: owner, AgentID: "user-chrome-probe", WorkingDirectory: dir}, identity, set); err != nil {
			t.Fatal(err)
		}
		var op *operation
		for item := range m.operations {
			op = item
		}
		result := map[string]any{}
		call := func(route, name string, args map[string]any) string {
			encoded, _ := json.Marshal(args)
			started := time.Now()
			var raw json.RawMessage
			if route == "computer" {
				raw, err = op.computerCall(t.Context(), name, encoded)
			} else {
				raw, err = op.browserCall(t.Context(), name, encoded)
			}
			measure(operationID+"."+name, started)
			if err == nil {
				err = toolResultError(raw)
			}
			if err != nil {
				t.Fatalf("%s: %v", name, err)
			}
			return string(raw)
		}
		call("browser", "browser_navigate", map[string]any{"url": page})
		result["tab_listed"] = strings.Contains(call("browser", "browser_tabs", map[string]any{"action": "list"}), title)
		if op.cua != nil {
			result["desktop_sees_user_chrome"] = strings.Contains(call("computer", "list_windows", map[string]any{"app": "chrome"}), title)
		}
		if err := m.Close(); err != nil {
			t.Fatal(err)
		}
		result["chrome_still_running"] = chromeRunning()
		return result
	}
	record["task"] = runTask(m, "user-chrome-task")
	// A restarted daemon reconnects from the private store and re-verifies.
	restarted, err := New(options)
	if err != nil {
		t.Fatal(err)
	}
	status, err = restarted.BrowserConnection(t.Context(), tenant, owner, "status", "", "")
	record["status_after_restart"] = status
	if err != nil || status.Mode != "user_chrome" {
		t.Fatalf("restart lost the connection: %+v %v", status, err)
	}
	record["task_after_restart"] = runTask(restarted, "user-chrome-after-restart")
	for _, key := range []string{"task", "task_after_restart"} {
		task := record[key].(map[string]any)
		if task["tab_listed"] != true || task["chrome_still_running"] != true || task["desktop_sees_user_chrome"] == false {
			t.Fatalf("%s: %+v", key, task)
		}
	}

	// The token stays only in its private connection file.
	store := restarted.browserConnectionPath(tenant, owner)
	var leaks []string
	_ = filepath.WalkDir(options.StateDirectory, func(path string, entry fs.DirEntry, err error) error {
		if err == nil && !entry.IsDir() && path != store {
			if data, readErr := os.ReadFile(path); readErr == nil && bytes.Contains(data, []byte(token)) {
				leaks = append(leaks, path)
			}
		}
		return nil
	})
	record["token_copies_outside_store"] = len(leaks)
	if len(leaks) > 0 {
		t.Fatalf("token leaked into %v", leaks)
	}
	// Owner-only: a 0600 file on macOS, a protected owner DACL on Windows.
	record["store_private"] = privatefs.CheckPath(store, "file", true) == nil
	if record["store_private"] != true {
		t.Fatal("the connection store is not private")
	}
	status, err = restarted.BrowserConnection(t.Context(), tenant, owner, "disconnect", "", "")
	record["disconnected"] = status
	if _, statErr := os.Stat(store); err != nil || status.Mode != "isolated" || !errors.Is(statErr, fs.ErrNotExist) {
		t.Fatalf("disconnect: %+v %v %v", status, err, statErr)
	}
	if data, _ := json.Marshal(record); bytes.Contains(data, []byte(token)) {
		t.Fatal("evidence contains the token")
	}
}

func chromeRunning() bool {
	if runtime.GOOS == "windows" {
		output, _ := exec.Command("tasklist", "/FI", "IMAGENAME eq chrome.exe", "/NH").Output()
		return bytes.Contains(bytes.ToLower(output), []byte("chrome.exe"))
	}
	return exec.Command("pgrep", "-x", "Google Chrome").Run() == nil
}
