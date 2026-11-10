package native

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/process"
)

const (
	codexModelSessionIdle = 10 * time.Minute
	// codexModelSessionMaxInput retires a thread once one turn's prompt
	// reaches it, so a session's history never crowds the context window.
	codexModelSessionMaxInput  int64 = 150_000
	codexModelSessionStartup         = 30 * time.Second
	codexModelSessionStopGrace       = 3 * time.Second
)

// ErrCodexModelSessionBusy reports that the session's thread is answering
// another call. The caller runs this one on its own.
var ErrCodexModelSessionBusy = errors.New("Codex model session is busy")

// ErrCodexModelOutputLimit means the turn streamed more than its call's
// MaxOutputChars and was interrupted; the answer carries what it streamed.
var ErrCodexModelOutputLimit = errors.New("Codex model reply exceeded its output limit")

// codexModelPartialBytes bounds the streamed text kept for a call that stops
// early, so its receipt stays far below the frame limit.
const codexModelPartialBytes = 256 << 10

// codexModelBlankRun stops a reply that streams this many whitespace
// characters in a row. JSON allows whitespace between any two tokens, so a
// structured reply whose schema forbids what the model wants to write next
// can stream nothing else until its output limit; a real reply never holds a
// run this long.
const codexModelBlankRun = 2048

// CodexModelRuntime is the installed Codex a session process runs.
type CodexModelRuntime struct {
	Executable string
	Version    string
	// Model is the configured default model; a change starts a new process.
	Model string
	// Environment is the child environment. Its CODEX_HOME is a home only
	// session calls use.
	Environment map[string]string
	// Dir is the empty working directory of the process and its threads.
	Dir string
	// Args are launch options after the app-server's own.
	Args []string
}

// CodexModelCall is one structured call in a session.
type CodexModelCall struct {
	Session      string
	Instructions string
	Input        string
	OutputSchema json.RawMessage
	Effort       string
	// MaxOutputChars interrupts the turn once its streamed reply passes this
	// many characters; zero is no cap.
	MaxOutputChars int
}

// CodexModelAnswer is the final message of a session call and the token
// usage of its one request.
type CodexModelAnswer struct {
	Text                       string
	Model                      string
	Input, CachedInput, Output int64
}

// CodexModelSessions runs the model calls that name a session on one Codex
// app-server, one thread per session. A thread holds the call's instructions
// as its base instructions and sees each call as a new turn, so the provider
// serves the unchanged prompt prefix from its cache. The process starts with
// the first call and exits after Idle without one.
type CodexModelSessions struct {
	// Idle stops the process after this long without a call; zero uses ten
	// minutes.
	Idle time.Duration
	// MaxInputTokens retires a thread once a turn's prompt reaches it; zero
	// uses 150,000.
	MaxInputTokens int64

	// start launches the app-server; nil starts the Runtime's executable.
	start func(ctx context.Context, runtime CodexModelRuntime) (*codexModelServer, error)

	mu       sync.Mutex
	server   *codexModelServer
	threads  map[string]*codexModelThread
	idle     *time.Timer
	idleTurn int
}

type codexModelThread struct {
	server *codexModelServer
	id     string
	model  string
	busy   bool
}

// Run answers one call in its session's thread, starting the process and the
// thread when needed. A failed call drops the thread; the next call of the
// session starts a new one.
func (s *CodexModelSessions) Run(ctx context.Context, runtime CodexModelRuntime, call CodexModelCall) (CodexModelAnswer, error) {
	key := codexModelThreadKey(call)
	s.mu.Lock()
	thread := s.threads[key]
	if thread != nil && thread.busy {
		s.mu.Unlock()
		return CodexModelAnswer{}, ErrCodexModelSessionBusy
	}
	s.stopIdleLocked()
	server, err := s.serverLocked(ctx, runtime)
	if err != nil {
		s.armIdleLocked()
		s.mu.Unlock()
		return CodexModelAnswer{}, err
	}
	if thread == nil || thread.server != server {
		thread = &codexModelThread{server: server}
		s.threads[key] = thread
	}
	thread.busy = true
	s.mu.Unlock()

	answer, err := thread.answer(ctx, runtime.Dir, call)

	s.mu.Lock()
	thread.busy = false
	if (err != nil || answer.Input >= s.maxInput()) && s.threads[key] == thread {
		delete(s.threads, key)
		if thread.id != "" && !server.gone() {
			go server.unsubscribe(thread.id)
		}
	}
	s.armIdleLocked()
	s.mu.Unlock()
	return answer, err
}

