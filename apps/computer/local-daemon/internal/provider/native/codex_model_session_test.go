package native

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"
)

// modelSessionFake is an in-process app-server: it records every request
// and answers each turn with the scripted reply.
type modelSessionFake struct {
	mu       sync.Mutex
	out      io.Writer
	requests []map[string]any
	replies  map[string]any
	threads  int
	// next scripts the coming turns; an empty script answers "ok".
	next []modelSessionTurn
	// gate holds a gated turn open until it is closed.
	gate    chan struct{}
	started chan struct{}
	exited  chan struct{}
}

type modelSessionTurn struct {
	text   string
	input  int64
	status string
	gated  bool
	// ask sends an approval request before the answer.
	ask bool
	// retry sends an error Codex retries itself before the turn goes on.
	retry string
	// deltas stream the reply before the gate.
	deltas []string
}

func newModelSessionFake() *modelSessionFake {
	return &modelSessionFake{replies: map[string]any{}, gate: make(chan struct{}), started: make(chan struct{}, 8)}
}

// start is a CodexModelSessions start function that runs a fresh fake
// process on the shared recorder.
func (f *modelSessionFake) start(ctx context.Context, _ CodexModelRuntime) (*codexModelServer, error) {
	stdinR, stdinW := io.Pipe()
	stdoutR, stdoutW := io.Pipe()
	f.mu.Lock()
	f.out = stdoutW
	exited := make(chan struct{})
	f.exited = exited
	f.mu.Unlock()
	go func() {
		defer close(exited)
		defer stdoutW.Close()
		scanner := bufio.NewScanner(stdinR)
		scanner.Buffer(make([]byte, 0, 64<<10), 4<<20)
		for scanner.Scan() {
			var message map[string]any
			if json.Unmarshal(scanner.Bytes(), &message) != nil {
				continue
			}
			f.handle(stdoutW, message)
		}
	}()
	server := newCodexModelServer(newCodexTransport(stdinW), func() { _ = stdinR.Close() }, newErrorTail(nil, defaultStderrTail))
	go server.serve(func() error { <-exited; return nil }, stdoutR)
	if err := server.initialize(ctx); err != nil {
		server.stop()
		return nil, err
	}
	return server, nil
}

func (f *modelSessionFake) send(out io.Writer, message map[string]any) {
	message["jsonrpc"] = "2.0"
	line, _ := json.Marshal(message)
	_, _ = out.Write(append(line, '\n'))
}

func (f *modelSessionFake) handle(out io.Writer, message map[string]any) {
	method, _ := message["method"].(string)
	id, hasID := message["id"]
	f.mu.Lock()
	if method != "" {
		f.requests = append(f.requests, message)
	} else if hasID {
		f.replies[string(mustMarshal(id))] = message["result"]
	}
	f.mu.Unlock()
	params, _ := message["params"].(map[string]any)
	switch method {
	case "initialize", "thread/unsubscribe":
		f.send(out, map[string]any{"id": id, "result": map[string]any{}})
	case "thread/start":
		f.mu.Lock()
		f.threads++
		thread := "thread-" + string(rune('0'+f.threads))
		f.mu.Unlock()
		f.send(out, map[string]any{"id": id, "result": map[string]any{"thread": map[string]any{"id": thread}, "model": "gpt-fake"}})
	case "turn/start":
		thread, _ := params["threadId"].(string)
		f.mu.Lock()
		turn := modelSessionTurn{text: `{"ok":true}`, input: 1000, status: "completed"}
		if len(f.next) > 0 {
			turn, f.next = f.next[0], f.next[1:]
		}
		f.mu.Unlock()
		f.send(out, map[string]any{"id": id, "result": map[string]any{"turn": map[string]any{"id": "turn-1"}}})
		go f.finish(out, thread, turn)
	case "turn/interrupt":
		thread, _ := params["threadId"].(string)
		f.send(out, map[string]any{"id": id, "result": map[string]any{}})
		f.send(out, map[string]any{"method": "turn/completed", "params": map[string]any{"threadId": thread, "turn": map[string]any{"id": "turn-1", "status": "interrupted"}}})
	}
}

