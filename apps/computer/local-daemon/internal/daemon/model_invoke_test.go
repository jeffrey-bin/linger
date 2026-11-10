package daemon

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/transport"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/protocol"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider"
)

// fakeModelInvoker holds each call until release or cancellation.
type fakeModelInvoker struct {
	mu       sync.Mutex
	started  chan provider.ModelInvokeRequest
	release  chan struct{}
	requests []provider.ModelInvokeRequest
}

func newFakeModelInvoker() *fakeModelInvoker {
	return &fakeModelInvoker{started: make(chan provider.ModelInvokeRequest, 8), release: make(chan struct{})}
}

func (f *fakeModelInvoker) Close() {}

func (f *fakeModelInvoker) Invoke(ctx context.Context, request provider.ModelInvokeRequest) provider.ModelInvokeResult {
	f.mu.Lock()
	f.requests = append(f.requests, request)
	f.mu.Unlock()
	f.started <- request
	select {
	case <-f.release:
		return provider.ModelInvokeResult{
			Outcome: provider.ModelInvokeCompleted, Text: `{"answer":"ok"}`, Model: "fixture-model", RuntimeVersion: "0.166.0",
			Usage: &provider.ModelInvokeUsage{InputTokens: 10, CachedInputTokens: 2, OutputTokens: 3},
		}
	case <-ctx.Done():
		return provider.ModelInvokeResult{Outcome: provider.ModelInvokeCanceled, Reason: "Model invocation was canceled"}
	}
}

func (f *fakeModelInvoker) calls() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.requests)
}

