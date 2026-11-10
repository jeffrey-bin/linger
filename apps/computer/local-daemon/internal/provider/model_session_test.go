package provider

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// The test binary doubles as a minimal Codex app-server when this variable
// names a file to record its arguments and environment in.
const fakeSessionServerKey = "PROVIDER_FAKE_CODEX_SESSION"

func init() {
	if record := os.Getenv(fakeSessionServerKey); record != "" {
		os.Exit(fakeSessionServer(record))
	}
}

func fakeSessionServer(record string) int {
	launch, _ := json.Marshal(map[string]any{"args": os.Args[1:], "codex_home": os.Getenv("CODEX_HOME"), "tmpdir": os.Getenv("TMPDIR"), "teamhub": os.Getenv("TEAMHUB_CLI_TOKEN")})
	file, err := os.OpenFile(record, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return 1
	}
	_, _ = file.Write(append(launch, '\n'))
	_ = file.Close()
	out := bufio.NewWriter(os.Stdout)
	send := func(message map[string]any) {
		message["jsonrpc"] = "2.0"
		line, _ := json.Marshal(message)
		_, _ = out.Write(append(line, '\n'))
		_ = out.Flush()
	}
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 0, 64<<10), 4<<20)
	turns := 0
	for scanner.Scan() {
		var message map[string]any
		if json.Unmarshal(scanner.Bytes(), &message) != nil {
			continue
		}
		switch message["method"] {
		case "initialize":
			send(map[string]any{"id": message["id"], "result": map[string]any{}})
		case "thread/start":
			send(map[string]any{"id": message["id"], "result": map[string]any{"thread": map[string]any{"id": "thread-1"}, "model": "gpt-session"}})
		case "turn/start":
			turns++
			send(map[string]any{"id": message["id"], "result": map[string]any{"turn": map[string]any{"id": "turn-1"}}})
			send(map[string]any{"method": "item/completed", "params": map[string]any{"threadId": "thread-1", "item": map[string]any{"type": "agentMessage", "text": fmt.Sprintf(`{"answer":"turn %d"}`, turns)}}})
			send(map[string]any{"method": "thread/tokenUsage/updated", "params": map[string]any{"threadId": "thread-1", "tokenUsage": map[string]any{
				"total": map[string]any{"inputTokens": 5000, "cachedInputTokens": 4900, "outputTokens": 30},
				"last":  map[string]any{"inputTokens": 2500, "cachedInputTokens": 2400, "outputTokens": 15},
			}}})
			send(map[string]any{"method": "turn/completed", "params": map[string]any{"threadId": "thread-1", "turn": map[string]any{"id": "turn-1", "status": "completed"}}})
		}
	}
	return 0
}

func TestModelInvokerAnswersSessionCallsOnOneResidentCodex(t *testing.T) {
	record := filepath.Join(t.TempDir(), "launches.jsonl")
	oneShot := 0
	fixture := newCodexInvokeFixture(t, func(_ context.Context, command *exec.Cmd) error {
		oneShot++
		return os.WriteFile(argValue(command.Args, "-o"), []byte(`{"answer":"alone"}`), 0o600)
	})
	lookup := fixture.invoker.Lookup
	fixture.invoker.Lookup = func(ctx context.Context, runtimeType string) (ModelInvokeRuntime, bool, error) {
		installed, ok, err := lookup(ctx, runtimeType)
		installed.ExecutablePath = os.Args[0]
		installed.Environment[fakeSessionServerKey] = record
		return installed, ok, err
	}
	root := filepath.Join(t.TempDir(), "codex-sessions")
	fixture.invoker.CodexSessions = &CodexSessions{Root: root}
	defer fixture.invoker.Close()

	request := structuredRequest()
	request.SessionKey = "permission-review:abc"
	for turn := 1; turn <= 2; turn++ {
		result := fixture.invoker.Invoke(context.Background(), request)
		if result.Outcome != ModelInvokeCompleted || result.Text != fmt.Sprintf(`{"answer":"turn %d"}`, turn) || result.Model != "gpt-session" ||
			result.Usage == nil || *result.Usage != (ModelInvokeUsage{InputTokens: 2500, CachedInputTokens: 2400, OutputTokens: 15}) {
			t.Fatalf("turn %d: %+v", turn, result)
		}
	}
	launches, err := os.ReadFile(record)
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(string(launches)), "\n")
	if len(lines) != 1 {
		t.Fatalf("launched %d app-servers for one session: %s", len(lines), launches)
	}
	var launch struct {
		Args      []string `json:"args"`
		CodexHome string   `json:"codex_home"`
		TempDir   string   `json:"tmpdir"`
		TeamHub   string   `json:"teamhub"`
	}
	if err := json.Unmarshal([]byte(lines[0]), &launch); err != nil {
		t.Fatal(err)
	}
	args := strings.Join(launch.Args, " ")
	if launch.Args[0] != "app-server" || !strings.Contains(args, "--disable shell_tool") || !strings.Contains(args, `--config web_search="disabled"`) {
		t.Fatalf("app-server args %v", launch.Args)
	}
	if launch.CodexHome != filepath.Join(root, "codex-home") || launch.TempDir != filepath.Join(root, "tmp") || launch.TeamHub != "" {
		t.Fatalf("app-server environment %+v", launch)
	}
	if _, err := os.Stat(filepath.Join(launch.CodexHome, "AGENTS.md")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("the session home copied the user's instructions: %v", err)
	}

	// Calls without a session, and Claude calls, still run on their own.
	alone := structuredRequest()
	if result := fixture.invoker.Invoke(context.Background(), alone); result.Text != `{"answer":"alone"}` || oneShot != 1 {
		t.Fatalf("a call without a session: %+v, one-shot runs %d", result, oneShot)
	}
}

func TestCodexSessionsStopWithTheInvoker(t *testing.T) {
	record := filepath.Join(t.TempDir(), "launches.jsonl")
	fixture := newCodexInvokeFixture(t, nil)
	lookup := fixture.invoker.Lookup
	fixture.invoker.Lookup = func(ctx context.Context, runtimeType string) (ModelInvokeRuntime, bool, error) {
		installed, ok, err := lookup(ctx, runtimeType)
		installed.ExecutablePath = os.Args[0]
		installed.Environment[fakeSessionServerKey] = record
		return installed, ok, err
	}
	fixture.invoker.CodexSessions = &CodexSessions{Root: t.TempDir()}
	request := structuredRequest()
	request.SessionKey = "permission-review:abc"
	request.Timeout = 30 * time.Second
	if result := fixture.invoker.Invoke(context.Background(), request); result.Outcome != ModelInvokeCompleted {
		t.Fatalf("result %+v", result)
	}
	done := make(chan struct{})
	go func() {
		fixture.invoker.Close()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("Close did not stop the app-server")
	}
}