func (f *modelSessionFake) finish(out io.Writer, thread string, turn modelSessionTurn) {
	if turn.retry != "" {
		f.send(out, map[string]any{"method": "error", "params": map[string]any{"threadId": thread, "willRetry": true, "error": map[string]any{"message": turn.retry}}})
	}
	for _, delta := range turn.deltas {
		f.send(out, map[string]any{"method": "item/agentMessage/delta", "params": map[string]any{"threadId": thread, "itemId": "item-1", "delta": delta}})
	}
	f.started <- struct{}{}
	if turn.gated {
		<-f.gate
	}
	if turn.ask {
		f.send(out, map[string]any{"id": 99, "method": "item/commandExecution/requestApproval", "params": map[string]any{"threadId": thread}})
	}
	if turn.status == "" {
		turn.status = "completed"
	}
	f.send(out, map[string]any{"method": "item/completed", "params": map[string]any{"threadId": thread, "item": map[string]any{"type": "agentMessage", "text": turn.text, "phase": "final_answer"}}})
	f.send(out, map[string]any{"method": "thread/tokenUsage/updated", "params": map[string]any{"threadId": thread, "tokenUsage": map[string]any{
		"total": map[string]any{"inputTokens": turn.input, "cachedInputTokens": 0, "outputTokens": 10},
		"last":  map[string]any{"inputTokens": turn.input, "cachedInputTokens": turn.input - 100, "outputTokens": 10},
	}}})
	f.send(out, map[string]any{"method": "turn/completed", "params": map[string]any{"threadId": thread, "turn": map[string]any{"id": "turn-1", "status": turn.status}}})
}

func (f *modelSessionFake) methods(method string) []map[string]any {
	f.mu.Lock()
	defer f.mu.Unlock()
	var found []map[string]any
	for _, request := range f.requests {
		if request["method"] == method {
			found = append(found, request)
		}
	}
	return found
}

func (f *modelSessionFake) script(turns ...modelSessionTurn) {
	f.mu.Lock()
	f.next = append(f.next, turns...)
	f.mu.Unlock()
}

func mustMarshal(value any) []byte {
	encoded, _ := json.Marshal(value)
	return encoded
}

func modelSessionCall(session string) CodexModelCall {
	return CodexModelCall{
		Session: session, Instructions: "You judge permissions.", Input: "<action/>",
		OutputSchema: json.RawMessage(`{"type":"object"}`), Effort: "low",
	}
}

func newTestModelSessions(fake *modelSessionFake) *CodexModelSessions {
	sessions := &CodexModelSessions{start: fake.start}
	return sessions
}

func TestCodexModelSessionsKeepOneThreadPerSession(t *testing.T) {
	fake := newModelSessionFake()
	sessions := newTestModelSessions(fake)
	defer sessions.Close()
	runtime := CodexModelRuntime{Executable: "codex", Version: "0.165.0", Dir: "/work"}
	for range 2 {
		answer, err := sessions.Run(context.Background(), runtime, modelSessionCall("context-a"))
		if err != nil || answer.Text != `{"ok":true}` || answer.Model != "gpt-fake" || answer.Input != 1000 || answer.CachedInput != 900 || answer.Output != 10 {
			t.Fatalf("answer %+v err=%v", answer, err)
		}
	}
	starts := fake.methods("thread/start")
	if len(starts) != 1 || len(fake.methods("turn/start")) != 2 {
		t.Fatalf("thread/start %d, turn/start %d", len(starts), len(fake.methods("turn/start")))
	}
	params := starts[0]["params"].(map[string]any)
	if params["baseInstructions"] != "You judge permissions." || params["approvalPolicy"] != "never" || params["sandbox"] != "read-only" || params["ephemeral"] != true || params["cwd"] != "/work" {
		t.Fatalf("thread/start params %v", params)
	}
	turn := fake.methods("turn/start")[0]["params"].(map[string]any)
	if turn["effort"] != "low" || turn["outputSchema"].(map[string]any)["type"] != "object" {
		t.Fatalf("turn/start params %v", turn)
	}
	if input := turn["input"].([]any)[0].(map[string]any); input["text"] != "<action/>" {
		t.Fatalf("turn input %v", input)
	}
	// Another session, and changed instructions, each get their own thread.
	if _, err := sessions.Run(context.Background(), runtime, modelSessionCall("context-b")); err != nil {
		t.Fatal(err)
	}
	changed := modelSessionCall("context-a")
	changed.Instructions = "A newer policy."
	if _, err := sessions.Run(context.Background(), runtime, changed); err != nil {
		t.Fatal(err)
	}
	if got := len(fake.methods("thread/start")); got != 3 {
		t.Fatalf("thread/start %d, want 3", got)
	}
}

