package localtools

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/mcpproxy"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider"
)

func TestLocalToolOperationPropagatesChildCleanupFailure(t *testing.T) {
	reader, writer := io.Pipe()
	defer reader.Close()
	exited := make(chan struct{})
	close(exited)
	client := &mcpClient{stdin: writer, stop: func() {}, exited: exited, err: errors.New("process group still active after cleanup deadline")}
	m := &Manager{operations: map[*operation]bool{}}
	op := &operation{manager: m, spec: provider.OperationSpec{AgentID: "fixture"}, browser: client, cancel: func() {}}
	m.operations[op] = true
	if err := op.close(); !errors.Is(err, mcpproxy.ErrCleanupUnconfirmed) {
		t.Fatalf("missing cleanup receipt was hidden: %v", err)
	}
	if !m.operations[op] {
		t.Fatal("unknown child did not retain its Operation")
	}
}

func TestMain(m *testing.M) {
	if mode := os.Getenv("LINGER_LOCAL_TOOL_FIXTURE"); mode != "" {
		if mode == "catalog" {
			f, err := os.OpenFile(os.Getenv("LINGER_CATALOG_COUNTER"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
			if err != nil {
				os.Exit(29)
			}
			_, _ = f.WriteString("x\n")
			_ = f.Close()
			mode = "image"
			if _, err := os.Stat(os.Getenv("LINGER_CATALOG_FAIL")); err == nil {
				mode = "invalid-initialize"
			}
		}
		runToolFixture(mode)
		os.Exit(0)
	}
	os.Exit(m.Run())
}

func runToolFixture(mode string) {
	var mu sync.Mutex
	active := false
	emit := func(value any) { mu.Lock(); defer mu.Unlock(); _ = json.NewEncoder(os.Stdout).Encode(value) }
	scanner := bufio.NewScanner(os.Stdin)
	for scanner.Scan() {
		var request struct {
			ID     uint64 `json:"id"`
			Method string `json:"method"`
			Params struct {
				Name      string         `json:"name"`
				Arguments map[string]any `json:"arguments"`
			} `json:"params"`
		}
		if json.Unmarshal(scanner.Bytes(), &request) != nil {
			return
		}
		if request.ID == 0 {
			continue
		}
		var result any
		switch request.Method {
		case "initialize":
			if mode == "invalid-initialize" {
				emit(map[string]any{"jsonrpc": "2.0", "id": request.ID, "result": map[string]any{}})
				continue
			}
			if mode == "count-launch" {
				f, err := os.OpenFile(os.Getenv("LINGER_LOCAL_TOOL_MARKER"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
				if err != nil {
					os.Exit(29)
				}
				_, _ = f.WriteString("launch\n")
				_ = f.Close()
			}
			if mode == "record-launch" {
				encoded, _ := json.Marshal(map[string]any{"args": os.Args[1:], "token": os.Getenv("PLAYWRIGHT_MCP_EXTENSION_TOKEN")})
				if err := os.WriteFile(os.Getenv("LINGER_LOCAL_TOOL_MARKER"), encoded, 0o600); err != nil {
					os.Exit(29)
				}
			}
			if mode == "browser-socket" {
				root := os.Getenv("PWTEST_SOCKETS_DIR")
				if root == "" {
					root = os.TempDir()
				}
				directory := filepath.Join(root, "browser")
				if err := os.MkdirAll(directory, 0o700); err != nil {
					os.Exit(27)
				}
				listener, err := net.Listen("unix", filepath.Join(directory, "1234567890abcdef.sock"))
				if err != nil {
					os.Exit(28)
				}
				_ = listener.Close()
			}
			result = map[string]any{"protocolVersion": "2025-03-26", "capabilities": map[string]any{"tools": map[string]any{}}}
		case "tools/list":
			result = map[string]any{"tools": []tool{{Name: "click", InputSchema: json.RawMessage(`{"additionalProperties":false,"properties":{"session":{"type":"string"}},"required":["session"],"type":"object"}`)}, {Name: "browser_snapshot", InputSchema: json.RawMessage(`{"additionalProperties":false,"properties":{},"type":"object"}`)}}}
		case "tools/call":
			if strings.HasPrefix(mode, "pages") && request.Params.Name != "start_session" && request.Params.Name != "end_session" && request.Params.Name != "check_permissions" {
				// A picture viewer: page k shows one white pixel at (10+2k, 6),
				// and keys past page 2 change nothing. Mode pages-refused
				// refuses the second key.
				marker := os.Getenv("LINGER_LOCAL_TOOL_MARKER")
				data, _ := os.ReadFile(marker)
				presses := strings.Count(string(data), `"name":"press_key"`)
				result = map[string]any{"content": []any{}}
				switch request.Params.Name {
				case "press_key":
					f, _ := os.OpenFile(marker, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
					_ = json.NewEncoder(f).Encode(request.Params)
					_ = f.Close()
					if mode == "pages-hang" {
						// The key never completes, so its outcome stays unknown.
						continue
					}
					if mode == "pages-refused" && presses == 1 {
						result = map[string]any{"isError": true, "content": []any{map[string]string{"type": "text", "text": "off_space_or_ax_unresolved"}}}
					}
				case "get_window_state":
					picture := image.NewRGBA(image.Rect(0, 0, 40, 30))
					picture.Set(10+2*min(presses, 2), 6, color.White)
					var encoded bytes.Buffer
					_ = png.Encode(&encoded, picture)
					result = map[string]any{"content": []any{map[string]string{"type": "image", "mimeType": "image/png", "data": base64.StdEncoding.EncodeToString(encoded.Bytes())}}}
				}
				break
			}
			if strings.HasPrefix(mode, "tabs") && request.Params.Name != "start_session" && request.Params.Name != "end_session" && request.Params.Name != "check_permissions" {
				// The Computer's Chrome: one window, where cmd+t adds a tab and
				// cmd+w closes one unless mode tabs-refused refuses it, and each
				// read shows the tabs the window has. In mode tabs-late the browser shows the
				// last such change only from the second read after it.
				marker := os.Getenv("LINGER_LOCAL_TOOL_MARKER")
				data, _ := os.ReadFile(marker)
				tabs := 1 + strings.Count(string(data), `"keys":["cmd","t"]`) - strings.Count(string(data), `"keys":["cmd","w"]`)
				if mode == "tabs-late" && request.Params.Name == "get_window_state" {
					lines := strings.Split(strings.TrimSpace(string(data)), "\n")
					last := lines[len(lines)-1]
					f, _ := os.OpenFile(marker, os.O_APPEND|os.O_WRONLY, 0o600)
					_, _ = f.WriteString(`{"name":"read"}` + "\n")
					_ = f.Close()
					if strings.Contains(last, `"keys":["cmd","t"]`) {
						tabs--
					} else if strings.Contains(last, `"keys":["cmd","w"]`) {
						tabs++
					}
				}
				switch mode {
				case "tabs-refused":
					tabs = 1
				case "tabs-off-space":
					// The first cmd+t is refused as for a window macOS has not
					// resolved, so it opened no tab.
					tabs = max(1, tabs-1)
				case "tabs-unreadable":
					tabs = 0
				}
				if request.Params.Name != "get_window_state" && request.Params.Name != "list_windows" {
					f, _ := os.OpenFile(marker, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
					_ = json.NewEncoder(f).Encode(request.Params)
					_ = f.Close()
				}
				result = map[string]any{"content": []any{}}
				switch request.Params.Name {
				case "hotkey":
					if mode == "tabs-off-space" && strings.Count(string(data), `"keys":["cmd","t"]`) == 0 {
						result = map[string]any{"isError": true, "content": []any{map[string]string{"type": "text", "text": "off_space_or_ax_unresolved"}}}
					}
					if mode == "tabs-refused" {
						result = map[string]any{"isError": true, "content": []any{map[string]string{"type": "text", "text": "keys were not delivered"}}}
					}
				case "list_windows":
					result = map[string]any{"content": []any{}, "structuredContent": map[string]any{"windows": []any{
						map[string]any{"pid": 42, "window_id": 9, "title": "b", "z_index": 3, "is_on_screen": true},
					}}}
				case "get_window_state":
					var tree strings.Builder
					for i := range tabs {
						fmt.Fprintf(&tree, "- [%d] AXRadioButton \"Tab %d\"\n- [%d] AXButton \"Close\" [actions=[press]]\n", 2*i, i, 2*i+1)
					}
					result = map[string]any{"content": []any{}, "structuredContent": map[string]any{"tree_markdown": tree.String(), "elements": []any{
						map[string]any{"element_token": "s1:1", "role": "AXTextField", "label": "Address and search bar"},
					}}}
				}
				break
			}
			switch request.Params.Name {
			case "check_permissions":
				if (runtime.GOOS == "windows" && len(request.Params.Arguments) != 0) || (runtime.GOOS != "windows" && request.Params.Arguments["prompt"] != false) {
					os.Exit(24)
				}
				source := "driver-daemon"
				if mode == "wrong-permission-owner" {
					source = "caller"
				}
				result = map[string]any{"content": []any{}, "structuredContent": map[string]any{"uia": mode != "wrong-permission-owner", "accessibility": true, "screen_recording": true, "source": map[string]string{"attribution": source}}}
			case "start_session":
				result = map[string]any{"content": []any{}, "structuredContent": map[string]any{"session": request.Params.Arguments["session"], "active": true}}
			case "end_session":
				mu.Lock()
				busy := active
				mu.Unlock()
				if busy {
					result = map[string]any{"isError": true, "structuredContent": map[string]any{"code": "session_cleanup_pending"}}
				} else {
					result = map[string]any{"content": []any{}, "structuredContent": map[string]any{"session": request.Params.Arguments["session"], "active": false}}
				}
			case "browser_snapshot":
				result = map[string]any{"content": []any{}, "socket_root": os.Getenv("PWTEST_SOCKETS_DIR"), "temp_root": os.Getenv("TMPDIR")}
			case "list_windows":
				windows := []any{
					map[string]any{"pid": 42, "window_id": 7, "title": "a", "z_index": 2, "is_on_screen": true},
					map[string]any{"pid": 42, "window_id": 8, "z_index": 9, "is_on_screen": false},
					map[string]any{"pid": 42, "window_id": 9, "title": "b", "z_index": 3, "is_on_screen": true},
					map[string]any{"pid": 99, "window_id": 5, "title": "Terminal", "z_index": 4, "is_on_screen": true},
				}
				if mode == "sheet" || mode == "window-view-sheet" || mode == "window-view-closed" || mode == "window-view-closed-text" {
					// A Save sheet above window 9.
					windows = append(windows, map[string]any{"pid": 42, "window_id": 12, "title": "", "z_index": 7, "is_on_screen": true})
				}
				if mode == "new-doc-below" {
					// A new document that Cua ranks below a restored one.
					windows = append(windows, map[string]any{"pid": 42, "window_id": 13, "title": "Untitled 5", "z_index": 1, "is_on_screen": true})
				}
				if mode == "untitled-below" {
					// A short-lived untitled Finder window.
					windows = append(windows, map[string]any{"pid": 42, "window_id": 13, "title": "", "z_index": 1, "is_on_screen": true})
				}
				if mode == "no-windows" {
					windows = nil
				}
				if pid := request.Params.Arguments["pid"]; pid != nil {
					windows = slices.DeleteFunc(windows, func(item any) bool { return item.(map[string]any)["pid"] != int(pid.(float64)) })
				}
				result = map[string]any{"content": []any{}, "structuredContent": map[string]any{"windows": windows}}
			case "bring_to_front", "scroll", "hotkey":
				if mode == "unfocused" && request.Params.Name == "bring_to_front" {
					result = map[string]any{"isError": true, "content": []any{map[string]string{"type": "text", "text": "not verified as the focused window"}}}
				}
				if marker := os.Getenv("LINGER_LOCAL_TOOL_MARKER"); marker != "" {
					f, _ := os.OpenFile(marker, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
					_ = json.NewEncoder(f).Encode(request.Params)
					_ = f.Close()
				}
				if result == nil {
					result = map[string]any{"content": []any{map[string]string{"type": "text", "text": request.Params.Name + " ok"}}}
				}
			case "press_key":
				if mode == "record-input" || strings.HasPrefix(mode, "window-view") && os.Getenv("LINGER_LOCAL_TOOL_MARKER") != "" {
					f, err := os.OpenFile(os.Getenv("LINGER_LOCAL_TOOL_MARKER"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
					if err != nil {
						os.Exit(26)
					}
					_ = json.NewEncoder(f).Encode(request.Params)
					_ = f.Close()
				}
				result = map[string]any{"content": []any{}}
			case "get_window_state", "type_text":
				if strings.HasPrefix(mode, "stale") {
					if marker := os.Getenv("LINGER_LOCAL_TOOL_MARKER"); marker != "" {
						f, _ := os.OpenFile(marker, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
						_ = json.NewEncoder(f).Encode(request.Params)
						_ = f.Close()
					}
					result = map[string]any{"content": []any{}}
					if request.Params.Name == "get_window_state" {
						result = map[string]any{"content": []any{}, "structuredContent": map[string]any{"truncated": mode == "stale-truncated", "elements": []any{
							map[string]any{"element_token": "s2:3", "role": "AXTextArea", "label": "Comment"},
							map[string]any{"element_token": "s2:4", "role": "AXButton", "label": "Delete all"},
							map[string]any{"element_token": "s2:5", "role": "AXButton", "label": "Send"},
							map[string]any{"element_token": "s2:6", "role": "AXButton", "label": "Send"},
						}}}
					}
					break
				}
				if strings.HasPrefix(mode, "cua-delta") {
					f, err := os.OpenFile(os.Getenv("LINGER_LOCAL_TOOL_MARKER"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
					if err != nil {
						os.Exit(26)
					}
					_ = json.NewEncoder(f).Encode(request.Params)
					_ = f.Close()
					detail := "returned_element_count does not match elements"
					if mode == "cua-delta-other" {
						detail = "unrelated schema error"
					}
					if mode == "cua-delta-degraded" && request.Params.Arguments["include_screenshot"] == false {
						result = map[string]any{"content": []any{}, "structuredContent": map[string]string{"degraded_reason": "ax_window_unresolved"}}
					} else if request.Params.Arguments["since"] != nil || mode == "cua-delta-always" {
						result = map[string]any{"isError": true, "structuredContent": map[string]any{"code": "typed_output_mismatch", "tool": request.Params.Name, "detail": detail, "execution_state": "unknown"}}
					} else {
						result = map[string]any{"content": []any{map[string]string{"type": "text", "text": "full window state"}}, "structuredContent": map[string]string{"snapshot_id": "full-snapshot"}}
					}
				} else if strings.HasPrefix(mode, "window-view") && request.Params.Name == "get_window_state" {
					a := request.Params.Arguments
					if marker := os.Getenv("LINGER_LOCAL_TOOL_MARKER"); marker != "" {
						f, _ := os.OpenFile(marker, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
						_ = json.NewEncoder(f).Encode(request.Params)
						_ = f.Close()
					}
					switch {
					case a["session"] != "owned-session":
						os.Exit(29)
					case (mode == "window-view-closed" || mode == "window-view-closed-text") && a["window_id"] == float64(12):
						closed := map[string]any{"isError": true, "content": []any{map[string]string{"type": "text", "text": "window_id 12 is not a live window (closed, or the id is stale)."}}}
						if mode == "window-view-closed" {
							closed["structuredContent"] = map[string]any{"code": "window_id_not_found", "pid": a["pid"], "window_id": 12, "suggestion": "call list_windows for current window_ids; the window may have closed"}
						}
						result = closed
					case mode == "window-view-sheet" && a["window_id"] == float64(12):
						// macOS lists a sheet's controls under its document window.
						result = map[string]any{"content": []any{}, "structuredContent": map[string]string{"degraded_reason": "ax_window_unresolved"}}
					case a["since"] == "latest" && a["include_screenshot"] == false && (mode == "window-view" || mode == "window-view-sheet" || mode == "window-view-closed" || mode == "window-view-closed-text"):
						result = map[string]any{"content": []any{map[string]string{"type": "text", "text": "+ [3] AXButton Save"}}, "structuredContent": map[string]string{"snapshot_id": "s00000002"}}
					case a["since"] == "latest", a["include_screenshot"] == false:
						result = map[string]any{"content": []any{}, "structuredContent": map[string]string{"degraded_reason": "ax_window_unresolved"}}
					case a["display_only"] == true && a["include_accessibility_tree"] == false:
						result = map[string]any{"content": []any{map[string]string{"type": "text", "text": "window metadata"}, map[string]string{"type": "image", "mimeType": "image/png", "data": "after"}}}
					default:
						os.Exit(29)
					}
				} else {
					result = map[string]any{"content": []any{}}
					if request.Params.Name == "type_text" && strings.HasPrefix(mode, "window-view") {
						if marker := os.Getenv("LINGER_LOCAL_TOOL_MARKER"); marker != "" {
							f, _ := os.OpenFile(marker, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
							_ = json.NewEncoder(f).Encode(request.Params)
							_ = f.Close()
						}
						if mode == "window-view-axrefused" && request.Params.Arguments["scope"] == nil {
							result = map[string]any{"isError": true, "content": []any{map[string]string{"type": "text", "text": "Background input refused (off_space_or_ax_unresolved): window 12 is not among the process's current AXWindows"}}, "structuredContent": map[string]any{"code": "off_space_or_ax_unresolved", "effect": "refused", "pid": request.Params.Arguments["pid"], "window_id": 12, "reason": "window 12 is not among the process's current AXWindows"}}
						}
					}
				}
			case "double_click":
				if marker := os.Getenv("LINGER_LOCAL_TOOL_MARKER"); marker != "" && strings.HasPrefix(mode, "window-view") {
					f, _ := os.OpenFile(marker, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
					_ = json.NewEncoder(f).Encode(request.Params)
					_ = f.Close()
				}
				result = map[string]any{"content": []any{map[string]string{"type": "text", "text": "double_click ok"}}}
				if mode == "window-view-axopen" && request.Params.Arguments["delivery_mode"] != "foreground" {
					result = map[string]any{"isError": true, "content": []any{map[string]string{"type": "text", "text": "double_click failed: AXOpen returned -25205 for element [55]"}}}
				}
			case "click":
				if mode == "stale" {
					if marker := os.Getenv("LINGER_LOCAL_TOOL_MARKER"); marker != "" {
						f, _ := os.OpenFile(marker, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
						_ = json.NewEncoder(f).Encode(request.Params)
						_ = f.Close()
					}
					result = map[string]any{"isError": true, "content": []any{map[string]string{"type": "text", "text": "element_token is stale"}}, "structuredContent": map[string]any{"refusal": map[string]string{"code": "stale_element_token"}, "status": "refused"}}
					break
				}
				if mode == "menubar" {
					result = map[string]any{"content": []any{map[string]string{"type": "text", "text": "Performed AXPress on [15] AXMenuBarItem \"File\"."}}}
					break
				}
				if mode == "textarea" {
					result = map[string]any{"isError": true, "content": []any{map[string]string{"type": "text", "text": "AX action failed: AXUIElementPerformAction(AXPress) returned -25206"}}}
					break
				}
				if mode == "menutitle" {
					result = map[string]any{"isError": true, "content": []any{map[string]string{"type": "text", "text": "invoke_menu: path segment \"Make Plain Text\" was not found"}}}
					break
				}
				if mode == "delay" {
					mu.Lock()
					active = true
					mu.Unlock()
					if marker := os.Getenv("LINGER_LOCAL_TOOL_MARKER"); marker != "" {
						_ = os.WriteFile(marker, []byte("submitted"), 0o600)
					}
					go func(id uint64) {
						time.Sleep(250 * time.Millisecond)
						mu.Lock()
						active = false
						mu.Unlock()
						emit(map[string]any{"jsonrpc": "2.0", "id": id, "result": json.RawMessage(`{"content":[{"type":"text","text":"done"}]}`)})
					}(request.ID)
					continue
				}
				if marker := os.Getenv("LINGER_LOCAL_TOOL_MARKER"); marker != "" && strings.HasPrefix(mode, "window-view") {
					f, _ := os.OpenFile(marker, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
					_ = json.NewEncoder(f).Encode(request.Params)
					_ = f.Close()
				}
				result = map[string]any{"content": []any{map[string]any{"type": "image", "mimeType": "image/png", "data": strings.Repeat("A", 2*1024*1024)}}}
			default:
				result = map[string]any{"content": []any{}}
			}
		default:
			os.Exit(25)
		}
		emit(map[string]any{"jsonrpc": "2.0", "id": request.ID, "result": result})
	}
}

func fixtureClient(t *testing.T, mode, marker string) *mcpClient {
	t.Helper()
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	c, err := startClient(ctx, executable, nil, t.TempDir(), []string{"LINGER_LOCAL_TOOL_FIXTURE=" + mode, "LINGER_LOCAL_TOOL_MARKER=" + marker})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := c.close(); err != nil {
			t.Error(err)
		}
	})
	return c
}

func TestLocalToolClientPreservesNativeLargeImageAndConfirmsOwnedExit(t *testing.T) {
	c := fixtureClient(t, "image", "")
	catalog, err := c.tools(t.Context())
	if err != nil || len(catalog) != 2 {
		t.Fatalf("catalog: %v %v", catalog, err)
	}
	result, err := c.request(t.Context(), "tools/call", map[string]any{"name": "click", "arguments": map[string]any{}})
	if err != nil {
		t.Fatal(err)
	}
	var output struct {
		Content []struct{ Type, Data, MimeType string }
	}
	if json.Unmarshal(result, &output) != nil || len(output.Content) != 1 || output.Content[0].Type != "image" || len(output.Content[0].Data) != 2*1024*1024 {
		t.Fatal("native image content was lost")
	}
	if err := c.close(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-c.exited:
	default:
		t.Fatal("close did not confirm process exit")
	}
}

func TestLocalToolJournalCrashRecoveryAndOriginalReceipt(t *testing.T) {
	path := filepath.Join(t.TempDir(), "action.json")
	j, err := openJournal(path)
	if err != nil {
		t.Fatal(err)
	}
	first, err := j.begin(t.Context(), actionIdentity{AgentID: "a", OperationID: "op", Session: "owner"})
	if err != nil {
		t.Fatal(err)
	}
	if err := first.finish(false); err != nil {
		t.Fatal(err)
	}
	restarted, err := openJournal(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := restarted.begin(t.Context(), actionIdentity{AgentID: "b", OperationID: "new", Session: "different-owner"}); err == nil {
		t.Fatal("new owner cleared a crashed action")
	}
	if err := first.finish(true); err != nil {
		t.Fatal(err)
	}
	second, err := j.begin(t.Context(), actionIdentity{OperationID: "second"})
	if err != nil {
		t.Fatal(err)
	}
	if err := first.finish(true); err != nil {
		t.Fatal(err)
	}
	if !j.blocked() {
		t.Fatal("late old receipt cleared a different action")
	}
	_ = second.finish(true)
	final, err := openJournal(path)
	if err != nil || final.blocked() {
		t.Fatalf("final recovery: %v", err)
	}
}

func TestLocalToolCuaCancelWaitsForOriginalOwnerCleanup(t *testing.T) {
	marker := filepath.Join(t.TempDir(), "submitted")
	client := fixtureClient(t, "delay", marker)
	journal, err := openJournal(filepath.Join(t.TempDir(), "action.json"))
	if err != nil {
		t.Fatal(err)
	}
	m := &Manager{journal: journal, operations: map[*operation]bool{}}
	op := &operation{manager: m, spec: provider.OperationSpec{AgentID: "a"}, identity: mcpproxy.OperationIdentity{OperationID: "op"}}
	c := &cuaSession{op: op, client: client, label: "original-owner", desktopCheck: func() error { return nil }}
	op.cua = c
	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan error, 1)
	go func() { _, err := c.call(ctx, "click", json.RawMessage(`{}`)); done <- err }()
	deadline := time.Now().Add(5 * time.Second)
	for {
		if _, err := os.Stat(marker); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("action did not start")
		}
		time.Sleep(time.Millisecond)
	}
	cancel()
	if err := <-done; !errors.Is(err, errOutcomeUnknown) {
		t.Fatalf("cancel lost unknown outcome: %v", err)
	}
	if !journal.blocked() {
		t.Fatal("cancel released the host while the shared driver was active")
	}
	started := time.Now()
	if err := c.drain(); err != nil {
		t.Fatal(err)
	}
	if time.Since(started) < 100*time.Millisecond {
		t.Fatal("pending cleanup was accepted as a final receipt")
	}
	if journal.blocked() {
		t.Fatal("same-owner final cleanup did not release host")
	}
}

func TestLocalToolCuaRejectsCallerPermissionAttribution(t *testing.T) {
	client := fixtureClient(t, "wrong-permission-owner", "")
	journal, _ := openJournal(filepath.Join(t.TempDir(), "action.json"))
	m := &Manager{journal: journal, operations: map[*operation]bool{}}
	op := &operation{manager: m, spec: provider.OperationSpec{AgentID: "a"}, identity: mcpproxy.OperationIdentity{OperationID: "op"}}
	c := &cuaSession{op: op, client: client, label: "owner", desktopCheck: func() error { return nil }}
	if _, err := c.call(t.Context(), "click", json.RawMessage(`{}`)); err == nil || !strings.Contains(err.Error(), "PERMISSION_REQUIRED") {
		t.Fatalf("permissions: %v", err)
	}
	if c.started || journal.blocked() {
		t.Fatal("permission rejection started input or left a false unknown")
	}
}

func TestLocalToolServerPreparationRevocationAndImage(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	active, calls := false, 0
	s, err := openToolServer(ctx, mcpproxy.OperationIdentity{BeforeToolCall: func() error {
		if !active {
			return errors.New("not active")
		}
		return nil
	}}, []tool{{Name: "screenshot", InputSchema: json.RawMessage(`{"type":"object"}`)}}, func(context.Context, string, json.RawMessage) (json.RawMessage, error) {
		calls++
		return json.RawMessage(`{"content":[{"type":"image","mimeType":"image/png","data":"` + strings.Repeat("A", 2*1024*1024) + `"}]}`), nil
	})
	if err != nil {
		t.Fatal(err)
	}
	defer s.server.Close()
	request := func(method string) (int, []byte) {
		t.Helper()
		response, err := http.Post(s.url, "application/json", strings.NewReader(fmt.Sprintf(`{"jsonrpc":"2.0","id":1,"method":%q,"params":{"name":"screenshot","arguments":{}}}`, method)))
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		body, _ := io.ReadAll(response.Body)
		return response.StatusCode, body
	}
	_, body := request("tools/list")
	if !strings.Contains(string(body), "screenshot") {
		t.Fatal("catalog absent")
	}
	if err := s.waitReady(t.Context()); err != nil {
		t.Fatal(err)
	}
	_, body = request("tools/call")
	if !strings.Contains(string(body), "not active") || calls != 0 {
		t.Fatal("preparation performed input")
	}
	active = true
	status, body := request("tools/call")
	if status != 200 || len(body) < 2*1024*1024 || calls != 1 {
		t.Fatal("large native image was not served")
	}
	cancel()
	status, _ = request("tools/call")
	if status != http.StatusGone || calls != 1 {
		t.Fatal("revoked URL accepted input")
	}
}

func TestPinnedPlaywrightCatalog(t *testing.T) {
	entry := os.Getenv("LINGER_PLAYWRIGHT_COMPAT_ENTRY")
	node := os.Getenv("LINGER_PLAYWRIGHT_COMPAT_NODE")
	if entry == "" || node == "" {
		t.Skip("set fixed Playwright MCP entry and Node for official catalog compatibility")
	}
	op := &operation{manager: &Manager{options: Options{NodePath: node, PlaywrightEntry: entry}, env: []string{"PATH=" + os.Getenv("PATH"), "HOME=" + t.TempDir()}}, spec: provider.OperationSpec{WorkingDirectory: t.TempDir()}, directory: t.TempDir(), cancel: func() {}}
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()
	client, err := op.startBrowser(ctx, "http://127.0.0.1:1", "catalog")
	op.browserCatalog = client
	defer op.close()
	if err != nil {
		t.Fatal(err)
	}
	catalog, err := client.tools(ctx)
	if err != nil {
		t.Fatal(err)
	}
	trusted := filterBrowserTools(catalog)
	names := map[string]bool{}
	for _, item := range trusted {
		names[item.Name] = true
		t.Log(item.Name)
	}
	for _, name := range []string{"browser_click", "browser_snapshot", "browser_take_screenshot", "browser_navigate", "browser_tabs"} {
		if !names[name] {
			t.Fatalf("official tool missing: %s", name)
		}
	}
	if names["browser_install"] || names["browser_run_code"] {
		t.Fatal("unmanaged executable tool was granted")
	}
}

// stubFront makes frontmostPID report pids in turn, repeating the last.
func stubFront(t *testing.T, pids ...int) {
	t.Helper()
	original := frontmostPID
	var mu sync.Mutex
	frontmostPID = func(context.Context) (int, error) {
		mu.Lock()
		defer mu.Unlock()
		pid := pids[0]
		if len(pids) > 1 {
			pids = pids[1:]
		}
		return pid, nil
	}
	t.Cleanup(func() { frontmostPID = original })
}

type fixtureCall struct {
	Name      string
	Arguments map[string]any
}

// fixtureCalls reads the driver calls the fixture recorded.
func fixtureCalls(t *testing.T, marker string) []fixtureCall {
	t.Helper()
	data, _ := os.ReadFile(marker)
	var calls []fixtureCall
	for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
		if line == "" {
			continue
		}
		var call fixtureCall
		if err := json.Unmarshal([]byte(line), &call); err != nil {
			t.Fatal(err)
		}
		calls = append(calls, call)
	}
	return calls
}

func TestLocalToolCuaMacKeysFollowTheFrontAppFocus(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("key focus routing is macOS only")
	}
	windowViewDelay = 0
	t.Cleanup(func() { windowViewDelay = 100 * time.Millisecond })
	marker := filepath.Join(t.TempDir(), "calls.jsonl")
	c := cuaFixtureSession(t, "window-view", marker)
	// The user's app is in front until the Computer fronts app 42.
	stubFront(t, 99, 42)
	if _, err := c.call(t.Context(), "press_key", json.RawMessage(`{"pid":42,"key":"return","delivery_mode":"foreground"}`)); err != nil {
		t.Fatal(err)
	}
	// The input reports delivery only; a read without a window reads the
	// app's front window.
	result, err := c.call(t.Context(), "get_window_state", json.RawMessage(`{"pid":42,"since":"latest"}`))
	if err != nil || !strings.Contains(string(result), "AXButton Save") {
		t.Fatalf("result=%s err=%v", result, err)
	}
	calls := fixtureCalls(t, marker)
	if len(calls) != 3 || calls[0].Name != "bring_to_front" || calls[0].Arguments["window_id"] != float64(9) || calls[0].Arguments["session"] != "owned-session" {
		t.Fatalf("driver calls=%v, want the app's front window fronted first", calls)
	}
	keys := calls[1].Arguments
	if calls[1].Name != "press_key" || keys["scope"] != "desktop" || keys["session"] != "owned-session-desktop" || keys["key"] != "return" || keys["pid"] != nil || keys["delivery_mode"] != nil {
		t.Fatalf("keys=%v, want desktop keys for the front app", calls[1])
	}
	if calls[2].Name != "get_window_state" || calls[2].Arguments["window_id"] != float64(9) {
		t.Fatalf("view=%v, want the app's front window", calls[2])
	}
	if err := c.drain(); err != nil {
		t.Fatal(err)
	}
	// A named front window takes Cua's exact-window delivery, which refuses
	// when that window does not hold the focus; nothing is fronted again.
	marker = filepath.Join(t.TempDir(), "calls.jsonl")
	c = cuaFixtureSession(t, "window-view", marker)
	if _, err := c.call(t.Context(), "press_key", json.RawMessage(`{"pid":42,"window_id":9,"key":"a"}`)); err != nil {
		t.Fatal(err)
	}
	calls = fixtureCalls(t, marker)
	if len(calls) != 1 || calls[0].Name != "press_key" || calls[0].Arguments["window_id"] != float64(9) || calls[0].Arguments["delivery_mode"] != "foreground" || calls[0].Arguments["session"] != "owned-session" {
		t.Fatalf("driver calls=%v", calls)
	}
	if err := c.drain(); err != nil {
		t.Fatal(err)
	}
	// Text goes into the focused element through accessibility first.
	marker = filepath.Join(t.TempDir(), "calls.jsonl")
	c = cuaFixtureSession(t, "window-view", marker)
	if _, err := c.call(t.Context(), "type_text", json.RawMessage(`{"pid":42,"text":"hello world"}`)); err != nil {
		t.Fatal(err)
	}
	if calls = fixtureCalls(t, marker); len(calls) != 1 || calls[0].Name != "type_text" || calls[0].Arguments["pid"] != float64(42) || calls[0].Arguments["scope"] != nil || calls[0].Arguments["text"] != "hello world" {
		t.Fatalf("driver calls=%v", calls)
	}
	if err := c.drain(); err != nil {
		t.Fatal(err)
	}
	// An app in front with no window still takes keys, such as cmd+n.
	marker = filepath.Join(t.TempDir(), "calls.jsonl")
	c = cuaFixtureSession(t, "no-windows", marker)
	if _, err := c.call(t.Context(), "hotkey", json.RawMessage(`{"pid":42,"keys":["cmd","n"]}`)); err != nil {
		t.Fatal(err)
	}
	if calls = fixtureCalls(t, marker); len(calls) != 1 || calls[0].Name != "hotkey" || calls[0].Arguments["scope"] != "desktop" {
		t.Fatalf("driver calls=%v", calls)
	}
	if err := c.drain(); err != nil {
		t.Fatal(err)
	}
}

func TestLocalToolCuaMacFocusedWindowIsTheWindowOpenedSinceTheRecord(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("key focus routing is macOS only")
	}
	c := cuaFixtureSession(t, "new-doc-below", filepath.Join(t.TempDir(), "calls.jsonl"))
	c.record(42, 9, []listedWindow{{WindowID: 7}, {WindowID: 9}})
	_, key, err := c.focusedWindow(t.Context(), float64(42))
	if err != nil || key == nil || key.WindowID != 13 {
		t.Fatalf("key=%v err=%v, want the document opened since the record", key, err)
	}
	if err := c.drain(); err != nil {
		t.Fatal(err)
	}
	c = cuaFixtureSession(t, "untitled-below", filepath.Join(t.TempDir(), "calls.jsonl"))
	c.record(42, 9, []listedWindow{{WindowID: 7}, {WindowID: 9}})
	if _, key, err = c.focusedWindow(t.Context(), float64(42)); err != nil || key == nil || key.WindowID != 9 {
		t.Fatalf("key=%v err=%v, want the recorded window, not an untitled window below it", key, err)
	}
	if err := c.drain(); err != nil {
		t.Fatal(err)
	}
}

func TestLocalToolCuaMacReadWithoutWindowReadsTheSheetThroughItsDocument(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("key focus routing is macOS only")
	}
	marker := filepath.Join(t.TempDir(), "calls.jsonl")
	c := cuaFixtureSession(t, "window-view-sheet", marker)
	// Window 9 holds the keys; the Save panel window 12 opened above it since.
	c.focus = map[int]focusRecord{42: {window: 9, known: map[float64]bool{7: true, 8: true, 9: true}}}
	result, err := c.call(t.Context(), "get_window_state", json.RawMessage(`{"pid":42,"since":"latest"}`))
	if err != nil || !strings.Contains(string(result), "AXButton Save") {
		t.Fatalf("result=%s err=%v", result, err)
	}
	var reads []any
	for _, call := range fixtureCalls(t, marker) {
		if call.Name == "get_window_state" {
			reads = append(reads, call.Arguments["window_id"])
		}
	}
	if !slices.Equal(reads, []any{float64(12), float64(9)}) {
		t.Fatalf("read windows %v, want the panel and then its document", reads)
	}
	if err := c.drain(); err != nil {
		t.Fatal(err)
	}
}

func TestLocalToolCuaMacReadWithoutWindowSkipsAWindowThatJustClosed(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("key focus routing is macOS only")
	}
	marker := filepath.Join(t.TempDir(), "calls.jsonl")
	c := cuaFixtureSession(t, "window-view-closed", marker)
	// A Go to Folder sheet, window 12, closed after Return but is still listed.
	c.focus = map[int]focusRecord{42: {window: 9, known: map[float64]bool{7: true, 8: true, 9: true}}}
	result, err := c.call(t.Context(), "get_window_state", json.RawMessage(`{"pid":42,"since":"latest"}`))
	if err != nil || !strings.Contains(string(result), "AXButton Save") {
		t.Fatalf("result=%s err=%v", result, err)
	}
	var reads []any
	for _, call := range fixtureCalls(t, marker) {
		if call.Name == "get_window_state" {
			reads = append(reads, call.Arguments["window_id"])
		}
	}
	if !slices.Equal(reads, []any{float64(12), float64(9)}) {
		t.Fatalf("read windows %v, want the closed sheet and then the app's window", reads)
	}
	if err := c.drain(); err != nil {
		t.Fatal(err)
	}
}

func TestLocalToolCuaMacReadKeepsAWindowErrorWithoutItsCode(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("key focus routing is macOS only")
	}
	marker := filepath.Join(t.TempDir(), "calls.jsonl")
	c := cuaFixtureSession(t, "window-view-closed-text", marker)
	c.focus = map[int]focusRecord{42: {window: 9, known: map[float64]bool{7: true, 8: true, 9: true}}}
	result, err := c.call(t.Context(), "get_window_state", json.RawMessage(`{"pid":42,"since":"latest"}`))
	if err != nil || !strings.Contains(string(result), "is not a live window") {
		t.Fatalf("result=%s err=%v", result, err)
	}
	var reads []any
	for _, call := range fixtureCalls(t, marker) {
		if call.Name == "get_window_state" {
			reads = append(reads, call.Arguments["window_id"])
		}
	}
	if !slices.Equal(reads, []any{float64(12)}) {
		t.Fatalf("read windows %v, want only the first read", reads)
	}
	if err := c.drain(); err != nil {
		t.Fatal(err)
	}
}

func TestCuaAxRefusedReadsTheStructuredEffect(t *testing.T) {
	text := `"content":[{"type":"text","text":"Background input refused (no_focused_text_input): no field"}]`
	for _, test := range []struct {
		result string
		want   bool
	}{
		{`{"isError":true,` + text + `,"structuredContent":{"code":"no_focused_text_input","effect":"refused","pid":1,"window_id":2,"reason":"no field"}}`, true},
		{`{"isError":true,"content":[{"type":"text","text":"Process 1 owns more than one eligible top-level window"}],"structuredContent":{"code":"ambiguous_window_target","effect":"refused","pid":1,"candidates":[2,3]}}`, true},
		{`{"isError":true,` + text + `}`, false},
		{`{"isError":false,` + text + `,"structuredContent":{"effect":"refused"}}`, false},
	} {
		if got := axRefused(json.RawMessage(test.result)); got != test.want {
			t.Fatalf("axRefused(%s)=%v, want %v", test.result, got, test.want)
		}
	}
}

func TestLocalToolCuaMacReadMakesTheReadWindowTheKeyWindow(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("key focus routing is macOS only")
	}
	c := cuaFixtureSession(t, "window-view-sheet", filepath.Join(t.TempDir(), "calls.jsonl"))
	// Window 9 opened after window 7 held the keys, as cmd+n opens a document.
	c.focus = map[int]focusRecord{42: {window: 7, known: map[float64]bool{7: true, 8: true, 12: true}}}
	if _, err := c.call(t.Context(), "get_window_state", json.RawMessage(`{"pid":42,"since":"latest"}`)); err != nil {
		t.Fatal(err)
	}
	// A Save sheet that later reads empty now falls back to window 9.
	if record := c.focus[42]; record.window != 9 || !record.known[9] {
		t.Fatalf("key window record %+v, want window 9", record)
	}
	if err := c.drain(); err != nil {
		t.Fatal(err)
	}
}

func TestLocalToolCuaMacAgentChromeKeysStayInTheBackground(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("the Computer's own Chrome is macOS only")
	}
	marker := filepath.Join(t.TempDir(), "calls.jsonl")
	c := cuaFixtureSession(t, "window-view", marker)
	original := agentChromePID
	agentChromePID = func(context.Context, string) (int, string, error) { return 42, "--mute-audio", nil }
	t.Cleanup(func() { agentChromePID = original })
	// The user's app stays in front: no key to the Computer's Chrome fronts it.
	stubFront(t, 99)
	if _, err := c.call(t.Context(), "press_key", json.RawMessage(`{"pid":42,"key":"escape","delivery_mode":"foreground"}`)); err != nil {
		t.Fatal(err)
	}
	calls := fixtureCalls(t, marker)
	if len(calls) != 1 || calls[0].Name != "press_key" {
		t.Fatalf("driver calls=%v, want one background key", calls)
	}
	keys := calls[0].Arguments
	if keys["pid"] != float64(42) || keys["window_id"] != float64(9) || keys["scope"] != nil || keys["delivery_mode"] != nil || keys["session"] != "owned-session" {
		t.Fatalf("keys=%v, want the window of pid 42 in the background", keys)
	}
	if err := c.drain(); err != nil {
		t.Fatal(err)
	}
}

func TestLocalToolCuaMacAgentChromeServesOneTaskAndNeverComesForward(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("the Computer's own Chrome is macOS only")
	}
	marker := filepath.Join(t.TempDir(), "calls.jsonl")
	c := cuaFixtureSession(t, "window-view", marker)
	original := agentChromePID
	agentChromePID = func(context.Context, string) (int, string, error) { return 42, "--mute-audio", nil }
	t.Cleanup(func() { agentChromePID = original })
	// A modifier click needs the window in front, which this Chrome never
	// takes, alone or in a batch.
	for _, call := range []struct{ name, args string }{
		{"click", `{"pid":42,"window_id":9,"element_token":"s1:3","modifier":["cmd"]}`},
		{"run_actions", `{"actions":[{"tool":"click","pid":42,"window_id":9,"element_token":"s1:3","modifier":["cmd"]}]}`},
	} {
		if _, err := c.call(t.Context(), call.name, json.RawMessage(call.args)); err == nil || !strings.Contains(err.Error(), "COMPUTER_INPUT_NOT_SENT") {
			t.Fatalf("modifier %s err=%v, want refused", call.name, err)
		}
	}
	// While another task holds this Chrome, inputs, window changes and
	// scripts of this task send nothing, even with no pid or a null one.
	other := &operation{manager: c.op.manager}
	c.op.manager.agentChromeOwner = other
	for _, call := range []struct{ name, args string }{
		{"click", `{"pid":42,"window_id":9,"element_token":"s1:3"}`},
		{"click", `{"element_token":"s1:3"}`},
		{"click", `{"pid":null,"element_token":"s1:3"}`},
		{"bring_to_front", `{"pid":42,"window_id":9}`},
		{"set_window_frame", `{"pid":42,"window_id":9,"x":0,"y":0,"width":800,"height":600}`},
		{"launch_app", `{"bundle_id":"com.google.Chrome","urls":["https://example.com/"]}`},
		{"launch_app", `{"name":"Google Chrome","urls":["https://example.com/"]}`},
		{"run_script", `{"script":"return 1"}`},
		{"recognize_text", `{"pid":42,"window_id":9,"pages":3,"next_key":"right"}`},
	} {
		if _, err := c.call(t.Context(), call.name, json.RawMessage(call.args)); err == nil || !strings.Contains(err.Error(), "COMPUTER_BUSY") {
			t.Fatalf("%s err=%v, want busy", call.name, err)
		}
	}
	if calls := fixtureCalls(t, marker); len(calls) != 0 {
		t.Fatalf("driver calls=%v, want none", calls)
	}
	// Once that task ends, the lease passes on.
	other.closing = true
	if _, err := c.call(t.Context(), "click", json.RawMessage(`{"pid":42,"window_id":9,"element_token":"s1:3"}`)); err != nil {
		t.Fatal(err)
	}
	if err := c.drain(); err != nil {
		t.Fatal(err)
	}
}

func TestLocalToolCuaMacAgentChromeOpensAURLOnlyInANewTab(t *testing.T) {
	inputSettle = 0
	t.Cleanup(func() { inputSettle = 300 * time.Millisecond })
	// A refused cmd+t leaves the window as it was, so the URL must not go to
	// the address bar of the tab already open.
	refusedMarker := filepath.Join(t.TempDir(), "refused.jsonl")
	refused := cuaFixtureSession(t, "tabs-refused", refusedMarker)
	if err := refused.agentChromeOpenTab(t.Context(), agentBrowsers[0], 42, 9, false, "https://example.com/"); err == nil || !errors.Is(err, errNotSent) {
		t.Fatalf("refused cmd+t err=%v, want not sent", err)
	}
	if calls := fixtureCalls(t, refusedMarker); len(calls) != 1 || calls[0].Name != "hotkey" {
		t.Fatalf("calls after a refused cmd+t=%v, want only the hotkey", calls)
	}
	marker := filepath.Join(t.TempDir(), "opened.jsonl")
	c := cuaFixtureSession(t, "tabs", marker)
	if err := c.agentChromeOpenTab(t.Context(), agentBrowsers[0], 42, 9, false, "https://example.com/"); err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, call := range fixtureCalls(t, marker) {
		got = append(got, call.Name)
	}
	if want := []string{"hotkey", "set_value", "press_key"}; !slices.Equal(got, want) {
		t.Fatalf("calls=%v, want %v", got, want)
	}
	// A cmd+t refused because macOS had not resolved the window is sent
	// again after a read, and the tab opens.
	marker = filepath.Join(t.TempDir(), "off-space.jsonl")
	c = cuaFixtureSession(t, "tabs-off-space", marker)
	if err := c.agentChromeOpenTab(t.Context(), agentBrowsers[0], 42, 9, true, "https://example.com/"); err != nil {
		t.Fatal(err)
	}
	got = nil
	for _, call := range fixtureCalls(t, marker) {
		got = append(got, call.Name)
	}
	if want := []string{"hotkey", "hotkey", "set_value", "press_key"}; !slices.Equal(got, want) {
		t.Fatalf("calls after an unresolved window=%v, want %v", got, want)
	}
	// A window on another Space that never shows its tab strip gets nothing
	// and a reason the user can act on.
	wait := agentChromeWait
	t.Cleanup(func() { agentChromeWait = wait })
	agentChromeWait = 0
	marker = filepath.Join(t.TempDir(), "unreadable.jsonl")
	c = cuaFixtureSession(t, "tabs-unreadable", marker)
	if err := c.agentChromeOpenTab(t.Context(), agentBrowsers[0], 42, 9, true, "https://example.com/"); !errors.Is(err, errAgentChromeOffSpace) || len(fixtureCalls(t, marker)) != 0 {
		t.Fatalf("err=%v calls=%v, want off-Space and nothing sent", err, fixtureCalls(t, marker))
	}
	if err := c.agentChromeOpenTab(t.Context(), agentBrowsers[0], 42, 9, false, "https://example.com/"); errors.Is(err, errAgentChromeOffSpace) || !errors.Is(err, errNotSent) {
		t.Fatalf("on the user's Space err=%v, want not sent without the off-Space reason", err)
	}
}

func TestLocalToolCuaMacAgentChromeStopsWhenSomeoneElseChangesTheTabs(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("the Computer's own Chrome is macOS only")
	}
	inputSettle = 0
	t.Cleanup(func() { inputSettle = 300 * time.Millisecond })
	pause := agentChromePause
	agentChromePause = func() time.Duration { return 0 }
	t.Cleanup(func() { agentChromePause = pause })
	marker := filepath.Join(t.TempDir(), "calls.jsonl")
	c := cuaFixtureSession(t, "tabs", marker)
	original := agentChromePID
	agentChromePID = func(context.Context, string) (int, string, error) { return 42, "--mute-audio", nil }
	t.Cleanup(func() { agentChromePID = original })
	c.op.manager.agentChromeOwner = c.op
	c.op.chromeTabs, c.op.chromePID, c.op.chromeWindow = 1, 42, 9
	// The task's own cmd+t opens a tab that is the task's.
	if _, err := c.call(t.Context(), "hotkey", json.RawMessage(`{"pid":42,"window_id":9,"keys":["cmd","t"]}`)); err != nil {
		t.Fatal(err)
	}
	if c.op.chromeTabs != 2 {
		t.Fatalf("tabs after the task's own tab=%d, want 2", c.op.chromeTabs)
	}
	// A tab someone else opens stops the task before its next input.
	f, err := os.OpenFile(marker, os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = f.WriteString(`{"name":"hotkey","arguments":{"keys":["cmd","t"]}}` + "\n")
	_ = f.Close()
	sent := len(fixtureCalls(t, marker))
	if _, err := c.call(t.Context(), "click", json.RawMessage(`{"pid":42,"window_id":9,"element_token":"s1:1"}`)); !errors.Is(err, errNotSent) || !strings.Contains(err.Error(), "COMPUTER_TAB_CHANGED") {
		t.Fatalf("err=%v, want the tab change refused", err)
	}
	if _, err := c.call(t.Context(), "press_key", json.RawMessage(`{"pid":42,"window_id":9,"key":"escape"}`)); !strings.Contains(fmt.Sprint(err), "COMPUTER_SITE_BLOCKED") {
		t.Fatalf("err=%v, want the task held", err)
	}
	if calls := fixtureCalls(t, marker); len(calls) != sent {
		t.Fatalf("calls after the change=%v, want none", calls[sent:])
	}
	if err := c.drain(); err != nil {
		t.Fatal(err)
	}
}

func TestLocalToolCuaMacAgentChromeKeepsTabsItsOwnInputChangesLate(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("the Computer's own Chrome is macOS only")
	}
	inputSettle = 0
	t.Cleanup(func() { inputSettle = 300 * time.Millisecond })
	pause := agentChromePause
	agentChromePause = func() time.Duration { return 0 }
	t.Cleanup(func() { agentChromePause = pause })
	marker := filepath.Join(t.TempDir(), "calls.jsonl")
	c := cuaFixtureSession(t, "tabs-late", marker)
	original := agentChromePID
	agentChromePID = func(context.Context, string) (int, string, error) { return 42, "--mute-audio", nil }
	t.Cleanup(func() { agentChromePID = original })
	c.op.manager.agentChromeOwner = c.op
	c.op.chromeTabs, c.op.chromePID, c.op.chromeWindow = 1, 42, 9
	// A tab the task's own input opens or closes may show only after the
	// input returns; the task keeps the count the strip settles on.
	for _, step := range []struct {
		keys string
		want int
	}{{`["cmd","t"]`, 2}, {`["cmd","w"]`, 1}} {
		if _, err := c.call(t.Context(), "hotkey", json.RawMessage(`{"pid":42,"window_id":9,"keys":`+step.keys+`}`)); err != nil {
			t.Fatal(err)
		}
		if c.op.chromeTabs != step.want {
			t.Fatalf("tabs after the task's own %s=%d, want %d", step.keys, c.op.chromeTabs, step.want)
		}
		if _, err := c.call(t.Context(), "click", json.RawMessage(`{"pid":42,"window_id":9,"element_token":"s1:1"}`)); err != nil {
			t.Fatalf("input after the task's own %s: %v", step.keys, err)
		}
	}
	if err := c.drain(); err != nil {
		t.Fatal(err)
	}
}

func TestLocalToolCuaMacAgentChromeKeepsTabsItsScriptsChange(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("the Computer's own Chrome is macOS only")
	}
	inputSettle = 0
	t.Cleanup(func() { inputSettle = 300 * time.Millisecond })
	pause := agentChromePause
	agentChromePause = func() time.Duration { return 0 }
	t.Cleanup(func() { agentChromePause = pause })
	marker := filepath.Join(t.TempDir(), "calls.jsonl")
	c := cuaFixtureSession(t, "tabs-late", marker)
	original := agentChromePID
	agentChromePID = func(context.Context, string) (int, string, error) { return 42, "--mute-audio", nil }
	t.Cleanup(func() { agentChromePID = original })
	c.op.manager.agentChromeOwner = c.op
	c.op.chromeTabs, c.op.chromePID, c.op.chromeWindow = 1, 42, 9
	// change writes a tab change to the fixture's record; shown says whether
	// the next read already shows it, as for a change made between inputs.
	change := func(keys string, shown bool) {
		f, err := os.OpenFile(marker, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = f.WriteString(`{"name":"hotkey","arguments":{"keys":` + keys + `}}` + "\n")
		if shown {
			_, _ = f.WriteString(`{"name":"read"}` + "\n")
		}
		_ = f.Close()
	}
	click := json.RawMessage(`{"pid":42,"window_id":9,"element_token":"s1:1"}`)
	// A tab a script opens or closes, shown only a read later, is the task's,
	// also when the script names its window only in its own text.
	for _, step := range []struct {
		keys, script string
		want         int
	}{
		{`["cmd","t"]`, `{"script":"return 1"}`, 2},
		{`["cmd","w"]`, `{"script":"return 1","args":{"pid":42,"window_id":9}}`, 1},
	} {
		change(step.keys, false)
		if _, err := c.call(t.Context(), "run_script", json.RawMessage(step.script)); err != nil {
			t.Fatalf("script that sent %s: %v", step.keys, err)
		}
		if c.op.chromeTabs != step.want {
			t.Fatalf("tabs after the script that sent %s=%d, want %d", step.keys, c.op.chromeTabs, step.want)
		}
		if _, err := c.call(t.Context(), "click", click); err != nil {
			t.Fatalf("input after the script that sent %s: %v", step.keys, err)
		}
	}
	// A tab someone else opens between inputs stops the next script before
	// it runs.
	change(`["cmd","t"]`, true)
	before, _ := os.ReadFile(marker)
	if _, err := c.call(t.Context(), "run_script", json.RawMessage(`{"script":"return 1"}`)); !errors.Is(err, errNotSent) || !strings.Contains(err.Error(), "COMPUTER_TAB_CHANGED") {
		t.Fatalf("err=%v, want the tab change refused", err)
	}
	after, _ := os.ReadFile(marker)
	if sent := strings.ReplaceAll(string(after[len(before):]), `{"name":"read"}`+"\n", ""); sent != "" {
		t.Fatalf("calls after the change=%s, want none", sent)
	}
	if err := c.drain(); err != nil {
		t.Fatal(err)
	}
}

func TestLocalToolCuaMacAgentChromeHoldsOnlyItsOwnWindow(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("the Computer's own Chrome is macOS only")
	}
	inputSettle = 0
	t.Cleanup(func() { inputSettle = 300 * time.Millisecond })
	pause := agentChromePause
	agentChromePause = func() time.Duration { return 0 }
	t.Cleanup(func() { agentChromePause = pause })
	marker := filepath.Join(t.TempDir(), "calls.jsonl")
	c := cuaFixtureSession(t, "tabs", marker)
	original := agentChromePID
	agentChromePID = func(context.Context, string) (int, string, error) { return 42, "--mute-audio", nil }
	t.Cleanup(func() { agentChromePID = original })
	c.op.manager.agentChromeOwner = c.op
	c.op.chromeTabs, c.op.chromePID, c.op.chromeWindow = 2, 42, 9
	// A script to another app while that browser runs is neither paced nor
	// held to its tabs, though the browser shows another count.
	if _, err := c.call(t.Context(), "run_script", json.RawMessage(`{"script":"return 1","args":{"pid":99}}`)); err != nil {
		t.Fatalf("script to another app: %v", err)
	}
	if calls := fixtureCalls(t, marker); len(calls) == 0 || !strings.Contains(fmt.Sprint(calls[len(calls)-1]), "const limit = 0,") {
		t.Fatalf("calls=%v, want an unpaced script", calls)
	}
	if c.op.chromeTabs != 2 {
		t.Fatalf("tabs=%d after a script to another app, want 2", c.op.chromeTabs)
	}
	// A task stopped by a check opens no URL there either.
	c.op.chromeBlocked = "captcha"
	if _, err := c.call(t.Context(), "launch_app", json.RawMessage(`{"agent_browser":true,"urls":["https://example.com/"]}`)); !strings.Contains(fmt.Sprint(err), "COMPUTER_SITE_BLOCKED") {
		t.Fatalf("err=%v, want the stopped task held", err)
	}
	if err := c.drain(); err != nil {
		t.Fatal(err)
	}
}

func TestLocalToolCuaMacKeysFollowAWindowRaisedInsideTheApp(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("key focus routing is macOS only")
	}
	windowViewDelay = 0
	t.Cleanup(func() { windowViewDelay = 100 * time.Millisecond })
	// Cua's z_index still puts window 9 above window 7 after the Agent raised
	// window 7, so the Computer's own record decides.
	marker := filepath.Join(t.TempDir(), "calls.jsonl")
	c := cuaFixtureSession(t, "window-view", marker)
	if _, err := c.call(t.Context(), "bring_to_front", json.RawMessage(`{"pid":42,"window_id":7}`)); err != nil {
		t.Fatal(err)
	}
	if _, err := c.call(t.Context(), "hotkey", json.RawMessage(`{"pid":42,"window_id":7,"keys":["cmd","a"]}`)); err != nil {
		t.Fatal(err)
	}
	if _, err := c.call(t.Context(), "press_key", json.RawMessage(`{"pid":42,"key":"a"}`)); err != nil {
		t.Fatal(err)
	}
	if _, err := c.call(t.Context(), "get_window_state", json.RawMessage(`{"pid":42,"since":"latest"}`)); err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, call := range fixtureCalls(t, marker) {
		got = append(got, fmt.Sprint(call.Name, " ", call.Arguments["window_id"]))
	}
	if want := []string{"bring_to_front 7", "hotkey 7", "press_key <nil>", "get_window_state 7"}; !slices.Equal(got, want) {
		t.Fatalf("driver calls=%v, want %v", got, want)
	}
	if err := c.drain(); err != nil {
		t.Fatal(err)
	}
	// An app in the background comes forward with the window the Agent last
	// named, not the window Cua lists in front.
	marker = filepath.Join(t.TempDir(), "calls.jsonl")
	c = cuaFixtureSession(t, "window-view", marker)
	if _, err := c.call(t.Context(), "scroll", json.RawMessage(`{"pid":42,"window_id":7,"direction":"down"}`)); err != nil {
		t.Fatal(err)
	}
	stubFront(t, 99, 42)
	if _, err := c.call(t.Context(), "press_key", json.RawMessage(`{"pid":42,"key":"return"}`)); err != nil {
		t.Fatal(err)
	}
	calls := fixtureCalls(t, marker)
	if index := slices.IndexFunc(calls, func(call fixtureCall) bool { return call.Name == "bring_to_front" }); index < 0 || calls[index].Arguments["window_id"] != float64(7) {
		t.Fatalf("driver calls=%v", calls)
	}
	if err := c.drain(); err != nil {
		t.Fatal(err)
	}
}

func TestLocalToolCuaMacKeysNeverReachAnotherWindow(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("key focus routing is macOS only")
	}
	for _, test := range []struct {
		name, mode, args, want string
		front                  []int
		fronted                int
	}{
		// The app is in front, but its window 9 is above window 7. Fronting
		// window 7 could end a rename or close a panel, so nothing is sent.
		{"window behind the app's front window", "window-view", `{"pid":42,"window_id":7,"key":"a"}`, `window 7 is not the app's front window; window 9 "b" of this app is in front of it`, []int{42}, 0},
		{"window behind its own sheet", "sheet", `{"pid":42,"window_id":9,"keys":["cmd","shift","g"]}`, `window 9 is not the app's front window; window 12 "" of this app is in front of it`, []int{42}, 0},
		{"user keeps another app in front", "window-view", `{"pid":42,"text":"secret"}`, "did not come to the front; the front app has pid 99", []int{99}, 3},
		{"no pid", "window-view", `{"key":"a"}`, "COMPUTER_TARGET_REQUIRED", []int{42}, 0},
		{"desktop scope", "window-view", `{"pid":42,"key":"a","scope":"desktop"}`, "COMPUTER_TARGET_REQUIRED", []int{42}, 0},
	} {
		t.Run(test.name, func(t *testing.T) {
			marker := filepath.Join(t.TempDir(), "calls.jsonl")
			c := cuaFixtureSession(t, test.mode, marker)
			stubFront(t, test.front...)
			tool := map[bool]string{true: "hotkey", false: "press_key"}[strings.Contains(test.args, "keys")]
			if strings.Contains(test.args, "text") {
				tool = "type_text"
			}
			_, err := c.call(t.Context(), tool, json.RawMessage(test.args))
			if err == nil || !strings.Contains(err.Error(), test.want) || !strings.Contains(err.Error(), "nothing was sent") {
				t.Fatalf("err=%v, want %q", err, test.want)
			}
			fronted := 0
			for _, call := range fixtureCalls(t, marker) {
				if call.Name != "bring_to_front" {
					t.Fatalf("driver received %v", call)
				}
				fronted++
			}
			if fronted != test.fronted {
				t.Fatalf("fronted %d times, want %d", fronted, test.fronted)
			}
			if err := c.drain(); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestLocalToolCuaInputReturnsWindowChangesAsText(t *testing.T) {
	if runtime.GOOS == "darwin" {
		t.Skip("macOS inputs report delivery only")
	}
	windowViewDelay = 0
	t.Cleanup(func() { windowViewDelay = 100 * time.Millisecond })
	for _, test := range []struct{ mode, args, want string }{
		{"window-view", `{"pid":42,"window_id":7,"direction":"down"}`, "+ [3] AXButton Save"},
		{"window-view-degraded", `{"pid":42,"window_id":7,"direction":"down"}`, "after"},
		{"window-view", `{"pid":42,"direction":"down"}`, ""},
	} {
		c := cuaFixtureSession(t, test.mode, "")
		result, err := c.call(t.Context(), "scroll", json.RawMessage(test.args))
		if err != nil {
			t.Fatal(err)
		}
		var reply struct {
			Content []struct{ Type, Text, Data string }
		}
		if json.Unmarshal(result, &reply) != nil || len(reply.Content) != 1+min(len(test.want), 1) || reply.Content[0].Text != "scroll ok" || (test.want != "" && reply.Content[1].Text+reply.Content[1].Data != test.want) {
			t.Fatalf("%s %s: %s", test.mode, test.args, result)
		}
		if err := c.drain(); err != nil {
			t.Fatal(err)
		}
	}
}

func TestLocalToolCuaRunActionsSendsItsStepsInOrder(t *testing.T) {
	windowViewDelay = 0
	t.Cleanup(func() { windowViewDelay = 100 * time.Millisecond })
	marker := filepath.Join(t.TempDir(), "calls.jsonl")
	c := cuaFixtureSession(t, "window-view", marker)
	result, err := c.call(t.Context(), "run_actions", json.RawMessage(`{"actions":[{"tool":"scroll","pid":42,"window_id":7,"direction":"down"},{"tool":"scroll","pid":42,"window_id":7,"direction":"up"}]}`))
	// A batch reads the last step's window once after its steps.
	if err != nil || !strings.Contains(string(result), "AXButton Save") {
		t.Fatalf("result=%s err=%v", result, err)
	}
	calls := fixtureCalls(t, marker)
	if len(calls) != 3 || calls[0].Name != "scroll" || calls[1].Arguments["direction"] != "up" || calls[2].Name != "get_window_state" || calls[2].Arguments["window_id"] != float64(7) {
		t.Fatalf("driver calls=%v", calls)
	}
	if calls[0].Arguments["session"] != "owned-session" {
		t.Fatalf("scroll request=%v", calls[0])
	}
	for _, refused := range []string{
		`{"actions":[{"tool":"launch_app","name":"Notes"}]}`,
		`{"actions":[{"tool":"scroll","pid":42,"window_id":7,"direction":"down","session":"other"}]}`,
	} {
		if _, err := c.call(t.Context(), "run_actions", json.RawMessage(refused)); err == nil {
			t.Fatalf("run_actions accepted %s", refused)
		}
	}
	if err := c.drain(); err != nil {
		t.Fatal(err)
	}
}

func TestLocalToolCuaRunActionsSendsMacKeysOneByOne(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("key focus routing is macOS only")
	}
	windowViewDelay = 0
	t.Cleanup(func() { windowViewDelay = 100 * time.Millisecond })
	marker := filepath.Join(t.TempDir(), "calls.jsonl")
	c := cuaFixtureSession(t, "window-view", marker)
	stubFront(t, 42)
	result, err := c.call(t.Context(), "run_actions", json.RawMessage(`{"actions":[
		{"tool":"scroll","pid":42,"window_id":9,"direction":"down"},
		{"tool":"press_key","pid":42,"key":"a"},
		{"tool":"scroll","pid":42,"window_id":9,"direction":"up"}]}`))
	if err != nil || !strings.Contains(string(result), "AXButton Save") {
		t.Fatalf("result=%s err=%v", result, err)
	}
	var names []string
	for _, call := range fixtureCalls(t, marker) {
		names = append(names, fmt.Sprint(call.Name, call.Arguments["scope"]))
	}
	if want := []string{"scroll<nil>", "press_keydesktop", "scroll<nil>", "get_window_state<nil>"}; !slices.Equal(names, want) {
		t.Fatalf("driver calls=%v, want %v", names, want)
	}
	// A refused key reports the steps that ran and sends nothing after it.
	marker = filepath.Join(t.TempDir(), "calls.jsonl")
	c = cuaFixtureSession(t, "window-view", marker)
	stubFront(t, 42)
	_, err = c.call(t.Context(), "run_actions", json.RawMessage(`{"actions":[
		{"tool":"scroll","pid":42,"window_id":9,"direction":"down"},
		{"tool":"press_key","pid":42,"window_id":7,"key":"a"},
		{"tool":"scroll","pid":42,"window_id":9,"direction":"up"}]}`))
	if err == nil || !strings.Contains(err.Error(), "Step 1 completed. Step 2 was not sent: COMPUTER_INPUT_NOT_SENT") || !strings.HasSuffix(err.Error(), "Step 3 was not sent.") {
		t.Fatalf("err=%v", err)
	}
	if calls := fixtureCalls(t, marker); len(calls) != 1 || calls[0].Name != "scroll" {
		t.Fatalf("driver calls=%v", calls)
	}
	if err := c.drain(); err != nil {
		t.Fatal(err)
	}
}

func TestLocalToolCuaMacRunActionsSendsModifiedClicksInFront(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("modifier clicks are macOS only")
	}
	windowViewDelay, inputSettle = 0, 0
	t.Cleanup(func() { windowViewDelay, inputSettle = 100*time.Millisecond, 300*time.Millisecond })
	marker := filepath.Join(t.TempDir(), "calls.jsonl")
	c := cuaFixtureSession(t, "window-view", marker)
	stubFront(t, 42)
	if result, err := c.call(t.Context(), "run_actions", json.RawMessage(`{"actions":[
		{"tool":"click","pid":42,"window_id":9,"element_token":"s1:3"},
		{"tool":"click","pid":42,"window_id":9,"element_token":"s1:5","modifier":["cmd"]}]}`)); err != nil || failed(result) {
		t.Fatalf("result=%s err=%v", result, err)
	}
	var names []string
	for _, call := range fixtureCalls(t, marker) {
		if call.Name == "click" {
			names = append(names, fmt.Sprint(call.Name, call.Arguments["delivery_mode"]))
		}
	}
	// The plain click stays in the background; the cmd-click goes in front.
	if want := []string{"click<nil>", "clickforeground"}; !slices.Equal(names, want) {
		t.Fatalf("driver calls=%v, want %v", names, want)
	}
	if err := c.drain(); err != nil {
		t.Fatal(err)
	}
}

func TestLocalToolCuaMacDoubleClickOpensRefusedRowsInFront(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("AXOpen is macOS only")
	}
	windowViewDelay, inputSettle = 0, 0
	t.Cleanup(func() { windowViewDelay, inputSettle = 100*time.Millisecond, 300*time.Millisecond })
	marker := filepath.Join(t.TempDir(), "calls.jsonl")
	c := cuaFixtureSession(t, "window-view-axopen", marker)
	stubFront(t, 42)
	result, err := c.call(t.Context(), "run_actions", json.RawMessage(`{"actions":[{"tool":"double_click","pid":42,"window_id":9,"element_token":"s1:55"}]}`))
	if err != nil || failed(result) || !strings.Contains(string(result), "double_click ok") {
		t.Fatalf("result=%s err=%v", result, err)
	}
	var modes []string
	for _, call := range fixtureCalls(t, marker) {
		if call.Name == "double_click" {
			modes = append(modes, fmt.Sprint(call.Arguments["delivery_mode"]))
		}
	}
	// The background AXOpen is refused, so the same row is opened in front.
	if want := []string{"<nil>", "foreground"}; !slices.Equal(modes, want) {
		t.Fatalf("double_click modes=%v, want %v", modes, want)
	}
	if err := c.drain(); err != nil {
		t.Fatal(err)
	}
}

func TestLocalToolCuaMacInputsFindTheirTargetWhenTheyRun(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("role and label targets are macOS only")
	}
	marker := filepath.Join(t.TempDir(), "calls.jsonl")
	c := cuaFixtureSession(t, "stale", marker)
	// A token that a newer read replaced stays refused, alone or in a batch:
	// a control with the same label may now belong to another record.
	for _, call := range []struct{ name, args string }{
		{"click", `{"pid":42,"window_id":9,"element_token":"s1:15"}`},
		{"run_actions", `{"actions":[{"tool":"click","pid":42,"window_id":9,"element_token":"s1:15"}],"read":{"pid":42,"window_id":9}}`},
	} {
		if result, err := c.call(t.Context(), call.name, json.RawMessage(call.args)); err != nil || !failed(result) {
			t.Fatalf("stale %s result=%s err=%v", call.name, result, err)
		}
	}
	// A role and label target is the one element with exactly that label.
	if result, err := c.call(t.Context(), "type_text", json.RawMessage(`{"pid":42,"window_id":9,"role":"AXTextArea","name":"Comment","text":"hi"}`)); err != nil || failed(result) {
		t.Fatalf("located type_text result=%s err=%v", result, err)
	}
	if _, err := c.call(t.Context(), "click", json.RawMessage(`{"pid":42,"window_id":9,"role":"AXButton","name":"Delete"}`)); err == nil || !strings.Contains(err.Error(), "COMPUTER_TARGET_NOT_FOUND") {
		t.Fatalf("partial label err=%v, want not found", err)
	}
	if _, err := c.call(t.Context(), "click", json.RawMessage(`{"pid":42,"window_id":9,"role":"AXButton","name":"Send"}`)); err == nil || !strings.Contains(err.Error(), "COMPUTER_TARGET_AMBIGUOUS") {
		t.Fatalf("two matches err=%v, want ambiguous", err)
	}
	if _, err := c.call(t.Context(), "click", json.RawMessage(`{"pid":42,"window_id":9,"role":"AXButton","name":"Send","nth":1}`)); err != nil {
		t.Fatal(err)
	}
	// A read cut short could hide a second match.
	partial := cuaFixtureSession(t, "stale-truncated", filepath.Join(t.TempDir(), "partial.jsonl"))
	if _, err := partial.call(t.Context(), "type_text", json.RawMessage(`{"pid":42,"window_id":9,"role":"AXTextArea","name":"Comment","text":"hi"}`)); err == nil || !strings.Contains(err.Error(), "COMPUTER_TARGET_UNREADABLE") {
		t.Fatalf("truncated read err=%v, want unreadable", err)
	}
	if err := partial.drain(); err != nil {
		t.Fatal(err)
	}
	// launch_app's name is an app name, not a target.
	if located("launch_app", map[string]any{"name": "Notes"}) || !located("click", map[string]any{"role": "AXButton", "name": "Send"}) {
		t.Fatal("only input tools take a role and name target")
	}
	var sent []string
	for _, call := range fixtureCalls(t, marker) {
		if call.Name == "get_window_state" {
			continue
		}
		if call.Arguments["role"] != nil || call.Arguments["name"] != nil {
			t.Fatalf("%s still names role or name: %v", call.Name, call.Arguments)
		}
		sent = append(sent, call.Name+" "+fmt.Sprint(call.Arguments["element_token"]))
	}
	if want := []string{"click s1:15", "click s1:15", "type_text s2:3", "click s2:6"}; !slices.Equal(sent, want) {
		t.Fatalf("sent=%v, want %v", sent, want)
	}
	if err := c.drain(); err != nil {
		t.Fatal(err)
	}
}

func TestLocalToolCuaMacMenuBarClickSaysTheMenuHoldsInput(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("menu bar items are macOS only")
	}
	c := cuaFixtureSession(t, "menubar", filepath.Join(t.TempDir(), "calls.jsonl"))
	result, err := c.call(t.Context(), "click", json.RawMessage(`{"pid":42,"window_id":9,"element_token":"s1:15"}`))
	if err != nil || !strings.Contains(string(result), "opened a menu bar menu") {
		t.Fatalf("result=%s err=%v", result, err)
	}
	if err := c.drain(); err != nil {
		t.Fatal(err)
	}
}

