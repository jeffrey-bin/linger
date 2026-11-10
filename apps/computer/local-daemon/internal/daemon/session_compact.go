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
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider/native"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider/redact"
	wire "github.com/simplexai-labs/linger/contracts-go/runnergateway"
)

const (
	// sessionCompactTimeout matches how long the Agent Service waits for the
	// receipt of one compaction.
	sessionCompactTimeout = 10 * time.Minute
)

// sessionCompact is the Daemon's record of one in-flight session compaction for an
// execution Context. Its process is outside the resident table until done
// closes, when it is parked back or retired.
type sessionCompact struct {
	id         string
	agentID    string
	contextKey string
	startedAt  time.Time
	cancel     context.CancelFunc
	done       chan struct{}
}

// parkedSession is a parked native process taken out for one compaction.
type parkedSession interface {
	Compact(ctx context.Context, instructions string) native.CompactResult
}

func takeNativeParkedSession(runtimeType, contextKey string) parkedSession {
	if session := native.TakeParkedSession(runtimeType, contextKey); session != nil {
		return session
	}
	return nil
}

type sessionCompactRequest struct {
	CompactID    string `json:"compact_id"`
	Instructions string `json:"instructions"`
}

// handleSessionCompact compacts only the process already parked for the
// Context. It never starts a process and takes no Operation slot; the take and
// the in-flight entry are admitted under admissionMu, so a start or release of
// the Context either sees the entry or finds the Context busy.
func (d *Daemon) handleSessionCompact(ctx context.Context, stream transport.Stream, command protocol.Command) error {
	var request sessionCompactRequest
	if err := json.Unmarshal(command.Payload, &request); err != nil {
		return fmt.Errorf("decode session compaction: %w", err)
	}
	if request.CompactID == "" || command.ExecutionContextKey == "" {
		return errors.New("session compaction is incomplete")
	}
	key := command.ExecutionContextKey
	receivedAt := time.Now()
	slog.Info("runner.session.compact", "phase", "received", "compact_id", request.CompactID,
		"execution_context_key", key, "agent_id", command.AgentID, "runtime_type", command.RuntimeType)
	d.admissionMu.Lock()
	reason := d.sessionCompactBlocked(command)
	var session parkedSession
	if reason == "" {
		if session = d.takeParkedSession(command.RuntimeType, key); session == nil {
			reason = "No process is parked for this Context"
		}
	}
	if reason != "" {
		d.admissionMu.Unlock()
		return d.sendSessionCompacted(ctx, stream, command, request.CompactID,
			native.CompactResult{Outcome: "no_process", Reason: reason}, time.Since(receivedAt))
	}
	compactCtx, cancel := context.WithTimeout(ctx, sessionCompactTimeout)
	entry := &sessionCompact{
		id: request.CompactID, agentID: command.AgentID, contextKey: key, startedAt: receivedAt,
		cancel: cancel, done: make(chan struct{}),
	}
	d.sessionCompactMu.Lock()
	d.sessionCompacts[key] = entry
	d.sessionCompactMu.Unlock()
	d.admissionMu.Unlock()

	d.preparationWG.Add(1)
	go func() {
		defer d.preparationWG.Done()
		d.runSessionCompact(compactCtx, stream, command, request.Instructions, session, entry)
	}()
	return nil
}

// sessionCompactBlocked names why the Context cannot compact now. The Agent
// Service compacts only an idle Context, so a busy Context is defensive. The
// caller holds admissionMu.
func (d *Daemon) sessionCompactBlocked(command protocol.Command) string {
	if !d.runtimeEnabled(command.RuntimeType) {
		return "Runtime is not enabled on this Computer"
	}
	if d.draining {
		return "Local Computer Daemon is draining"
	}
	key := command.ExecutionContextKey
	d.activeMu.Lock()
	stopped := d.locallyStopped[command.AgentID]
	busy := false
	for _, active := range d.activeOperations {
		busy = busy || active.identity.ExecutionContextKey == key
	}
	d.activeMu.Unlock()
	if stopped {
		return "Agent Runner is locally stopped"
	}
	if busy || d.providerPrepareInFlight(key) || d.sessionCompactInFlight(key) {
		return "Context is busy"
	}
	return ""
}

