package native

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strconv"
	"sync"
	"time"
)

const codexReplyQueueCapacity = 64

var (
	errCodexChildGone     = errors.New("codex process exited")
	errCodexReplyOverflow = errors.New("Codex reply queue exceeded capacity")
)

// codexRPCError is a JSON-RPC error answered by the app-server.
type codexRPCError struct {
	Code    int
	Message string
}

func (e *codexRPCError) Error() string { return fmt.Sprintf("Codex RPC %d: %s", e.Code, e.Message) }

// codexHandshakeTimeout is the expiry of one request's startup budget. It
// counts as a deadline.
type codexHandshakeTimeout struct {
	method string
	budget time.Duration
}

func (e *codexHandshakeTimeout) Error() string {
	return fmt.Sprintf("%s: %s exceeded %s", CodexHandshakeTimeoutMarker, e.method, e.budget)
}

func (e *codexHandshakeTimeout) Is(target error) bool { return target == context.DeadlineExceeded }

type codexReply struct {
	result json.RawMessage
	err    error
}

type codexPending struct {
	method string
	done   chan codexReply
	// observe sees the reply even after the caller stopped waiting.
	observe func(codexReply)
}

// codexCallHooks lets a caller see a request's id before the write and its
// reply after the caller stopped waiting.
type codexCallHooks struct {
	sent    func(id int64)
	observe func(codexReply)
	// bestEffort keeps stdin open when the context ends during a blocked
	// write, because the request shares the transport with a live turn. The
	// pending entry is always discarded on context end.
	bestEffort bool
}

// codexTransport is the newline-delimited JSON-RPC connection to one
// app-server process.
type codexTransport struct {
	stdin     io.WriteCloser
	writeSlot chan struct{}
	replies   chan []byte

	mu      sync.Mutex
	nextID  int64
	pending map[int64]*codexPending
	deadErr error
	dead    chan struct{}

	noticeHook     func(method string, params json.RawMessage)
	serverCallHook func(id json.RawMessage, method string, params json.RawMessage)
}

func newCodexTransport(stdin io.WriteCloser) *codexTransport {
	t := &codexTransport{
		stdin:     stdin,
		writeSlot: make(chan struct{}, 1),
		replies:   make(chan []byte, codexReplyQueueCapacity),
		pending:   map[int64]*codexPending{},
		dead:      make(chan struct{}),
	}
	go t.writeReplies()
	return t
}

// fail marks the transport dead once and fails every pending request.
func (t *codexTransport) fail(err error) {
	t.mu.Lock()
	if t.deadErr != nil {
		t.mu.Unlock()
		return
	}
	t.deadErr = err
	pending := t.pending
	t.pending = map[int64]*codexPending{}
	close(t.dead)
	t.mu.Unlock()
	for _, entry := range pending {
		entry.deliver(codexReply{err: err})
	}
}

func (p *codexPending) deliver(reply codexReply) {
	if p.observe != nil {
		p.observe(reply)
	}
	select {
	case p.done <- reply:
	default:
	}
}

func (t *codexTransport) err() error {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.deadErr
}

func (t *codexTransport) isDead() bool { return t.err() != nil }

// closeInput closes the child's stdin. The transport cannot write again.
func (t *codexTransport) closeInput() { _ = t.stdin.Close() }

// codexUnsentError wraps the failure of a request that never reached
// stdin: the app-server cannot have seen it.
type codexUnsentError struct{ error }

func (e codexUnsentError) Unwrap() error { return e.error }

func codexUnsent(err error) bool {
	var unsent codexUnsentError
	return errors.As(err, &unsent)
}

// write sends one line. A blocked write that outlives ctx closes stdin,
// unless keepInput is set. A line that was never started fails with a
// codexUnsentError.
func (t *codexTransport) write(ctx context.Context, method string, line []byte, keepInput bool) error {
	select {
	case t.writeSlot <- struct{}{}:
	case <-ctx.Done():
		return codexUnsentError{context.Cause(ctx)}
	case <-t.dead:
		return codexUnsentError{t.err()}
	}
	done := make(chan error, 1)
	go func() {
		defer func() { <-t.writeSlot }()
		n, err := t.stdin.Write(line)
		if err == nil && n < len(line) {
			err = io.ErrShortWrite
		}
		done <- err
	}()
	select {
	case err := <-done:
		return writeResult(method, err)
	case <-ctx.Done():
		// A write that finished as ctx ended was not blocked; stdin stays open.
		select {
		case err := <-done:
			return writeResult(method, err)
		default:
		}
		if !keepInput {
			t.closeInput()
		}
		return context.Cause(ctx)
	}
}

func writeResult(method string, err error) error {
	if err != nil {
		return fmt.Errorf("write %s: %w", method, err)
	}
	return nil
}

func (t *codexTransport) notify(ctx context.Context, method string) error {
	line, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "method": method})
	return t.write(ctx, method, append(line, '\n'), false)
}

