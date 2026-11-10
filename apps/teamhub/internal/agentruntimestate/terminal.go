package agentruntimestate

import (
	"context"
	"encoding/json"
	"slices"
	"strings"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

// runStop is what a Run terminal tells the Run's stopped event.
type runStop struct {
	status  string
	intent  string
	reason  string
	failure *PublicRuntimeFailure
}

// runStopFromTerminal is the only mapping from a Run terminal to a status
// intent and reason. The Agent Service sends the terminal, never the intent.
func runStopFromTerminal(raw json.RawMessage) (runStop, error) {
	failure, err := terminalRuntimeFailure(raw)
	if err != nil {
		return runStop{}, err
	}
	var terminal struct {
		Type   string `json:"type"`
		Error  string `json:"error"`
		Reason string `json:"reason"`
	}
	if json.Unmarshal(raw, &terminal) != nil {
		return runStop{}, ErrInvalid
	}
	switch terminal.Type {
	case "succeeded":
		return runStop{status: "succeeded", intent: "complete"}, nil
	case "canceled":
		return runStop{status: "canceled", intent: "canceled", reason: boundedRuntimeStatusReason(terminal.Reason)}, nil
	case "failed":
		if strings.TrimSpace(terminal.Error) == "" {
			return runStop{}, ErrInvalid
		}
		intent := "failed"
		if terminal.Error == "process_interrupted" {
			intent = "process_interrupted"
		}
		return runStop{status: "failed", intent: intent, reason: boundedRuntimeStatusReason(terminal.Error), failure: failure}, nil
	default:
		return runStop{}, ErrInvalid
	}
}

// TerminateLocalRuns writes one terminal to those of runIDs still queued or
// running. Call it after locking the Runs' Contexts. Each terminated Run that
// shows a status gets its stopped event under its status Room lock, taken in
// Room order, and each Context one state revision.
func TerminateLocalRuns(ctx context.Context, queries *store.Queries, runIDs []string, terminal json.RawMessage) ([]store.TerminateAgentLocalRunsRow, error) {
	stop, err := runStopFromTerminal(terminal)
	if err != nil {
		return nil, err
	}
	terminalJSON, err := canonicalJSON(terminal)
	if err != nil {
		return nil, ErrInvalid
	}
	if len(runIDs) == 0 {
		return nil, nil
	}
	terminated, err := queries.TerminateAgentLocalRuns(ctx, store.TerminateAgentLocalRunsParams{
		Status: stop.status, Terminal: terminalJSON, RunIds: runIDs,
	})
	if err != nil {
		return nil, err
	}
	slices.SortFunc(terminated, func(left, right store.TerminateAgentLocalRunsRow) int {
		return strings.Compare(left.RunID, right.RunID)
	})
	if err := stopRunStatuses(ctx, queries, terminated, stop); err != nil {
		return nil, err
	}
	contextKeys := make([]string, 0, len(terminated))
	for _, run := range terminated {
		contextKeys = append(contextKeys, run.ContextKey)
	}
	slices.Sort(contextKeys)
	for _, contextKey := range slices.Compact(contextKeys) {
		if _, err := queries.BumpAgentExecutionContextStateRevision(ctx, contextKey); err != nil {
			return nil, err
		}
	}
	return terminated, nil
}

// stopRunStatuses ends the event log of each terminated Run that shows a
// status with its stopped event and announces the stop.
func stopRunStatuses(ctx context.Context, queries *store.Queries, runs []store.TerminateAgentLocalRunsRow, stop runStop) error {
	type shown struct{ runID, roomID string }
	statuses := make([]shown, 0, len(runs))
	for _, run := range runs {
		status, err := queries.GetAgentRunStatus(ctx, run.RunID)
		if isNoRows(err) {
			continue
		}
		if err != nil {
			return err
		}
		statuses = append(statuses, shown{runID: run.RunID, roomID: status.StatusRoomID})
	}
	slices.SortFunc(statuses, func(left, right shown) int {
		if order := strings.Compare(left.roomID, right.roomID); order != 0 {
			return order
		}
		return strings.Compare(left.runID, right.runID)
	})
	for _, status := range statuses {
		log, err := openRunStatusLog(ctx, queries, status.runID)
		if err != nil {
			return err
		}
		if log == nil {
			continue
		}
		if err := appendStoppedEvent(ctx, queries, log, stop.intent, stop.failure); err != nil {
			return err
		}
		if err := log.publish(ctx, queries); err != nil {
			return err
		}
	}
	return nil
}
