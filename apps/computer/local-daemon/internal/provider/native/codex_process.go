package native

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/process"
)

const codexPipeDrainGrace = 10 * time.Second

var (
	// codexStopGrace bounds each step of stopping a process; tests lower it.
	codexStopGrace = newCodexTunable(10 * time.Second)
	// codexConfirmOverride lets tests force an unconfirmed exit fence.
	codexConfirmOverride atomic.Pointer[func(*codexProcess) bool]

	codexActiveLaunches atomic.Int64

	codexCleanupUnconfirmedText = "codex cleanup unconfirmed: process tree exit could not be confirmed"
)

// codexTunable is a duration tests may lower while background stops run.
type codexTunable struct{ nanos atomic.Int64 }

func newCodexTunable(value time.Duration) *codexTunable {
	tunable := &codexTunable{}
	tunable.nanos.Store(int64(value))
	return tunable
}

func (t *codexTunable) get() time.Duration { return time.Duration(t.nanos.Load()) }

// set replaces the value and returns the previous one.
func (t *codexTunable) set(value time.Duration) time.Duration {
	return time.Duration(t.nanos.Swap(int64(value)))
}

// codexProcess is one app-server process and the resident state it carries
// between Operations.
type codexProcess struct {
	cmd       *exec.Cmd
	pid       int
	cancel    context.CancelFunc
	transport *codexTransport
	stderr    *errorTail
	stdout    *os.File
	stderrR   *os.File
	release   func() error
	baseLog   *slog.Logger

	computerVersion string

	// Resident identity.
	key        string
	home       string
	executable string
	version    string
	configArgs []string
	dir        string
	model      string
	effort     string
	// authPrint and skillPrint are the account and the delivered Skills the
	// app-server loaded at launch.
	authPrint  string
	skillPrint string

	stdoutDone chan struct{}
	waitDone   chan struct{}

	mu          sync.Mutex
	op          *codexOperation
	front       *mcpFront
	threadID    string
	threadModel string
	// preparedThread marks a thread a provider prepare started that no turn
	// has run on yet; the Context's first Run adopts it instead of starting
	// another.
	preparedThread bool
	// responseTotals is each thread's last reported usage total; only a
	// larger total is a new model response.
	responseTotals map[string]int64
	fingerprint    string
	mcpHash        string
	tracker        codexTurnTracker
	// Lifecycle facts.
	waitErr     error
	state       *os.ProcessState
	reaped      bool
	terminated  bool
	external    bool
	stopTried   bool
	confirmed   bool
	cleanupErr  error
	cleanupDone bool
	res         residency
}

// codexLaunch spawns one app-server process. The process outlives the
// caller's context.
func codexLaunch(profile Profile, spec RunSpec, executable, home, key string, attempt int, front *mcpFront, logger *slog.Logger) (*codexProcess, error) {
	args := codexExecutionArgs(profile, spec, home, logger)
	authPrint := codexAuthFingerprint(home)
	skillPrint := profile.ResidentSkillDigest
	var release func() error
	if profile.RetainProcessTemp != nil {
		var err error
		if release, err = profile.RetainProcessTemp(); err != nil {
			return nil, fmt.Errorf("retain Codex process files: %w", err)
		}
	}
	releaseEarly := func() {
		if release != nil {
			if err := release(); err != nil {
				logger.Warn("Codex process temp cleanup failed", "error", err)
			}
		}
	}
	inv := profileInvocation(executable, nil, profile.Env)
	procCtx, cancel := context.WithCancel(context.Background())
	cmd := ownedCommand(procCtx, inv, args...)
	cmd.Dir = spec.Dir
	cmd.WaitDelay = codexPipeDrainGrace
	stdinR, stdinW, err := os.Pipe()
	if err != nil {
		cancel()
		releaseEarly()
		return nil, fmt.Errorf("start Codex: %w", err)
	}
	stdoutR, stdoutW, err := os.Pipe()
	if err != nil {
		cancel()
		_ = stdinR.Close()
		_ = stdinW.Close()
		releaseEarly()
		return nil, fmt.Errorf("start Codex: %w", err)
	}
	stderrR, stderrW, err := os.Pipe()
	if err != nil {
		cancel()
		for _, f := range []*os.File{stdinR, stdinW, stdoutR, stdoutW} {
			_ = f.Close()
		}
		releaseEarly()
		return nil, fmt.Errorf("start Codex: %w", err)
	}
	cmd.Stdin, cmd.Stdout, cmd.Stderr = stdinR, stdoutW, stderrW
	startErr := process.Start(cmd)
	_ = stdinR.Close()
	_ = stdoutW.Close()
	_ = stderrW.Close()
	if startErr != nil {
		cancel()
		_ = stdinW.Close()
		_ = stdoutR.Close()
		_ = stderrR.Close()
		releaseEarly()
		return nil, fmt.Errorf("start Codex: %w", ExplainExecError(startErr))
	}
	logRuntimeLaunch(logger, "codex", "app-server", cmd)
	proc := &codexProcess{
		cmd: cmd, pid: cmd.Process.Pid, cancel: cancel,
		transport: newCodexTransport(stdinW),
		stderr:    newErrorTail(nil, defaultStderrTail),
		stdout:    stdoutR, stderrR: stderrR, release: release,
		baseLog: logger,
		key:     key, home: home, executable: executable, version: profile.CodexToolVersion,
		configArgs: append([]string(nil), profile.CodexConfigArgs...),
		dir:        spec.Dir, model: spec.Model, effort: spec.Effort,
		authPrint: authPrint, skillPrint: skillPrint,
		stdoutDone: make(chan struct{}), waitDone: make(chan struct{}),
		front: front,
	}
	proc.res.bind(key, profile)
	proc.transport.noticeHook = proc.dispatchNotice
	proc.transport.serverCallHook = proc.answerServerCall
	go func() {
		defer close(proc.stdoutDone)
		proc.transport.readLoop(stdoutR)
	}()
	go func() { _, _ = io.Copy(proc.stderr, stderrR) }()
	go proc.reap()
	active := codexActiveLaunches.Add(1)
	logger.Info("codex lifecycle", "phase", "spawn", "pid", proc.pid, "attempt", attempt, "active_launches", active)
	return proc, nil
}

