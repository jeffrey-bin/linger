package native

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

func claudeQuietLogger() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

func claudeSpec(spec RunSpec) RunSpec {
	if spec.ClaudePolicy == nil {
		spec.ClaudePolicy = &ClaudeToolPolicy{}
	}
	return spec
}

func claudeStart(t *testing.T, profile Profile, prompt string, spec RunSpec) *Run {
	t.Helper()
	backend, err := Open("claude", profile)
	if err != nil {
		t.Fatal(err)
	}
	run, err := backend.Start(t.Context(), prompt, claudeSpec(spec))
	if err != nil {
		t.Fatal(err)
	}
	return run
}

// claudeFinish drains a Run and returns its events and Outcome.
func claudeFinish(t *testing.T, run *Run, within time.Duration) ([]Event, Outcome) {
	t.Helper()
	deadline := time.After(within)
	var events []Event
	for {
		select {
		case event, ok := <-run.Events:
			if !ok {
				select {
				case outcome, ok := <-run.Outcome:
					if !ok {
						t.Fatal("Outcome channel closed without a value")
					}
					return events, outcome
				case <-deadline:
					t.Fatal("Outcome did not arrive")
				}
			}
			events = append(events, event)
		case <-deadline:
			t.Fatal("Run did not finish")
		}
	}
}

func claudeFramesProfile(t *testing.T, mode string, frames []string, extra map[string]string) Profile {
	t.Helper()
	env := map[string]string{"CLAUDE_FAKE_FRAMES": "[" + strings.Join(frames, ",") + "]"}
	for key, value := range extra {
		env[key] = value
	}
	return claudeFakeProfile(t, mode, env)
}

func TestClaudeTerminalContract(t *testing.T) {
	text := `{"type":"assistant","message":{"id":"a1","role":"assistant","content":[{"type":"text","text":"independent answer"}]}}`
	empty := `{"type":"result","subtype":"success","is_error":false,"terminal_reason":"completed","result":"","session_id":"s"}`
	for _, test := range []struct {
		name   string
		frames []string
		status string
		output string
		code   string
	}{
		{"terminal text wins", []string{text, `{"type":"result","subtype":"success","result":"terminal answer","terminal_reason":"completed"}`}, "completed", "terminal answer", ""},
		{"empty result", []string{empty}, "completed", "", ""},
		{"fallback", []string{text, empty}, "completed", "independent answer", ""},
		{"tool clears fallback", []string{text, `{"type":"assistant","message":{"id":"a2","content":[{"type":"tool_use","id":"t","name":"Read","input":{}}]}}`, empty}, "completed", "", ""},
		{"unknown block clears fallback", []string{text, `{"type":"assistant","message":{"id":"a2","content":[{"type":"mystery"}]}}`, empty}, "completed", "", ""},
		{"empty thinking keeps fallback", []string{text, `{"type":"assistant","message":{"id":"a2","content":[{"type":"thinking","text":""}]}}`, empty}, "completed", "independent answer", ""},
		{"no result", []string{text}, "failed", "", ""},
		{"error result", []string{`{"type":"result","is_error":true,"errors":["synthetic outage"],"terminal_reason":"completed"}`}, "failed", "", ""},
		{"prompt too long", []string{`{"type":"result","is_error":false,"terminal_reason":"prompt_too_long","result":"too big"}`}, "failed", "", "prompt_too_long"},
		{"child assistant ignored", []string{`{"type":"assistant","parent_tool_use_id":"p","message":{"id":"c","content":[{"type":"text","text":"child"}]}}`, empty}, "completed", "", ""},
		{"async launch", []string{`{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t","content":[{"type":"text","content":[{"status":"async_launched"}]}]}]}}`, empty}, "failed", "", ""},
	} {
		t.Run(test.name, func(t *testing.T) {
			run := claudeStart(t, claudeFramesProfile(t, "frames", test.frames, nil), "hello", RunSpec{})
			_, outcome := claudeFinish(t, run, 10*time.Second)
			if outcome.Status != test.status || outcome.Output != test.output || !outcome.ExitConfirmed || outcome.Diagnostics.Code != test.code {
				t.Fatalf("outcome = %+v", outcome)
			}
			if outcome.CompactionCount == nil {
				t.Fatal("CompactionCount is nil")
			}
			if wantContext := test.code == "prompt_too_long"; (outcome.FailureCode == "context_too_long") != wantContext {
				t.Fatalf("failure code = %q", outcome.FailureCode)
			}
		})
	}
}

