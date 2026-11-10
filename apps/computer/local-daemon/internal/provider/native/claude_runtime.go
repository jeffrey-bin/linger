package native

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/google/uuid"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/process"
)

type claudeRuntime struct{ profile Profile }

func newClaudeRuntime(profile Profile) Runtime { return &claudeRuntime{profile: profile} }

var errClaudeAdoptEnded = errors.New("parked Claude process ended before adoption")

func claudeCleanRoot(root string) string {
	root = strings.TrimSpace(root)
	if root == "" {
		return ""
	}
	return filepath.Clean(root)
}

// claudeLaunch is everything Start resolved before it spawns or adopts.
type claudeLaunch struct {
	resolved   string
	launchArgs []string
	initialize []byte
	mcp        json.RawMessage
	targets    map[string]string
	shape      *claudeShape
	root       string
	identity   string
	fence      releaseFence
}

// claudeIdentity is the session a run names: the resume, else the
// assigned new session.
func claudeIdentity(spec RunSpec) string {
	if spec.ResumeID != "" {
		return spec.ResumeID
	}
	return spec.AssignSessionID
}

func (r *claudeRuntime) Start(ctx context.Context, prompt string, spec RunSpec) (*Run, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	spec.MCPServers = mcpNamespace(spec.MCPServers)
	if spec.ClaudePolicy == nil {
		return nil, errors.New("Claude tool policy is required")
	}
	if err := claudeCheckEffort(spec.Effort); err != nil {
		return nil, err
	}
	program := r.profile.Program
	if program == "" {
		program = "claude"
	}
	resolved, err := exec.LookPath(program)
	if err != nil {
		return nil, fmt.Errorf("resolve Claude executable: %w", err)
	}
	if spec.PrepareOnly || spec.ResumeRequired || spec.AssignSessionID != "" {
		for _, id := range []string{spec.ResumeID, spec.AssignSessionID} {
			if id != "" && !claudeCanonicalUUID(id) {
				return nil, errors.New("Claude Session identity is not a UUID")
			}
		}
	}
	logger := r.profile.Logger
	if logger == nil {
		logger = slog.Default()
	}
	root := claudeCleanRoot(r.profile.Env[claudeSessionRoot])
	if spec.AssignSessionID != "" && root != "" && claudeSessionMaterialized(root, spec.AssignSessionID) {
		spec.ResumeID, spec.AssignSessionID, spec.ResumeRequired = spec.AssignSessionID, "", true
	}
	identity := claudeIdentity(spec)
	if root != "" && identity != "" {
		if _, err := claudeReadMarker(root, identity); err != nil {
			return nil, err
		}
	}
	if spec.providerPrepare() {
		return r.prestart(ctx, spec, resolved, root, identity, logger)
	}

	runCtx, runCancel := budgetContext(ctx, spec.Budget)
	started := false
	defer func() {
		if !started {
			runCancel()
		}
	}()
	mcp := claudeToolTimeouts(spec.MCPServers)
	launch := claudeLaunch{resolved: resolved, mcp: mcp, root: root, identity: identity}
	if !json.Valid(mcp) {
		return nil, errors.New("invalid MCP configuration JSON")
	}
	mcpShape, targets, mcpEligible := residentMCPShape(mcp)
	launch.targets = targets
	eligible := !spec.PrepareOnly && root != "" && mcpEligible && claudeResidents.enabled()
	launch.fence = captureReleaseFence(r.profile)
	shaped, launchArgs := claudeBuildArgv(logger, spec)
	launch.launchArgs = launchArgs
	launch.initialize = claudeInitializeFrame(spec)
	if eligible {
		launch.shape = &claudeShape{
			execPath: resolved, cwd: spec.Dir, args: shaped,
			env:        claudeShapeEnv(childEnvironment(r.profile.Env)),
			initialize: string(launch.initialize), mcp: mcpShape,
		}
	}

	if eligible {
		proc, adopted, err := claudeResidents.take(root, claudeMismatch(launch.shape, spec), logger, spec.Readiness)
		if err != nil {
			return nil, err
		}
		if proc != nil {
			if err := r.attach(ctx, proc, spec, launch, adopted); err != nil {
				logger.Warn("Claude process attachment failed", "pid", proc.pid, "adopted", adopted, "error", err)
				claudeResidents.note(logger, proc, "recycled", "attach_failed", nil, false)
				spec.Readiness.recycled("attach_failed", nil)
				claudeResidents.retire(proc)
				proc = nil
			}
		}
		if proc != nil {
			run, err := r.reuse(ctx, runCtx, runCancel, proc, prompt, spec, launch)
			if err == nil {
				started = true
				return run, nil
			}
			if !errors.Is(err, errClaudeAdoptEnded) {
				return nil, err
			}
		}
	}
	if err := claudeResidents.stopKey(root, logger, spec.Readiness); err != nil {
		return nil, err
	}
	run, err := r.spawn(ctx, runCtx, runCancel, prompt, spec, launch, logger)
	if err != nil {
		return nil, err
	}
	started = true
	return run, nil
}