func TestLocalToolCuaMacTextAreaPressSaysToTypeInstead(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("AX press errors are macOS only")
	}
	c := cuaFixtureSession(t, "textarea", filepath.Join(t.TempDir(), "calls.jsonl"))
	result, err := c.call(t.Context(), "click", json.RawMessage(`{"pid":42,"window_id":9,"element_token":"s1:1"}`))
	if err != nil || !strings.Contains(string(result), "send type_text with only pid") {
		t.Fatalf("result=%s err=%v", result, err)
	}
	if err := c.drain(); err != nil {
		t.Fatal(err)
	}
}

func TestLocalToolCuaMacMenuItemNotFoundSaysToSendItsShortcut(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("menu items are macOS only")
	}
	c := cuaFixtureSession(t, "menutitle", filepath.Join(t.TempDir(), "calls.jsonl"))
	result, err := c.call(t.Context(), "click", json.RawMessage(`{"pid":42,"window_id":9,"element_token":"s1:4"}`))
	if err != nil || !strings.Contains(string(result), "Send the item's keyboard shortcut instead") {
		t.Fatalf("result=%s err=%v", result, err)
	}
	if err := c.drain(); err != nil {
		t.Fatal(err)
	}
}

func TestLocalToolCuaMacRunActionsReadsAfterItsSteps(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("the read option is macOS only")
	}
	windowViewDelay, inputSettle = 0, 0
	t.Cleanup(func() { windowViewDelay, inputSettle = 100*time.Millisecond, 300*time.Millisecond })
	marker := filepath.Join(t.TempDir(), "calls.jsonl")
	c := cuaFixtureSession(t, "window-view", marker)
	result, err := c.call(t.Context(), "run_actions", json.RawMessage(`{"actions":[{"tool":"scroll","pid":42,"window_id":7,"direction":"down"}],"read":{"pid":42,"window_id":7,"since":"latest"}}`))
	if err != nil || !strings.Contains(string(result), "AXButton Save") {
		t.Fatalf("result=%s err=%v", result, err)
	}
	calls := fixtureCalls(t, marker)
	if last := calls[len(calls)-1]; calls[0].Name != "scroll" || last.Name != "get_window_state" || last.Arguments["window_id"] != float64(7) {
		t.Fatalf("driver calls=%v", calls)
	}
	if err := c.drain(); err != nil {
		t.Fatal(err)
	}
}