func modelInvokeFixture(t *testing.T, invoker ModelInvoker) (*Daemon, *fakeStream) {
	t.Helper()
	stream := &fakeStream{}
	d, err := newTestDaemon(t, Options{
		ComputerID: "computer-1", ControlPlane: fakeControlPlane{stream: stream}, IdentityStore: fakeStore{},
		OperationResolver: prepareOperationResolver{workingDirectory: t.TempDir()},
		ModelInvoker:      invoker,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(d.WaitForOperations)
	return d, stream
}

func modelInvokeCommand(invokeID string, payload map[string]any) protocol.Command {
	body := map[string]any{
		"invoke_id": invokeID, "mode": "structured", "reasoning_effort": "low", "instructions": "Answer.",
		"input": "Question", "output_schema": map[string]any{"type": "object"}, "timeout_ms": 30000,
	}
	for key, value := range payload {
		body[key] = value
	}
	return protocol.Command{
		Type: protocol.CommandModelInvoke, CommandID: "command-" + invokeID, ProtocolVersion: "1.2",
		RunnerID: "computer-1", ConnectionEpoch: 1, TenantID: "tenant-1", OwnerActorID: "owner-1", AgentID: "agent-1",
		RuntimeType: "codex", Payload: mustJSON(body),
	}
}

func waitForModelInvoked(t *testing.T, stream *fakeStream, invokeID string) map[string]any {
	t.Helper()
	watchdog := time.After(5 * time.Second)
	for {
		for _, event := range stream.snapshotEvents() {
			var payload map[string]any
			_ = json.Unmarshal(event.Payload, &payload)
			if event.Type == protocol.EventModelInvoked && payload["invoke_id"] == invokeID {
				return payload
			}
		}
		select {
		case <-watchdog:
			t.Fatalf("no model.invoked for %s", invokeID)
		case <-time.After(5 * time.Millisecond):
		}
	}
}

func TestModelInvokeRunsTheCallAndReportsItsResult(t *testing.T) {
	invoker := newFakeModelInvoker()
	d, stream := modelInvokeFixture(t, invoker)
	if err := d.handleModelInvoke(context.Background(), stream, modelInvokeCommand("invoke-1", map[string]any{"session_key": "permission-review:abc"})); err != nil {
		t.Fatal(err)
	}
	request := <-invoker.started
	if request.RuntimeType != "codex" || request.Mode != "structured" || request.ReasoningEffort != "low" ||
		request.Instructions != "Answer." || request.Input != "Question" || string(request.OutputSchema) != `{"type":"object"}` ||
		request.Timeout != 30*time.Second || request.SessionKey != "permission-review:abc" {
		t.Fatalf("request = %+v", request)
	}
	close(invoker.release)
	payload := waitForModelInvoked(t, stream, "invoke-1")
	if payload["outcome"] != "completed" || payload["text"] != `{"answer":"ok"}` || payload["model"] != "fixture-model" ||
		payload["runtime_version"] != "0.166.0" || payload["command_id"] != "command-invoke-1" || payload["runner_id"] != "computer-1" ||
		payload["reason"] != nil {
		t.Fatalf("payload = %v", payload)
	}
	usage, _ := payload["usage"].(map[string]any)
	if usage["input_tokens"] != float64(10) || usage["cached_input_tokens"] != float64(2) || usage["output_tokens"] != float64(3) {
		t.Fatalf("usage = %v", usage)
	}
}

func TestModelInvokeRunsEveryCallItReceives(t *testing.T) {
	invoker := newFakeModelInvoker()
	d, stream := modelInvokeFixture(t, invoker)
	// The Agent Service's scheduler bounds concurrency; the Daemon has no cap.
	running := make([]string, 0, 5)
	for index := range 5 {
		id := fmt.Sprintf("invoke-%d", index+1)
		if err := d.handleModelInvoke(context.Background(), stream, modelInvokeCommand(id, nil)); err != nil {
			t.Fatal(err)
		}
		<-invoker.started
		running = append(running, id)
	}
	close(invoker.release)
	for _, id := range running {
		if payload := waitForModelInvoked(t, stream, id); payload["outcome"] != "completed" {
			t.Fatalf("%s payload = %v", id, payload)
		}
	}
	if invoker.calls() != len(running) {
		t.Fatalf("calls = %d", invoker.calls())
	}
}

func TestModelInvokeIsCanceledByDisconnectAndDrain(t *testing.T) {
	for name, stop := range map[string]func(*Daemon, context.CancelFunc){
		"connection lost": func(_ *Daemon, cancelConnection context.CancelFunc) { cancelConnection() },
		"connection cleanup": func(d *Daemon, _ context.CancelFunc) {
			d.cancelModelInvokes("connection_lost")
		},
		"drain": func(d *Daemon, _ context.CancelFunc) { d.Drain(); d.WaitForOperations() },
	} {
		t.Run(name, func(t *testing.T) {
			invoker := newFakeModelInvoker()
			d, stream := modelInvokeFixture(t, invoker)
			connectionCtx, cancelConnection := context.WithCancel(context.Background())
			defer cancelConnection()
			if err := d.handleModelInvoke(connectionCtx, stream, modelInvokeCommand("invoke-stop", nil)); err != nil {
				t.Fatal(err)
			}
			<-invoker.started
			stop(d, cancelConnection)
			payload := waitForModelInvoked(t, stream, "invoke-stop")
			if payload["outcome"] != "canceled" || payload["text"] != nil {
				t.Fatalf("payload = %v", payload)
			}
			d.WaitForOperations()
			if len(d.modelInvokes) != 0 {
				t.Fatalf("in-flight calls = %v", d.modelInvokes)
			}
		})
	}
}

func TestModelInvokeRefusesWithoutRunningTheCall(t *testing.T) {
	for name, test := range map[string]struct {
		setup   func(*Daemon)
		payload map[string]any
		outcome string
	}{
		"draining":           {setup: func(d *Daemon) { d.draining = true }, outcome: "unavailable"},
		"locally stopped":    {setup: func(d *Daemon) { d.locallyStopped["agent-1"] = true }, outcome: "unavailable"},
		"structured without": {payload: map[string]any{"output_schema": nil}, outcome: "failed"},
		"unknown effort":     {payload: map[string]any{"reasoning_effort": "xhigh"}, outcome: "failed"},
		"text with files": {payload: map[string]any{
			"mode": "text", "workspace_files": []map[string]any{{"path": "a.md", "content_base64": "YQ=="}},
		}, outcome: "failed"},
	} {
		t.Run(name, func(t *testing.T) {
			invoker := newFakeModelInvoker()
			d, stream := modelInvokeFixture(t, invoker)
			if test.setup != nil {
				test.setup(d)
			}
			if err := d.handleModelInvoke(context.Background(), stream, modelInvokeCommand("invoke-refused", test.payload)); err != nil {
				t.Fatal(err)
			}
			if payload := waitForModelInvoked(t, stream, "invoke-refused"); payload["outcome"] != test.outcome || payload["reason"] == nil {
				t.Fatalf("payload = %v", payload)
			}
			if invoker.calls() != 0 {
				t.Fatal("a refused call ran")
			}
		})
	}
}

func TestModelInvokeWithoutAnInvokerAnswersRuntimeUnavailable(t *testing.T) {
	d, stream := modelInvokeFixture(t, nil)
	if err := d.handleModelInvoke(context.Background(), stream, modelInvokeCommand("invoke-none", nil)); err != nil {
		t.Fatal(err)
	}
	if payload := waitForModelInvoked(t, stream, "invoke-none"); payload["outcome"] != "runtime_unavailable" {
		t.Fatalf("payload = %v", payload)
	}
}

func TestModelInvokeCarriesWorkspaceFilesBothWays(t *testing.T) {
	invoker := &workspaceModelInvoker{}
	d, stream := modelInvokeFixture(t, invoker)
	command := modelInvokeCommand("invoke-files", map[string]any{
		"mode": "workspace", "output_schema": nil,
		"workspace_files": []map[string]any{{"path": "raw/a.md", "content_base64": "aGVsbG8="}},
	})
	if err := d.handleModelInvoke(context.Background(), stream, command); err != nil {
		t.Fatal(err)
	}
	payload := waitForModelInvoked(t, stream, "invoke-files")
	files, _ := payload["workspace_files"].([]any)
	if payload["outcome"] != "completed" || len(files) != 1 {
		t.Fatalf("payload = %v", payload)
	}
	file, _ := files[0].(map[string]any)
	if file["path"] != "pages/a.json" || file["content_base64"] != "e30=" {
		t.Fatalf("file = %v", file)
	}
	if len(invoker.request.WorkspaceFiles) != 1 || string(invoker.request.WorkspaceFiles[0].Content) != "hello" {
		t.Fatalf("request files = %+v", invoker.request.WorkspaceFiles)
	}
}

type workspaceModelInvoker struct{ request provider.ModelInvokeRequest }

func (w *workspaceModelInvoker) Close() {}

func (w *workspaceModelInvoker) Invoke(_ context.Context, request provider.ModelInvokeRequest) provider.ModelInvokeResult {
	w.request = request
	return provider.ModelInvokeResult{
		Outcome: provider.ModelInvokeCompleted, Text: "",
		WorkspaceFiles: []provider.ModelInvokeFile{{Path: "pages/a.json", Content: []byte("{}")}},
	}
}

// A reply within the text and tree bounds can still encode past the frame
// limit; it is reported as failed instead of closing the connection.
func TestModelInvokeDegradesAReplyLargerThanAFrame(t *testing.T) {
	invoker := &oversizedModelInvoker{}
	d, stream := modelInvokeFixture(t, invoker)
	if err := d.handleModelInvoke(context.Background(), stream, modelInvokeCommand("invoke-big", map[string]any{"mode": "text", "output_schema": nil})); err != nil {
		t.Fatal(err)
	}
	payload := waitForModelInvoked(t, stream, "invoke-big")
	if payload["outcome"] != "failed" || payload["text"] != nil || payload["workspace_files"] != nil ||
		!strings.Contains(fmt.Sprint(payload["reason"]), "frame limit") {
		t.Fatalf("payload outcome = %v reason = %v", payload["outcome"], payload["reason"])
	}
	for _, event := range stream.snapshotEvents() {
		if len(event.Payload) > transport.MaxFrameBytes {
			t.Fatalf("sent a %d byte frame", len(event.Payload))
		}
	}
}

type oversizedModelInvoker struct{}

func (oversizedModelInvoker) Close() {}

func (oversizedModelInvoker) Invoke(context.Context, provider.ModelInvokeRequest) provider.ModelInvokeResult {
	// Control characters escape to six bytes each in JSON.
	text := strings.Repeat("\x01", provider.ModelInvokeMaxTextBytes)
	files := []provider.ModelInvokeFile{{Path: "pages/a.json", Content: make([]byte, provider.ModelInvokeMaxWorkspaceBytes)}}
	return provider.ModelInvokeResult{Outcome: provider.ModelInvokeCompleted, Text: text, WorkspaceFiles: files}
}

// stoppedModelInvoker answers every call as a session call that stopped early.
type stoppedModelInvoker struct {
	request chan provider.ModelInvokeRequest
}

func (s stoppedModelInvoker) Close() {}

func (s stoppedModelInvoker) Invoke(_ context.Context, request provider.ModelInvokeRequest) provider.ModelInvokeResult {
	s.request <- request
	return provider.ModelInvokeResult{Outcome: provider.ModelInvokeOutputLimited, Reason: "Model reply exceeded its output limit", Text: `{"actions":[{"p`}
}

func TestModelInvokeCarriesTheCapAndWhatAStoppedCallStreamed(t *testing.T) {
	invoker := stoppedModelInvoker{request: make(chan provider.ModelInvokeRequest, 1)}
	d, stream := modelInvokeFixture(t, invoker)
	if err := d.handleModelInvoke(context.Background(), stream, modelInvokeCommand("invoke-1", map[string]any{"max_output_chars": 24000})); err != nil {
		t.Fatal(err)
	}
	if request := <-invoker.request; request.MaxOutputChars != 24000 {
		t.Fatalf("request = %+v", request)
	}
	payload := waitForModelInvoked(t, stream, "invoke-1")
	if payload["outcome"] != "output_limited" || payload["text"] != `{"actions":[{"p` || payload["reason"] != "Model reply exceeded its output limit" || payload["usage"] != nil {
		t.Fatalf("payload = %v", payload)
	}
}