// Close stops the process. A later call starts a new one.
func (s *CodexModelSessions) Close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.stopIdleLocked()
	s.retireLocked()
}

func (s *CodexModelSessions) maxInput() int64 {
	if s.MaxInputTokens > 0 {
		return s.MaxInputTokens
	}
	return codexModelSessionMaxInput
}

// codexModelThreadKey separates sessions, and calls of one session whose
// instructions, schema, or effort differ, such as after a policy change.
func codexModelThreadKey(call CodexModelCall) string {
	digest := sha256.New()
	for _, part := range []string{call.Session, call.Instructions, string(call.OutputSchema), call.Effort} {
		_, _ = fmt.Fprintf(digest, "%d:%s", len(part), part)
	}
	return hex.EncodeToString(digest.Sum(nil))
}

// serverLocked returns the running process for runtime, replacing one that
// exited or runs another Codex, home, or model.
func (s *CodexModelSessions) serverLocked(ctx context.Context, runtime CodexModelRuntime) (*codexModelServer, error) {
	identity := strings.Join([]string{runtime.Executable, runtime.Version, runtime.Environment["CODEX_HOME"], runtime.Model}, "\x00")
	if s.server != nil && (s.server.identity != identity || s.server.gone()) {
		s.retireLocked()
	}
	if s.server != nil {
		return s.server, nil
	}
	start := s.start
	if start == nil {
		start = startCodexModelServer
	}
	server, err := start(ctx, runtime)
	if err != nil {
		return nil, err
	}
	server.identity = identity
	s.server, s.threads = server, map[string]*codexModelThread{}
	return server, nil
}

// retireLocked stops the process; a turn still running on it fails.
func (s *CodexModelSessions) retireLocked() {
	if s.server == nil {
		return
	}
	server := s.server
	s.server, s.threads = nil, nil
	server.stop()
}

func (s *CodexModelSessions) stopIdleLocked() {
	s.idleTurn++
	if s.idle != nil {
		s.idle.Stop()
		s.idle = nil
	}
}

// armIdleLocked schedules the idle stop once no thread is busy. A timer that
// fired while a call held the lock sees a newer turn and does nothing.
func (s *CodexModelSessions) armIdleLocked() {
	if s.server == nil {
		return
	}
	for _, thread := range s.threads {
		if thread.busy {
			return
		}
	}
	idle := s.Idle
	if idle <= 0 {
		idle = codexModelSessionIdle
	}
	s.idleTurn++
	turn := s.idleTurn
	s.idle = time.AfterFunc(idle, func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.idleTurn == turn {
			s.idle = nil
			s.retireLocked()
		}
	})
}

// answer runs one turn, first starting the thread with the instructions.
func (t *codexModelThread) answer(ctx context.Context, dir string, call CodexModelCall) (CodexModelAnswer, error) {
	if t.id == "" {
		id, model, err := t.server.startThread(ctx, dir, call.Instructions)
		if err != nil {
			return CodexModelAnswer{}, err
		}
		t.id, t.model = id, model
	}
	answer, err := t.server.runTurn(ctx, t.id, call)
	answer.Model = t.model
	return answer, err
}

// codexModelServer is one app-server process that only answers session
// calls.
type codexModelServer struct {
	identity  string
	cancel    context.CancelFunc
	transport *codexTransport
	stderr    *errorTail
	exited    chan struct{}

	mu    sync.Mutex
	turns map[string]*codexModelTurn
}