func TestClaudeBurstDoesNotDeadlock(t *testing.T) {
	result := `{"type":"result","subtype":"success","result":"ready","terminal_reason":"completed"}`
	run := claudeStart(t, claudeFramesProfile(t, "burst", []string{result}, nil), strings.Repeat("p", 640<<10), RunSpec{})
	events, outcome := claudeFinish(t, run, 20*time.Second)
	logs := 0
	for _, event := range events {
		if event.Kind == EventLog {
			logs++
		}
	}
	if logs != 150 || outcome.Status != statusCompleted || outcome.Output != "ready" {
		t.Fatalf("logs=%d outcome=%+v", logs, outcome)
	}
}

func TestClaudeEarlyExitAndRejectedInit(t *testing.T) {
	run := claudeStart(t, claudeFakeProfile(t, "early-exit", nil), "hello", RunSpec{})
	_, outcome := claudeFinish(t, run, 10*time.Second)
	if outcome.Status != statusFailed || !strings.Contains(outcome.Error, claudeSubmitFailed) || strings.Contains(outcome.Error, "fake-secret-value") {
		t.Fatalf("early exit = %+v", outcome)
	}
	run = claudeStart(t, claudeFakeProfile(t, "reject-init", nil), "hello", RunSpec{})
	_, outcome = claudeFinish(t, run, 10*time.Second)
	if outcome.Status != statusFailed || !outcome.ExitConfirmed {
		t.Fatalf("rejected init = %+v", outcome)
	}
}

// The frame sequences below are what Claude Code 2.1.309 printed.
func TestClaudeFailureCodeComesFromTheAssistantAPIError(t *testing.T) {
	const init = `{"type":"system","subtype":"init","session_id":"87654321-4321-4321-8321-210987654321"}`
	apiError := func(code, text string) string {
		return `{"type":"assistant","error":"` + code + `","is_api_error_message":true,"session_id":"87654321-4321-4321-8321-210987654321","message":{"id":"m","model":"<synthetic>","role":"assistant","content":[{"type":"text","text":"` + text + `"}]}}`
	}
	failed := func(text string) string {
		return `{"type":"result","subtype":"success","is_error":true,"terminal_reason":"api_error","api_error_status":null,"num_turns":1,"result":"` + text + `","session_id":"87654321-4321-4321-8321-210987654321"}`
	}
	for _, test := range []struct {
		name, code, want string
	}{
		{"not logged in", "authentication_failed", "authentication_required"},
		{"model not found", "model_not_found", "model_unavailable"},
		{"rate limit", "rate_limit", "rate_limited"},
		{"billing", "billing_error", "rate_limited"},
		{"server error", "server_error", "model_service_error"},
		{"unmapped", "unknown", ""},
	} {
		t.Run(test.name, func(t *testing.T) {
			frames := []string{init, apiError(test.code, "detail"), failed("detail")}
			_, outcome := claudeFinish(t, claudeStart(t, claudeFramesProfile(t, "frames", frames, nil), "hello", RunSpec{}), 10*time.Second)
			if outcome.Status != statusFailed || outcome.FailureCode != test.want || outcome.ResumeRefused {
				t.Fatalf("outcome = %+v", outcome)
			}
		})
	}
	// An API error the turn recovered from does not label a later success.
	frames := []string{init, apiError("rate_limit", "retrying"), `{"type":"result","subtype":"success","is_error":false,"terminal_reason":"completed","result":"ok","session_id":"87654321-4321-4321-8321-210987654321"}`}
	_, outcome := claudeFinish(t, claudeStart(t, claudeFramesProfile(t, "frames", frames, nil), "hello", RunSpec{}), 10*time.Second)
	if outcome.Status != statusCompleted || outcome.FailureCode != "" {
		t.Fatalf("recovered outcome = %+v", outcome)
	}
}

