package provider

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/protocol"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider/native"
)

func TestClaudeLiveLifecycle(t *testing.T) {
	if os.Getenv("LINGER_LIVE_LOCAL_CLAUDE") != "1" {
		t.Skip("requires explicitly enabled authenticated Claude live acceptance")
	}
	executable := os.Getenv("LINGER_CLAUDE_PATH")
	if executable == "" {
		var err error
		executable, err = exec.LookPath("claude")
		if err != nil {
			t.Fatal(err)
		}
	}
	version, err := exec.Command(executable, "--version").Output()
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("Claude CLI: %s", strings.TrimSpace(string(version)))
	root := t.TempDir()
	workspace := filepath.Join(root, "workspace")
	skillRoot := filepath.Join(workspace, ".agents", "skills", "acceptance-proof")
	if err := os.MkdirAll(skillRoot, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(skillRoot, "SKILL.md"), []byte("---\nname: acceptance-proof\ndescription: Local adapter acceptance proof\n---\nWhen invoked, call the acceptance proof MCP tool, then write its returned token to baseline.txt in the current working directory.\n"), 0600); err != nil {
		t.Fatal(err)
	}
	proof := fmt.Sprintf("claude-proof-%d", time.Now().UnixNano())
	var toolCalls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodPost {
			response.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		var rpc struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
			Params struct {
				Name string `json:"name"`
			} `json:"params"`
		}
		if json.NewDecoder(request.Body).Decode(&rpc) != nil {
			response.WriteHeader(http.StatusBadRequest)
			return
		}
		if len(rpc.ID) == 0 {
			response.WriteHeader(http.StatusAccepted)
			return
		}
		var result any
		switch rpc.Method {
		case "initialize":
			result = map[string]any{"protocolVersion": "2024-11-05", "capabilities": map[string]any{"tools": map[string]any{}}, "serverInfo": map[string]string{"name": "acceptance", "version": "1"}}
		case "tools/list":
			result = map[string]any{"tools": []any{map[string]any{"name": "proof", "description": "Return the acceptance proof token", "inputSchema": map[string]any{"type": "object", "properties": map[string]any{}}}}}
		case "tools/call":
			if rpc.Params.Name != "proof" {
				response.WriteHeader(http.StatusForbidden)
				return
			}
			toolCalls.Add(1)
			result = map[string]any{"content": []any{map[string]string{"type": "text", "text": proof}}}
		case "ping":
			result = map[string]any{}
		default:
			response.WriteHeader(http.StatusBadRequest)
			return
		}
		response.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(response).Encode(map[string]any{"jsonrpc": "2.0", "id": rpc.ID, "result": result})
	}))
	defer server.Close()
	mcpConfig, _ := json.Marshal(map[string]any{"mcpServers": map[string]any{"acceptance": map[string]string{"type": "http", "url": server.URL}}})
	environment := make(map[string]string)
	for _, entry := range os.Environ() {
		key, value, ok := strings.Cut(entry, "=")
		if ok {
			environment[key] = value
		}
	}
	base := OperationSpec{Provider: "claude", ExecutablePath: executable, WorkingDirectory: workspace, Environment: environment, Timeout: 120 * time.Second, TenantID: "claude-live-tenant", OwnerActorID: "claude-live-owner", AgentID: "claude-live-agent", ScopeID: "claude-live-context", ClaudeSkillNames: []string{"acceptance-proof"}, MCPConfig: mcpConfig, MCPRelays: json.RawMessage(`[{"name":"acceptance","tool_names":["proof"]}]`), SystemPrompt: "For every final answer include the exact phrase LOCAL_CLAUDE_SNAPSHOT_FIRST. Follow user instructions and use the provided tools."}
	executor := Executor{RuntimeHomeRoot: filepath.Join(root, "runtime-homes"), TempBase: filepath.Join(root, "temp")}
	created := Result{SessionID: uuid.NewString()}
	base.OperationKind = "run.start"
	base.ThinkingLevel = "none"
	base.CreateProviderSessionID = created.SessionID
	base.TaskID = "claude-live-first"
	base.Prompt = "Invoke the acceptance-proof Skill and follow it. Then read baseline.txt and confirm the MCP proof token. Do not call the proof tool more than once."
	firstRun := startClaudeLiveRun(t, context.Background(), &executor, base)
	first := firstRun.wait(t)
	assertClaudeLiveCompleted(t, first, created.SessionID, "LOCAL_CLAUDE_SNAPSHOT_FIRST")
	content, err := os.ReadFile(filepath.Join(workspace, "baseline.txt"))
	if err != nil || !strings.Contains(string(content), proof) || toolCalls.Load() != 1 {
		t.Fatalf("Skill/MCP/file proof failed: read=%v calls=%d", err, toolCalls.Load())
	}
	if !firstRun.hasTool("Skill") || !firstRun.hasTool("mcp__acceptance__proof") {
		t.Fatal("native Skill and MCP tool events were not observed")
	}
	t.Log("PASS create, managed Skill, MCP invocation, file output, native tool events")
	base.CreateProviderSessionID = ""
	base.ResumeSessionID = created.SessionID
	base.SystemPrompt = "For every final answer include the exact phrase LOCAL_CLAUDE_SNAPSHOT_REPLACED. Follow user instructions and use the provided tools."
	base.TaskID = "claude-live-steer"
	base.Prompt = "Run Bash in the foreground: printf started > steer-started.txt; sleep 30; printf unexpected > steer-late.txt. Wait for it to finish before replying."
	steered := startClaudeLiveRun(t, context.Background(), &executor, base)
	waitClaudeLiveFile(t, filepath.Join(workspace, "steer-started.txt"), steered)
	turnID := steered.turn()
	if turnID == "" {
		t.Fatal("Claude did not expose native turn identity")
	}
	steerCtx, stopSteer := context.WithTimeout(context.Background(), 15*time.Second)
	ack, err := steered.execution.Input(steerCtx, native.SteerRequest{ExpectedTurnID: turnID, Input: "Stop the waiting command. Instead use Bash to write the word steered to steered.txt, read baseline.txt, and reply with its proof token. Do not restart the old waiting command."})
	stopSteer()
	if err != nil {
		t.Fatalf("steer failed: %v", err)
	}
	if ack.TurnID != turnID {
		t.Fatal("steer did not acknowledge the active run identity")
	}
	continued := steered.wait(t)
	assertClaudeLiveCompleted(t, continued, created.SessionID, "LOCAL_CLAUDE_SNAPSHOT_REPLACED")
	if !strings.Contains(continued.Output, proof) {
		t.Fatal("native Session lost the prior proof after instruction update")
	}
	if _, err := os.Stat(filepath.Join(workspace, "steered.txt")); err != nil {
		t.Fatal(err)
	}
	t.Log("PASS steer ACK, continuation, strict Session identity, current instructions")
	base.TaskID = "claude-live-cancel"
	base.Prompt = "Use Bash in the foreground: printf started > cancel-started.txt; sleep 10; printf unexpected > cancel-late.txt. Wait for completion before replying."
	cancelCtx, stopRun := context.WithCancel(context.Background())
	canceled := startClaudeLiveRun(t, cancelCtx, &executor, base)
	waitClaudeLiveFile(t, filepath.Join(workspace, "cancel-started.txt"), canceled)
	stopRun()
	terminal := canceled.wait(t)
	if terminal.Status != "aborted" && terminal.Status != "cancelled" {
		t.Fatalf("unexpected cancellation status: %s (%s)", terminal.Status, terminal.Error)
	}
	time.Sleep(11 * time.Second)
	if _, err := os.Stat(filepath.Join(workspace, "cancel-late.txt")); !os.IsNotExist(err) {
		t.Fatal("cancelled command wrote after cancellation")
	}
	executor = Executor{RuntimeHomeRoot: executor.RuntimeHomeRoot, TempBase: executor.TempBase}
	base.TaskID = "claude-live-restart-resume"
	base.Prompt = "Read baseline.txt and steered.txt using tools, then reply with the proof token and the word steered."
	restored := startClaudeLiveRun(t, context.Background(), &executor, base).wait(t)
	assertClaudeLiveCompleted(t, restored, created.SessionID, "LOCAL_CLAUDE_SNAPSHOT_REPLACED")
	if !strings.Contains(restored.Output, proof) {
		t.Fatal("post-cancel restart lost the native Session proof")
	}
	if _, err := os.Stat(filepath.Join(workspace, "steer-late.txt")); !os.IsNotExist(err) {
		t.Fatal("interrupted old turn command survived steer")
	}
	t.Log("PASS cancel, no delayed side effects, new executor resumes the original native Session")
}