// claudeSettledRun is a Run that never launched a turn: its events are
// closed and its single Outcome is ready.
func claudeSettledRun(outcome Outcome) *Run {
	events := make(chan Event)
	close(events)
	outcomes := make(chan Outcome, 1)
	outcomes <- outcome
	close(outcomes)
	return &Run{Events: events, Outcome: outcomes}
}

// launchProcess starts the CLI for launch with config as its MCP
// configuration. front, when set, belongs to the new process. On failure
// everything it was given is released.
func (r *claudeRuntime) launchProcess(spec RunSpec, launch claudeLaunch, front *mcpFront, config []byte, logger *slog.Logger) (*claudeProcess, error) {
	mcpPath, err := claudeWriteMCPConfig(config)
	if err != nil {
		front.Close()
		return nil, fmt.Errorf("write Claude MCP configuration: %w", err)
	}
	argv := append(append([]string(nil), launch.launchArgs...), "--mcp-config", mcpPath)
	abandon := func(release func() error) {
		front.Close()
		claudeRemoveMCPConfig(mcpPath)
		if release != nil {
			if err := release(); err != nil {
				logger.Warn("release Claude process temp failed", "error", err)
			}
		}
	}
	cmd := ownedCommand(context.Background(), profileInvocation(launch.resolved, nil, r.profile.Env), argv...)
	cmd.Dir = spec.Dir
	pipes, err := claudeOpenPipes()
	if err != nil {
		abandon(nil)
		return nil, fmt.Errorf("start Claude: %w", err)
	}
	cmd.Stdin, cmd.Stdout, cmd.Stderr = pipes.childIn, pipes.childOut, pipes.childErr
	logRuntimeLaunch(logger, "claude", "stream-json", cmd)
	var release func() error
	if r.profile.RetainProcessTemp != nil {
		if release, err = r.profile.RetainProcessTemp(); err != nil {
			pipes.closeAll()
			abandon(nil)
			return nil, fmt.Errorf("retain Claude process temp: %w", err)
		}
	}
	if err := process.Start(cmd); err != nil {
		pipes.closeAll()
		abandon(release)
		return nil, fmt.Errorf("start Claude: %w", err)
	}
	pipes.closeChildEnds()

	proc := claudeNewProcess(claudeOwnedGroup{cmd}, logger)
	proc.stdin, proc.stdout, proc.stderr = pipes.in, pipes.out, pipes.err
	proc.shape, proc.front, proc.mcpPath, proc.release = launch.shape, front, mcpPath, release
	proc.res.bind(launch.root, r.profile)
	proc.startOwned(cmd)
	return proc, nil
}

func (r *claudeRuntime) spawn(callerCtx, runCtx context.Context, runCancel context.CancelFunc, prompt string, spec RunSpec, launch claudeLaunch, logger *slog.Logger) (*Run, error) {
	var front *mcpFront
	config := []byte(launch.mcp)
	if launch.shape != nil && len(launch.targets) > 0 {
		var err error
		if front, config, err = claudeOpenFront(launch); err != nil {
			return nil, err
		}
	}
	proc, err := r.launchProcess(spec, launch, front, config, logger)
	if err != nil {
		return nil, err
	}
	spec.Readiness.spawned()
	spec.Readiness.session(spec.ResumeID != "")
	if launch.identity != "" && launch.root != "" {
		if err := claudeWriteMarker(launch.root, launch.identity, spec.AppendPrompt); err != nil {
			return nil, claudeAbandonSpawn(proc, fmt.Errorf("write Claude instruction marker: %w", err))
		}
	}
	turn := claudeNewTurn(callerCtx, runCtx, proc, runCancel, prompt, spec, r.profile, false)
	turn.logger, turn.fence = logger, launch.fence
	proc.conv.reset(turn, uuid.NewString())
	if !proc.bind(turn) {
		return nil, claudeAbandonSpawn(proc, errors.New("start Claude: process ended during launch"))
	}
	proc.startReader()
	go turn.watch()
	go turn.submitFresh(launch.initialize)
	return turn.run(), nil
}