func TestCodexModelSessionsReportABusyThread(t *testing.T) {
	fake := newModelSessionFake()
	sessions := newTestModelSessions(fake)
	defer sessions.Close()
	fake.script(modelSessionTurn{text: `{"ok":1}`, input: 100, gated: true})
	done := make(chan error, 1)
	go func() {
		_, err := sessions.Run(context.Background(), CodexModelRuntime{}, modelSessionCall("context-a"))
		done <- err
	}()
	<-fake.started
	if _, err := sessions.Run(context.Background(), CodexModelRuntime{}, modelSessionCall("context-a")); !errors.Is(err, ErrCodexModelSessionBusy) {
		t.Fatalf("second call of a busy session: %v", err)
	}
	if _, err := sessions.Run(context.Background(), CodexModelRuntime{}, modelSessionCall("context-b")); err != nil {
		t.Fatalf("another session waited for the busy one: %v", err)
	}
	close(fake.gate)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestCodexModelSessionsRetireLargeAndFailedThreads(t *testing.T) {
	fake := newModelSessionFake()
	sessions := newTestModelSessions(fake)
	sessions.MaxInputTokens = 5000
	defer sessions.Close()
	fake.script(
		modelSessionTurn{text: `{"ok":1}`, input: 6000},
		modelSessionTurn{status: "failed"},
		modelSessionTurn{text: `{"ok":2}`, input: 100},
	)
	for _, wantErr := range []bool{false, true, false} {
		if _, err := sessions.Run(context.Background(), CodexModelRuntime{}, modelSessionCall("context-a")); (err != nil) != wantErr {
			t.Fatalf("err=%v, want error %v", err, wantErr)
		}
	}
	if got := len(fake.methods("thread/start")); got != 3 {
		t.Fatalf("thread/start %d, want a new thread after the large and the failed turn", got)
	}
	deadline := time.Now().Add(2 * time.Second)
	for len(fake.methods("thread/unsubscribe")) < 2 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if got := len(fake.methods("thread/unsubscribe")); got != 2 {
		t.Fatalf("thread/unsubscribe %d, want 2", got)
	}
}

func TestCodexModelSessionsRestartAfterIdleAndExit(t *testing.T) {
	fake := newModelSessionFake()
	sessions := newTestModelSessions(fake)
	sessions.Idle = 20 * time.Millisecond
	defer sessions.Close()
	if _, err := sessions.Run(context.Background(), CodexModelRuntime{}, modelSessionCall("context-a")); err != nil {
		t.Fatal(err)
	}
	fake.mu.Lock()
	exited := fake.exited
	fake.mu.Unlock()
	select {
	case <-exited:
	case <-time.After(2 * time.Second):
		t.Fatal("the idle process did not stop")
	}
	sessions.mu.Lock()
	sessions.Idle = time.Hour
	sessions.mu.Unlock()
	if _, err := sessions.Run(context.Background(), CodexModelRuntime{}, modelSessionCall("context-a")); err != nil {
		t.Fatal(err)
	}
	if got := len(fake.methods("initialize")); got != 2 {
		t.Fatalf("initialize %d, want a second process", got)
	}
	// A process that exits on its own is replaced as well.
	sessions.mu.Lock()
	server := sessions.server
	sessions.mu.Unlock()
	server.transport.closeInput()
	<-server.exited
	if _, err := sessions.Run(context.Background(), CodexModelRuntime{}, modelSessionCall("context-a")); err != nil {
		t.Fatal(err)
	}
	if got := len(fake.methods("initialize")); got != 3 {
		t.Fatalf("initialize %d, want a third process", got)
	}
	// Another Codex version also starts a new process.
	if _, err := sessions.Run(context.Background(), CodexModelRuntime{Version: "0.166.0"}, modelSessionCall("context-a")); err != nil {
		t.Fatal(err)
	}
	if got := len(fake.methods("initialize")); got != 4 {
		t.Fatalf("initialize %d, want a fourth process", got)
	}
}

func TestCodexModelSessionsDeclineServerRequestsAndInterruptOnCancel(t *testing.T) {
	fake := newModelSessionFake()
	sessions := newTestModelSessions(fake)
	defer sessions.Close()
	fake.script(modelSessionTurn{text: `{"ok":1}`, input: 100, ask: true})
	if _, err := sessions.Run(context.Background(), CodexModelRuntime{}, modelSessionCall("context-a")); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		fake.mu.Lock()
		reply, ok := fake.replies["99"]
		fake.mu.Unlock()
		if ok {
			if decision := reply.(map[string]any)["decision"]; decision != "decline" {
				t.Fatalf("approval answered %v", reply)
			}
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	fake.mu.Lock()
	_, answered := fake.replies["99"]
	fake.mu.Unlock()
	if !answered {
		t.Fatal("the approval request was not answered")
	}

	fake.script(modelSessionTurn{text: `{"ok":2}`, input: 100, gated: true})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		_, err := sessions.Run(ctx, CodexModelRuntime{}, modelSessionCall("context-a"))
		done <- err
	}()
	<-fake.started
	<-fake.started
	// Let the turn/start reply arrive, so the call knows which turn to
	// interrupt.
	time.Sleep(100 * time.Millisecond)
	cancel()
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled call: %v", err)
	}
	if got := fake.methods("turn/interrupt"); len(got) != 1 || !strings.HasPrefix(got[0]["params"].(map[string]any)["threadId"].(string), "thread-") {
		t.Fatalf("turn/interrupt %v", got)
	}
	close(fake.gate)
}