func TestLocalToolCuaMacInputStopsWhenTheUserTakesOver(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("key focus routing is macOS only")
	}
	windowViewDelay = 0
	t.Cleanup(func() { windowViewDelay = 100 * time.Millisecond })
	// After the Computer fronted app 42, the user brought app 99 forward.
	marker := filepath.Join(t.TempDir(), "calls.jsonl")
	c := cuaFixtureSession(t, "window-view", marker)
	c.leased = 42
	stubFront(t, 99)
	_, err := c.call(t.Context(), "press_key", json.RawMessage(`{"pid":42,"key":"a"}`))
	if err == nil || !strings.Contains(err.Error(), "COMPUTER_USER_TOOK_OVER") || len(fixtureCalls(t, marker)) != 0 {
		t.Fatalf("err=%v calls=%v", err, fixtureCalls(t, marker))
	}
	if err := c.drain(); err != nil {
		t.Fatal(err)
	}
	// Text Cua cannot insert through accessibility is pasted into the front
	// app with one cmd+v, unless another app has come to the front.
	// Checks: focusing the app, the accessibility attempt, then the paste.
	var pasted []string
	original := setClipboard
	restored := 0
	var cancelCall context.CancelFunc
	setClipboard = func(_ context.Context, text string) (func(), error) {
		pasted = append(pasted, text)
		if cancelCall != nil {
			cancelCall()
		}
		return func() { restored++ }, nil
	}
	pasteSettle = 0
	t.Cleanup(func() { setClipboard, pasteSettle = original, 200*time.Millisecond })
	for _, test := range []struct {
		fronts []int
		sent   bool
	}{{[]int{42, 42, 42}, true}, {[]int{42, 42, 99}, false}} {
		pasted = nil
		marker = filepath.Join(t.TempDir(), "calls.jsonl")
		c = cuaFixtureSession(t, "window-view-axrefused", marker)
		stubFront(t, test.fronts...)
		result, err := c.call(t.Context(), "type_text", json.RawMessage(`{"pid":42,"text":"0123456789abcdef0123456789abcdefXYZ"}`))
		var keys []string
		for _, call := range fixtureCalls(t, marker) {
			if call.Arguments["scope"] == "desktop" {
				keys = append(keys, fmt.Sprint(call.Name, call.Arguments["keys"]))
			}
		}
		if test.sent && (err != nil || !strings.Contains(string(result), "Pasted 35 characters") || !slices.Equal(pasted, []string{"0123456789abcdef0123456789abcdefXYZ"}) || !slices.Equal(keys, []string{"hotkey[cmd v]"}) || restored != 1) {
			t.Fatalf("result=%s err=%v pasted=%v keys=%v restored=%d", result, err, pasted, keys, restored)
		}
		if !test.sent && (err == nil || !strings.Contains(err.Error(), "COMPUTER_USER_TOOK_OVER") || pasted != nil || keys != nil) {
			t.Fatalf("err=%v pasted=%v keys=%v", err, pasted, keys)
		}
		if err := c.drain(); err != nil {
			t.Fatal(err)
		}
	}
	// A call cancelled after the text went onto the pasteboard finishes its
	// paste before it puts the earlier items back, so a late cmd+v never
	// pastes them.
	restored = 0
	marker = filepath.Join(t.TempDir(), "calls.jsonl")
	c = cuaFixtureSession(t, "window-view-axrefused", marker)
	stubFront(t, 42, 42, 42)
	ctx, cancel := context.WithCancel(t.Context())
	cancelCall = cancel
	if result, err := c.call(ctx, "type_text", json.RawMessage(`{"pid":42,"text":"secret"}`)); err != nil || !strings.Contains(string(result), "Pasted 6 characters") || restored != 1 {
		t.Fatalf("result=%s err=%v restored=%d", result, err, restored)
	}
	cancelCall = nil
	_ = c.drain()
	// A bring_to_front that did not verify leases nothing, so the user's app
	// never becomes the Computer's own.
	c = cuaFixtureSession(t, "unfocused", filepath.Join(t.TempDir(), "calls.jsonl"))
	stubFront(t, 99)
	if _, err := c.call(t.Context(), "bring_to_front", json.RawMessage(`{"pid":42,"window_id":9}`)); err != nil || c.leased != 0 {
		t.Fatalf("err=%v leased=%d", err, c.leased)
	}
	if err := c.drain(); err != nil {
		t.Fatal(err)
	}
}