// claudeOpenFront starts a resident MCP front bound to the run's targets
// and returns the run's MCP config rewritten to point at it.
func claudeOpenFront(launch claudeLaunch) (*mcpFront, []byte, error) {
	front, err := newMCPFront()
	if err != nil {
		return nil, nil, fmt.Errorf("start Claude MCP front: %w", err)
	}
	if err := front.Bind(launch.targets); err != nil {
		front.Close()
		return nil, nil, err
	}
	config, err := front.Rewrite(launch.mcp)
	if err != nil {
		front.Close()
		return nil, nil, err
	}
	return front, config, nil
}

// claudeAbandonSpawn kills a process that started but cannot serve the Run.
// An unconfirmed tree stays in the table as retiring and blocks its root.
func claudeAbandonSpawn(p *claudeProcess, cause error) error {
	_ = p.group.signal(syscall.SIGKILL)
	select {
	case <-p.leaderDone:
	case <-time.After(claudeKillWait):
	}
	if claudeClosed(p.leaderDone) && p.group.waitEmpty(claudeKillWait) {
		p.mu.Lock()
		p.groupConfirmed, p.stopping = true, true
		p.mu.Unlock()
		p.cancel()
		p.closeStdin()
		p.closeStdout()
		p.releaseResources()
		return cause
	}
	p.mu.Lock()
	p.stopping = true
	p.mu.Unlock()
	p.startReader()
	p.cancel()
	claudeResidents.hold(p)
	return fmt.Errorf("%w; %s", cause, claudeCleanupUnconfirmed)
}

// reuse runs a turn on a process taken from the table.
func (r *claudeRuntime) reuse(callerCtx, runCtx context.Context, runCancel context.CancelFunc, p *claudeProcess, prompt string, spec RunSpec, launch claudeLaunch) (*Run, error) {
	logger := r.profile.Logger
	turn := claudeNewTurn(callerCtx, runCtx, p, runCancel, prompt, spec, r.profile, true)
	turn.logger, turn.fence = logger, launch.fence
	fail := func(err error) (*Run, error) {
		p.cancel()
		claudeResidents.retire(p)
		return nil, err
	}
	p.conv.reset(turn, uuid.NewString())
	if p.front != nil {
		if err := p.front.Bind(launch.targets); err != nil {
			return fail(err)
		}
	}
	p.stderrSnippet.Reset()
	if !p.bind(turn) {
		p.front.Unbind()
		if !claudeResidents.retire(p) {
			return nil, errResidentRecycleUnconfirmed
		}
		return nil, errClaudeAdoptEnded
	}
	go turn.watch()
	go turn.submitReused()
	return turn.run(), nil
}

// claudePipes are the three stdio pipes of a CLI process. The child ends go
// to the child; the Daemon keeps the others.
type claudePipes struct {
	in, childIn   *os.File
	out, childOut *os.File
	err, childErr *os.File
}

func claudeOpenPipes() (*claudePipes, error) {
	p := &claudePipes{}
	var err error
	if p.childIn, p.in, err = os.Pipe(); err != nil {
		return nil, err
	}
	if p.out, p.childOut, err = os.Pipe(); err != nil {
		p.closeAll()
		return nil, err
	}
	if p.err, p.childErr, err = os.Pipe(); err != nil {
		p.closeAll()
		return nil, err
	}
	return p, nil
}

func (p *claudePipes) closeChildEnds() {
	for _, file := range []*os.File{p.childIn, p.childOut, p.childErr} {
		if file != nil {
			_ = file.Close()
		}
	}
}

func (p *claudePipes) closeAll() {
	p.closeChildEnds()
	for _, file := range []*os.File{p.in, p.out, p.err} {
		if file != nil {
			_ = file.Close()
		}
	}
}