func TestClaudeResumeRefusalIsStructural(t *testing.T) {
	const id = "12345678-1234-4234-8234-123456789012"
	missing := `{"type":"result","subtype":"error_during_execution","is_error":true,"num_turns":0,"stop_reason":null,"session_id":"` + id + `","errors":["No conversation found with session ID: ` + id + `"]}`
	_, outcome := claudeFinish(t, claudeStart(t, claudeFramesProfile(t, "frames", []string{missing}, nil), "hello", RunSpec{ResumeID: id}), 10*time.Second)
	if outcome.Status != statusFailed || !outcome.ResumeRefused || outcome.SessionID != "" || outcome.FailureCode != "session_not_found" {
		t.Fatalf("missing conversation = %+v", outcome)
	}
	// Once init confirmed the resumed session, a later failure is ordinary
	// whatever its text says.
	confirmed := []string{`{"type":"system","subtype":"init","session_id":"` + id + `"}`, missing}
	_, outcome = claudeFinish(t, claudeStart(t, claudeFramesProfile(t, "frames", confirmed, nil), "hello", RunSpec{ResumeID: id}), 10*time.Second)
	if outcome.Status != statusFailed || outcome.ResumeRefused || outcome.SessionID != id || outcome.FailureCode != "" {
		t.Fatalf("confirmed resume = %+v", outcome)
	}
	// Without a requested resume there is nothing to refuse.
	_, outcome = claudeFinish(t, claudeStart(t, claudeFramesProfile(t, "frames", []string{missing}, nil), "hello", RunSpec{}), 10*time.Second)
	if outcome.Status != statusFailed || outcome.ResumeRefused || outcome.FailureCode != "" {
		t.Fatalf("fresh run = %+v", outcome)
	}
}

func TestClaudeStrictResumeRejectsDifferentSession(t *testing.T) {
	const x = "12345678-1234-4234-8234-123456789012"
	result := `{"type":"result","subtype":"success","result":"ok","terminal_reason":"completed","session_id":"87654321-4321-4321-8321-210987654321"}`
	run := claudeStart(t, claudeFramesProfile(t, "frames", []string{result}, nil), "hello", RunSpec{ResumeID: x, ResumeRequired: true})
	_, outcome := claudeFinish(t, run, 10*time.Second)
	if outcome.Status != statusFailed || !outcome.ResumeRefused || outcome.SessionID != "" || outcome.Output != "" || outcome.FailureCode != "session_not_found" {
		t.Fatalf("outcome = %+v", outcome)
	}
}

func TestClaudeUsageTotals(t *testing.T) {
	frames := []string{
		`{"type":"assistant","message":{"id":"a","model":"fixture","content":[{"type":"text","text":"x"}],"usage":{"input_tokens":100}}}`,
		`{"type":"result","result":"ok","terminal_reason":"completed","modelUsage":{"fixture":{"inputTokens":21,"outputTokens":7,"cacheReadInputTokens":13,"cacheCreationInputTokens":5},"auxiliary":{"inputTokens":3},"":{"inputTokens":9},"zero":{}}}`,
	}
	run := claudeStart(t, claudeFramesProfile(t, "frames", frames, nil), "hello", RunSpec{})
	_, outcome := claudeFinish(t, run, 10*time.Second)
	if outcome.Usage["fixture"] != (TokenCount{21, 7, 13, 5, 0}) || outcome.Usage["auxiliary"].Input != 3 || len(outcome.Usage) != 2 || outcome.LastUsage["fixture"].Input != 100 {
		t.Fatalf("usage = %+v last = %+v", outcome.Usage, outcome.LastUsage)
	}
	if got := claudeResultTotals(claudeFrame{Usage: &claudeTokenTally{InputTokens: 4}}, "spec-model"); got["spec-model"].Input != 4 {
		t.Fatalf("top-level usage = %+v", got)
	}
}