func TestCodexModelSessionsLogARetryingAndUnfinishedTurn(t *testing.T) {
	var logs bytes.Buffer
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logs, nil)))
	defer slog.SetDefault(previous)
	fake := newModelSessionFake()
	sessions := newTestModelSessions(fake)
	defer sessions.Close()
	defer close(fake.gate)
	fake.script(modelSessionTurn{text: `{"ok":1}`, input: 100, gated: true, retry: "stream disconnected; retrying 1/5"})
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	if _, err := sessions.Run(ctx, CodexModelRuntime{}, modelSessionCall("context-a")); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("timed-out call: %v", err)
	}
	text := logs.String()
	for _, want := range []string{
		`phase=codex_retrying`, `message="stream disconnected; retrying 1/5"`,
		`phase=turn_unfinished`, `last_event=error`, `quiet_ms=`,
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("log lacks %s:\n%s", want, text)
		}
	}
}

func TestCodexModelSessionsInterruptAReplyPastItsOutputLimit(t *testing.T) {
	fake := newModelSessionFake()
	sessions := newTestModelSessions(fake)
	defer sessions.Close()
	defer close(fake.gate)
	fake.script(modelSessionTurn{text: `{"ok":1}`, input: 100, gated: true, deltas: []string{"ab", "abababababab", "abababababab"}})
	call := modelSessionCall("context-a")
	call.MaxOutputChars = 20
	answer, err := sessions.Run(context.Background(), CodexModelRuntime{}, call)
	if !errors.Is(err, ErrCodexModelOutputLimit) {
		t.Fatalf("over-limit call: %v", err)
	}
	if answer.Text != "ab"+strings.Repeat("ab", 12) {
		t.Fatalf("partial reply %q", answer.Text)
	}
	if got := fake.methods("turn/interrupt"); len(got) != 1 {
		t.Fatalf("turn/interrupt %v", got)
	}
	// The interrupted thread is retired; the next call starts a new one.
	if _, err := sessions.Run(context.Background(), CodexModelRuntime{}, modelSessionCall("context-a")); err != nil {
		t.Fatal(err)
	}
	if got := fake.methods("thread/start"); len(got) != 2 {
		t.Fatalf("thread/start %d", len(got))
	}
}

