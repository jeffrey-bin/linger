package agentruntimestate

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

func (s *Service) AcceptTrustedNotification(ctx context.Context, input AcceptTrustedNotificationInput) (AcceptTrustedNotificationResult, error) {
	if strings.TrimSpace(input.ExecutionRunRef) == "" || len(input.ExecutionRunRef) > 128 ||
		input.Input.SourceKind != "internal" || input.Input.SourceInboxID != "" {
		return AcceptTrustedNotificationResult{}, ErrInvalid
	}
	if err := validateRuntimeInputs([]RuntimeInput{input.Input}); err != nil {
		return AcceptTrustedNotificationResult{}, err
	}
	return executeEpochTx(ctx, s, input.Epoch, func(ctx context.Context, _ pgx.Tx, queries *store.Queries) (AcceptTrustedNotificationResult, error) {
		contextRow, err := lockContext(ctx, queries, input.ContextKey)
		if err != nil {
			return AcceptTrustedNotificationResult{}, err
		}
		existing, err := queries.GetAgentRuntimeInput(ctx, store.GetAgentRuntimeInputParams{
			ContextKey: input.ContextKey, InputID: input.Input.InputID,
		})
		if err == nil {
			if err := assertSameRuntimeInput(existing, input.Input); err != nil {
				return AcceptTrustedNotificationResult{}, err
			}
			return AcceptTrustedNotificationResult{Status: "already_accepted"}, nil
		}
		if !isNoRows(err) {
			return AcceptTrustedNotificationResult{}, err
		}
		if contextRow.TargetResidency != "active" {
			return AcceptTrustedNotificationResult{}, ErrConflict
		}
		run, err := queries.GetAgentLocalRun(ctx, store.GetAgentLocalRunParams{
			ContextKey: input.ContextKey, RunID: input.ExecutionRunRef,
		})
		if isNoRows(err) {
			return AcceptTrustedNotificationResult{}, ErrNotFound
		}
		if err != nil {
			return AcceptTrustedNotificationResult{}, err
		}
		if run.Status != "running" || run.Epoch.String != input.Epoch {
			return AcceptTrustedNotificationResult{}, ErrConflict
		}
		groupID, err := newID("steer-")
		if err != nil {
			return AcceptTrustedNotificationResult{}, err
		}
		selection, _ := canonicalJSON(map[string]any{"selected": "trusted_notification"})
		sequence, err := insertRuntimeInput(
			ctx, queries, input.ContextKey, input.Input,
			"steering", selection, groupID, "", "",
		)
		if err != nil {
			return AcceptTrustedNotificationResult{}, err
		}
		if _, err := activateContextForInput(ctx, queries, contextRow, sequence); err != nil {
			return AcceptTrustedNotificationResult{}, err
		}
		return AcceptTrustedNotificationResult{Status: "committed", SteerGroupID: groupID}, nil
	})
}

func (s *Service) SubmitTrustedTurn(ctx context.Context, input SubmitTrustedTurnInput) (SubmitTrustedTurnResult, error) {
	if err := validateRuntimeInputs(input.Inputs); err != nil {
		return SubmitTrustedTurnResult{}, err
	}
	result, err := executeEpochTx(ctx, s, input.Epoch, func(ctx context.Context, tx pgx.Tx, queries *store.Queries) (SubmitTrustedTurnResult, error) {
		contextRow, authority, err := lockRuntimeInputsContext(ctx, queries, input.ContextKey, input.Inputs, true)
		if err != nil {
			return SubmitTrustedTurnResult{}, err
		}
		if err := requireRuntimeInputsAuthority(ctx, tx, queries, contextRow, input.Inputs); err != nil {
			return SubmitTrustedTurnResult{}, err
		}
		replayRunID := ""
		found := 0
		for _, accepted := range input.Inputs {
			existing, err := queries.GetAgentRuntimeInput(ctx, store.GetAgentRuntimeInputParams{
				ContextKey: input.ContextKey, InputID: accepted.InputID,
			})
			if isNoRows(err) {
				continue
			}
			if err != nil {
				return SubmitTrustedTurnResult{}, err
			}
			if err := assertSameRuntimeInput(existing, accepted); err != nil || !existing.LocalRunID.Valid {
				return SubmitTrustedTurnResult{}, ErrConflict
			}
			if replayRunID == "" {
				replayRunID = existing.LocalRunID.String
			} else if replayRunID != existing.LocalRunID.String {
				return SubmitTrustedTurnResult{}, ErrConflict
			}
			found++
		}
		if found > 0 {
			if found != len(input.Inputs) {
				return SubmitTrustedTurnResult{}, ErrConflict
			}
			return SubmitTrustedTurnResult{RunID: replayRunID}, nil
		}
		runID, err := newID("local-run-")
		if err != nil {
			return SubmitTrustedTurnResult{}, err
		}
		if _, err := queries.CreateAgentLocalRun(ctx, store.CreateAgentLocalRunParams{
			RunID: runID, ContextKey: input.ContextKey,
		}); err != nil {
			return SubmitTrustedTurnResult{}, err
		}
		selectionJSON, _ := canonicalJSON(map[string]any{"selected": "trusted", "effective": "enqueue"})
		var lastSequence int64
		for index, accepted := range input.Inputs {
			sequence, err := insertRuntimeInput(ctx, queries, input.ContextKey, accepted, "handled", selectionJSON, "", runID, "")
			if err != nil {
				return SubmitTrustedTurnResult{}, err
			}
			lastSequence = max(lastSequence, sequence)
			if err := insertRunInput(ctx, queries, runID, input.ContextKey, accepted.InputID, "initial", int64(index)); err != nil {
				return SubmitTrustedTurnResult{}, err
			}
		}
		if err := projectQueuedRun(ctx, queries, input.ContextKey, runID, authority.memberRooms); err != nil {
			return SubmitTrustedTurnResult{}, err
		}
		advanced, err := activateContextForInput(ctx, queries, contextRow, lastSequence)
		if err != nil {
			return SubmitTrustedTurnResult{}, err
		}
		return SubmitTrustedTurnResult{RunID: runID, Created: true, Context: advanced}, nil
	})
	return result, err
}

