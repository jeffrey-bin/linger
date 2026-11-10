package native

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"sync"
	"syscall"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/process"
)

// Process lifetime limits. Tests lower them.
var (
	claudeTerminationGrace = 5 * time.Second
	claudeKillWait         = 5 * time.Second
	claudePipeWait         = 10 * time.Second
	claudeInitLimit        = 30 * time.Second
	claudeSteerLimit       = 10 * time.Second
	claudeRefusalLimit     = 5 * time.Second
	claudeStopReaderSlack  = 30 * time.Second
	claudeExtraKillRounds  = 2
)

const claudeCleanupUnconfirmed = "Claude process cleanup was not confirmed"

// claudeGroup is the owned process tree of one CLI process.
type claudeGroup interface {
	signal(syscall.Signal) error
	waitEmpty(time.Duration) bool
	release()
}

type claudeOwnedGroup struct{ cmd *exec.Cmd }

func (g claudeOwnedGroup) signal(sig syscall.Signal) error { return process.Signal(g.cmd, sig) }
func (g claudeOwnedGroup) waitEmpty(budget time.Duration) bool {
	return process.WaitEmpty(g.cmd, budget)
}
func (g claudeOwnedGroup) release() { process.Release(g.cmd) }

// claudeProcess is one Claude CLI child. It serves one turn at a time and
// may park between turns as a resident.
type claudeProcess struct {
	pid           int
	group         claudeGroup
	stdin         io.WriteCloser
	stdout        io.ReadCloser
	stderr        io.ReadCloser
	stderrSnippet *errorTail
	shape         *claudeShape
	front         *mcpFront
	mcpPath       string
	release       func() error
	conv          *claudeConversation

	ctx    context.Context
	cancel context.CancelFunc

	writeSlot   chan struct{}
	stdinOnce   sync.Once
	stdoutOnce  sync.Once
	streamEnded chan struct{}
	leaderDone  chan struct{}
	stderrDone  chan struct{}
	watcherDone chan struct{}
	readerDone  chan struct{}

	mu         sync.Mutex
	turn       *claudeTurn
	lastLogger *slog.Logger
	sessionID  string
	// prestartCreated marks a pre-start spawned for a new conversation
	// (--session-id) rather than a resume.
	prestartCreated bool
	stopping        bool
	ended           bool
	groupConfirmed  bool
	released        bool
	waitErr         error
	state           *os.ProcessState

	res          residency
	stopRounds   int
	releaseGuard sync.Once
	readerOnce   sync.Once
	readerActive bool
}

func claudeNewProcess(group claudeGroup, logger *slog.Logger) *claudeProcess {
	ctx, cancel := context.WithCancel(context.Background())
	p := &claudeProcess{
		group: group, ctx: ctx, cancel: cancel, lastLogger: logger,
		writeSlot:   make(chan struct{}, 1),
		streamEnded: make(chan struct{}),
		leaderDone:  make(chan struct{}),
		stderrDone:  make(chan struct{}),
		watcherDone: make(chan struct{}),
		readerDone:  make(chan struct{}),
	}
	p.conv = claudeNewConversation(p)
	p.stderrSnippet = newErrorTail(newDiagnosticLog(slog.New(claudeLogRoute{p}), claudeStderrPrefix), 0)
	return p
}

// claudeLogRoute sends records to the logger of the Run bound right now, or
// of the last Run when the process is parked.
type claudeLogRoute struct{ proc *claudeProcess }

func (r claudeLogRoute) Enabled(ctx context.Context, level slog.Level) bool {
	return r.proc.logger().Handler().Enabled(ctx, level)
}
func (r claudeLogRoute) Handle(ctx context.Context, record slog.Record) error {
	return r.proc.logger().Handler().Handle(ctx, record)
}
func (r claudeLogRoute) WithAttrs([]slog.Attr) slog.Handler { return r }
func (r claudeLogRoute) WithGroup(string) slog.Handler      { return r }

func (p *claudeProcess) logger() *slog.Logger {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.turn != nil {
		return p.turn.logger
	}
	if p.lastLogger == nil {
		return slog.Default()
	}
	return p.lastLogger
}