func startCodexModelServer(ctx context.Context, runtime CodexModelRuntime) (*codexModelServer, error) {
	procCtx, cancel := context.WithCancel(context.Background())
	cmd := ownedCommand(procCtx, profileInvocation(runtime.Executable, nil, runtime.Environment), CodexAppServerArgs(runtime.Version, runtime.Args...)...)
	cmd.Dir = runtime.Dir
	cmd.WaitDelay = codexPipeDrainGrace
	stdin, err := cmd.StdinPipe()
	if err != nil {
		cancel()
		return nil, fmt.Errorf("start Codex: %w", err)
	}
	stdoutR, stdoutW, err := os.Pipe()
	if err != nil {
		cancel()
		return nil, fmt.Errorf("start Codex: %w", err)
	}
	stderr := newErrorTail(nil, defaultStderrTail)
	cmd.Stdout, cmd.Stderr = stdoutW, stderr
	err = process.Start(cmd)
	_ = stdoutW.Close()
	if err != nil {
		cancel()
		_ = stdoutR.Close()
		return nil, fmt.Errorf("start Codex: %w", ExplainExecError(err))
	}
	server := newCodexModelServer(newCodexTransport(stdin), cancel, stderr)
	go server.serve(cmd.Wait, stdoutR)
	if err := server.initialize(ctx); err != nil {
		server.stop()
		return nil, err
	}
	return server, nil
}

func newCodexModelServer(transport *codexTransport, cancel context.CancelFunc, stderr *errorTail) *codexModelServer {
	server := &codexModelServer{
		cancel: cancel, transport: transport, stderr: stderr,
		exited: make(chan struct{}), turns: map[string]*codexModelTurn{},
	}
	transport.noticeHook = server.notice
	transport.serverCallHook = server.decline
	return server
}

// serve reads the process until it exits. A descendant holding stdout must
// not keep the transport alive past the leader.
func (s *codexModelServer) serve(wait func() error, stdout io.ReadCloser) {
	read := make(chan struct{})
	go func() {
		defer close(read)
		s.transport.readLoop(stdout)
		_ = stdout.Close()
	}()
	_ = wait()
	select {
	case <-read:
	case <-time.After(codexModelSessionStopGrace):
		s.transport.fail(errCodexChildGone)
	}
	s.cancel()
	close(s.exited)
}

func (s *codexModelServer) gone() bool {
	select {
	case <-s.exited:
		return true
	default:
		return s.transport.isDead()
	}
}

// stop closes stdin, which ends the app-server, and kills its process group
// if it lingers.
func (s *codexModelServer) stop() {
	s.transport.closeInput()
	select {
	case <-s.exited:
	case <-time.After(codexModelSessionStopGrace):
		s.cancel()
		<-s.exited
	}
}

func (s *codexModelServer) initialize(ctx context.Context) error {
	params := map[string]any{
		"clientInfo":   map[string]any{"name": "linger-computer", "title": "Linger Computer", "version": "1"},
		"capabilities": map[string]any{"experimentalApi": true},
	}
	if _, _, err := s.transport.call(ctx, "initialize", params, codexModelSessionStartup, nil); err != nil {
		return s.failure("codex initialize failed", err)
	}
	if err := s.transport.notify(ctx, "initialized"); err != nil {
		return s.failure("codex initialize failed", err)
	}
	return nil
}

// startThread opens an ephemeral read-only thread whose base instructions
// replace Codex's own, and that never asks for approval.
func (s *codexModelServer) startThread(ctx context.Context, dir, instructions string) (string, string, error) {
	params := map[string]any{
		"cwd": dir, "baseInstructions": instructions, "approvalPolicy": "never",
		"sandbox": "read-only", "ephemeral": true,
	}
	result, _, err := s.transport.call(ctx, "thread/start", params, codexModelSessionStartup, nil)
	if err != nil {
		return "", "", s.failure("codex thread/start failed", err)
	}
	var started struct {
		Thread struct {
			ID string `json:"id"`
		} `json:"thread"`
		Model string `json:"model"`
	}
	if json.Unmarshal(result, &started) != nil || started.Thread.ID == "" {
		return "", "", errors.New("codex thread/start returned no thread")
	}
	return started.Thread.ID, started.Model, nil
}