// activateContextForInput makes the Context active for the inputs this
// command wrote and records the latest of them. Input sequences come from one
// global sequence, so concurrent writers never contend for a Context number.
func activateContextForInput(ctx context.Context, queries *store.Queries, contextRow contextRecord, sequence int64) (*ContextState, error) {
	row, err := queries.ActivateAgentExecutionContextForInput(ctx, store.ActivateAgentExecutionContextForInputParams{
		InputSequence: sequence, ContextKey: contextRow.ContextKey,
	})
	if isNoRows(err) {
		return nil, ErrConflict
	}
	if err != nil {
		return nil, err
	}
	return &ContextState{StateRevision: row.StateRevision, TargetResidency: row.TargetResidency, NextInputSequence: row.NextInputSequence}, nil
}

func requireContextInboxAuthority(ctx context.Context, queries *store.Queries, owner contextRecord, inboxID string) error {
	if strings.HasPrefix(inboxID, "meta:") || strings.HasPrefix(inboxID, "taskmeta:") || strings.HasPrefix(inboxID, "task:") {
		taskID := owner.TaskID.String
		if strings.HasPrefix(inboxID, "taskmeta:") {
			taskID = strings.TrimPrefix(inboxID, "taskmeta:")
		}
		if strings.HasPrefix(inboxID, "task:") {
			taskID = strings.TrimPrefix(inboxID, "task:")
		}
		if _, err := queries.LockDirectInboxTaskAuthority(ctx, store.LockDirectInboxTaskAuthorityParams{TenantID: owner.TenantID, TaskID: taskID}); err != nil {
			return err
		}
	} else {
		roomID := strings.TrimPrefix(strings.TrimPrefix(inboxID, "room:"), "thread:")
		if _, err := queries.LockDirectInboxRoomAuthority(ctx, store.LockDirectInboxRoomAuthorityParams{TenantID: owner.TenantID, RoomID: roomID}); err != nil {
			return err
		}
	}
	return requireContextInboxAccess(ctx, queries, owner, inboxID)
}

// Read paths use their RR snapshot without locking frequently updated Room or
// Task rows. Acceptance rechecks this predicate under its authority locks.
func requireContextInboxAccess(ctx context.Context, queries *store.Queries, owner contextRecord, inboxID string) error {
	authorized, err := queries.IsAgentContextInboxAuthorized(ctx, store.IsAgentContextInboxAuthorizedParams{ContextKey: owner.ContextKey, InboxID: inboxID})
	if err != nil {
		return err
	}
	if !authorized {
		if _, err := inboxContextAgentType(ctx, queries, owner); err != nil {
			return err
		}
		return ErrInboxNotAuthorized
	}
	return nil
}

func requireRuntimeInputsAuthority(
	ctx context.Context,
	db store.DBTX,
	queries *store.Queries,
	contextRow contextRecord,
	inputs []RuntimeInput,
) error {
	if contextRow.ContextKind != "meta" {
		return nil
	}
	for _, input := range inputs {
		var payload struct {
			SourceInboxIDs []string `json:"sourceInboxIds"`
		}
		if err := json.Unmarshal(input.Payload, &payload); err != nil {
			return ErrInvalid
		}
		inboxIDs := append([]string(nil), payload.SourceInboxIDs...)
		if input.SourceInboxID != "" {
			inboxIDs = append(inboxIDs, input.SourceInboxID)
		}
		seen := make(map[string]struct{}, len(inboxIDs))
		for _, inboxID := range inboxIDs {
			if _, duplicate := seen[inboxID]; duplicate {
				continue
			}
			seen[inboxID] = struct{}{}
			if err := requireContextInboxAuthority(ctx, queries, contextRow, inboxID); err != nil {
				return err
			}
		}
		if contextRow.RoomID.Valid {
			if err := validateRoomRuntimeInput(ctx, db, contextRow, input); err != nil {
				return err
			}
		}
	}
	return nil
}

