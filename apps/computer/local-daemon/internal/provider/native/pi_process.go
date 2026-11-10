package native

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/process"
)

const (
	piExitWait         = 3 * time.Second
	piTermWait         = time.Second
	piGroupGrace       = 100 * time.Millisecond
	piGroupConfirmWait = 3 * time.Second
)

var (
	errPiRPCClosed     = errors.New("Pi RPC closed")
	errPiNotAdmitted   = errors.New("Pi turn no longer admits input")
	errPiProcessBusy   = errors.New("Pi process is not idle")
	errPiProbeMismatch = errors.New("Pi process is not idle for reuse")
)

// piTreeCheck replaces the process-tree emptiness check in tests.
var piTreeCheck atomic.Pointer[func(*exec.Cmd, time.Duration) bool]

func piTreeGone(cmd *exec.Cmd, budget time.Duration) bool {
	if check := piTreeCheck.Load(); check != nil {
		return (*check)(cmd, budget)
	}
	return process.WaitEmpty(cmd, budget)
}

// piProcess is one Pi RPC process. It owns the session lock, the MCP file,
// the resident front and the temp lease for its whole life, across parked
// turns. At most one turn is bound to it at a time.
type piProcess struct {
	res    residency
	cmd    *exec.Cmd
	pid    int
	stdin  *os.File
	stdout *os.File

	sessionID, sessionDir, contextDir string
	shape                             *piShape
	lock                              *os.File
	mcp                               piMCPWiring
	front                             *mcpFront
	releaseTemp                       func() error

	// cancel ends the process context, which outlives every caller.
	cancel context.CancelFunc

	writeMu sync.Mutex

	closed      chan struct{} // the stdout reader ended
	exited      chan struct{}
	waitErr     error
	terminated  atomic.Bool
	releaseOnce sync.Once

	mu      sync.Mutex
	pending map[string]chan piReply
	turn    *piTurn
}

type piReplyFrame struct {
	Type    string          `json:"type"`
	ID      string          `json:"id"`
	Command string          `json:"command"`
	Success bool            `json:"success"`
	Data    json.RawMessage `json:"data"`
	Error   json.RawMessage `json:"error"`
}

// piReply is a routed response plus the turn that was bound, and whether
// it was still live, when the reader saw the response.
type piReply struct {
	piReplyFrame
	turn     *piTurn
	turnLive bool
}

func piRandomHex(n int) string {
	raw := make([]byte, n)
	_, _ = rand.Read(raw)
	return hex.EncodeToString(raw)
}

// piLaunch starts Pi with private stdin and stdout pipes. Stderr is
// discarded entirely: Pi's native errors may carry credential URLs.
func piLaunch(profile Profile, cmd *exec.Cmd) (*piProcess, error) {
	stdinRead, stdinWrite, err := os.Pipe()
	if err != nil {
		return nil, err
	}
	stdoutRead, stdoutWrite, err := os.Pipe()
	if err != nil {
		_ = stdinRead.Close()
		_ = stdinWrite.Close()
		return nil, err
	}
	cmd.Stdin, cmd.Stdout, cmd.Stderr = stdinRead, stdoutWrite, nil
	startErr := process.Start(cmd)
	_ = stdinRead.Close()
	_ = stdoutWrite.Close()
	if startErr != nil {
		_ = stdinWrite.Close()
		_ = stdoutRead.Close()
		return nil, fmt.Errorf("Pi could not be started: %w", ExplainExecError(startErr))
	}
	logRuntimeLaunch(profile.Logger, "pi", "rpc", cmd)
	return &piProcess{
		cmd: cmd, pid: cmd.Process.Pid, stdin: stdinWrite, stdout: stdoutRead,
		closed:  make(chan struct{}),
		exited:  make(chan struct{}),
		pending: map[string]chan piReply{},
	}, nil
}

// run starts the process waiter and the stdout reader.
func (p *piProcess) run() {
	go func() {
		p.waitErr = p.cmd.Wait()
		close(p.exited)
	}()
	go p.read()
}

