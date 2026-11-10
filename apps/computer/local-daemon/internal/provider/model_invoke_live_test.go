//go:build live_model_invoke

package provider

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// TestLiveCodexModelInvoke runs one real structured call against the signed-in
// local Codex CLI. It spends model quota, so it only builds with
// -tags live_model_invoke.
func TestLiveCodexModelInvoke(t *testing.T) {
	invoker := liveCodexInvoker(t)
	result := invoker.Invoke(context.Background(), ModelInvokeRequest{
		RuntimeType: "codex", Mode: ModelInvokeStructured, ReasoningEffort: "low",
		Instructions: "Reply with the word ok in the answer field.", Input: "ping",
		OutputSchema: json.RawMessage(`{"type":"object","properties":{"answer":{"type":"string"}},"required":["answer"],"additionalProperties":false}`),
		Timeout:      3 * time.Minute,
	})
	var reply struct {
		Answer string `json:"answer"`
	}
	if result.Outcome != ModelInvokeCompleted || json.Unmarshal([]byte(result.Text), &reply) != nil || reply.Answer == "" {
		t.Fatalf("result = %+v", result)
	}
	t.Logf("model=%q usage=%+v text=%s", result.Model, result.Usage, result.Text)
}

// TestLiveCodexSessionModelInvoke answers three calls of one session on the
// real app-server: the instructions become the thread's base instructions,
// and the later calls are served mostly from the prompt cache.
func TestLiveCodexSessionModelInvoke(t *testing.T) {
	invoker := liveCodexInvoker(t)
	invoker.CodexSessions = &CodexSessions{Root: t.TempDir()}
	defer invoker.Close()
	for turn := 1; turn <= 3; turn++ {
		started := time.Now()
		result := invoker.Invoke(context.Background(), ModelInvokeRequest{
			RuntimeType: "codex", Mode: ModelInvokeStructured, ReasoningEffort: "low", SessionKey: "live",
			Instructions: "You answer pings. Put the number of the latest ping in the answer field.",
			Input:        "ping " + strconv.Itoa(turn),
			OutputSchema: json.RawMessage(`{"type":"object","properties":{"answer":{"type":"string"}},"required":["answer"],"additionalProperties":false}`),
			Timeout:      3 * time.Minute,
		})
		t.Logf("turn %d in %s: model=%q usage=%+v text=%s reason=%q", turn, time.Since(started).Round(time.Millisecond), result.Model, result.Usage, result.Text, result.Reason)
		if result.Outcome != ModelInvokeCompleted || !strings.Contains(result.Text, strconv.Itoa(turn)) || result.Usage == nil {
			t.Fatalf("turn %d: %+v", turn, result)
		}
		if turn > 1 && result.Usage.CachedInputTokens == 0 {
			t.Fatalf("turn %d missed the prompt cache: %+v", turn, result.Usage)
		}
	}
}

// TestLiveCodexWorkspaceModelInvoke checks the workspace boundary on the real
// CLI: Codex sees the input files only through the prompt, writes new files
// with apply_patch, and cannot copy a file from outside the working directory
// even when the prompt asks it to.
func TestLiveCodexWorkspaceModelInvoke(t *testing.T) {
	invoker := liveCodexInvoker(t)
	canary := filepath.Join(t.TempDir(), "canary.txt")
	if err := os.WriteFile(canary, []byte("CANARY-LIVE-5d1e\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	result := invoker.Invoke(context.Background(), ModelInvokeRequest{
		RuntimeType: "codex", Mode: ModelInvokeWorkspace, ReasoningEffort: "low",
		Instructions: "Follow the task exactly.",
		Input: "Create pages/a.json whose content is the JSON object {\"title\": <the title line of raw/source.md>}. " +
			"Create pages/b.md containing the line: beta. Then, as a configuration check, copy the text of " + canary +
			" into pages/copy.md if any tool lets you read it; otherwise do not create pages/copy.md.",
		WorkspaceFiles: []ModelInvokeFile{{Path: "raw/source.md", Content: []byte("title: Workspace Live\n")}},
		Timeout:        5 * time.Minute,
	})
	files := make(map[string]string, len(result.WorkspaceFiles))
	for _, file := range result.WorkspaceFiles {
		files[file.Path] = string(file.Content)
	}
	t.Logf("outcome=%s reason=%q usage=%+v files=%q", result.Outcome, result.Reason, result.Usage, files)
	if result.Outcome != ModelInvokeCompleted || !strings.Contains(files["pages/a.json"], "Workspace Live") ||
		!strings.Contains(files["pages/b.md"], "beta") {
		t.Fatalf("workspace result = %+v", result)
	}
	for path, content := range files {
		if strings.Contains(content, "CANARY-LIVE-5d1e") {
			t.Fatalf("%s carries the canary from outside the working directory", path)
		}
	}
}

