package agentruntimestate

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

func (s *Service) EnqueueSteer(ctx context.Context, input EnqueueSteerInput) (EnqueueSteerResult, error) {
	if strings.TrimSpace(input.GroupID) == "" || len(input.GroupID) > 256 {
		return EnqueueSteerResult{}, ErrInvalid
	}
	return executeEpochTx(ctx, s, input.Epoch, func(ctx context.Context, _ pgx.Tx, queries *store.Queries) (EnqueueSteerResult, error) {
		hint, err := queries.ListAgentRuntimeSteerInputsAuthorityHint(ctx, store.ListAgentRuntimeSteerInputsAuthorityHintParams{ContextKey: input.ContextKey, SteerGroupID: input.GroupID})
		if err != nil {
			return EnqueueSteerResult{}, err
		}
		_, authority, err := lockRuntimeInputsContext(ctx, queries, input.ContextKey, runtimeInputsForAuthority(hint), false)
		if err != nil {
			return EnqueueSteerResult{}, err
		}
		rows, err := queries.LockAgentRuntimeSteerInputs(ctx, store.LockAgentRuntimeSteerInputsParams{
			ContextKey: input.ContextKey, SteerGroupID: input.GroupID,
		})
		if err != nil {
			return EnqueueSteerResult{}, err
		}
		if len(rows) == 0 {
			// A repeated enqueue finds the Run its first attempt queued.
			runID, err := queries.GetAgentSteerGroupRun(ctx, store.GetAgentSteerGroupRunParams{ContextKey: input.ContextKey, SteerGroupID: input.GroupID})
			if isNoRows(err) {
				return EnqueueSteerResult{}, ErrNotFound
			}
			if err != nil {
				return EnqueueSteerResult{}, err
			}
			return EnqueueSteerResult{RunID: runID}, nil
		}
		if !sameRuntimeInputAuthority(hint, rows) {
			return EnqueueSteerResult{}, ErrConflict
		}
		runID, err := enqueueSteerRows(ctx, queries, input.ContextKey, input.GroupID, rows, authority.memberRooms)
		if err != nil {
			return EnqueueSteerResult{}, err
		}
		if _, err := queries.BumpAgentExecutionContextStateRevision(ctx, input.ContextKey); err != nil {
			return EnqueueSteerResult{}, err
		}
		return EnqueueSteerResult{RunID: runID}, nil
	})
}

func (s *Service) AssignSteerRun(ctx context.Context, input AssignSteerRunInput) error {
	if strings.TrimSpace(input.GroupID) == "" || strings.TrimSpace(input.RunID) == "" {
		return ErrInvalid
	}
	_, err := executeEpochTx(ctx, s, input.Epoch, func(ctx context.Context, _ pgx.Tx, queries *store.Queries) (bool, error) {
		if _, err := lockContext(ctx, queries, input.ContextKey); err != nil {
			return false, err
		}
		run, err := queries.GetAgentLocalRun(ctx, store.GetAgentLocalRunParams{
			ContextKey: input.ContextKey, RunID: input.RunID,
		})
		if isNoRows(err) {
			return false, ErrNotFound
		}
		if err != nil {
			return false, err
		}
		if run.Status != "running" {
			return false, ErrConflict
		}
		if run.Epoch.String != input.Epoch {
			return false, ErrFenced
		}
		rows, err := queries.LockAgentRuntimeSteerInputs(ctx, store.LockAgentRuntimeSteerInputsParams{
			ContextKey: input.ContextKey, SteerGroupID: input.GroupID,
		})
		if err != nil {
			return false, err
		}
		if len(rows) == 0 {
			return false, ErrNotFound
		}
		ordinal, err := queries.NextAgentLocalRunSteerOrdinal(ctx, input.RunID)
		if err != nil {
			return false, err
		}
		for _, row := range rows {
			if row.LocalRunID.Valid && row.LocalRunID.String != input.RunID {
				return false, ErrConflict
			}
			changed, err := queries.AssignAgentRuntimeSteerInput(ctx, store.AssignAgentRuntimeSteerInputParams{
				LocalRunID: input.RunID, ContextKey: input.ContextKey,
				InputID: row.InputID, SteerGroupID: input.GroupID,
			})
			if err != nil {
				return false, err
			}
			if changed != 1 {
				return false, ErrConflict
			}
			inserted, err := queries.InsertAgentLocalRunSteerInput(ctx, store.InsertAgentLocalRunSteerInputParams{
				RunID: input.RunID, ContextKey: input.ContextKey, InputID: row.InputID, Ordinal: ordinal,
			})
			if err != nil {
				return false, err
			}
			if inserted == 1 {
				ordinal++
			}
		}
		if _, err := queries.BumpAgentExecutionContextStateRevision(ctx, input.ContextKey); err != nil {
			return false, err
		}
		return true, nil
	})
	return err
}