// logger is the logger of the attached Operation, else the launch logger.
func (p *codexProcess) logger() *slog.Logger {
	p.mu.Lock()
	op := p.op
	p.mu.Unlock()
	if op != nil {
		return op.logger
	}
	return p.baseLog
}

// reap waits for the leader. An exit before any termination action is
// external; later actions never change that.
func (p *codexProcess) reap() {
	err := p.cmd.Wait()
	p.mu.Lock()
	p.waitErr, p.state, p.reaped = err, p.cmd.ProcessState, true
	p.external = !p.terminated
	external := p.external
	p.mu.Unlock()
	close(p.waitDone)
	if !external {
		return
	}
	p.logger().Info("codex leader exit observed", "pid", p.pid, "external_exit", true)
	// Let the reader drain what the leader already wrote, but a descendant
	// holding stdout must not keep the transport alive.
	select {
	case <-p.stdoutDone:
	case <-time.After(codexStopGrace.get()):
		p.transport.fail(errCodexChildGone)
	}
}

// terminate records a termination action before it happens.
func (p *codexProcess) terminate(cause string) {
	p.mu.Lock()
	p.terminated = true
	external := p.external
	p.mu.Unlock()
	p.logger().Info("codex process termination", "pid", p.pid, "cause", cause, "external_exit", external)
	switch cause {
	case "stdin":
		p.transport.closeInput()
	case "cancel":
		p.cancel()
	case "signal":
		_ = process.Signal(p.cmd, syscall.SIGKILL)
	}
}

// alive reports whether the process may be reused.
func (p *codexProcess) alive() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.stopTried || p.reaped || p.external {
		return false
	}
	select {
	case <-p.stdoutDone:
		return false
	default:
	}
	return !p.transport.isDead()
}

func (p *codexProcess) isReaped() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.reaped
}

func (p *codexProcess) externalExit() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.reaped && p.external
}

// stop is the serialized, confirm-once stop of the process.
func (p *codexProcess) stop() bool { return p.res.stop(p.stopTree) }