// startOwned wires a launched command into the process: it reaps the leader
// and drains stderr at once. The stdout reader starts with startReader.
func (p *claudeProcess) startOwned(cmd *exec.Cmd) {
	p.pid = cmd.Process.Pid
	go func() {
		_, _ = io.Copy(p.stderrSnippet, p.stderr)
		close(p.stderrDone)
	}()
	go func() {
		err := cmd.Wait()
		p.mu.Lock()
		p.waitErr, p.state = err, cmd.ProcessState
		p.mu.Unlock()
		close(p.leaderDone)
		// Descendants may still hold the output pipes. Give them the pipe
		// wait, then stop reading so the tree cleanup can run.
		deadline := time.NewTimer(claudePipeWait)
		defer deadline.Stop()
		select {
		case <-p.streamEnded:
		case <-deadline.C:
			p.closeStdout()
			_ = p.stderr.Close()
			return
		}
		select {
		case <-p.stderrDone:
		case <-deadline.C:
			_ = p.stderr.Close()
		}
	}()
}

// startReader starts the stdout reader and the cancellation watcher once.
func (p *claudeProcess) startReader() {
	p.readerOnce.Do(func() {
		p.mu.Lock()
		p.readerActive = true
		p.mu.Unlock()
		go p.watch()
		go p.read()
	})
}

func (p *claudeProcess) closeStdin() {
	p.stdinOnce.Do(func() {
		if p.stdin != nil {
			_ = p.stdin.Close()
		}
	})
}

func (p *claudeProcess) closeStdout() {
	p.stdoutOnce.Do(func() {
		if p.stdout != nil {
			_ = p.stdout.Close()
		}
	})
}

func (p *claudeProcess) isStopping() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.stopping || p.ctx.Err() != nil
}

func claudeClosed(ch <-chan struct{}) bool {
	select {
	case <-ch:
		return true
	default:
		return false
	}
}

// alive is the resident liveness test.
func (p *claudeProcess) alive() bool {
	p.mu.Lock()
	stopping := p.stopping
	p.mu.Unlock()
	return !stopping && p.ctx.Err() == nil && !claudeClosed(p.streamEnded) && !claudeClosed(p.leaderDone)
}

// write sends one frame. An expired caller limit cancels the whole process,
// because a partial frame cannot be recovered.
func (p *claudeProcess) write(ctx context.Context, frame []byte) error {
	if claudeClosed(p.streamEnded) {
		return io.EOF
	}
	select {
	case p.writeSlot <- struct{}{}:
	case <-ctx.Done():
		return context.Cause(ctx)
	case <-p.ctx.Done():
		return errors.New("Claude process is stopping")
	case <-p.streamEnded:
		return io.EOF
	}
	line := make([]byte, 0, len(frame)+1)
	line = append(append(line, frame...), '\n')
	done := make(chan error, 1)
	go func() {
		defer func() { <-p.writeSlot }()
		n, err := p.stdin.Write(line)
		if err == nil && n < len(line) {
			err = io.ErrShortWrite
		}
		done <- err
	}()
	select {
	case err := <-done:
		return err
	case <-ctx.Done():
		select {
		case err := <-done:
			return err
		default:
		}
		p.cancel()
		return context.Cause(ctx)
	case <-p.ctx.Done():
		return errors.New("Claude process is stopping")
	case <-p.streamEnded:
		return io.EOF
	}
}

// bind attaches a turn. It fails once the reader has passed the point
// where it ends the bound turn.
func (p *claudeProcess) bind(t *claudeTurn) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.ended || p.stopping {
		return false
	}
	p.turn, p.lastLogger = t, t.logger
	return true
}

func (p *claudeProcess) read() {
	scanner := newFrameScanner(p.stdout)
	for scanner.Scan() {
		p.dispatch(scanner.Bytes(), time.Now())
	}
	readErr := scanner.Err()
	if errors.Is(readErr, os.ErrClosed) {
		// The Daemon closed stdout itself while tearing the tree down.
		readErr = nil
	}
	close(p.streamEnded)
	p.closeEventStream(readErr)
}

func (p *claudeProcess) dispatch(line []byte, observed time.Time) {
	p.mu.Lock()
	t := p.turn
	p.mu.Unlock()
	if t != nil {
		t.dispatchFrame(line, observed)
		return
	}
	p.parkedFrame(line)
}

// parkedFrame answers control requests that arrive while no turn is bound.
func (p *claudeProcess) parkedFrame(line []byte) {
	var frame struct {
		Type      string          `json:"type"`
		RequestID string          `json:"request_id"`
		Response  json.RawMessage `json:"response"`
	}
	if json.Unmarshal(line, &frame) != nil {
		return
	}
	switch frame.Type {
	case "control_request":
		if frame.RequestID == "" {
			return
		}
		ctx, cancel := context.WithTimeout(p.ctx, claudeRefusalLimit)
		_ = p.write(ctx, claudeControlRefusal(frame.RequestID, "No active turn"))
		cancel()
	case "control_response":
		p.conv.handleResponse(frame.Response)
	}
}