func TestClaudeUnsupportedEffortNeverSpawns(t *testing.T) {
	dir := t.TempDir()
	backend, _ := Open("claude", claudeFakeProfile(t, "frames", map[string]string{"CLAUDE_FAKE_DIR": dir}))
	_, err := backend.Start(t.Context(), "hello", claudeSpec(RunSpec{Effort: "ultra"}))
	if err == nil || !strings.Contains(err.Error(), "unsupported") {
		t.Fatalf("err = %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "argv")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("the fake was spawned")
	}
	if _, err := backend.Start(t.Context(), "hello", RunSpec{}); err == nil || !strings.Contains(err.Error(), "policy is required") {
		t.Fatalf("missing policy err = %v", err)
	}
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := backend.Start(cancelled, "hello", claudeSpec(RunSpec{})); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled err = %v", err)
	}
	missing, _ := Open("claude", Profile{Program: filepath.Join(dir, "missing-claude")})
	if _, err := missing.Start(t.Context(), "hello", claudeSpec(RunSpec{})); err == nil || !strings.HasPrefix(err.Error(), "resolve Claude executable:") {
		t.Fatalf("missing program err = %v", err)
	}
	if _, err := backend.Start(t.Context(), "hello", claudeSpec(RunSpec{AssignSessionID: "not-a-uuid"})); err == nil || !strings.Contains(err.Error(), "not a UUID") {
		t.Fatalf("identity err = %v", err)
	}
}

func claudeFlagValue(argv []string, flag string) []string {
	var values []string
	for i, arg := range argv {
		if arg == flag && i+1 < len(argv) {
			values = append(values, argv[i+1])
		}
	}
	return values
}