// runTurn sends the input as one turn and waits for its final message.
// Ending ctx interrupts the turn.
func (s *codexModelServer) runTurn(ctx context.Context, threadID string, call CodexModelCall) (CodexModelAnswer, error) {
	turn := &codexModelTurn{done: make(chan struct{}), overflow: make(chan struct{}), started: time.Now(), maxChars: call.MaxOutputChars}
	s.mu.Lock()
	s.turns[threadID] = turn
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		delete(s.turns, threadID)
		s.mu.Unlock()
	}()
	params := map[string]any{
		"threadId":     threadID,
		"input":        []any{map[string]any{"type": "text", "text": call.Input}},
		"outputSchema": call.OutputSchema,
		"effort":       call.Effort,
	}
	result, _, err := s.transport.call(ctx, "turn/start", params, 0, nil)
	if err != nil {
		return CodexModelAnswer{}, s.failure("codex turn/start failed", err)
	}
	var started struct {
		Turn struct {
			ID string `json:"id"`
		} `json:"turn"`
	}
	_ = json.Unmarshal(result, &started)
	interrupt := func() {
		if started.Turn.ID != "" {
			interruptCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), codexModelSessionStopGrace)
			_, _, _ = s.transport.call(interruptCtx, "turn/interrupt", map[string]any{"threadId": threadID, "turnId": started.Turn.ID}, 0, nil)
			cancel()
		}
	}
	select {
	case <-turn.done:
	case <-turn.overflow:
		slog.Warn("runner.model.session", "phase", "output_limited", "thread_id", threadID,
			"max_output_chars", call.MaxOutputChars, "blank_run", turn.blankRunReached())
		interrupt()
		return CodexModelAnswer{Text: turn.partial()}, ErrCodexModelOutputLimit
	case <-ctx.Done():
		// The log keeps what the turn last did, to tell a stalled stream from
		// a slow one; the answer carries what it streamed.
		method, quiet := turn.last()
		slog.Warn("runner.model.session", "phase", "turn_unfinished", "thread_id", threadID,
			"last_event", method, "quiet_ms", quiet.Milliseconds(), "cause", context.Cause(ctx))
		interrupt()
		return CodexModelAnswer{Text: turn.partial()}, context.Cause(ctx)
	case <-s.transport.dead:
		return CodexModelAnswer{}, s.failure("codex turn failed", s.transport.err())
	}
	return turn.result()
}

// unsubscribe unloads a retired thread without waiting on the caller.
func (s *codexModelServer) unsubscribe(threadID string) {
	ctx, cancel := context.WithTimeout(context.Background(), codexModelSessionStopGrace)
	defer cancel()
	_, _, _ = s.transport.call(ctx, "thread/unsubscribe", map[string]any{"threadId": threadID}, 0, nil)
}

// failure adds what Codex wrote to stderr, which names auth and version
// problems the RPC error does not.
func (s *codexModelServer) failure(step string, err error) error {
	if tail := strings.TrimSpace(s.stderr.Tail()); tail != "" {
		return fmt.Errorf("%s: %w: %s", step, err, tail)
	}
	return fmt.Errorf("%s: %w", step, err)
}

func (s *codexModelServer) notice(method string, params json.RawMessage) {
	var n codexNotification
	if json.Unmarshal(params, &n) != nil {
		return
	}
	s.mu.Lock()
	turn := s.turns[n.ThreadID]
	s.mu.Unlock()
	if turn != nil {
		turn.observe(method, &n)
	}
}

// decline refuses every request the app-server makes: a session call has
// no tools, and nobody is there to approve or answer anything.
func (s *codexModelServer) decline(id json.RawMessage, method string, _ json.RawMessage) {
	switch method {
	case "item/commandExecution/requestApproval", "execCommandApproval", "item/fileChange/requestApproval", "applyPatchApproval":
		s.transport.reply(id, map[string]any{"decision": "decline"}, nil)
	case "item/permissions/requestApproval":
		s.transport.reply(id, map[string]any{"permissions": map[string]any{}, "scope": "turn"}, nil)
	case "mcpServer/elicitation/request":
		s.transport.reply(id, map[string]any{"action": "decline", "content": nil, "_meta": nil}, nil)
	default:
		s.transport.reply(id, nil, &codexRPCError{Code: -32601, Message: "unsupported codex app-server request: " + method})
	}
}