// awaitLeader reaps the leader, escalating to SIGKILL when it lingers after
// its output ended.
func (p *claudeProcess) awaitLeader() bool {
	select {
	case <-p.leaderDone:
		return true
	case <-time.After(claudeKillWait):
	}
	_ = p.group.signal(syscall.SIGKILL)
	select {
	case <-p.leaderDone:
		return true
	case <-time.After(claudeKillWait):
		return false
	}
}

func (p *claudeProcess) closeEventStream(readErr error) {
	if readErr != nil {
		p.cancel()
		p.closeStdout()
	}
	p.closeStdin()
	p.conv.finish()
	exited := p.awaitLeader()
	recordTiming(p.logger(), time.Now(), timingClaudeProcessExited, "pid", p.pid)
	<-p.watcherDone
	select {
	case <-p.stderrDone:
	case <-time.After(claudePipeWait):
	}
	confirmed := exited && p.group.waitEmpty(0)
	if !confirmed {
		_ = p.group.signal(syscall.SIGKILL)
		confirmed = p.group.waitEmpty(claudeKillWait)
	}
	p.mu.Lock()
	p.groupConfirmed = confirmed
	p.ended = true
	t := p.turn
	p.turn = nil
	if t != nil {
		t.endLocked()
	}
	p.mu.Unlock()
	if confirmed {
		p.releaseResources()
	}
	claudeSettle(p, confirmed)
	if t != nil {
		t.deliver(t.compute(claudeEnding{exited: exited, confirmed: confirmed, readErr: readErr}))
	}
	close(p.readerDone)
}

// watch owns group signalling after cancellation: TERM, the grace, then
// KILL, and an abort when the tree survives both.
func (p *claudeProcess) watch() {
	defer close(p.watcherDone)
	select {
	case <-p.ctx.Done():
	case <-p.leaderDone:
		if p.ctx.Err() == nil {
			return
		}
	}
	p.closeStdin()
	_ = p.group.signal(syscall.SIGTERM)
	empty := p.group.waitEmpty(claudeTerminationGrace)
	if !empty {
		_ = p.group.signal(syscall.SIGKILL)
		empty = p.group.waitEmpty(claudeKillWait)
	}
	if !empty {
		p.conv.abort(claudeCleanupUnconfirmed)
		p.closeStdout()
		return
	}
	select {
	case <-p.streamEnded:
	case <-time.After(claudePipeWait):
		p.closeStdout()
	}
}

func (p *claudeProcess) releaseResources() {
	p.releaseGuard.Do(func() {
		p.mu.Lock()
		p.released = true
		logger := p.lastLogger
		front := p.front
		p.mu.Unlock()
		if p.group != nil {
			p.group.release()
		}
		front.Close()
		claudeRemoveMCPConfig(p.mcpPath)
		if p.release != nil {
			if err := p.release(); err != nil && logger != nil {
				logger.Warn("release Claude process temp failed", "error", err)
			}
		}
	})
}

// stop is the serialized, confirm-once stop of the process.
func (p *claudeProcess) stop() bool { return p.res.stop(p.stopTree) }

// stopTree cancels the process and confirms that its tree is gone. Later
// calls spend at most claudeExtraKillRounds extra SIGKILL rounds, then only
// probe.
func (p *claudeProcess) stopTree() bool {
	p.mu.Lock()
	if p.released {
		p.mu.Unlock()
		return true
	}
	p.stopping = true
	t := p.turn
	readerActive := p.readerActive
	p.mu.Unlock()
	p.cancel()
	if t != nil {
		t.runCancel()
	}
	if readerActive {
		select {
		case <-p.readerDone:
		case <-time.After(claudeTerminationGrace + claudeStopReaderSlack):
			return false
		}
	}
	p.mu.Lock()
	confirmed := p.groupConfirmed
	p.mu.Unlock()
	if !confirmed {
		if p.stopRounds < claudeExtraKillRounds {
			p.stopRounds++
			_ = p.group.signal(syscall.SIGKILL)
			confirmed = p.group.waitEmpty(claudeKillWait)
		} else {
			confirmed = p.group.waitEmpty(0)
		}
	}
	if !confirmed {
		return false
	}
	p.mu.Lock()
	p.groupConfirmed = true
	p.mu.Unlock()
	p.releaseResources()
	return true
}

func (p *claudeProcess) exitError() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.waitErr
}

func (p *claudeProcess) exitState() *os.ProcessState {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.state
}

// cancelledByDaemon reports a process the Daemon itself cancelled; its exit
// status describes our signal, not a CLI failure.
func (p *claudeProcess) cancelledByDaemon() bool { return p.ctx.Err() != nil }