func TestClaudeArgv(t *testing.T) {
	logger := claudeQuietLogger()
	_, none := claudeBuildArgv(logger, claudeSpec(RunSpec{Effort: "none"}))
	if !slices.Contains(none, "disabled") || slices.Contains(none, "--effort") {
		t.Fatalf("none argv = %v", none)
	}
	_, low := claudeBuildArgv(logger, claudeSpec(RunSpec{Effort: "low"}))
	if v := claudeFlagValue(low, "--effort"); len(v) != 1 || v[0] != "low" || !slices.Contains(claudeFlagValue(low, "--thinking"), "adaptive") {
		t.Fatalf("low argv = %v", low)
	}
	for _, overrides := range [][]string{
		{"--settings", "x", "--managed-settings", "y", "--dangerously-skip-permissions"},
		{"--settings=x", "--managed-settings='y'", "--dangerously-skip-permissions", "--model", "kept"},
	} {
		for _, spec := range []RunSpec{{ComputerArgs: overrides}, {AgentArgs: overrides}} {
			_, argv := claudeBuildArgv(logger, claudeSpec(spec))
			settings, managed := claudeFlagValue(argv, "--settings"), claudeFlagValue(argv, "--managed-settings")
			if len(settings) != 1 || len(managed) != 1 || slices.Contains(argv, "--dangerously-skip-permissions") || slices.Contains(argv, "x") || slices.Contains(argv, "y") {
				t.Fatalf("filtered argv = %v", argv)
			}
			for _, arg := range argv {
				if strings.HasPrefix(arg, "--settings=") || strings.HasPrefix(arg, "--managed-settings=") {
					t.Fatalf("inline override survived: %v", argv)
				}
			}
		}
	}
	policy := &ClaudeToolPolicy{AllowRules: []string{"Bash(teamhub message read:*)"}, MCPToolNames: []string{"mcp__a__b", "plain", "mcp__a__b"}}
	_, argv := claudeBuildArgv(logger, RunSpec{ClaudePolicy: policy, Model: "m", AssignSessionID: "id"})
	joined := strings.Join(argv, " ")
	for _, want := range []string{"--permission-mode acceptEdits", "--permission-prompt-tool stdio", "--strict-mcp-config", "--setting-sources project,user", "--disallowedTools AskUserQuestion", "--replay-user-messages", "--model m", "--session-id id"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("argv lacks %q: %s", want, joined)
		}
	}
	if strings.Contains(joined, "bypassPermissions") || strings.Contains(joined, "--allowedTools") {
		t.Fatalf("argv widens permissions: %s", joined)
	}
	if tools := claudeFlagValue(argv, "--tools"); len(tools) != 1 || tools[0] != "Read,Glob,Grep,Write,Edit,Bash,TodoWrite,Skill,Agent,WebSearch,WebFetch,ToolSearch" {
		t.Fatalf("tools = %v", tools)
	}
	var managed, settings map[string]any
	_ = json.Unmarshal([]byte(claudeFlagValue(argv, "--managed-settings")[0]), &managed)
	_ = json.Unmarshal([]byte(claudeFlagValue(argv, "--settings")[0]), &settings)
	wantManaged := `{"allowManagedPermissionRulesOnly":true,"permissions":{"allow":["Bash(teamhub message read:*)"],"disableBypassPermissionsMode":"disable"}}`
	if encoded, _ := json.Marshal(managed); string(encoded) != wantManaged {
		t.Fatalf("managed = %s", encoded)
	}
	wantSettings := `{"autoCompactWindow":200000,"autoMemoryEnabled":false,"cleanupPeriodDays":36500,"disableAgentView":true,"disableBundledSkills":true,"disableRemoteControl":true,"env":{"CLAUDE_CODE_DISABLE_BACKGROUND_TASKS":"1"},"syncClaudeAiPlugins":false,"syncClaudeAiSkills":false}`
	if encoded, _ := json.Marshal(settings); string(encoded) != wantSettings {
		t.Fatalf("settings = %s", encoded)
	}
	_, resumed := claudeBuildArgv(logger, claudeSpec(RunSpec{ResumeID: "r"}))
	if v := claudeFlagValue(resumed, "--resume"); len(v) != 1 || v[0] != "r" {
		t.Fatalf("resume argv = %v", resumed)
	}
	if empty := claudeManagedSettings(&ClaudeToolPolicy{}); empty != `{"allowManagedPermissionRulesOnly":true,"permissions":{"disableBypassPermissionsMode":"disable"}}` {
		t.Fatalf("empty managed = %s", empty)
	}
	t.Setenv("LINGER_GATEWAY_TOKEN", "daemon-secret")
	if env := childEnvironment(map[string]string{"PATH": "/bin"}); len(env) != 1 || env[0] != "PATH=/bin" {
		t.Fatalf("env = %v", env)
	}
}