func (p *piProcess) residency() *residency { return &p.res }

func (p *piProcess) residentAttrs() []any {
	return []any{"pid", p.pid, "session_id", p.sessionID}
}

// alive: no stop has started, the reader still runs, and Pi has not exited.
func (p *piProcess) alive() bool {
	return !p.res.isStopping() && !piDone(p.closed) && !piDone(p.exited)
}

func piDone(ch <-chan struct{}) bool {
	select {
	case <-ch:
		return true
	default:
		return false
	}
}

// bind makes t the process's only turn.
func (p *piProcess) bind(t *piTurn) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.turn != nil || p.res.isStopping() {
		return errPiProcessBusy
	}
	p.turn = t
	return nil
}

func (p *piProcess) unbind(t *piTurn) {
	p.mu.Lock()
	if p.turn == t {
		p.turn = nil
	}
	p.mu.Unlock()
}

func (p *piProcess) boundTurn() *piTurn {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.turn
}

// read consumes stdout until end of stream. Responses go to their pending
// request; every other frame belongs to the bound turn and is dropped when
// none is bound.
func (p *piProcess) read() {
	defer close(p.closed)
	scanner := newFrameScanner(p.stdout)
	for scanner.Scan() {
		frame := scanner.Bytes()
		var head struct {
			Type string `json:"type"`
		}
		if json.Unmarshal(frame, &head) != nil {
			continue
		}
		if head.Type == "response" {
			p.route(frame)
			continue
		}
		var event piEventFrame
		if json.Unmarshal(frame, &event) != nil {
			continue
		}
		if t := p.boundTurn(); t != nil {
			t.apply(event, time.Now())
		}
	}
	if err := scanner.Err(); err != nil {
		if t := p.boundTurn(); t != nil {
			t.noteFailure("Pi event stream could not be read: " + err.Error())
		}
	}
}

func (p *piProcess) route(frame []byte) {
	var reply piReplyFrame
	if json.Unmarshal(frame, &reply) != nil {
		return
	}
	p.mu.Lock()
	pending := p.pending[reply.ID]
	delete(p.pending, reply.ID)
	turn := p.turn
	p.mu.Unlock()
	live := turn != nil && turn.live()
	if pending != nil {
		pending <- piReply{piReplyFrame: reply, turn: turn, turnLive: live}
	}
}

// call sends one RPC request and waits for its accepted response. A blocked
// write never holds the caller past ctx. admit, when set, is checked under
// the write lock just before the frame is written; a refusal writes nothing
// and returns errPiNotAdmitted.
func (p *piProcess) call(ctx context.Context, command string, fields map[string]any, admit func() bool) (piReply, error) {
	id := piRandomHex(12)
	frame := map[string]any{"id": id, "type": command}
	for key, value := range fields {
		frame[key] = value
	}
	var encoded bytes.Buffer
	encoder := json.NewEncoder(&encoded)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(frame); err != nil {
		return piReply{}, err
	}
	replies := make(chan piReply, 1)
	p.mu.Lock()
	p.pending[id] = replies
	p.mu.Unlock()
	defer func() {
		p.mu.Lock()
		delete(p.pending, id)
		p.mu.Unlock()
	}()
	written := make(chan error, 1)
	go func() {
		p.writeMu.Lock()
		defer p.writeMu.Unlock()
		if ctx.Err() != nil {
			written <- ctx.Err()
			return
		}
		if admit != nil && !admit() {
			written <- errPiNotAdmitted
			return
		}
		_, err := p.stdin.Write(encoded.Bytes())
		written <- err
	}()
	accept := func(reply piReply) (piReply, error) {
		if reply.Command != command || !reply.Success {
			return reply, fmt.Errorf("Pi %s rejected: %s", command, piText(reply.Error))
		}
		return reply, nil
	}
	for {
		select {
		case reply := <-replies:
			return accept(reply)
		case err := <-written:
			if err != nil {
				return piReply{}, err
			}
			written = nil
		case <-ctx.Done():
			select {
			case reply := <-replies:
				return accept(reply)
			default:
			}
			return piReply{}, ctx.Err()
		case <-p.closed:
			select {
			case reply := <-replies:
				return accept(reply)
			default:
			}
			return piReply{}, errPiRPCClosed
		}
	}
}

