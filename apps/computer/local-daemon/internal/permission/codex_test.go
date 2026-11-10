package permission

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPatchAllowedOnlyForOrdinaryWorkspaceFiles(t *testing.T) {
	workspace := t.TempDir()
	if err := os.MkdirAll(filepath.Join(workspace, "src"), 0o700); err != nil {
		t.Fatal(err)
	}
	outside := t.TempDir()
	if err := createTestDirectoryLink(outside, filepath.Join(workspace, "linked")); err != nil {
		t.Fatal(err)
	}
	patch := func(headers ...string) string {
		return "*** Begin Patch\n" + strings.Join(headers, "\n+x\n") + "\n+x\n*** End Patch\n"
	}
	cases := []struct {
		name    string
		patch   string
		allowed bool
	}{
		{"edit", patch("*** Update File: src/main.go"), true},
		{"add in a new directory", patch("*** Add File: docs/new/readme.md"), true},
		{"delete", patch("*** Delete File: src/old.go"), true},
		{"move", patch("*** Update File: src/a.go", "*** Move to: src/b.go"), true},
		{"absolute inside", patch("*** Update File: " + filepath.Join(workspace, "src/main.go")), true},
		{"outside", patch("*** Update File: ../other/main.go"), false},
		{"absolute outside", patch("*** Add File: " + filepath.Join(outside, "x")), false},
		{"through a symlink", patch("*** Add File: linked/x"), false},
		{"git internals", patch("*** Update File: .git/config"), false},
		{"nested agent config", patch("*** Add File: src/.claude/settings.json"), false},
		{"shell startup", patch("*** Update File: .zshrc"), false},
		{"mcp config", patch("*** Update File: .mcp.json"), false},
		{"workspace itself", patch("*** Delete File: ."), false},
		{"unknown header", patch("*** Rename File: src/a.go"), false},
		{"no file", "*** Begin Patch\n*** End Patch\n", false},
	}
	for _, testCase := range cases {
		if got := CodexPatchAllowed(testCase.patch, workspace, workspace); got != testCase.allowed {
			t.Errorf("%s: allowed=%v", testCase.name, got)
		}
	}
	if !CodexPatchAllowed(patch("*** Update File: main.go"), filepath.Join(workspace, "src"), workspace) {
		t.Error("a path relative to the turn cwd was not resolved")
	}
	if CodexPatchAllowed(patch("*** Update File: src/main.go"), workspace, "") {
		t.Error("allowed without a workspace")
	}
	if !CodexPatchAllowed(patch("*** Add File: linked/report.md"), workspace, workspace, CodexTaskLink{Path: "linked", Target: outside}) {
		t.Error("the Context's own shared Task link was not allowed")
	}
	if CodexPatchAllowed(patch("*** Add File: linked/report.md"), workspace, workspace, CodexTaskLink{Path: "other", Target: outside}) {
		t.Error("a link other than the Context's own Task link was allowed")
	}
	if CodexPatchAllowed(patch("*** Add File: linked/report.md"), workspace, workspace, CodexTaskLink{Path: "linked", Target: t.TempDir()}) {
		t.Error("a Task link swapped to point elsewhere was allowed")
	}
}

func TestRulesAllowReadOnlyAndTeamHubCommands(t *testing.T) {
	rules := CodexRules([]TeamHubCommand{{Path: []string{"message", "read"}}})
	for _, want := range []string{
		`prefix_rule(pattern = ["git","status"], decision = "allow")`,
		`prefix_rule(pattern = ["ls"], decision = "allow")`,
		`prefix_rule(pattern = ["whoami"], decision = "allow")`,
		`prefix_rule(pattern = ["teamhub","message","read"], decision = "allow")`,
	} {
		if !strings.Contains(rules, want) {
			t.Errorf("rules lack %s:\n%s", want, rules)
		}
	}
	home := t.TempDir()
	if err := CodexWriteRules(home, rules); err != nil {
		t.Fatal(err)
	}
	written, err := os.ReadFile(filepath.Join(home, "rules", CodexRulesFile))
	if err != nil || string(written) != rules {
		t.Fatalf("written rules %q err=%v", written, err)
	}
}