func TestClaudeSettingsFollowContextWindow(t *testing.T) {
	settingsFor := func(window int) (map[string]any, map[string]any) {
		t.Helper()
		var settings map[string]any
		if err := json.Unmarshal([]byte(claudeSettings(window)), &settings); err != nil {
			t.Fatal(err)
		}
		env, _ := settings["env"].(map[string]any)
		return settings, env
	}
	small, env := settingsFor(64896)
	if small["autoCompactWindow"] != float64(200000) || small["bashOutputMaxChars"] != float64(4056) ||
		env["CLAUDE_CODE_MAX_CONTEXT_TOKENS"] != "64896" || env["CLAUDE_CODE_DISABLE_1M_CONTEXT"] != "1" ||
		env["CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS"] != "4056" || env["MAX_MCP_OUTPUT_TOKENS"] != "4056" ||
		env["CLAUDE_CODE_DISABLE_BACKGROUND_TASKS"] != "1" {
		t.Fatalf("64k settings = %v", small)
	}
	// A large window keeps Claude's own tool output limits; only a 1M one
	// keeps the [1m] variants.
	large, env := settingsFor(400000)
	if _, ok := large["bashOutputMaxChars"]; ok || env["CLAUDE_CODE_MAX_CONTEXT_TOKENS"] != "400000" ||
		env["CLAUDE_CODE_DISABLE_1M_CONTEXT"] != "1" || env["MAX_MCP_OUTPUT_TOKENS"] != nil {
		t.Fatalf("400k settings = %v", large)
	}
	if _, env := settingsFor(1000000); env["CLAUDE_CODE_DISABLE_1M_CONTEXT"] != nil {
		t.Fatalf("1M settings env = %v", env)
	}
	if claudeSettings(0) != `{"autoCompactWindow":200000,"autoMemoryEnabled":false,"cleanupPeriodDays":36500,"disableAgentView":true,"disableBundledSkills":true,"disableRemoteControl":true,"env":{"CLAUDE_CODE_DISABLE_BACKGROUND_TASKS":"1"},"syncClaudeAiPlugins":false,"syncClaudeAiSkills":false}` {
		t.Fatalf("unknown window settings = %s", claudeSettings(0))
	}
	// The settings are part of the argv a parked process keeps, so another
	// window starts a new process.
	shaped, _ := claudeBuildArgv(claudeQuietLogger(), claudeSpec(RunSpec{Model: "local", ContextWindow: 64896}))
	if !slices.Equal(claudeFlagValue(shaped, "--settings"), []string{claudeSettings(64896)}) {
		t.Fatalf("shaped argv = %v", shaped)
	}
}

func TestClaudeLaunchWritesManagedMCPConfig(t *testing.T) {
	dir := t.TempDir()
	result := `{"type":"result","result":"ok","terminal_reason":"completed"}`
	profile := claudeFramesProfile(t, "frames", []string{result}, map[string]string{"CLAUDE_FAKE_DIR": dir})
	run := claudeStart(t, profile, "hello", RunSpec{MCPServers: json.RawMessage(`{"mcpServers":{"local":{"type":"stdio","command":"x"}}}`)})
	if _, outcome := claudeFinish(t, run, 10*time.Second); outcome.Status != statusCompleted {
		t.Fatalf("outcome = %+v", outcome)
	}
	argv, _ := os.ReadFile(filepath.Join(dir, "argv"))
	paths := claudeFlagValue(strings.Split(string(argv), "\n"), "--mcp-config")
	if len(paths) != 1 || !strings.HasPrefix(filepath.Base(filepath.Dir(paths[0])), claudeMCPDirPrefix) {
		t.Fatalf("mcp config = %v", paths)
	}
	if _, err := os.Stat(filepath.Dir(paths[0])); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("MCP config directory survived the confirmed exit")
	}
	backend, _ := Open("claude", profile)
	if _, err := backend.Start(t.Context(), "hello", claudeSpec(RunSpec{MCPServers: json.RawMessage(`{"mcpServers":`)})); err == nil || !strings.Contains(err.Error(), "invalid MCP configuration JSON") {
		t.Fatalf("invalid MCP err = %v", err)
	}
}

func TestClaudeRemoveMCPConfigKeepsForeignLayout(t *testing.T) {
	dir := t.TempDir()
	foreign := filepath.Join(dir, "config.json")
	sibling := filepath.Join(dir, "keep")
	_ = os.WriteFile(foreign, []byte("{}"), 0o600)
	_ = os.WriteFile(sibling, []byte("x"), 0o600)
	claudeRemoveMCPConfig(foreign)
	if _, err := os.Stat(foreign); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("foreign file survived")
	}
	if _, err := os.Stat(sibling); err != nil {
		t.Fatal("foreign directory was removed")
	}
	path, err := claudeWriteMCPConfig([]byte("{}"))
	if err != nil {
		t.Fatal(err)
	}
	if info, err := os.Stat(path); err != nil || (info.Mode().Perm() != 0o600 && os.PathSeparator == '/') {
		t.Fatalf("mcp file = %v %v", info, err)
	}
	claudeRemoveMCPConfig(path)
	if _, err := os.Stat(filepath.Dir(path)); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("MCP directory survived")
	}
}