func cuaFixtureSession(t *testing.T, mode, marker string) *cuaSession {
	t.Helper()
	client := fixtureClient(t, mode, marker)
	journal, err := openJournal(filepath.Join(t.TempDir(), "action.json"))
	if err != nil {
		t.Fatal(err)
	}
	m := &Manager{options: Options{StateDirectory: t.TempDir()}, journal: journal, operations: map[*operation]bool{}}
	op := &operation{manager: m, spec: provider.OperationSpec{AgentID: "owned-agent"}, identity: mcpproxy.OperationIdentity{OperationID: "owned-operation"}}
	stubFront(t, 42)
	return &cuaSession{op: op, client: client, label: "owned-session", desktopCheck: func() error { return nil }}
}

func TestCuaLockedDesktopRejectsInputBeforeDriver(t *testing.T) {
	marker := filepath.Join(t.TempDir(), "calls.jsonl")
	c := cuaFixtureSession(t, "window-view", marker)
	locked := errors.New("desktop locked")
	c.desktopCheck = func() error { return locked }
	_, err := c.call(t.Context(), "scroll", json.RawMessage(`{"pid":42,"window_id":7,"direction":"down"}`))
	if !errors.Is(err, locked) {
		t.Fatalf("error = %v, want locked desktop", err)
	}
	if calls := fixtureCalls(t, marker); len(calls) != 0 {
		t.Fatalf("driver received input on locked desktop: %v", calls)
	}
	if err := c.drain(); err != nil {
		t.Fatal(err)
	}
}