func (s *Service) CompleteSteer(ctx context.Context, input CompleteSteerInput) error {
	if strings.TrimSpace(input.GroupID) == "" || strings.TrimSpace(input.RunID) == "" ||
		(input.Outcome != "applied" && input.Outcome != "uncertain") {
		return ErrInvalid
	}
	_, err := executeEpochTx(ctx, s, input.Epoch, func(ctx context.Context, _ pgx.Tx, queries *store.Queries) (bool, error) {
		if _, err := lockContext(ctx, queries, input.ContextKey); err != nil {
			return false, err
		}
		rows, err := queries.LockAgentRuntimeSteerInputs(ctx, store.LockAgentRuntimeSteerInputsParams{
			ContextKey: input.ContextKey, SteerGroupID: input.GroupID,
		})
		if err != nil {
			return false, err
		}
		if len(rows) == 0 {
			// A repeated completion finds its steers settled on the same Run.
			runID, err := queries.GetAgentSteerGroupRun(ctx, store.GetAgentSteerGroupRunParams{ContextKey: input.ContextKey, SteerGroupID: input.GroupID})
			if isNoRows(err) {
				return false, ErrNotFound
			}
			if err != nil {
				return false, err
			}
			if runID != input.RunID {
				return false, ErrConflict
			}
			return true, nil
		}
		selection, _ := canonicalJSON(map[string]any{"selected": "steer", "effective": input.Outcome})
		for _, row := range rows {
			if !row.LocalRunID.Valid || row.LocalRunID.String != input.RunID {
				return false, ErrConflict
			}
			changed, err := queries.CompleteAgentRuntimeSteerInput(ctx, store.CompleteAgentRuntimeSteerInputParams{
				SelectionResult: selection, SteerOutcome: optionalText(input.Outcome),
				LocalRunID: input.RunID, ContextKey: input.ContextKey,
				InputID: row.InputID, SteerGroupID: input.GroupID,
			})
			if err != nil {
				return false, err
			}
			if changed != 1 {
				return false, ErrConflict
			}
		}
		if _, err := queries.BumpAgentExecutionContextStateRevision(ctx, input.ContextKey); err != nil {
			return false, err
		}
		return true, nil
	})
	return err
}

// RedeliverUnconfirmedRunInputs places a finished Run's uncertain follow-ups
// again for the same Context and returns how many were placed. The Context
// lock serializes concurrent resends, and the database function places each
// follow-up at most once, so a repeated call places nothing. A Context whose
// Agent left the Room takes no input and reports zero.
func (s *Service) RedeliverUnconfirmedRunInputs(ctx context.Context, runID string) (int, error) {
	if strings.TrimSpace(runID) == "" {
		return 0, ErrInvalid
	}
	return executeTx(ctx, s, func(ctx context.Context, _ pgx.Tx, queries *store.Queries) (int, error) {
		contextKey, err := queries.GetAgentLocalRunContextKey(ctx, runID)
		if isNoRows(err) {
			return 0, ErrNotFound
		}
		if err != nil {
			return 0, err
		}
		if _, err := lockContext(ctx, queries, contextKey); err != nil {
			if errors.Is(err, ErrFenced) {
				return 0, nil
			}
			return 0, err
		}
		run, err := queries.GetAgentLocalRun(ctx, store.GetAgentLocalRunParams{ContextKey: contextKey, RunID: runID})
		if err != nil {
			return 0, err
		}
		if run.Status == "queued" || run.Status == "running" {
			return 0, nil
		}
		inputIDs, err := queries.ListUnconfirmedAgentRuntimeRunInputs(ctx, runID)
		if err != nil {
			return 0, err
		}
		redelivered := 0
		for _, inputID := range inputIDs {
			placed, err := queries.RedeliverAgentRuntimeInput(ctx, store.RedeliverAgentRuntimeInputParams{ContextKey: contextKey, InputID: inputID})
			if err != nil {
				return 0, err
			}
			if placed != "" {
				redelivered++
			}
		}
		if redelivered > 0 {
			if _, err := queries.BumpAgentExecutionContextStateRevision(ctx, contextKey); err != nil {
				return 0, err
			}
		}
		return redelivered, nil
	})
}