// piText decodes a JSON string, or returns the raw JSON text otherwise.
func piText(raw json.RawMessage) string {
	var text string
	if json.Unmarshal(raw, &text) == nil {
		return text
	}
	return strings.TrimSpace(string(raw))
}

// sessionState asks Pi for its state and checks the session identity.
func (p *piProcess) sessionState(ctx context.Context) (piState, error) {
	reply, err := p.call(ctx, "get_state", nil, nil)
	if err != nil {
		return piState{}, fmt.Errorf("Pi get_state failed: %w", err)
	}
	var state piState
	_ = json.Unmarshal(reply.Data, &state)
	if state.SessionID != p.sessionID {
		return state, errors.New("Pi returned a different session identity")
	}
	return state, nil
}

type piState struct {
	SessionID           string `json:"sessionId"`
	IsStreaming         bool   `json:"isStreaming"`
	IsCompacting        bool   `json:"isCompacting"`
	PendingMessageCount int    `json:"pendingMessageCount"`
}

// probeIdle proves the process can take a new prompt: same session, no
// streaming, no compaction, nothing queued, and a transcript that still
// belongs to the process's Context.
func (p *piProcess) probeIdle(ctx context.Context) error {
	state, err := p.sessionState(ctx)
	if err != nil {
		return err
	}
	if state.IsStreaming || state.IsCompacting || state.PendingMessageCount != 0 {
		return errPiProbeMismatch
	}
	return piValidateSession(p.sessionDir, p.sessionID, p.contextDir)
}

// stop is the table-serialized stop of the whole process tree.
func (p *piProcess) stop() bool { return p.res.stop(p.stopTree) }

// stopTree closes stdin and escalates until Pi and its descendants are
// gone. A confirmed exit releases everything the process owns; otherwise
// only the front closes, because survivors may still write the session.
func (p *piProcess) stopTree() bool {
	go func() { _ = p.stdin.Close() }()
	if !piWaitClosed(p.exited, piExitWait) {
		p.terminated.Store(true)
		_ = process.Signal(p.cmd, syscall.SIGTERM)
		if !piWaitClosed(p.exited, piTermWait) {
			_ = process.Signal(p.cmd, syscall.SIGKILL)
			go func() { _ = p.stdout.Close() }()
			<-p.exited
		}
	}
	if !piTreeGone(p.cmd, piGroupGrace) {
		_ = process.Signal(p.cmd, syscall.SIGKILL)
	}
	confirmed := piTreeGone(p.cmd, piGroupConfirmWait)
	if !piWaitClosed(p.closed, piChildPipeDrain) {
		go func() { _ = p.stdout.Close() }()
	}
	if !confirmed {
		p.front.Close()
		return false
	}
	p.release()
	return true
}

// release frees what the process owns, exactly once, after its tree is
// confirmed gone.
func (p *piProcess) release() {
	p.releaseOnce.Do(func() {
		p.front.Close()
		if p.cancel != nil {
			p.cancel()
		}
		process.Release(p.cmd)
		if p.releaseTemp != nil {
			_ = p.releaseTemp()
		}
		p.mcp.remove()
		piReleaseLock(p.lock)
	})
}

func piWaitClosed(done <-chan struct{}, budget time.Duration) bool {
	timer := time.NewTimer(budget)
	defer timer.Stop()
	select {
	case <-done:
		return true
	case <-timer.C:
		return false
	}
}

func piReleaseLock(file *os.File) {
	if file != nil {
		_ = file.Close()
	}
}
