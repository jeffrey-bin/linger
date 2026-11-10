package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/assignment"
	lingercontext "github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/context"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/registration"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/runtimehistory"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/transport"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/protocol"
	localworkspace "github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/workspace"
)

func debugInspectedEvent(command protocol.Command, payload json.RawMessage) protocol.Event {
	return protocol.Event{
		Type: protocol.EventDebugInspected, ProtocolVersion: command.ProtocolVersion, CommandID: command.CommandID,
		TenantID: command.TenantID, RunnerID: command.RunnerID, AgentID: command.AgentID,
		RegistrationID: command.RegistrationID, AssignmentRevision: command.AssignmentRevision,
		ConnectionEpoch: command.ConnectionEpoch, RunnerRevision: command.RunnerRevision,
		WorkspaceGrantID: command.WorkspaceGrantID, ExecutionContextKey: command.ExecutionContextKey,
		RuntimeInstanceID: command.RuntimeInstanceID, ViewDigest: command.ViewDigest, Payload: payload,
	}
}

func (d *Daemon) handleDebugInspect(ctx context.Context, stream transport.Stream, command protocol.Command) error {
	result, err := d.inspectDebug(ctx, command)
	if err != nil {
		var payload struct {
			Request struct {
				Runtime struct {
					Type string `json:"type"`
				} `json:"runtime"`
			} `json:"request"`
		}
		if decodeErr := json.Unmarshal(command.Payload, &payload); decodeErr != nil {
			return decodeErr
		}
		reason := "inspection_unavailable"
		if errors.Is(err, lingercontext.ErrContextConflict) {
			reason = "context_view_conflict"
		}
		source := "codex_rollout"
		if payload.Request.Runtime.Type == "claude" {
			source = "claude_transcript"
		}
		slog.Warn("Runner Debug history unavailable", "command_id", command.CommandID,
			"connection_epoch", command.ConnectionEpoch, "view_digest", command.ViewDigest, "reason", reason)
		result = mustJSON(map[string]any{
			"status": "unavailable", "reason": reason, "provider_kind": payload.Request.Runtime.Type,
			"instructions": map[string]any{"status": "unavailable", "source": source, "blocks": []any{}},
			"records":      []any{},
		})
	}
	return stream.Send(ctx, debugInspectedEvent(command, result))
}

func (d *Daemon) inspectDebug(ctx context.Context, command protocol.Command) (json.RawMessage, error) {
	var payload struct {
		Request struct {
			Runtime struct {
				Type string `json:"type"`
			} `json:"runtime"`
			Session struct {
				ThreadID       string `json:"thread_id"`
				ThreadIDCamel  string `json:"threadId"`
				SessionID      string `json:"session_id"`
				SessionIDCamel string `json:"sessionId"`
			} `json:"session"`
			Cursor string `json:"cursor,omitempty"`
			Limit  int    `json:"limit,omitempty"`
		} `json:"request"`
		DetachedHistory bool `json:"detached_history"`
	}
	if err := json.Unmarshal(command.Payload, &payload); err != nil {
		return nil, err
	}
	request := payload.Request
	if request.Runtime.Type != "codex" && request.Runtime.Type != "claude" && request.Runtime.Type != "pi" {
		return nil, errors.New("Debug history Runtime is not supported")
	}
	if !payload.DetachedHistory {
		if d.contextViews == nil {
			return nil, errors.New("Context View store is unavailable")
		}
		view, err := d.contextViews.CurrentView(ctx, command.ExecutionContextKey, command.ViewDigest)
		if err != nil {
			return nil, err
		}
		if view.View.TenantID != command.TenantID || view.View.AgentID != command.AgentID ||
			view.View.RuntimeInstanceID != command.RuntimeInstanceID {
			return nil, errors.New("Debug history Context View identity is invalid")
		}
	}
	registrationID := command.RegistrationID
	if payload.DetachedHistory {
		// A read-only History request may arrive without the Runner identity:
		// the Agent Service has no in-process Agent Runner desired state for a
		// cold Context and must not create one to serve a read. Authorization
		// then comes from this Daemon's own ready Assignment, which is the
		// record the identity would have been checked against anyway.
		resolved, err := d.detachedHistoryAssignment(ctx, command)
		if err != nil {
			return nil, err
		}
		registrationID = resolved.RegistrationID
	}
	binding, err := d.registrationBinding(ctx, registrationID)
	if err != nil {
		return nil, err
	}
	if binding.Key.DaemonID != d.daemonID || binding.Key.TenantID != command.TenantID || binding.Key.ProviderType != request.Runtime.Type {
		return nil, errors.New("Debug history Registration binding is invalid")
	}
	home, err := localworkspace.RuntimeHomePath(d.runtimeHomeRoot, localworkspace.RuntimeHomeIdentity{
		TenantID: command.TenantID, OwnerActorID: binding.Key.OwnerActorID,
		AgentID: command.AgentID, ScopeID: command.ExecutionContextKey, ProviderType: request.Runtime.Type,
	})
	if err != nil {
		return nil, err
	}
	threadID := firstDebugSessionID(request.Session.ThreadID, request.Session.ThreadIDCamel, request.Session.SessionID, request.Session.SessionIDCamel)
	inspect := runtimehistory.Inspect
	if request.Runtime.Type == "claude" {
		inspect = runtimehistory.InspectClaude
	} else if request.Runtime.Type == "pi" {
		inspect = runtimehistory.InspectPi
	}
	return json.Marshal(inspect(ctx, runtimehistory.Request{CodexHome: home, ThreadID: threadID, Cursor: request.Cursor, Limit: request.Limit}))
}

// detachedHistoryAssignment returns the ready Assignment that authorizes a
// detached History read. A command that carries the Runner identity must match
// it exactly, as before. A command without one is matched on the Agent
// placement alone and must resolve to exactly one ready Assignment, so an
// ambiguous placement fails closed instead of picking a Runner.
func (d *Daemon) detachedHistoryAssignment(ctx context.Context, command protocol.Command) (assignment.Record, error) {
	assignments, err := d.assignments.List(ctx)
	if err != nil {
		return assignment.Record{}, err
	}
	identified := command.RegistrationID != ""
	var matches []assignment.Record
	for _, assigned := range assignments {
		if assigned.State != "ready" || assigned.TenantID != command.TenantID ||
			assigned.AgentID != command.AgentID || assigned.RunnerID != command.RunnerID ||
			assigned.WorkspaceGrantID != command.WorkspaceGrantID {
			continue
		}
		if identified && (assigned.RegistrationID != command.RegistrationID ||
			assigned.AssignmentRevision != command.AssignmentRevision ||
			assigned.RunnerRevision != command.RunnerRevision) {
			continue
		}
		matches = append(matches, assigned)
	}
	if len(matches) == 0 {
		return assignment.Record{}, errors.New("Detached history Assignment is unavailable")
	}
	if !identified && len(matches) > 1 {
		return assignment.Record{}, errors.New("Detached history Assignment is ambiguous")
	}
	return matches[0], nil
}

func firstDebugSessionID(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

func (d *Daemon) registrationBinding(ctx context.Context, registrationID string) (registration.Observation, error) {
	if registrationID == "" {
		return registration.Observation{}, errors.New("Debug history lacks a Local Runtime Registration")
	}
	items, err := d.registrations.List(ctx)
	if err != nil {
		return registration.Observation{}, err
	}
	for _, item := range items {
		if item.RegistrationID == registrationID {
			return item, nil
		}
	}
	return registration.Observation{}, errors.New("Debug history Local Runtime Registration is unavailable")
}