func (s *Service) ContextHasQueuedRuns(ctx context.Context, contextKey string) (bool, error) {
	if s == nil || s.pool == nil {
		return false, ErrInvalid
	}
	if _, err := DecodeContextKey(contextKey); err != nil {
		return false, ErrInvalid
	}
	return store.New(s.pool).AgentRuntimeContextHasQueuedRun(ctx, contextKey)
}

func enqueueSteerRows(
	ctx context.Context,
	queries *store.Queries,
	contextKey string,
	groupID string,
	rows []store.AgentRuntimeInput,
	memberRooms map[string]bool,
) (string, error) {
	runID, err := newID("local-run-")
	if err != nil {
		return "", err
	}
	if _, err := queries.CreateAgentLocalRun(ctx, store.CreateAgentLocalRunParams{
		RunID: runID, ContextKey: contextKey,
	}); err != nil {
		return "", err
	}
	selection, _ := canonicalJSON(map[string]any{"selected": "steer", "effective": "enqueue"})
	for index, row := range rows {
		if _, err := queries.DeleteAgentLocalRunInputByMessage(ctx, store.DeleteAgentLocalRunInputByMessageParams{
			ContextKey: contextKey, InputID: row.InputID,
		}); err != nil {
			return "", err
		}
		changed, err := queries.CompleteAgentRuntimeSteerInput(ctx, store.CompleteAgentRuntimeSteerInputParams{
			SelectionResult: selection, LocalRunID: runID, ContextKey: contextKey,
			InputID: row.InputID, SteerGroupID: groupID,
		})
		if err != nil {
			return "", err
		}
		if changed != 1 {
			return "", ErrConflict
		}
		if err := insertRunInput(ctx, queries, runID, contextKey, row.InputID, "initial", int64(index)); err != nil {
			return "", err
		}
	}
	if err := projectQueuedRun(ctx, queries, contextKey, runID, memberRooms); err != nil {
		return "", err
	}
	return runID, nil
}

func trustedInboxSteerGroup(rows []store.AgentRuntimeInput) (bool, error) {
	trusted := false
	for index, row := range rows {
		var selection struct {
			Selected string `json:"selected"`
		}
		if json.Unmarshal(row.SelectionResult, &selection) != nil || selection.Selected == "" {
			return false, ErrConflict
		}
		current := selection.Selected == "trusted_inbox_notification"
		if index > 0 && current != trusted {
			return false, ErrConflict
		}
		trusted = current
	}
	return trusted, nil
}

// ListMessageSteers returns the steers a Message transaction queued for this
// Context that the Agent Service has not settled, in input order.
func (s *Service) ListMessageSteers(ctx context.Context, contextKey string) ([]StoredRuntimeInput, error) {
	if s == nil || s.pool == nil {
		return nil, ErrInvalid
	}
	if _, err := DecodeContextKey(contextKey); err != nil {
		return nil, ErrInvalid
	}
	rows, err := store.New(s.pool).ListAgentContextMessageSteers(ctx, contextKey)
	if err != nil {
		return nil, err
	}
	steers := make([]StoredRuntimeInput, 0, len(rows))
	for _, row := range rows {
		steer, err := storedInputFromRow(row)
		if err != nil {
			return nil, err
		}
		steers = append(steers, steer)
	}
	return steers, nil
}

// ListWaitingContexts names the Contexts whose queued Run or Message steer
// has waited long enough that its wake hint may have been lost.
func (s *Service) ListWaitingContexts(ctx context.Context) ([]string, error) {
	if s == nil || s.pool == nil {
		return nil, ErrInvalid
	}
	keys, err := store.New(s.pool).ListAgentContextsWithWaitingRuns(ctx)
	if err != nil {
		return nil, err
	}
	return keys, nil
}
