package agentruntimestate

import (
	"context"
	"encoding/json"
	"log/slog"

	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

// EpochStart is what opening a new Agent Service epoch did.
type EpochStart struct {
	InterruptedRunIDs []string `json:"interrupted_run_ids"`
	// WaitingContextKeys names the Contexts with a queued Run or Message steer,
	// which the new process takes up at once.
	WaitingContextKeys []string `json:"waiting_context_keys"`
}

var interruptedTerminal = json.RawMessage(`{"type":"failed","error":"process_interrupted","failure":{"code":"interrupted"}}`)

// StartEpoch opens the epoch of a newly started Agent Service process. Only
// one process runs against a database, so a Run still running under an
// earlier epoch has lost its process: it ends as interrupted and its native
// questions expire. Queued Runs stay queued. A steer that waited for an
// interrupted Run becomes a queued Run when it is a Message; any other steer
// is settled as uncertain. The Codex thread stays on the Context, so the next
// Run resumes it. No Computer is connected to the new process yet, so every
// Computer is offline until it connects again.
func (s *Service) StartEpoch(ctx context.Context, epoch string) (EpochStart, error) {
	if !validEpoch(epoch) {
		return EpochStart{}, ErrInvalid
	}
	result, err := executeTx(ctx, s, func(ctx context.Context, _ pgx.Tx, queries *store.Queries) (EpochStart, error) {
		// Deleting the previous epoch waits for every write that still holds it.
		if err := queries.ReplaceAgentServiceEpoch(ctx); err != nil {
			return EpochStart{}, err
		}
		if err := markLocalComputersOffline(ctx, queries); err != nil {
			return EpochStart{}, err
		}
		if err := queries.InsertAgentServiceEpoch(ctx, epoch); err != nil {
			return EpochStart{}, err
		}
		contextKeys, err := queries.LockAgentContextsForEpochStart(ctx, epoch)
		if err != nil {
			return EpochStart{}, err
		}
		result := EpochStart{InterruptedRunIDs: []string{}, WaitingContextKeys: []string{}}
		for _, contextKey := range contextKeys {
			runIDs, err := queries.ListAgentContextRunsOfEarlierEpoch(ctx, store.ListAgentContextRunsOfEarlierEpochParams{
				ContextKey: contextKey, Epoch: epoch,
			})
			if err != nil {
				return EpochStart{}, err
			}
			interrupted, err := TerminateLocalRuns(ctx, queries, runIDs, interruptedTerminal)
			if err != nil {
				return EpochStart{}, err
			}
			if len(interrupted) > 0 {
				owner, err := queries.GetAgentExecutionContext(ctx, contextKey)
				if err != nil {
					return EpochStart{}, err
				}
				for _, run := range interrupted {
					if err := expireRuntimeHumanInteractions(ctx, queries, run.RunID, owner.TenantID, owner.AgentActorID); err != nil {
						return EpochStart{}, err
					}
					result.InterruptedRunIDs = append(result.InterruptedRunIDs, run.RunID)
				}
			}
			if err := settleSteersOfInterruptedRuns(ctx, queries, contextKey); err != nil {
				return EpochStart{}, err
			}
		}
		waiting, err := queries.ListAgentContextsWithQueuedWork(ctx)
		if err != nil {
			return EpochStart{}, err
		}
		result.WaitingContextKeys = append(result.WaitingContextKeys, waiting...)
		return result, nil
	})
	if err == nil {
		slog.InfoContext(ctx, "agent_service.epoch_started", "epoch", epoch,
			"interrupted_runs", len(result.InterruptedRunIDs), "waiting_contexts", len(result.WaitingContextKeys))
	}
	return result, err
}

// settleSteersOfInterruptedRuns runs under the Context lock after its Runs of
// the earlier epoch ended. No process holds the steers any more.
func settleSteersOfInterruptedRuns(ctx context.Context, queries *store.Queries, contextKey string) error {
	steering, err := queries.ListAgentRuntimeSteeringInputs(ctx, contextKey)
	if err != nil {
		return err
	}
	if len(steering) == 0 {
		return nil
	}
	groups := make([]string, 0)
	groupRows := make(map[string][]store.AgentRuntimeInput)
	for _, row := range steering {
		if !row.SteerGroupID.Valid {
			return ErrConflict
		}
		groupID := row.SteerGroupID.String
		if _, exists := groupRows[groupID]; !exists {
			groups = append(groups, groupID)
		}
		groupRows[groupID] = append(groupRows[groupID], row)
	}
	uncertain, _ := canonicalJSON(map[string]any{"selected": "steer", "effective": "uncertain"})
	for _, groupID := range groups {
		rows := groupRows[groupID]
		trusted, err := trustedInboxSteerGroup(rows)
		if err != nil {
			return err
		}
		if trusted {
			// No member Room was locked, so the queued Run opens its status when
			// claimed.
			if _, err := enqueueSteerRows(ctx, queries, contextKey, groupID, rows, nil); err != nil {
				return err
			}
			continue
		}
		for _, row := range rows {
			changed, err := queries.SettleUncertainAgentRuntimeSteerInput(ctx, store.SettleUncertainAgentRuntimeSteerInputParams{
				SelectionResult: uncertain, ContextKey: contextKey,
				InputID: row.InputID, SteerGroupID: groupID,
			})
			if err != nil {
				return err
			}
			if changed != 1 {
				return ErrConflict
			}
		}
	}
	_, err = queries.BumpAgentExecutionContextStateRevision(ctx, contextKey)
	return err
}