func (d *Daemon) runSessionCompact(ctx context.Context, stream transport.Stream, command protocol.Command, instructions string, session parkedSession, entry *sessionCompact) {
	slog.Info("runner.session.compact", "phase", "started", "compact_id", entry.id, "execution_context_key", entry.contextKey)
	result := session.Compact(ctx, instructions)
	entry.cancel()
	d.sessionCompactMu.Lock()
	if d.sessionCompacts[entry.contextKey] == entry {
		delete(d.sessionCompacts, entry.contextKey)
	}
	d.sessionCompactMu.Unlock()
	close(entry.done)
	if err := d.sendSessionCompacted(context.WithoutCancel(ctx), stream, command, entry.id, result, time.Since(entry.startedAt)); err != nil {
		slog.Debug("runner.session.compact receipt unavailable", "compact_id", entry.id)
	}
}

func (d *Daemon) sessionCompactInFlight(contextKey string) bool {
	d.sessionCompactMu.Lock()
	defer d.sessionCompactMu.Unlock()
	return d.sessionCompacts[contextKey] != nil
}

// cancelSessionCompacts cancels every matching in-flight compaction and returns
// what to wait for. A canceled compaction retires its process instead of
// parking it back.
func (d *Daemon) cancelSessionCompacts(match func(*sessionCompact) bool, source string) []chan struct{} {
	d.sessionCompactMu.Lock()
	defer d.sessionCompactMu.Unlock()
	var done []chan struct{}
	for _, entry := range d.sessionCompacts {
		if !match(entry) {
			continue
		}
		entry.cancel()
		done = append(done, entry.done)
		slog.Info("runner.session.compact", "phase", "cancel_requested", "compact_id", entry.id,
			"execution_context_key", entry.contextKey, "cancellation_source", source)
	}
	return done
}

// waitSessionCompacts waits until each canceled compaction has parked back or
// retired its process.
func waitSessionCompacts(ctx context.Context, done []chan struct{}) {
	for _, finished := range done {
		select {
		case <-finished:
		case <-ctx.Done():
			return
		}
	}
}

// interruptSessionCompact ends the Context's in-flight compaction before work
// that needs the Context's process or session continues.
func (d *Daemon) interruptSessionCompact(ctx context.Context, contextKey, source string) {
	waitSessionCompacts(ctx, d.cancelSessionCompacts(sessionCompactForContext(contextKey), source))
}

func sessionCompactForContext(contextKey string) func(*sessionCompact) bool {
	return func(entry *sessionCompact) bool { return entry.contextKey == contextKey }
}

func sessionCompactForAgent(agentID string) func(*sessionCompact) bool {
	return func(entry *sessionCompact) bool { return entry.agentID == agentID }
}

func sessionCompactAll(*sessionCompact) bool { return true }

func (d *Daemon) sendSessionCompacted(ctx context.Context, stream transport.Stream, command protocol.Command, compactID string, result native.CompactResult, duration time.Duration) error {
	payload := wire.SessionCompacted{
		Type: wire.TypeExecuted, Kind: wire.KindSessionCompact, CommandID: command.CommandID, RunnerID: command.RunnerID,
		CompactID: compactID, ExecutionContextKey: command.ExecutionContextKey, Outcome: result.Outcome,
		DurationMs: uint64(max(duration.Milliseconds(), 0)), Reason: receiptReason(redact.Text(result.Reason)),
	}
	// The Gateway closes the connection on a frame its schema rejects.
	if result.PreTokens != nil && *result.PreTokens >= 0 {
		preTokens := uint64(*result.PreTokens)
		payload.PreTokens = &preTokens
	}
	slog.Info("runner.session.compact", "phase", result.Outcome, "compact_id", compactID,
		"execution_context_key", command.ExecutionContextKey, "duration_ms", duration.Milliseconds())
	return stream.Send(ctx, protocol.Event{
		Type: protocol.EventSessionCompacted, ProtocolVersion: command.ProtocolVersion, CommandID: command.CommandID,
		SentAt: time.Now().UTC(), Payload: mustJSON(payload),
	})
}