func TestLocalToolCuaMacReadsTextUnlessPixelsAreNeeded(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("macOS reads text by default")
	}
	windowRetryDelay = 0
	t.Cleanup(func() { windowRetryDelay = 400 * time.Millisecond })
	for _, test := range []struct {
		name, mode, args string
		screenshots      []any
	}{
		{"text by default", "cua-delta", `{"pid":42,"window_id":7}`, []any{false}},
		{"explicit pixels kept", "cua-delta", `{"pid":42,"window_id":7,"include_screenshot":true}`, []any{true}},
		// A degraded text read is tried once more with a longer walk budget
		// before the window is read as pixels.
		{"unreadable tree read with pixels", "cua-delta-degraded", `{"pid":42,"window_id":7}`, []any{false, false, nil}},
	} {
		t.Run(test.name, func(t *testing.T) {
			marker := filepath.Join(t.TempDir(), "calls.jsonl")
			client := fixtureClient(t, test.mode, marker)
			journal, err := openJournal(filepath.Join(t.TempDir(), "action.json"))
			if err != nil {
				t.Fatal(err)
			}
			m := &Manager{journal: journal, operations: map[*operation]bool{}}
			op := &operation{manager: m, spec: provider.OperationSpec{AgentID: "owned-agent"}, identity: mcpproxy.OperationIdentity{OperationID: "owned-operation"}}
			c := &cuaSession{op: op, client: client, label: "owned-session", desktopCheck: func() error { return nil }}
			result, err := c.call(t.Context(), "get_window_state", json.RawMessage(test.args))
			if err != nil {
				t.Fatal(err)
			}
			var reply cuaResult
			if json.Unmarshal(result, &reply) != nil || reply.IsError || reply.Structured.Degraded != "" {
				t.Fatalf("unexpected result: %s", result)
			}
			data, err := os.ReadFile(marker)
			if err != nil {
				t.Fatal(err)
			}
			var screenshots []any
			for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
				var request struct{ Arguments map[string]any }
				if json.Unmarshal([]byte(line), &request) != nil {
					t.Fatal("invalid fixture request")
				}
				screenshots = append(screenshots, request.Arguments["include_screenshot"])
			}
			if !slices.Equal(screenshots, test.screenshots) {
				t.Fatalf("include_screenshot per call = %v, want %v", screenshots, test.screenshots)
			}
			if err := c.drain(); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestLocalToolCuaDeltaCountFailureReadsFullWindowOnlyOnce(t *testing.T) {
	for _, test := range []struct {
		name, mode, tool, args string
		calls                  int
		failed                 bool
	}{
		{"delta fallback", "cua-delta", "get_window_state", `{"pid":42,"window_id":7,"since":"latest","query":"owned"}`, 2, false},
		{"full failure retained", "cua-delta-always", "get_window_state", `{"pid":42,"window_id":7,"since":"latest","query":"owned"}`, 2, true},
		{"other error untouched", "cua-delta-other", "get_window_state", `{"pid":42,"window_id":7,"since":"latest","query":"owned"}`, 1, true},
		{"input never replayed", "cua-delta", "type_text", `{"pid":42,"window_id":7,"element_token":"s00000001:2","text":"x","since":"latest","query":"owned"}`, 1, true},
		{"full snapshot never retried", "cua-delta-always", "get_window_state", `{"pid":42,"window_id":7,"query":"owned"}`, 1, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			marker := filepath.Join(t.TempDir(), "calls.jsonl")
			client := fixtureClient(t, test.mode, marker)
			journal, err := openJournal(filepath.Join(t.TempDir(), "action.json"))
			if err != nil {
				t.Fatal(err)
			}
			m := &Manager{journal: journal, operations: map[*operation]bool{}}
			op := &operation{manager: m, spec: provider.OperationSpec{AgentID: "owned-agent"}, identity: mcpproxy.OperationIdentity{OperationID: "owned-operation"}}
			c := &cuaSession{op: op, client: client, label: "owned-session", desktopCheck: func() error { return nil }}
			result, err := c.call(t.Context(), test.tool, json.RawMessage(test.args))
			if err != nil {
				t.Fatal(err)
			}
			var reply cuaResult
			if json.Unmarshal(result, &reply) != nil || reply.IsError != test.failed {
				t.Fatalf("unexpected result: %s", result)
			}
			data, err := os.ReadFile(marker)
			if err != nil {
				t.Fatal(err)
			}
			lines := strings.Split(strings.TrimSpace(string(data)), "\n")
			if len(lines) != test.calls {
				t.Fatalf("calls=%d want=%d", len(lines), test.calls)
			}
			for i, line := range lines {
				var request struct {
					Name      string
					Arguments map[string]any
				}
				if json.Unmarshal([]byte(line), &request) != nil {
					t.Fatal("invalid fixture request")
				}
				a := request.Arguments
				if request.Name != test.tool || a["session"] != "owned-session" || a["pid"] != float64(42) || a["window_id"] != float64(7) {
					t.Fatalf("changed read scope: %s", line)
				}
				if a["query"] != "owned" {
					t.Fatalf("changed read query: %s", line)
				}
				if i == 1 && a["since"] != nil {
					t.Fatal("fallback retained broken delta baseline")
				}
			}
			if err := c.drain(); err != nil {
				t.Fatal(err)
			}
			if journal.blocked() {
				t.Fatal("completed read retained action fence")
			}
		})
	}
}