// stopTree runs turn cleanup, reaps the leader and verifies the process
// group is gone. An unconfirmed stop keeps the process owned for a later
// retry.
func (p *codexProcess) stopTree() bool {
	p.mu.Lock()
	if p.confirmed {
		p.mu.Unlock()
		return true
	}
	p.stopTried = true
	retry := p.cleanupDone && p.reaped
	p.mu.Unlock()
	logger := p.logger()
	if retry {
		// After reaping, a retry only rechecks the group.
		return p.confirmIf(p.groupGone(), logger)
	}
	if p.externalExit() {
		p.transport.fail(errCodexChildGone)
	}
	cleanupErr := p.cleanupTurn()
	if cleanupErr != nil && !p.transport.isDead() {
		logger.Error("codex turn cleanup unconfirmed", "pid", p.pid, "error", sanitizeDiagnostic(cleanupErr.Error()))
		return false
	}
	p.mu.Lock()
	p.cleanupErr, p.cleanupDone = cleanupErr, true
	p.mu.Unlock()
	p.reapWithGrace()
	gone := p.groupGone()
	p.mu.Lock()
	external := p.external
	p.mu.Unlock()
	excused := cleanupErr == nil || (external && errors.Is(cleanupErr, errCodexChildGone))
	return p.confirmIf(p.isReaped() && gone && excused, logger)
}

func (p *codexProcess) reapWithGrace() {
	if p.isReaped() {
		return
	}
	select {
	case <-p.stdoutDone:
		select {
		case <-p.waitDone:
			return
		case <-time.After(codexStopGrace.get()):
		}
	default:
	}
	p.terminate("stdin")
	select {
	case <-p.stdoutDone:
	case <-time.After(codexStopGrace.get()):
		p.terminate("cancel")
		_ = p.stdout.Close()
	}
	select {
	case <-p.waitDone:
	case <-time.After(codexStopGrace.get()):
		p.terminate("signal")
		<-p.waitDone
	}
}

func (p *codexProcess) groupGone() bool {
	if process.WaitEmpty(p.cmd, codexStopGrace.get()) {
		return true
	}
	p.terminate("signal")
	return process.WaitEmpty(p.cmd, codexStopGrace.get())
}

func (p *codexProcess) confirmIf(confirmed bool, logger *slog.Logger) bool {
	if override := codexConfirmOverride.Load(); confirmed && override != nil {
		confirmed = (*override)(p)
	}
	p.mu.Lock()
	reaped, waitErr := p.reaped, p.waitErr
	first := confirmed && !p.confirmed
	if confirmed {
		p.confirmed = true
	}
	front := p.front
	p.mu.Unlock()
	waitText := ""
	if waitErr != nil {
		waitText = waitErr.Error()
	}
	total := p.stderr.Total()
	logger.Info("codex lifecycle", "phase", "cleanup", "pid", p.pid, "attempt", p.attemptNumber(), "reaped", reaped,
		"wait_error", waitText, "stderr_bytes", total, "stderr_truncated", total > defaultStderrTail)
	if reaped {
		recordTiming(logger, time.Now(), timingCodexProcessExited, "pid", p.pid)
	}
	if !first {
		return confirmed
	}
	process.Release(p.cmd)
	front.Close()
	p.cancel()
	_ = p.stdout.Close()
	_ = p.stderrR.Close()
	p.transport.fail(errCodexChildGone)
	if p.release != nil {
		if err := p.release(); err != nil {
			logger.Warn("Codex process temp cleanup failed", "error", err)
		}
	}
	codexActiveLaunches.Add(-1)
	return true
}

func (p *codexProcess) attemptNumber() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.op != nil {
		return p.op.attempt
	}
	return 0
}

// exitDiagnostics describes an external leader exit.
func (p *codexProcess) exitDiagnostics() RuntimeFailureDiagnostics {
	p.mu.Lock()
	defer p.mu.Unlock()
	if !p.reaped || !p.external {
		return RuntimeFailureDiagnostics{}
	}
	return processExitDiagnostics(p.state)
}

// stderrCounts classifies stderr for setup-failure logs only.
func (p *codexProcess) stderrCounts(budgetTimeout bool) []any {
	var refresh, refreshTimeout, transport int
	for _, line := range strings.Split(strings.ToLower(sanitizeDiagnostic(p.stderr.Tail())), "\n") {
		refresh += strings.Count(line, "failed to refresh available models")
		refreshTimeout += strings.Count(line, "failed to refresh available models: timeout waiting for child process to exit")
		if strings.Contains(line, "mcp") && strings.Contains(line, "transport") &&
			(strings.Contains(line, "error") || strings.Contains(line, "failed") || strings.Contains(line, "closed")) {
			transport++
		}
	}
	bare := 0
	if budgetTimeout && refresh == 0 && transport == 0 {
		bare = 1
	}
	return []any{"stderr_model_refresh_failure_count", refresh, "stderr_model_refresh_timeout_count", refreshTimeout,
		"stderr_mcp_init_transport_count", transport, "stderr_bare_timeout_count", bare}
}
