package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/transport"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/protocol"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider/redact"
	wire "github.com/simplexai-labs/linger/contracts-go/runnergateway"
)

// ModelInvoker runs one execute model_invoke on a local Runtime.
type ModelInvoker interface {
	Invoke(ctx context.Context, request provider.ModelInvokeRequest) provider.ModelInvokeResult
	// Close stops the processes it keeps between calls.
	Close()
}

// modelInvoke is the Daemon's record of one in-flight model invocation. It has no
// Context, takes no Operation slot and is never written to the ledger: a lost
// connection or a drain kills its process and nobody replays it.
type modelInvoke struct {
	id     string
	cancel context.CancelFunc
}

type modelInvokeRequest struct {
	InvokeID        string                     `json:"invoke_id"`
	Mode            string                     `json:"mode"`
	ReasoningEffort string                     `json:"reasoning_effort"`
	Instructions    string                     `json:"instructions"`
	Input           string                     `json:"input"`
	OutputSchema    json.RawMessage            `json:"output_schema"`
	WorkspaceFiles  []provider.ModelInvokeFile `json:"workspace_files"`
	TimeoutMS       int64                      `json:"timeout_ms"`
	MaxOutputChars  int                        `json:"max_output_chars"`
	SessionKey      string                     `json:"session_key"`
}

// handleModelInvoke admits one model call and runs it off the receive loop.
// The Agent Service's model scheduler decides how many run at once; a call the
// Daemon refuses is answered at once and nothing is queued.
func (d *Daemon) handleModelInvoke(ctx context.Context, stream transport.Stream, command protocol.Command) error {
	var request modelInvokeRequest
	if err := json.Unmarshal(command.Payload, &request); err != nil {
		return fmt.Errorf("decode model invocation: %w", err)
	}
	if request.InvokeID == "" {
		return errors.New("model invocation is incomplete")
	}
	receivedAt := time.Now()
	slog.Info("runner.model.invoke", "phase", "received", "invoke_id", request.InvokeID,
		"agent_id", command.AgentID, "runtime_type", command.RuntimeType, "mode", request.Mode)
	d.admissionMu.Lock()
	result := d.modelInvokeBlocked(command, request)
	var entry *modelInvoke
	var invokeCtx context.Context
	if result.Outcome == "" {
		d.modelInvokeMu.Lock()
		switch {
		case d.modelInvokes[request.InvokeID] != nil:
			result = provider.ModelInvokeResult{Outcome: provider.ModelInvokeFailed, Reason: "Model invocation is already running"}
		default:
			var cancel context.CancelFunc
			invokeCtx, cancel = context.WithCancel(ctx)
			entry = &modelInvoke{id: request.InvokeID, cancel: cancel}
			d.modelInvokes[request.InvokeID] = entry
		}
		d.modelInvokeMu.Unlock()
	}
	d.admissionMu.Unlock()
	if entry == nil {
		return d.sendModelInvoked(ctx, stream, command, request.InvokeID, result, time.Since(receivedAt))
	}
	d.preparationWG.Add(1)
	go func() {
		defer d.preparationWG.Done()
		d.runModelInvoke(invokeCtx, stream, command, request, entry, receivedAt)
	}()
	return nil
}

// modelInvokeBlocked returns the outcome for a call the Daemon must refuse, or
// an empty result. The caller holds admissionMu.
func (d *Daemon) modelInvokeBlocked(command protocol.Command, request modelInvokeRequest) provider.ModelInvokeResult {
	if d.draining {
		return provider.ModelInvokeResult{Outcome: provider.ModelInvokeUnavailable, Reason: "Local Computer Daemon is draining"}
	}
	d.activeMu.Lock()
	stopped := d.locallyStopped[command.AgentID]
	d.activeMu.Unlock()
	if stopped {
		return provider.ModelInvokeResult{Outcome: provider.ModelInvokeUnavailable, Reason: "Agent Runner is locally stopped"}
	}
	if d.modelInvoker == nil {
		return provider.ModelInvokeResult{Outcome: provider.ModelInvokeRuntimeUnavailable, Reason: "Model invocation is unavailable"}
	}
	if reason := invalidModelInvokeRequest(request); reason != "" {
		return provider.ModelInvokeResult{Outcome: provider.ModelInvokeFailed, Reason: reason}
	}
	return provider.ModelInvokeResult{}
}

// invalidModelInvokeRequest restates the schema's cross-field rules so a call
// the Agent should never send fails instead of running.
func invalidModelInvokeRequest(request modelInvokeRequest) string {
	switch request.ReasoningEffort {
	case "low", "medium", "high":
	default:
		return "Model invocation reasoning effort is invalid"
	}
	switch request.Mode {
	case provider.ModelInvokeStructured:
		var schema map[string]any
		if json.Unmarshal(request.OutputSchema, &schema) != nil || schema == nil {
			return "Structured model invocation requires an output schema"
		}
	case provider.ModelInvokeText:
	case provider.ModelInvokeWorkspace:
	default:
		return "Model invocation mode is invalid"
	}
	if request.Mode != provider.ModelInvokeWorkspace && len(request.WorkspaceFiles) != 0 {
		return "Only workspace model invocations carry files"
	}
	if request.Input == "" {
		return "Model invocation input is empty"
	}
	return ""
}

