package provider

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

func TestModelInvokeTimeoutAllowsWikiRefreshDeadline(t *testing.T) {
	if got := modelInvokeTimeout(4 * time.Hour); got != 4*time.Hour {
		t.Fatalf("four-hour invocation was shortened to %s", got)
	}
	if got := modelInvokeTimeout(0); got != 10*time.Minute {
		t.Fatalf("default timeout changed to %s", got)
	}
}

func argValue(args []string, name string) string {
	for index, arg := range args {
		if arg == name && index+1 < len(args) {
			return args[index+1]
		}
	}
	return ""
}

func disabledFeatures(args []string) []string {
	var features []string
	for index, arg := range args {
		if arg == "--disable" {
			features = append(features, args[index+1])
		}
	}
	return features
}

func TestCodexModelInvokeArgsPinEffortIsolationAndNoPrompt(t *testing.T) {
	args := codexModelInvokeArgs(ModelInvokeStructured, "low", "/tmp/call/work", "/tmp/call/schema.json", "/tmp/call/last.txt")
	if args[0] != "exec" || !slices.Contains(args, "--skip-git-repo-check") || !slices.Contains(args, "--ephemeral") ||
		!slices.Contains(args, "--ignore-rules") || argValue(args, "--sandbox") != "read-only" ||
		argValue(args, "--color") != "never" || argValue(args, "-C") != "/tmp/call/work" ||
		argValue(args, "--output-schema") != "/tmp/call/schema.json" || argValue(args, "-o") != "/tmp/call/last.txt" ||
		!slices.Contains(args, "--json") {
		t.Fatalf("args = %q", args)
	}
	if !slices.Contains(args, `model_reasoning_effort="low"`) || !slices.Contains(args, `web_search="disabled"`) {
		t.Fatalf("args lack effort or web search override: %q", args)
	}
	want := []string{
		"shell_tool", "unified_exec", "code_mode_host", "multi_agent", "goals",
		"browser_use", "browser_use_external", "browser_use_full_cdp_access",
		"computer_use", "in_app_browser", "apps", "plugins", "hooks",
		"image_generation", "view_image", "tool_suggest", "skill_search", "sleep_tool",
	}
	if got := disabledFeatures(args); !slices.Equal(got, want) {
		t.Fatalf("disabled features = %q", got)
	}
	// Every option takes its value; nothing is left over as a PROMPT argument.
	if last := args[len(args)-1]; last != "/tmp/call/last.txt" {
		t.Fatalf("argv ends with %q", last)
	}

	text := codexModelInvokeArgs(ModelInvokeText, "high", "/w", "", "/l")
	if slices.Contains(text, "--output-schema") || !slices.Contains(text, `model_reasoning_effort="high"`) {
		t.Fatalf("text args = %q", text)
	}

	workspace := codexModelInvokeArgs(ModelInvokeWorkspace, "medium", "/w", "", "/l")
	if argValue(workspace, "--sandbox") != "workspace-write" {
		t.Fatalf("workspace args = %q", workspace)
	}
	// Workspace mode keeps only the code-mode host, which carries apply_patch;
	// a shell could read any file the user can.
	if got := disabledFeatures(workspace); !slices.Equal(got, slices.DeleteFunc(slices.Clone(want), func(f string) bool { return f == "code_mode_host" })) {
		t.Fatalf("workspace disabled features = %q", got)
	}
	for _, setting := range []string{"sandbox_workspace_write.exclude_slash_tmp=true", "sandbox_workspace_write.exclude_tmpdir_env_var=true"} {
		if !slices.Contains(workspace, setting) || slices.Contains(text, setting) {
			t.Fatalf("workspace writable roots are not confined: %q", workspace)
		}
	}
}