// codexModelTurn collects one turn's final message, usage, and failure.
type codexModelTurn struct {
	mu        sync.Mutex
	text      string
	usage     codexUsage
	failure   string
	done      chan struct{}
	closed    bool
	started   time.Time
	lastEvent string
	lastAt    time.Time
	// maxChars, streamed and overflow cap the reply; streamedText keeps its
	// first codexModelPartialBytes for a call that stops early. blankRun
	// counts the whitespace the reply has streamed since its last other
	// character.
	maxChars     int
	streamed     int
	blankRun     int
	blankStop    bool
	streamedText strings.Builder
	overflow     chan struct{}
	overflowed   bool
}

// blankRunReached reports whether the reply was stopped for a whitespace run.
func (t *codexModelTurn) blankRunReached() bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.blankStop
}

// partial is the reply streamed so far.
func (t *codexModelTurn) partial() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.streamedText.String()
}

// last names the turn's latest event and how long it has been quiet since.
func (t *codexModelTurn) last() (string, time.Duration) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.lastAt.IsZero() {
		return "", time.Since(t.started)
	}
	return t.lastEvent, time.Since(t.lastAt)
}

func (t *codexModelTurn) observe(method string, n *codexNotification) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.lastEvent, t.lastAt = method, time.Now()
	switch method {
	case "item/agentMessage/delta":
		if room := codexModelPartialBytes - t.streamedText.Len(); room > 0 {
			t.streamedText.WriteString(truncateBytes(n.Delta, room))
		}
		t.streamed += utf8.RuneCountInString(n.Delta)
		for _, r := range n.Delta {
			if unicode.IsSpace(r) {
				t.blankRun++
			} else {
				t.blankRun = 0
			}
		}
		if t.blankRun >= codexModelBlankRun {
			t.blankStop = true
		}
		if (t.blankStop || t.maxChars > 0 && t.streamed > t.maxChars) && !t.overflowed {
			t.overflowed = true
			close(t.overflow)
		}
	case "item/completed":
		if n.Item.Type == "agentMessage" && n.Item.Text != "" && (n.Item.Phase == nil || *n.Item.Phase == "final_answer") {
			t.text = n.Item.Text
		}
	case "thread/tokenUsage/updated":
		var usage struct {
			Last json.RawMessage `json:"last"`
		}
		if json.Unmarshal(n.TokenUsage, &usage) == nil {
			if last, ok := codexCamelUsage(usage.Last); ok {
				t.usage = last
			}
		}
	case "error":
		if n.Error != nil && n.Error.Message != "" && !n.WillRetry {
			t.failure = n.Error.Message
		}
		// Codex retries a dropped stream or a rate limit itself; the turn
		// is quiet meanwhile, so each retry is logged.
		if n.Error != nil && n.WillRetry {
			slog.Warn("runner.model.session", "phase", "codex_retrying", "thread_id", n.ThreadID,
				"message", firstRunes(sanitizeDiagnostic(n.Error.Message), 300))
		}
	case "turn/completed":
		if n.Turn.Status != "completed" && t.failure == "" {
			t.failure = "Codex turn " + n.Turn.Status
			if n.Turn.Error != nil && n.Turn.Error.Message != "" {
				t.failure = n.Turn.Error.Message
			}
		}
		if !t.closed {
			t.closed = true
			close(t.done)
		}
	}
}

func (t *codexModelTurn) result() (CodexModelAnswer, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.failure != "" {
		return CodexModelAnswer{}, errors.New(t.failure)
	}
	if strings.TrimSpace(t.text) == "" {
		return CodexModelAnswer{}, errors.New("Runtime exited without a reply")
	}
	return CodexModelAnswer{Text: t.text, Input: t.usage.Input, CachedInput: t.usage.Cached, Output: t.usage.Output}, nil
}

func firstRunes(text string, limit int) string {
	runes := []rune(text)
	if len(runes) <= limit {
		return text
	}
	return string(runes[:limit])
}

// truncateBytes cuts text to at most limit bytes on a rune boundary.
func truncateBytes(text string, limit int) string {
	if len(text) <= limit {
		return text
	}
	for limit > 0 && !utf8.RuneStart(text[limit]) {
		limit--
	}
	return text[:limit]
}