func (d *Daemon) runModelInvoke(ctx context.Context, stream transport.Stream, command protocol.Command, request modelInvokeRequest, entry *modelInvoke, receivedAt time.Time) {
	slog.Info("runner.model.invoke", "phase", "started", "invoke_id", entry.id)
	result := d.modelInvoker.Invoke(ctx, provider.ModelInvokeRequest{
		RuntimeType: command.RuntimeType, Mode: request.Mode, ReasoningEffort: request.ReasoningEffort,
		Instructions: request.Instructions, Input: request.Input, OutputSchema: request.OutputSchema,
		WorkspaceFiles: request.WorkspaceFiles, Timeout: time.Duration(request.TimeoutMS) * time.Millisecond,
		SessionKey: request.SessionKey, MaxOutputChars: request.MaxOutputChars,
	})
	entry.cancel()
	d.modelInvokeMu.Lock()
	if d.modelInvokes[entry.id] == entry {
		delete(d.modelInvokes, entry.id)
	}
	d.modelInvokeMu.Unlock()
	if err := d.sendModelInvoked(context.WithoutCancel(ctx), stream, command, entry.id, result, time.Since(receivedAt)); err != nil {
		slog.Debug("runner.model.invoke receipt unavailable", "invoke_id", entry.id)
	}
}

// cancelModelInvokes cancels every in-flight model call; each still sends its
// canceled receipt if the connection is open.
func (d *Daemon) cancelModelInvokes(source string) {
	d.modelInvokeMu.Lock()
	defer d.modelInvokeMu.Unlock()
	for _, entry := range d.modelInvokes {
		entry.cancel()
		slog.Info("runner.model.invoke", "phase", "cancel_requested", "invoke_id", entry.id, "cancellation_source", source)
	}
}

func (d *Daemon) sendModelInvoked(ctx context.Context, stream transport.Stream, command protocol.Command, invokeID string, result provider.ModelInvokeResult, duration time.Duration) error {
	payload := map[string]any{
		"type": wire.TypeExecuted, "kind": wire.KindModelInvoke, "command_id": command.CommandID, "runner_id": command.RunnerID,
		"invoke_id": invokeID, "outcome": result.Outcome, "duration_ms": duration.Milliseconds(),
	}
	// The Gateway closes the connection on a frame its schema rejects, so
	// optional fields are sent only when they fit it.
	// A session call that stopped early carries what it streamed so far.
	if result.Outcome != provider.ModelInvokeCompleted && result.Text != "" {
		payload["text"] = result.Text
	}
	if result.Outcome == provider.ModelInvokeCompleted {
		payload["text"] = result.Text
		if result.WorkspaceFiles != nil {
			payload["workspace_files"] = result.WorkspaceFiles
		}
		if result.Usage != nil {
			payload["usage"] = result.Usage
		}
	}
	if result.Model != "" && len(result.Model) <= 200 {
		payload["model"] = result.Model
	}
	if result.RuntimeVersion != "" && len(result.RuntimeVersion) <= 128 {
		payload["runtime_version"] = result.RuntimeVersion
	}
	if reason := receiptReason(redact.Text(result.Reason)); reason != "" && result.Outcome != provider.ModelInvokeCompleted {
		payload["reason"] = reason
	}
	encoded := mustJSON(payload)
	if len(encoded) > transport.MaxFrameBytes {
		// JSON escaping and base64 can push a reply that is within the text
		// and tree bounds past the frame limit, and an oversized frame would
		// close the connection for every other Operation on it.
		slog.Warn("runner.model.invoke", "phase", "reply_oversized", "invoke_id", invokeID, "frame_bytes", len(encoded))
		for _, field := range []string{"text", "workspace_files", "usage"} {
			delete(payload, field)
		}
		result.Outcome = provider.ModelInvokeFailed
		payload["outcome"] = result.Outcome
		payload["reason"] = "Model invocation reply exceeds the Runner Gateway frame limit"
		encoded = mustJSON(payload)
	}
	slog.Info("runner.model.invoke", "phase", result.Outcome, "invoke_id", invokeID, "duration_ms", duration.Milliseconds())
	return stream.Send(ctx, protocol.Event{
		Type: protocol.EventModelInvoked, ProtocolVersion: command.ProtocolVersion, CommandID: command.CommandID,
		SentAt: time.Now().UTC(), Payload: encoded,
	})
}