func TestClaudeModelInvokeArgsDisableToolsAndCustomizations(t *testing.T) {
	schema := json.RawMessage(`{"type":"object"}`)
	args := claudeModelInvokeArgs(ModelInvokeStructured, "low", schema)
	for _, flag := range []string{"-p", "--safe-mode", "--strict-mcp-config", "--no-session-persistence", "--disable-slash-commands"} {
		if !slices.Contains(args, flag) {
			t.Fatalf("args lack %s: %q", flag, args)
		}
	}
	if argValue(args, "--output-format") != "json" || argValue(args, "--json-schema") != `{"type":"object"}` ||
		argValue(args, "--effort") != "low" || argValue(args, "--permission-mode") != "dontAsk" {
		t.Fatalf("args = %q", args)
	}
	if index := slices.Index(args, "--tools"); index < 0 || args[index+1] != "" {
		t.Fatalf("tools are not disabled: %q", args)
	}
	if slices.Contains(args, "--restricted") {
		t.Fatalf("structured mode is restricted: %q", args)
	}

	text := claudeModelInvokeArgs(ModelInvokeText, "medium", nil)
	if slices.Contains(text, "--json-schema") || argValue(text, "--effort") != "medium" {
		t.Fatalf("text args = %q", text)
	}

	workspace := claudeModelInvokeArgs(ModelInvokeWorkspace, "high", nil)
	if argValue(workspace, "--tools") != "Read,Write,Edit,Glob,Grep" || !slices.Contains(workspace, "--restricted") ||
		argValue(workspace, "--permission-mode") != "acceptEdits" {
		t.Fatalf("workspace args = %q", workspace)
	}
}

type codexInvokeFixture struct {
	source  string
	base    string
	invoker ModelInvoker
}