// A structured reply whose schema forbids what the model wants to write next
// can stream whitespace until its output limit; with no cap it is stopped
// after a run of codexModelBlankRun.
func TestCodexModelSessionsInterruptAReplyStuckOnWhitespace(t *testing.T) {
	fake := newModelSessionFake()
	sessions := newTestModelSessions(fake)
	defer sessions.Close()
	defer close(fake.gate)
	blank := strings.Repeat(" \n", codexModelBlankRun/4)
	fake.script(modelSessionTurn{text: `{"ok":1}`, input: 100, gated: true, deltas: []string{`{"relations":{"clients":[]`, blank, blank, blank}})
	answer, err := sessions.Run(context.Background(), CodexModelRuntime{}, modelSessionCall("context-a"))
	if !errors.Is(err, ErrCodexModelOutputLimit) {
		t.Fatalf("whitespace reply: %v", err)
	}
	if !strings.HasPrefix(answer.Text, `{"relations":{"clients":[]`) || len(answer.Text) < codexModelBlankRun {
		t.Fatalf("partial reply %q", answer.Text[:min(len(answer.Text), 40)])
	}
	if got := fake.methods("turn/interrupt"); len(got) != 1 {
		t.Fatalf("turn/interrupt %v", got)
	}
}

// Whitespace between content resets the run, so a reply with shorter runs
// finishes.
func TestCodexModelSessionsKeepAReplyWithShortWhitespaceRuns(t *testing.T) {
	fake := newModelSessionFake()
	sessions := newTestModelSessions(fake)
	defer sessions.Close()
	gap := strings.Repeat(" ", codexModelBlankRun-1)
	fake.script(modelSessionTurn{text: `{"ok":1}`, input: 100, deltas: []string{"{", gap, `"ok":`, gap, "1}"}})
	if _, err := sessions.Run(context.Background(), CodexModelRuntime{}, modelSessionCall("context-a")); err != nil {
		t.Fatalf("reply with short runs: %v", err)
	}
	if got := fake.methods("turn/interrupt"); len(got) != 0 {
		t.Fatalf("turn/interrupt %v", got)
	}
}

func TestCodexModelSessionsReturnWhatATimedOutTurnStreamed(t *testing.T) {
	fake := newModelSessionFake()
	sessions := newTestModelSessions(fake)
	defer sessions.Close()
	defer close(fake.gate)
	fake.script(modelSessionTurn{text: `{"ok":1}`, input: 100, gated: true, deltas: []string{"{\"actions\":", " [ ]"}})
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	answer, err := sessions.Run(ctx, CodexModelRuntime{}, modelSessionCall("context-a"))
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("timed-out call: %v", err)
	}
	if answer.Text != `{"actions": [ ]` {
		t.Fatalf("partial reply %q", answer.Text)
	}
}

func TestTruncateBytesKeepsWholeRunes(t *testing.T) {
	if got := truncateBytes("abあい", 4); got != "ab" {
		t.Fatalf("truncateBytes %q", got)
	}
	if got := truncateBytes("abあい", 5); got != "abあ" {
		t.Fatalf("truncateBytes %q", got)
	}
}