type claudeLiveRun struct {
	execution *Execution
	mu        sync.Mutex
	events    []map[string]any
}

func startClaudeLiveRun(t *testing.T, ctx context.Context, executor *Executor, spec OperationSpec) *claudeLiveRun {
	t.Helper()
	ctx, cancel := context.WithCancel(ctx)
	t.Cleanup(cancel)
	run := &claudeLiveRun{}
	execution, err := executor.Start(ctx, spec, func(_ context.Context, event protocol.Event) error {
		var payload map[string]any
		if err := json.Unmarshal(event.Payload, &payload); err != nil {
			return err
		}
		run.mu.Lock()
		run.events = append(run.events, payload)
		run.mu.Unlock()
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	run.execution = execution
	return run
}

func (run *claudeLiveRun) wait(t *testing.T) Result {
	t.Helper()
	select {
	case result := <-run.execution.Result:
		return result
	case <-time.After(140 * time.Second):
		t.Fatal("Claude live execution did not terminate")
		return Result{}
	}
}

func (run *claudeLiveRun) hasTool(name string) bool {
	run.mu.Lock()
	defer run.mu.Unlock()
	for _, event := range run.events {
		if event["type"] == "tool.called" && event["tool_name"] == name {
			return true
		}
	}
	return false
}

func (run *claudeLiveRun) turn() string {
	run.mu.Lock()
	defer run.mu.Unlock()
	for _, event := range run.events {
		if event["type"] == "run.started" {
			turn, _ := event["turn_id"].(string)
			return turn
		}
	}
	return ""
}

func assertClaudeLiveCompleted(t *testing.T, result Result, sessionID, currentInstructionMarker string) {
	t.Helper()
	if result.Status != "completed" || result.SessionID != sessionID || !strings.Contains(result.Output, currentInstructionMarker) {
		t.Fatalf("Claude live result failed: status=%s session_matches=%t current_instructions_match=%t error=%s", result.Status, result.SessionID == sessionID, strings.Contains(result.Output, currentInstructionMarker), result.Error)
	}
}

func waitClaudeLiveFile(t *testing.T, path string, run *claudeLiveRun) {
	t.Helper()
	deadline := time.NewTimer(90 * time.Second)
	defer deadline.Stop()
	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			if _, err := os.Stat(path); err == nil {
				return
			}
		case result := <-run.execution.Result:
			t.Fatalf("Claude completed before starting the requested command: status=%s error=%s", result.Status, result.Error)
		case <-deadline.C:
			t.Fatal("Claude did not start the requested command")
		}
	}
}