func newCodexInvokeFixture(t *testing.T, run func(ctx context.Context, command *exec.Cmd) error) codexInvokeFixture {
	t.Helper()
	source := t.TempDir()
	if err := os.WriteFile(filepath.Join(source, "config.toml"), []byte("model = \"fixture-model\"\n[mcp_servers.secret]\ncommand = \"secret\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(source, "auth.json"), []byte(`{}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(source, "AGENTS.md"), []byte("private"), 0o600); err != nil {
		t.Fatal(err)
	}
	base := filepath.Join(t.TempDir(), "operation-tmp")
	return codexInvokeFixture{source: source, base: base, invoker: ModelInvoker{
		TempBase: base,
		Lookup: func(_ context.Context, runtimeType string) (ModelInvokeRuntime, bool, error) {
			if runtimeType != "codex" {
				return ModelInvokeRuntime{}, false, nil
			}
			return ModelInvokeRuntime{
				ExecutablePath: "/fixture/codex", Version: "0.166.0",
				Environment: map[string]string{
					"CODEX_HOME": source, "HOME": t.TempDir(), "PATH": "/usr/bin",
					"TEAMHUB_CLI_TOKEN": "secret", "LINGER_RUNNER_TOKEN": "secret",
				},
			}, true, nil
		},
		Run: run,
	}}
}

func environmentMap(command *exec.Cmd) map[string]string {
	result := make(map[string]string)
	for _, entry := range command.Env {
		if key, value, ok := strings.Cut(entry, "="); ok {
			result[key] = value
		}
	}
	return result
}

func structuredRequest() ModelInvokeRequest {
	return ModelInvokeRequest{
		RuntimeType: "codex", Mode: ModelInvokeStructured, ReasoningEffort: "low",
		Instructions: "Answer in JSON.", Input: "secret prompt body",
		OutputSchema: json.RawMessage(`{"type":"object","properties":{"answer":{"type":"string"}},"required":["answer"],"additionalProperties":false}`),
		Timeout:      time.Minute,
	}
}

func TestModelInvokerRunsCodexInATemporaryDirectoryWithPromptOnStdin(t *testing.T) {
	var workDir, codexHome string
	fixture := newCodexInvokeFixture(t, func(_ context.Context, command *exec.Cmd) error {
		environment := environmentMap(command)
		workDir, codexHome = command.Dir, environment["CODEX_HOME"]
		if !strings.HasPrefix(command.Dir, filepath.Dir(command.Dir)) || filepath.Base(command.Dir) != "work" {
			return fmt.Errorf("cwd = %s", command.Dir)
		}
		for key := range environment {
			if strings.HasPrefix(key, "TEAMHUB_") || strings.HasPrefix(key, "LINGER_") {
				return fmt.Errorf("environment leaks %s", key)
			}
		}
		for _, key := range []string{"TMPDIR", "TMP", "TEMP"} {
			if environment[key] != filepath.Join(filepath.Dir(command.Dir), "tmp") {
				return fmt.Errorf("%s = %s", key, environment[key])
			}
		}
		entries, err := os.ReadDir(codexHome)
		if err != nil {
			return err
		}
		if len(entries) != 2 || codexHome == "" || strings.HasPrefix(codexHome, "/fixture") {
			return fmt.Errorf("CODEX_HOME %s has %d entries", codexHome, len(entries))
		}
		prompt, err := io.ReadAll(command.Stdin)
		if err != nil {
			return err
		}
		if string(prompt) != "Answer in JSON.\n\n<input>\nsecret prompt body\n</input>\n" {
			return fmt.Errorf("stdin = %q", prompt)
		}
		for _, arg := range command.Args {
			if strings.Contains(arg, "secret prompt body") {
				return errors.New("prompt is in argv")
			}
		}
		schema, err := os.ReadFile(argValue(command.Args, "--output-schema"))
		if err != nil || !json.Valid(schema) {
			return fmt.Errorf("schema file: %w", err)
		}
		_, _ = io.WriteString(command.Stdout, `{"type":"thread.started"}`+"\n"+
			`{"type":"turn.completed","usage":{"input_tokens":120,"cached_input_tokens":20,"output_tokens":7}}`+"\n")
		return os.WriteFile(argValue(command.Args, "-o"), []byte(`{"answer":"ok"}`), 0o600)
	})
	result := fixture.invoker.Invoke(context.Background(), structuredRequest())
	if result.Outcome != ModelInvokeCompleted || result.Text != `{"answer":"ok"}` || result.Model != "fixture-model" ||
		result.RuntimeVersion != "0.166.0" || result.Usage == nil || *result.Usage != (ModelInvokeUsage{InputTokens: 120, CachedInputTokens: 20, OutputTokens: 7}) {
		t.Fatalf("result = %+v", result)
	}
	if !strings.HasPrefix(workDir, fixture.base) {
		t.Fatalf("work dir %s is outside the temp base %s", workDir, fixture.base)
	}
	if _, err := os.Stat(filepath.Dir(workDir)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("temporary directory survived the call: %v", err)
	}
	if _, err := os.Stat(filepath.Join(fixture.source, "auth.json")); err != nil {
		t.Fatalf("the source auth.json was removed: %v", err)
	}
}

func TestModelInvokerBoundsTheReply(t *testing.T) {
	fixture := newCodexInvokeFixture(t, func(_ context.Context, command *exec.Cmd) error {
		return os.WriteFile(argValue(command.Args, "-o"), make([]byte, ModelInvokeMaxTextBytes+1), 0o600)
	})
	if result := fixture.invoker.Invoke(context.Background(), structuredRequest()); result.Outcome != ModelInvokeFailed ||
		!strings.Contains(result.Reason, "1 MiB") {
		t.Fatalf("result = %+v", result)
	}
	empty := newCodexInvokeFixture(t, func(context.Context, *exec.Cmd) error { return nil })
	if result := empty.invoker.Invoke(context.Background(), structuredRequest()); result.Outcome != ModelInvokeFailed ||
		result.Reason != "Runtime exited without a reply" {
		t.Fatalf("result = %+v", result)
	}
}

func TestModelInvokerClassifiesFailures(t *testing.T) {
	for _, test := range []struct {
		stderr, event, outcome string
	}{
		{stderr: "Reading prompt from stdin...\nError: Unknown feature flag: sleep_tool\n", outcome: ModelInvokeRuntimeIncompatible},
		{stderr: "error: unexpected argument '--ignore-rules' found\n", outcome: ModelInvokeRuntimeIncompatible},
		{event: `{"type":"turn.failed","error":{"message":"401 Unauthorized: token expired"}}`, outcome: ModelInvokeAuthRequired},
		{stderr: "Error: stream disconnected before completion\n", outcome: ModelInvokeFailed},
	} {
		fixture := newCodexInvokeFixture(t, func(_ context.Context, command *exec.Cmd) error {
			_, _ = io.WriteString(command.Stderr, test.stderr)
			if test.event != "" {
				_, _ = io.WriteString(command.Stdout, test.event+"\n")
			}
			return errors.New("exit status 1")
		})
		result := fixture.invoker.Invoke(context.Background(), structuredRequest())
		if result.Outcome != test.outcome || result.Reason == "" {
			t.Fatalf("%q: result = %+v", test.stderr+test.event, result)
		}
	}
}

func TestModelInvokerReportsTimeoutAndCancellation(t *testing.T) {
	block := func(ctx context.Context, _ *exec.Cmd) error {
		<-ctx.Done()
		return ctx.Err()
	}
	fixture := newCodexInvokeFixture(t, block)
	request := structuredRequest()
	request.Timeout = 20 * time.Millisecond
	if result := fixture.invoker.Invoke(context.Background(), request); result.Outcome != ModelInvokeTimedOut {
		t.Fatalf("timeout result = %+v", result)
	}
	ctx, cancel := context.WithCancel(context.Background())
	time.AfterFunc(20*time.Millisecond, cancel)
	if result := fixture.invoker.Invoke(ctx, structuredRequest()); result.Outcome != ModelInvokeCanceled {
		t.Fatalf("cancel result = %+v", result)
	}
}

func TestModelInvokerWorkspaceModeRoundTripsFiles(t *testing.T) {
	fixture := newCodexInvokeFixture(t, func(_ context.Context, command *exec.Cmd) error {
		input, err := os.ReadFile(filepath.Join(command.Dir, "raw", "notes.md"))
		if err != nil || string(input) != "notes" {
			return fmt.Errorf("input file %q: %w", input, err)
		}
		// Codex has no file-reading tool in workspace mode, so the input
		// files travel in the prompt.
		prompt, err := io.ReadAll(command.Stdin)
		if err != nil {
			return err
		}
		if !strings.HasPrefix(string(prompt), "Write pages.") ||
			!strings.Contains(string(prompt), "<workspace_file path=\"raw/notes.md\">\nnotes\n</workspace_file>") ||
			!strings.Contains(string(prompt), `<workspace_file path="raw/blob.bin" bytes="2" binary="true"/>`) {
			return fmt.Errorf("stdin = %q", prompt)
		}
		if err := os.MkdirAll(filepath.Join(command.Dir, "pages"), 0o700); err != nil {
			return err
		}
		if err := os.WriteFile(filepath.Join(command.Dir, "pages", "a.json"), []byte(`{"page":1}`), 0o600); err != nil {
			return err
		}
		if err := createTestModelFileLink(t, filepath.Join(command.Dir, "pages", "link")); err != nil {
			return err
		}
		return os.WriteFile(argValue(command.Args, "-o"), []byte("done"), 0o600)
	})
	request := ModelInvokeRequest{
		RuntimeType: "codex", Mode: ModelInvokeWorkspace, ReasoningEffort: "medium", Input: "Write pages.",
		WorkspaceFiles: []ModelInvokeFile{
			{Path: "raw/notes.md", Content: []byte("notes")}, {Path: "raw/blob.bin", Content: []byte{0xff, 0xfe}},
		}, Timeout: time.Minute,
	}
	result := fixture.invoker.Invoke(context.Background(), request)
	if result.Outcome != ModelInvokeCompleted || len(result.WorkspaceFiles) != 3 ||
		result.WorkspaceFiles[0].Path != "pages/a.json" || string(result.WorkspaceFiles[0].Content) != `{"page":1}` ||
		result.WorkspaceFiles[2].Path != "raw/notes.md" {
		t.Fatalf("result = %+v", result)
	}

	for _, path := range []string{
		"../escape.md", "AGENTS.md", "agents.override.md", "CLAUDE.md", ".codex/config.toml",
		"raw/.claude/settings.json", "raw/.CODEX/x", ".claude",
	} {
		request.WorkspaceFiles = []ModelInvokeFile{{Path: path, Content: []byte("x")}}
		if result := fixture.invoker.Invoke(context.Background(), request); result.Outcome != ModelInvokeFailed {
			t.Fatalf("%s accepted: %+v", path, result)
		}
	}
	// Instruction file names are only reserved at the root.
	if modelInvokeReservedPath("raw/AGENTS.md") || modelInvokeReservedPath("raw/claude.md.json") {
		t.Fatal("nested instruction-like names are reserved")
	}

	large := newCodexInvokeFixture(t, func(_ context.Context, command *exec.Cmd) error {
		if err := os.WriteFile(filepath.Join(command.Dir, "big.bin"), make([]byte, ModelInvokeMaxWorkspaceBytes+1), 0o600); err != nil {
			return err
		}
		return os.WriteFile(argValue(command.Args, "-o"), []byte("done"), 0o600)
	})
	request.WorkspaceFiles = nil
	if result := large.invoker.Invoke(context.Background(), request); result.Outcome != ModelInvokeFailed ||
		!strings.Contains(result.Reason, "2 MiB") {
		t.Fatalf("oversized workspace accepted: %+v", result)
	}
}

func TestModelInvokerRejectsUnsupportedOrMissingRuntimes(t *testing.T) {
	called := false
	fixture := newCodexInvokeFixture(t, func(context.Context, *exec.Cmd) error { called = true; return nil })
	request := structuredRequest()
	request.RuntimeType = "pi"
	if result := fixture.invoker.Invoke(context.Background(), request); result.Outcome != ModelInvokeRuntimeUnavailable {
		t.Fatalf("pi result = %+v", result)
	}
	request.RuntimeType = "claude"
	if result := fixture.invoker.Invoke(context.Background(), request); result.Outcome != ModelInvokeRuntimeUnavailable {
		t.Fatalf("missing claude result = %+v", result)
	}
	if err := os.Remove(filepath.Join(fixture.source, "auth.json")); err != nil {
		t.Fatal(err)
	}
	if result := fixture.invoker.Invoke(context.Background(), structuredRequest()); result.Outcome != ModelInvokeAuthRequired {
		t.Fatalf("signed-out result = %+v", result)
	}
	if called {
		t.Fatal("a process was started for an unusable Runtime")
	}
}

func TestClaudeInvokeOutputReadsStructuredResultAndUsage(t *testing.T) {
	var output claudeInvokeOutput
	encoded := `{"type":"result","is_error":false,"result":"","structured_output":{"answer":"ok"},` +
		`"usage":{"input_tokens":30,"cache_read_input_tokens":5,"output_tokens":4},"modelUsage":{"claude-fixture":{}}}`
	if err := json.Unmarshal([]byte(encoded), &output); err != nil {
		t.Fatal(err)
	}
	if string(output.StructuredOutput) != `{"answer":"ok"}` || output.model() != "claude-fixture" ||
		*output.usage() != (ModelInvokeUsage{InputTokens: 30, CachedInputTokens: 5, OutputTokens: 4}) {
		t.Fatalf("output = %+v", output)
	}
	failed := classifyModelInvokeFailure(context.Background(), context.Background(), errors.New("exit status 1"), "", "Not logged in · Please run /login")
	if failed.Outcome != ModelInvokeAuthRequired {
		t.Fatalf("signed-out Claude = %+v", failed)
	}
}

func TestCodexInvokeEventsSkipOversizedLines(t *testing.T) {
	events := &codexInvokeEvents{}
	long := `{"type":"item.completed","item":{"text":"` + strings.Repeat("x", modelInvokeMaxEventLineBytes) + `"}}`
	for _, chunk := range []string{long[:100], long[100:] + "\n" + `{"type":"turn.completed","usage":{"input_tokens":1,`, `"output_tokens":2}}` + "\n"} {
		if _, err := events.Write([]byte(chunk)); err != nil {
			t.Fatal(err)
		}
	}
	if usage := events.usage(); usage == nil || usage.InputTokens != 1 || usage.OutputTokens != 2 {
		t.Fatalf("usage = %+v", usage)
	}
}

func TestCodexInvokeSandboxConfigKeepsWindowsUnelevated(t *testing.T) {
	if args := codexInvokeSandboxConfig("windows"); !slices.Equal(args, []string{"--config", `windows.sandbox="unelevated"`}) {
		t.Fatalf("windows args = %q", args)
	}
	if args := codexInvokeSandboxConfig("darwin"); args != nil {
		t.Fatalf("darwin args = %q", args)
	}
}