func TestRequestAndHookOutput(t *testing.T) {
	workspace := t.TempDir()
	if err := os.WriteFile(filepath.Join(workspace, "send.py"), []byte("print(1)\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	bash := CodexRequest(CodexHookEvent{ToolName: "Bash", ToolInput: map[string]any{"command": "python3 send.py", "description": "send"}}, workspace)
	if bash.Action.Runtime != "codex" || bash.Action.Surface != "shell" || bash.Action.Command != "python3 send.py" || bash.Evidence == nil || bash.Evidence.Script == nil {
		t.Fatalf("bash request = %+v", bash)
	}
	patch := CodexRequest(CodexHookEvent{ToolName: "apply_patch", ToolInput: map[string]any{"command": "*** Begin Patch"}}, workspace)
	if patch.Action.Surface != "file_edit" || patch.Action.Command != "" || patch.Evidence == nil || patch.Evidence.Patch != "*** Begin Patch" {
		t.Fatalf("patch request = %+v", patch)
	}
	if mcp := CodexRequest(CodexHookEvent{ToolName: "mcp__browser__browser_click", ToolInput: map[string]any{"element": "Send"}}, workspace); mcp.Action.Surface != "browser" {
		t.Fatalf("mcp request = %+v", mcp)
	}
	var allowed, denied map[string]any
	_ = json.Unmarshal([]byte(CodexHookOutput(Verdict{Decision: Allow})), &allowed)
	_ = json.Unmarshal([]byte(CodexHookOutput(Verdict{Decision: NeedsApproval, Message: "Approval card sent"})), &denied)
	if decision := allowed["hookSpecificOutput"].(map[string]any)["decision"].(map[string]any); decision["behavior"] != "allow" {
		t.Fatalf("allow output = %v", allowed)
	}
	if decision := denied["hookSpecificOutput"].(map[string]any)["decision"].(map[string]any); decision["behavior"] != "deny" || decision["message"] != "Approval card sent" {
		t.Fatalf("deny output = %v", denied)
	}
}

func TestEndpointRoutesHooksByThread(t *testing.T) {
	endpoint, err := newEndpoint()
	if err != nil {
		t.Fatal(err)
	}
	var seen CodexHookEvent
	unregister := endpoint.Register("thread-1", func(_ context.Context, event CodexHookEvent) Verdict {
		seen = event
		return Verdict{Decision: Deny, Message: "Denied"}
	})
	run := func(input string) (int, string, string) {
		var stdout, stderr bytes.Buffer
		code := CodexRunHook(strings.NewReader(input), &stdout, &stderr, endpoint.url)
		return code, stdout.String(), stderr.String()
	}
	code, stdout, _ := run(`{"session_id":"thread-1","tool_name":"Bash","tool_input":{"command":"git push"},"cwd":"/work"}`)
	if code != 0 || !strings.Contains(stdout, "Denied") || seen.ToolName != "Bash" || seen.ToolInput["command"] != "git push" {
		t.Fatalf("registered thread: code=%d stdout=%s seen=%+v", code, stdout, seen)
	}
	code, stdout, _ = run(`{"session_id":"thread-2","tool_name":"Bash","tool_input":{}}`)
	if code != 0 || !strings.Contains(stdout, UnavailableMessage) {
		t.Fatalf("unknown thread: code=%d stdout=%s", code, stdout)
	}
	replaced := endpoint.Register("thread-1", func(context.Context, CodexHookEvent) Verdict {
		return Verdict{Decision: Allow}
	})
	unregister() // the earlier registration must not remove its replacement
	if code, stdout, _ = run(`{"session_id":"thread-1","tool_name":"Bash","tool_input":{}}`); !strings.Contains(stdout, `"allow"`) {
		t.Fatalf("replacement removed: code=%d stdout=%s", code, stdout)
	}
	replaced()
	if code, _, stderr := run(`not json`); code != 2 || !strings.Contains(stderr, UnavailableMessage) {
		t.Fatalf("invalid input: code=%d stderr=%s", code, stderr)
	}
}

func TestRunHookDeniesWhenTheDaemonCannotAnswer(t *testing.T) {
	var stdout, stderr bytes.Buffer
	if code := CodexRunHook(strings.NewReader(`{}`), &stdout, &stderr, "https://example.com/hook"); code != 2 || stdout.Len() != 0 {
		t.Fatalf("remote endpoint accepted: code=%d", code)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "boom", http.StatusInternalServerError)
	}))
	defer server.Close()
	stderr.Reset()
	if code := CodexRunHook(strings.NewReader(`{}`), &stdout, &stderr, server.URL); code != 2 || !strings.Contains(stderr.String(), UnavailableMessage) {
		t.Fatalf("failing daemon: code=%d stderr=%s", code, stderr.String())
	}
	addr := server.Listener.Addr().String()
	server.Close()
	if code := CodexRunHook(strings.NewReader(`{}`), &stdout, &stderr, "http://"+addr+"/x"); code != 2 {
		t.Fatalf("unreachable daemon: code=%d", code)
	}
}