// call sends a request and waits for its reply. A positive budget bounds
// the request with a handshake timeout. observe, when set, keeps the entry
// past cancellation so a late reply is still seen.
func (t *codexTransport) call(ctx context.Context, method string, params any, budget time.Duration, hooks *codexCallHooks) (json.RawMessage, int64, error) {
	var observe func(codexReply)
	bestEffort := false
	if hooks != nil {
		observe, bestEffort = hooks.observe, hooks.bestEffort
	}
	if budget > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeoutCause(ctx, budget, &codexHandshakeTimeout{method: method, budget: budget})
		defer cancel()
	}
	entry := &codexPending{method: method, done: make(chan codexReply, 1), observe: observe}
	t.mu.Lock()
	if t.deadErr != nil {
		err := t.deadErr
		t.mu.Unlock()
		return nil, 0, err
	}
	t.nextID++
	id := t.nextID
	t.pending[id] = entry
	t.mu.Unlock()
	line, err := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": params})
	if err != nil {
		t.forget(id)
		return nil, id, err
	}
	if hooks != nil && hooks.sent != nil {
		hooks.sent(id)
	}
	if err := t.write(ctx, method, append(line, '\n'), bestEffort); err != nil {
		// A late reply can only follow a request that reached stdin.
		if observe == nil || bestEffort || codexUnsent(err) {
			t.forget(id)
		}
		return nil, id, err
	}
	select {
	case reply := <-entry.done:
		return reply.result, id, reply.err
	case <-ctx.Done():
		if observe == nil || bestEffort {
			t.forget(id)
		}
		// A reply routed at the same moment still wins.
		select {
		case reply := <-entry.done:
			return reply.result, id, reply.err
		default:
		}
		return nil, id, context.Cause(ctx)
	}
}

func (t *codexTransport) forget(id int64) {
	t.mu.Lock()
	delete(t.pending, id)
	t.mu.Unlock()
}

func (t *codexTransport) inflight() int {
	t.mu.Lock()
	defer t.mu.Unlock()
	return len(t.pending)
}

// reply queues an answer to a server request. The stdout reader never
// waits on stdin.
func (t *codexTransport) reply(id json.RawMessage, result any, rpcErr *codexRPCError) {
	if t.isDead() {
		return
	}
	message := map[string]any{"jsonrpc": "2.0", "id": id}
	if rpcErr != nil {
		message["error"] = map[string]any{"code": rpcErr.Code, "message": rpcErr.Message}
	} else {
		message["result"] = result
	}
	line, err := json.Marshal(message)
	if err != nil {
		return
	}
	select {
	case t.replies <- append(line, '\n'):
	default:
		t.fail(errCodexReplyOverflow)
	}
}

func (t *codexTransport) writeReplies() {
	for {
		select {
		case <-t.dead:
			return
		case line := <-t.replies:
			select {
			case t.writeSlot <- struct{}{}:
			case <-t.dead:
				return
			}
			_, err := t.stdin.Write(line)
			<-t.writeSlot
			if err != nil {
				return
			}
		}
	}
}

// readLoop consumes stdout until EOF or a scanner error, then marks the
// transport dead.
func (t *codexTransport) readLoop(stdout io.Reader) {
	scanner := newFrameScanner(stdout)
	for scanner.Scan() {
		t.route(scanner.Bytes())
	}
	if err := scanner.Err(); err != nil {
		t.fail(fmt.Errorf("%w: %w", errCodexChildGone, err))
		return
	}
	t.fail(errCodexChildGone)
}

func (t *codexTransport) route(frame []byte) {
	var message map[string]json.RawMessage
	if json.Unmarshal(frame, &message) != nil || message == nil {
		return
	}
	rawID, hasID := message["id"]
	rawMethod, hasMethod := message["method"]
	var method string
	if hasMethod && json.Unmarshal(rawMethod, &method) != nil {
		return
	}
	switch {
	case hasID && hasMethod:
		trimmed := bytes.TrimSpace(rawID)
		if len(trimmed) == 0 || !(trimmed[0] == '"' || trimmed[0] == '-' || (trimmed[0] >= '0' && trimmed[0] <= '9')) {
			return
		}
		if t.serverCallHook != nil {
			t.serverCallHook(append(json.RawMessage(nil), trimmed...), method, codexCopy(message["params"]))
		}
	case hasID:
		t.deliverReply(rawID, message)
	case hasMethod:
		if t.noticeHook != nil {
			t.noticeHook(method, codexCopy(message["params"]))
		}
	}
}

func (t *codexTransport) deliverReply(rawID json.RawMessage, message map[string]json.RawMessage) {
	id, err := strconv.ParseInt(string(bytes.TrimSpace(rawID)), 10, 64)
	if err != nil {
		return
	}
	t.mu.Lock()
	entry := t.pending[id]
	delete(t.pending, id)
	t.mu.Unlock()
	if entry == nil {
		return
	}
	reply := codexReply{}
	rawErr, hasErr := message["error"]
	result, hasResult := message["result"]
	switch {
	case hasErr && !bytes.Equal(bytes.TrimSpace(rawErr), []byte("null")):
		var decoded struct {
			Code    *int   `json:"code"`
			Message string `json:"message"`
		}
		if json.Unmarshal(rawErr, &decoded) != nil || decoded.Code == nil {
			reply.err = errors.New("invalid Codex RPC error")
		} else {
			reply.err = &codexRPCError{Code: *decoded.Code, Message: decoded.Message}
		}
	case hasResult:
		reply.result = codexCopy(result)
	default:
		reply.err = errors.New("Codex RPC response omitted result")
	}
	entry.deliver(reply)
}

func codexCopy(raw json.RawMessage) json.RawMessage {
	if raw == nil {
		return nil
	}
	return append(json.RawMessage(nil), raw...)
}
