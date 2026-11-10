package native

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"

	"github.com/google/uuid"
)

// prestart spawns the CLI ahead of a Room-presence run and parks it for the
// Run to adopt. A prepare carries no Run, so its MCP set is empty and it
// writes no instruction marker: a discarded pre-start leaves no Claude state
// behind.
func (r *claudeRuntime) prestart(ctx context.Context, spec RunSpec, resolved, root, identity string, logger *slog.Logger) (*Run, error) {
	if root == "" || identity == "" || !claudeResidents.enabled() {
		return nil, errors.New("Claude provider prepare is not eligible")
	}
	fence := captureReleaseFence(r.profile)
	mcpShape, _, _ := residentMCPShape(spec.MCPServers)
	shaped, launchArgs := claudeBuildArgv(logger, spec)
	initialize := claudeInitializeFrame(spec)
	launch := claudeLaunch{
		resolved: resolved, launchArgs: launchArgs, initialize: initialize,
		mcp: spec.MCPServers, root: root, fence: fence,
		shape: &claudeShape{
			execPath: resolved, cwd: spec.Dir, args: shaped,
			env:        claudeShapeEnv(childEnvironment(r.profile.Env)),
			initialize: string(initialize), mcp: mcpShape,
		},
	}

	live, fields := claudeResidents.peek(root, claudeMismatch(launch.shape, spec))
	if live && len(fields) == 0 {
		return claudeSettledRun(Outcome{Status: statusCompleted, SessionID: identity}), nil
	}
	reason := "spawn"
	if live {
		reason = "incompatible"
	}
	stopped, err := claudeResidents.stopWhere(reason, func(p *claudeProcess) bool { return p.res.key == root }, logger)
	for range stopped {
		spec.Readiness.recycled(reason, fields)
	}
	if err != nil {
		return nil, err
	}

	proc, err := r.launchProcess(spec, launch, nil, spec.MCPServers, logger)
	if err != nil {
		return nil, err
	}
	spec.Readiness.spawned()
	spec.Readiness.session(spec.ResumeID != "")
	proc.mu.Lock()
	proc.sessionID, proc.prestartCreated = identity, spec.AssignSessionID != ""
	proc.mu.Unlock()
	proc.startReader()

	initCtx, cancel := context.WithTimeout(ctx, claudeInitLimit)
	_, err = proc.conv.request(initCtx, claudeInitializeRequestID, initialize)
	cancel()
	if err != nil {
		claudeResidents.retire(proc)
		return nil, fmt.Errorf("initialize Claude pre-start: %w", err)
	}
	if !claudeResidents.park(proc, fence, true, logger, spec.Readiness) {
		claudeResidents.retire(proc)
		return nil, errors.New("Claude provider prepare could not park the process")
	}
	return claudeSettledRun(Outcome{Status: statusCompleted, SessionID: identity, Parked: true}), nil
}

// claudeMCPChange is the answer to mcp_set_servers.
type claudeMCPChange struct {
	Added   []string                   `json:"added"`
	Removed []string                   `json:"removed"`
	Errors  map[string]json.RawMessage `json:"errors"`
}

// attach gives a taken process the Run's attachments without a new
// session: a changed MCP set is connected through a new front, and an
// adopted pre-start gets the instruction marker. The process is out of the
// table while this runs.
func (r *claudeRuntime) attach(ctx context.Context, p *claudeProcess, spec RunSpec, launch claudeLaunch, adopted bool) (err error) {
	p.mu.Lock()
	current, previous := "", p.front
	if p.shape != nil {
		current = p.shape.mcp
	}
	p.mu.Unlock()
	front, changed := previous, current != launch.shape.mcp
	if changed {
		front = nil
		config := []byte(launch.mcp)
		if len(launch.targets) > 0 {
			if front, config, err = claudeOpenFront(launch); err != nil {
				return err
			}
		}
		defer func() {
			if err != nil {
				front.Close()
			}
		}()
		if err = p.setMCPServers(ctx, config); err != nil {
			return err
		}
	}
	if adopted {
		p.mu.Lock()
		session := p.sessionID
		p.mu.Unlock()
		if err = claudeWriteMarker(launch.root, session, spec.AppendPrompt); err != nil {
			return fmt.Errorf("write Claude instruction marker: %w", err)
		}
	}
	p.mu.Lock()
	if p.released || p.stopping || p.ended {
		p.mu.Unlock()
		return errClaudeAdoptEnded
	}
	p.shape, p.front = launch.shape, front
	p.mu.Unlock()
	if changed {
		previous.Close()
	}
	return nil
}

// setMCPServers asks the CLI to connect the servers of config and checks
// that every one of them was added.
func (p *claudeProcess) setMCPServers(ctx context.Context, config []byte) error {
	var document struct {
		Servers map[string]json.RawMessage `json:"mcpServers"`
	}
	if err := json.Unmarshal(config, &document); err != nil {
		return fmt.Errorf("decode Claude MCP configuration: %w", err)
	}
	id := uuid.NewString()
	frame, err := json.Marshal(map[string]any{
		"type": "control_request", "request_id": id,
		"request": map[string]any{"subtype": "mcp_set_servers", "servers": document.Servers},
	})
	if err != nil {
		return err
	}
	limit, cancel := context.WithTimeout(ctx, claudeInitLimit)
	payload, err := p.conv.request(limit, id, frame)
	cancel()
	if err != nil {
		return fmt.Errorf("set Claude MCP servers: %w", err)
	}
	var change claudeMCPChange
	if len(payload) > 0 {
		if err := json.Unmarshal(payload, &change); err != nil {
			return fmt.Errorf("decode Claude MCP server change: %w", err)
		}
	}
	added := map[string]bool{}
	for _, name := range change.Added {
		added[name] = true
	}
	missing := len(change.Errors) > 0
	for name := range document.Servers {
		missing = missing || !added[name]
	}
	if missing {
		return errors.New("Claude did not connect every MCP server")
	}
	return nil
}