// lockContext locks a Context for a Runtime write and checks the identity it
// still holds.
func lockContext(ctx context.Context, queries *store.Queries, contextKey string) (contextRecord, error) {
	locked, err := queries.LockAgentExecutionContext(ctx, contextKey)
	if isNoRows(err) {
		return contextRecord{}, ErrNotFound
	}
	if err != nil {
		return contextRecord{}, err
	}
	row := contextRecord(locked)
	if err := requireContextAuthority(ctx, queries, row); err != nil {
		return contextRecord{}, err
	}
	return row, nil
}

func validateRuntimeInputs(inputs []RuntimeInput) error {
	if len(inputs) == 0 || len(inputs) > 1024 {
		return ErrInvalid
	}
	seen := make(map[string]struct{}, len(inputs))
	for _, input := range inputs {
		if strings.TrimSpace(input.InputID) == "" || len(input.InputID) > 1000 ||
			!validSourceKind(input.SourceKind) || len(input.SourceMessageID) > 1000 || len(input.SourceInboxID) > 1000 {
			return ErrInvalid
		}
		if _, duplicate := seen[input.InputID]; duplicate {
			return ErrConflict
		}
		seen[input.InputID] = struct{}{}
		var payload map[string]any
		if json.Unmarshal(input.Payload, &payload) != nil || payload == nil || payload["messageId"] != input.InputID {
			return ErrInvalid
		}
		if _, err := hashJSON(input.Payload); err != nil {
			return err
		}
	}
	return nil
}

func validSourceKind(value string) bool {
	switch value {
	case "inbox", "trusted_turn", "internal":
		return true
	default:
		return false
	}
}

func insertRuntimeInput(
	ctx context.Context,
	queries *store.Queries,
	contextKey string,
	input RuntimeInput,
	status string,
	selection []byte,
	steerGroupID, localRunID, steerOutcome string,
) (int64, error) {
	payload, err := canonicalJSON(input.Payload)
	if err != nil {
		return 0, ErrInvalid
	}
	digest := sha256.Sum256(payload)
	return queries.InsertAgentRuntimeInput(ctx, store.InsertAgentRuntimeInputParams{
		ContextKey: contextKey, InputID: input.InputID,
		Payload: payload, PayloadHash: digest[:], SourceKind: input.SourceKind,
		SourceMessageID: optionalText(input.SourceMessageID), SourceInboxID: optionalText(input.SourceInboxID),
		Status: status, SelectionResult: selection, SteerGroupID: optionalText(steerGroupID),
		LocalRunID: optionalText(localRunID), SteerOutcome: optionalText(steerOutcome),
	})
}

func insertRunInput(ctx context.Context, queries *store.Queries, runID, contextKey, inputID, relation string, ordinal int64) error {
	return queries.InsertAgentLocalRunInput(ctx, store.InsertAgentLocalRunInputParams{
		RunID: runID, ContextKey: contextKey, InputID: inputID, Relation: relation, Ordinal: ordinal,
	})
}

func assertSameRuntimeInput(existing store.AgentRuntimeInput, input RuntimeInput) error {
	payload, err := canonicalJSON(input.Payload)
	if err != nil {
		return ErrInvalid
	}
	digest := sha256.Sum256(payload)
	if !bytes.Equal(existing.PayloadHash, digest[:]) || existing.SourceKind != input.SourceKind ||
		existing.SourceMessageID.String != input.SourceMessageID || existing.SourceInboxID.String != input.SourceInboxID {
		return ErrConflict
	}
	return nil
}

func storedInputFromRow(row store.AgentRuntimeInput) (StoredRuntimeInput, error) {
	if !json.Valid(row.Payload) || len(row.SelectionResult) > 0 && !json.Valid(row.SelectionResult) {
		return StoredRuntimeInput{}, errors.New("stored Agent Runtime input JSON is invalid")
	}
	return StoredRuntimeInput{
		RuntimeInput: RuntimeInput{
			InputID: row.InputID, Payload: append(json.RawMessage(nil), row.Payload...), SourceKind: row.SourceKind,
			SourceMessageID: row.SourceMessageID.String, SourceInboxID: row.SourceInboxID.String,
		},
		Sequence: row.InputSequence, Status: row.Status,
		SelectionResult: append(json.RawMessage(nil), row.SelectionResult...),
		SteerGroupID:    row.SteerGroupID.String, LocalRunID: row.LocalRunID.String,
		SteerOutcome: row.SteerOutcome.String, CreatedAt: row.CreatedAt.Time,
	}, nil
}