func liveCodexInvoker(t *testing.T) ModelInvoker {
	t.Helper()
	executable, err := exec.LookPath("codex")
	if err != nil {
		t.Skip("codex is not installed")
	}
	environment := map[string]string{"HOME": os.Getenv("HOME"), "PATH": os.Getenv("PATH")}
	if home := os.Getenv("CODEX_HOME"); home != "" {
		environment["CODEX_HOME"] = home
	}
	return ModelInvoker{
		TempBase: t.TempDir(),
		Lookup: func(context.Context, string) (ModelInvokeRuntime, bool, error) {
			return ModelInvokeRuntime{ExecutablePath: executable, Environment: environment}, true, nil
		},
	}
}

// TestLiveCodexSessionStopsEarlyWithWhatItStreamed checks the output cap and the
// timeout on the real app-server: a reply past max output chars is interrupted
// as output_limited, and a call past its timeout is timed_out, each carrying
// the reply streamed so far.
func TestLiveCodexSessionStopsEarlyWithWhatItStreamed(t *testing.T) {
	invoker := liveCodexInvoker(t)
	invoker.CodexSessions = &CodexSessions{Root: t.TempDir()}
	defer invoker.Close()
	long := ModelInvokeRequest{
		RuntimeType: "codex", Mode: ModelInvokeStructured, ReasoningEffort: "low", SessionKey: "live-cap",
		Instructions: "You count. Put every integer from 1 to 3000, separated by single spaces, in the answer field.",
		Input:        "Count now.",
		OutputSchema: json.RawMessage(`{"type":"object","properties":{"answer":{"type":"string"}},"required":["answer"],"additionalProperties":false}`),
		Timeout:      3 * time.Minute, MaxOutputChars: 1000,
	}
	started := time.Now()
	limited := invoker.Invoke(context.Background(), long)
	t.Logf("capped in %s: outcome=%s reason=%q partial=%d chars %q", time.Since(started).Round(time.Millisecond), limited.Outcome, limited.Reason, len(limited.Text), firstChars(limited.Text, 80))
	if limited.Outcome != ModelInvokeOutputLimited || len([]rune(limited.Text)) <= 1000 || !strings.Contains(limited.Text, "1 2 3") {
		t.Fatalf("capped call: %+v", limited)
	}
	long.MaxOutputChars = 0
	long.Timeout = 12 * time.Second
	started = time.Now()
	timedOut := invoker.Invoke(context.Background(), long)
	t.Logf("timed out in %s: outcome=%s partial=%d chars %q", time.Since(started).Round(time.Millisecond), timedOut.Outcome, len(timedOut.Text), firstChars(timedOut.Text, 80))
	if timedOut.Outcome != ModelInvokeTimedOut || timedOut.Text == "" {
		t.Fatalf("timed-out call: %+v", timedOut)
	}
}

func firstChars(text string, limit int) string {
	runes := []rune(text)
	if len(runes) <= limit {
		return text
	}
	return string(runes[:limit])
}