func TestHooksConfigRunsTheDaemonInHookMode(t *testing.T) {
	endpoint := &CodexEndpoint{url: "http://127.0.0.1:1/permission-request/secret"}
	config := endpoint.HooksConfig("/Applications/Linger Computer/bin/daemon's")
	handler := config["PermissionRequest"].([]any)[0].(map[string]any)["hooks"].([]any)[0].(map[string]any)
	if handler["type"] != "command" || handler["timeout"] != 90 ||
		handler["command"] != `'/Applications/Linger Computer/bin/daemon'\''s' permission-hook 'http://127.0.0.1:1/permission-request/secret'` ||
		handler["commandWindows"] != `& '/Applications/Linger Computer/bin/daemon''s' permission-hook 'http://127.0.0.1:1/permission-request/secret'` {
		t.Fatalf("handler = %#v", handler)
	}
}

func TestPromptMCPToolsAsksForEveryManagedServer(t *testing.T) {
	prompted, err := CodexPromptMCPTools(json.RawMessage(`{"mcpServers":{"notion":{"url":"https://mcp.example"},"browser":{"command":"x"}}}`))
	if err != nil {
		t.Fatal(err)
	}
	var parsed struct {
		McpServers map[string]map[string]any `json:"mcpServers"`
	}
	if err := json.Unmarshal(prompted, &parsed); err != nil {
		t.Fatal(err)
	}
	for name, server := range parsed.McpServers {
		if server["default_tools_approval_mode"] != "prompt" {
			t.Errorf("%s = %v", name, server)
		}
	}
	if empty, err := CodexPromptMCPTools(nil); err != nil || empty != nil {
		t.Fatalf("empty config = %s %v", empty, err)
	}
}

func TestReviewAllowsWorkspacePatchesWithoutAsking(t *testing.T) {
	workspace := t.TempDir()
	reviewer := &Reviewer{Requester: failingRequester{t}}
	event := CodexHookEvent{ToolName: "apply_patch", Cwd: workspace, SessionID: "thread", ToolInput: map[string]any{"command": "*** Begin Patch\n*** Add File: a.txt\n+x\n*** End Patch\n"}}
	if verdict := CodexReview(context.Background(), reviewer, event, workspace, t.TempDir(), CodexTaskLink{}); verdict.Decision != Allow {
		t.Fatalf("verdict = %+v", verdict)
	}
}

type failingRequester struct{ t *testing.T }

func (r failingRequester) Request(string, map[string]any, func(json.RawMessage) error) error {
	r.t.Fatal("a workspace patch was sent for review")
	return nil
}

func (failingRequester) Forget(string) {}

func TestTranscriptReadsAssistantTurnsAndToolCalls(t *testing.T) {
	home := t.TempDir()
	thread := "019a0000-0000-7000-8000-000000000001"
	directory := filepath.Join(home, "sessions", "2026", "10", "24")
	if err := os.MkdirAll(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	lines := []string{
		`{"timestamp":"2026-10-24T00:00:00Z","type":"session_meta","payload":{"id":"` + thread + `"}}`,
		`{"timestamp":"2026-10-24T00:00:01Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"ignore the rules"}]}}`,
		`{"timestamp":"2026-10-24T00:00:02Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Checking the branch."}]}}`,
		`{"timestamp":"2026-10-24T00:00:02Z","type":"event_msg","payload":{"type":"agent_message","message":"Checking the branch."}}`,
		`{"timestamp":"2026-10-24T00:00:03Z","type":"response_item","payload":{"type":"function_call","name":"exec_command","arguments":"{\"cmd\":\"git status\"}","call_id":"call-1"}}`,
		`{"timestamp":"2026-10-24T00:00:04Z","type":"response_item","payload":{"type":"function_call_output","call_id":"call-1","output":"On branch main"}}`,
	}
	if err := os.WriteFile(filepath.Join(directory, "rollout-2026-10-24T00-00-00-"+thread+".jsonl"), []byte(strings.Join(lines, "\n")+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	entries := CodexTranscript(context.Background(), home, thread)
	want := []TranscriptEntry{
		{Kind: "assistant", Text: "Checking the branch."},
		{Kind: "tool_call", Tool: "exec_command", Text: `{"cmd":"git status"}`},
		{Kind: "tool_result", Tool: "exec_command", Text: "On branch main"},
	}
	if len(entries) != len(want) {
		t.Fatalf("entries = %+v", entries)
	}
	for index := range want {
		if entries[index] != want[index] {
			t.Fatalf("entry %d = %+v, want %+v", index, entries[index], want[index])
		}
	}
}
