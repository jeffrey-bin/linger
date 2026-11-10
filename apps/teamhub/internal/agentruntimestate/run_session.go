package agentruntimestate

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"regexp"
	"strings"
	"time"
	"unicode/utf16"

	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/messagecreation"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

var runtimeCredentialPattern = regexp.MustCompile(`(?:mcp_ctx_|cli_ctx_)[A-Za-z0-9_-]{43}`)

func (s *Service) ClaimLocalRun(ctx context.Context, input ClaimLocalRunInput) (ClaimLocalRunResult, error) {
	if strings.TrimSpace(input.ClaimID) == "" || len(input.ClaimID) > 256 {
		return ClaimLocalRunResult{}, ErrInvalid
	}
	return executeEpochTx(ctx, s, input.Epoch, func(ctx context.Context, tx pgx.Tx, queries *store.Queries) (ClaimLocalRunResult, error) {
		// Serialize the queued -> running transition with configuration reservation.
		// Lock registration before Context, matching the update authority boundary.
		configurationStatus, err := queries.LockAgentLocalRunConfiguration(ctx, input.ContextKey)
		if isNoRows(err) {
			return ClaimLocalRunResult{}, ErrNotFound
		}
		if err != nil {
			return ClaimLocalRunResult{}, err
		}
		if configurationStatus != "active" {
			return ClaimLocalRunResult{}, ErrConflict
		}
		owner, err := lockContext(ctx, queries, input.ContextKey)
		if err != nil {
			return ClaimLocalRunResult{}, err
		}
		running, err := queries.GetRunningAgentLocalRun(ctx, input.ContextKey)
		if err == nil {
			// A repeated claim whose response was lost gets its Run again; any
			// other running Run keeps the Context busy.
			if running.Epoch.String != input.Epoch || running.ClaimID.String != input.ClaimID {
				return ClaimLocalRunResult{}, nil
			}
			result, err := claimedRunResult(ctx, queries, owner, running)
			if err != nil || !running.ClaimProfileRevision.Valid {
				return result, err
			}
			// The lost response carried a profile update; deliver it again
			// unless a newer profile replaced it, which a later claim delivers.
			registration, err := queries.GetMaterializableAgentRuntimeRegistrationByManagementID(ctx, owner.AgentManagementID)
			if err != nil {
				return ClaimLocalRunResult{}, err
			}
			if registration.ConfigurationRevision == running.ClaimProfileRevision.Int64 {
				result.Run.ProfileUpdate = &ProfileUpdate{
					ConfigurationRevision: registration.ConfigurationRevision,
					Name:                  registration.DisplayName, Instructions: registration.Instructions,
				}
			}
			return result, nil
		}
		if !isNoRows(err) {
			return ClaimLocalRunResult{}, err
		}
		live, err := queries.VoiceLiveOwnsContext(ctx, input.ContextKey)
		if err != nil {
			return ClaimLocalRunResult{}, err
		}
		if live {
			return ClaimLocalRunResult{}, nil
		}
		for {
			queued, err := queries.LockNextQueuedAgentLocalRun(ctx, input.ContextKey)
			if isNoRows(err) {
				return ClaimLocalRunResult{}, nil
			}
			if err != nil {
				return ClaimLocalRunResult{}, err
			}
			if owner.ContextKind == "meta" {
				canceled, err := runHasCanceledRoomMessages(ctx, tx, queued.RunID, owner.AgentActorID)
				if err != nil {
					return ClaimLocalRunResult{}, err
				}
				if canceled {
					if err := cancelQueuedRun(ctx, queries, queued.RunID); err != nil {
						return ClaimLocalRunResult{}, err
					}
					continue
				}
			}
			// The registration SHARE lock above spans the claim and its revision.
			registration, err := queries.GetMaterializableAgentRuntimeRegistrationByManagementID(ctx, owner.AgentManagementID)
			if err != nil {
				return ClaimLocalRunResult{}, err
			}
			if _, nativeProvider := runtimeSessionProviderIdentity(registration); nativeProvider == "" {
				return ClaimLocalRunResult{}, ErrConflict
			}
			claimed, err := queries.ClaimAgentLocalRun(ctx, store.ClaimAgentLocalRunParams{
				Epoch: input.Epoch, ClaimID: input.ClaimID,
				ClaimConfigurationRevision: registration.ConfigurationRevision,
				RunID:                      queued.RunID, ContextKey: input.ContextKey,
			})
			if err != nil {
				return ClaimLocalRunResult{}, err
			}
			if err := queries.RecordAgentExecutionContextClaimedRun(ctx, store.RecordAgentExecutionContextClaimedRunParams{
				ContextKey: input.ContextKey, RunID: claimed.RunID,
			}); err != nil {
				return ClaimLocalRunResult{}, err
			}
			result, err := claimedRunResult(ctx, queries, owner, claimed)
			if err != nil {
				return ClaimLocalRunResult{}, err
			}
			// A queued input may predate Live. Enrich it only when Meta actually
			// resumes, under the same Context lock and transaction as the claim.
			result.Run.Inputs[0].RuntimeInput, err = attachLiveHandover(ctx, queries, owner, result.Run.Inputs[0].RuntimeInput)
			if err != nil {
				return ClaimLocalRunResult{}, err
			}
			profileUpdate, err := claimProfileUpdate(ctx, queries, input.ContextKey, registration)
			if err != nil {
				return ClaimLocalRunResult{}, err
			}
			if profileUpdate != nil {
				if err := queries.RecordAgentLocalRunClaimProfileRevision(ctx, store.RecordAgentLocalRunClaimProfileRevisionParams{
					ProfileRevision: profileUpdate.ConfigurationRevision, RunID: claimed.RunID,
				}); err != nil {
					return ClaimLocalRunResult{}, err
				}
			}
			result.Run.ProfileUpdate = profileUpdate
			return result, nil
		}
	})
}

// claimedRunResult reads what a claim hands out: the Run's initial inputs and
// whether the Context had input before them.
func claimedRunResult(ctx context.Context, queries *store.Queries, owner contextRecord, run store.AgentLocalRun) (ClaimLocalRunResult, error) {
	rows, err := queries.ListAgentLocalRunInputs(ctx, run.RunID)
	if err != nil {
		return ClaimLocalRunResult{}, err
	}
	initial := make([]StoredRuntimeInput, 0, len(rows))
	for _, row := range rows {
		if row.RunRelation != "initial" {
			continue
		}
		converted, err := storedInputFromRunRow(row)
		if err != nil {
			return ClaimLocalRunResult{}, err
		}
		initial = append(initial, converted)
	}
	if len(initial) == 0 {
		return ClaimLocalRunResult{}, ErrConflict
	}
	continues, err := continuesContext(ctx, queries, owner.ContextKey, initial)
	if err != nil {
		return ClaimLocalRunResult{}, err
	}
	return ClaimLocalRunResult{Run: &ClaimedLocalRun{
		RunID: run.RunID, AttemptCount: int(run.AttemptCount), Inputs: initial,
		CancellationRequested: run.CancellationRequested, ContinuesContext: continues,
	}}, nil
}

// continuesContext reports whether the Context received input before this
// Run's first input, so a fresh Runtime Session is told it continues earlier
// work.
func continuesContext(ctx context.Context, queries *store.Queries, contextKey string, inputs []StoredRuntimeInput) (bool, error) {
	if len(inputs) == 0 {
		return false, nil
	}
	first := inputs[0].Sequence
	for _, input := range inputs[1:] {
		first = min(first, input.Sequence)
	}
	return queries.AgentContextHasInputBefore(ctx, store.AgentContextHasInputBeforeParams{
		ContextKey: contextKey, InputSequence: first,
	})
}

// RequeueLocalRun returns a running Run to the queue for its next claim. Its
// pending native questions expire with it: the native turn that asked them is
// gone, and the resumed turn asks again if it still needs to.
func (s *Service) RequeueLocalRun(ctx context.Context, input RequeueLocalRunInput) error {
	_, err := executeEpochTx(ctx, s, input.Epoch, func(ctx context.Context, _ pgx.Tx, queries *store.Queries) (struct{}, error) {
		contextRow, err := lockContext(ctx, queries, input.ContextKey)
		if err != nil {
			return struct{}{}, err
		}
		changed, err := queries.RequeueAgentLocalRun(ctx, store.RequeueAgentLocalRunParams{
			RunID: input.RunID, ContextKey: input.ContextKey, Epoch: input.Epoch,
		})
		if err != nil {
			return struct{}{}, err
		}
		if changed != 1 {
			// A repeated requeue finds its Run queued already.
			run, err := queries.GetAgentLocalRun(ctx, store.GetAgentLocalRunParams{ContextKey: input.ContextKey, RunID: input.RunID})
			if err == nil && run.Status == "queued" {
				return struct{}{}, nil
			}
			return struct{}{}, ErrConflict
		}
		if err := expireRuntimeHumanInteractions(ctx, queries, input.RunID, contextRow.TenantID, contextRow.AgentActorID); err != nil {
			return struct{}{}, err
		}
		if _, err := queries.BumpAgentExecutionContextStateRevision(ctx, input.ContextKey); err != nil {
			return struct{}{}, err
		}
		return struct{}{}, nil
	})
	return err
}

func (s *Service) FinishLocalRun(ctx context.Context, input FinishLocalRunInput) (FinishLocalRunResult, error) {
	stop, err := runStopFromTerminal(input.Terminal)
	if err != nil {
		return FinishLocalRunResult{}, err
	}
	var commitResult string
	var finishedAt time.Time
	result, err := executeEpochTx(ctx, s, input.Epoch, func(ctx context.Context, tx pgx.Tx, queries *store.Queries) (FinishLocalRunResult, error) {
		contextRow, err := lockContext(ctx, queries, input.ContextKey)
		if err != nil {
			return FinishLocalRunResult{}, err
		}
		run, err := queries.GetAgentLocalRun(ctx, store.GetAgentLocalRunParams{ContextKey: input.ContextKey, RunID: input.RunID})
		if isNoRows(err) {
			return FinishLocalRunResult{}, ErrNotFound
		}
		if err != nil {
			return FinishLocalRunResult{}, err
		}
		terminalJSON, _ := canonicalJSON(input.Terminal)
		if run.Status != "running" {
			// A Run TeamHub canceled for a reason answers its holder's finish with
			// that terminal, which the Agent Service settles as upstream canceled.
			stored, err := runStopFromTerminal(run.Terminal)
			if err != nil {
				return FinishLocalRunResult{}, err
			}
			if run.Status == stop.status && sameJSON(run.Terminal, terminalJSON) {
				commitResult = "already_terminal"
			} else if stored.status == "canceled" && stored.reason != "" {
				commitResult = "upstream_canceled"
			} else {
				return FinishLocalRunResult{}, ErrConflict
			}
			finishedAt = run.FinishedAt.Time
			converted, err := localRunFromRow(ctx, queries, run)
			if err != nil {
				return FinishLocalRunResult{}, err
			}
			result := FinishLocalRunResult{Run: converted}
			if input.Session != nil {
				// A repeated finish returns the Session its first attempt stored.
				session, err := currentRuntimeSession(ctx, queries, input.ContextKey)
				if err != nil {
					return FinishLocalRunResult{}, err
				}
				result.Session = session
			}
			return result, nil
		}
		if run.Epoch.String != input.Epoch {
			return FinishLocalRunResult{}, ErrFenced
		}
		terminated, err := TerminateLocalRuns(ctx, queries, []string{input.RunID}, input.Terminal)
		if err != nil {
			return FinishLocalRunResult{}, err
		}
		if len(terminated) != 1 {
			return FinishLocalRunResult{}, ErrConflict
		}
		if err := expireRuntimeHumanInteractions(ctx, queries, input.RunID, contextRow.TenantID, contextRow.AgentActorID); err != nil {
			return FinishLocalRunResult{}, err
		}
		var session *RuntimeSession
		if input.Session != nil {
			checkpointed, err := checkpointSessionInTx(ctx, queries, contextRow, input.Epoch, *input.Session, &run)
			if err != nil {
				return FinishLocalRunResult{}, err
			}
			session = &checkpointed
		}
		finished, err := queries.GetAgentLocalRun(ctx, store.GetAgentLocalRunParams{ContextKey: input.ContextKey, RunID: input.RunID})
		if err != nil {
			return FinishLocalRunResult{}, err
		}
		commitResult, finishedAt = "committed", finished.FinishedAt.Time
		converted, err := localRunFromRow(ctx, queries, finished)
		return FinishLocalRunResult{Run: converted, Session: session}, err
	})
	if err == nil {
		observeRunTerminalCommit(ctx, input.RunID, stop.status, commitResult, finishedAt)
	}
	return result, err
}

// observeRunTerminalCommit runs only after the terminal committed.
func observeRunTerminalCommit(ctx context.Context, runID, status, result string, finishedAt time.Time) {
	fields := []any{"run_id", runID, "status", status,
		"result", result, "observed_at_unix_ms", time.Now().UnixMilli()}
	if !finishedAt.IsZero() {
		fields = append(fields, "finished_at_unix_ms", finishedAt.UnixMilli())
	}
	slog.InfoContext(ctx, "local_run.terminal_committed", fields...)
}

func (s *Service) CancelLocalRun(ctx context.Context, input CancelLocalRunInput) (CancelLocalRunResult, error) {
	result, err := executeEpochTx(ctx, s, input.Epoch, func(ctx context.Context, _ pgx.Tx, queries *store.Queries) (CancelLocalRunResult, error) {
		if _, err := lockContext(ctx, queries, input.ContextKey); err != nil {
			return CancelLocalRunResult{}, err
		}
		run, err := queries.GetAgentLocalRun(ctx, store.GetAgentLocalRunParams{ContextKey: input.ContextKey, RunID: input.RunID})
		if isNoRows(err) {
			return CancelLocalRunResult{Status: "not_found"}, nil
		}
		if err != nil {
			return CancelLocalRunResult{}, err
		}
		if run.Status == "running" {
			if err := queries.RequestAgentLocalRunCancellation(ctx, store.RequestAgentLocalRunCancellationParams{ContextKey: input.ContextKey, RunID: input.RunID}); err != nil {
				return CancelLocalRunResult{}, err
			}
			return CancelLocalRunResult{Status: "cancel_requested"}, nil
		}
		if run.Status != "queued" {
			return CancelLocalRunResult{Status: "already_terminal"}, nil
		}
		if err := cancelQueuedRun(ctx, queries, input.RunID); err != nil {
			return CancelLocalRunResult{}, err
		}
		return CancelLocalRunResult{Status: "canceled"}, nil
	})
	return result, err
}

func (s *Service) GetLocalRun(ctx context.Context, contextKey, runID string) (LocalRun, error) {
	if s == nil || s.pool == nil || contextKey == "" || runID == "" {
		return LocalRun{}, ErrInvalid
	}
	queries := store.New(s.pool)
	row, err := queries.GetAgentLocalRun(ctx, store.GetAgentLocalRunParams{ContextKey: contextKey, RunID: runID})
	if isNoRows(err) {
		return LocalRun{}, ErrNotFound
	}
	if err != nil {
		return LocalRun{}, err
	}
	return localRunFromRow(ctx, queries, row)
}

func (s *Service) ContextHasPendingWork(ctx context.Context, contextKey string) (bool, error) {
	if s == nil || s.pool == nil || contextKey == "" {
		return false, ErrInvalid
	}
	return store.New(s.pool).AgentRuntimeContextHasPendingWork(ctx, contextKey)
}

func (s *Service) GetRuntimeSession(ctx context.Context, contextKey string) (*RuntimeSession, error) {
	if s == nil || s.pool == nil || contextKey == "" {
		return nil, ErrInvalid
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	queries := store.New(tx)
	row, err := queries.GetAgentRuntimeSession(ctx, contextKey)
	if isNoRows(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	converted, err := sessionFromRow(row)
	if err != nil {
		return nil, err
	}
	owner, err := queries.GetAgentExecutionContext(ctx, contextKey)
	if err != nil {
		return nil, err
	}
	registration, err := queries.GetMaterializableAgentRuntimeRegistrationByManagementID(ctx, owner.AgentManagementID)
	if err != nil && !isNoRows(err) {
		return nil, err
	}
	if err == nil && profileOnlySince(owner, registration, converted.ProviderKind, converted.ConfigurationRevision) {
		converted.CompatibleConfigurationRevision = registration.ConfigurationRevision
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &converted, nil
}

// currentRuntimeSession is the Session a Context holds now, if any.
func currentRuntimeSession(ctx context.Context, queries *store.Queries, contextKey string) (*RuntimeSession, error) {
	row, err := queries.GetAgentRuntimeSession(ctx, contextKey)
	if isNoRows(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	session, err := sessionFromRow(row)
	if err != nil {
		return nil, err
	}
	return &session, nil
}

// ClearRuntimeSession reports Cleared when no Session of the named
// configuration revision remains, so a repeated clear succeeds too.
func (s *Service) ClearRuntimeSession(ctx context.Context, input ClearRuntimeSessionInput) (ClearRuntimeSessionResult, error) {
	if input.ConfigurationRevision < 1 ||
		(input.ExpectedCurrentConfigurationRevision != nil && *input.ExpectedCurrentConfigurationRevision < 1) {
		return ClearRuntimeSessionResult{}, ErrInvalid
	}
	return executeEpochTx(ctx, s, input.Epoch, func(ctx context.Context, _ pgx.Tx, queries *store.Queries) (ClearRuntimeSessionResult, error) {
		if input.ExpectedCurrentConfigurationRevision != nil {
			// Match configuration changes and deletion: registration before Context.
			status, err := queries.LockAgentLocalRunConfiguration(ctx, input.ContextKey)
			if isNoRows(err) {
				return ClearRuntimeSessionResult{}, ErrNotFound
			}
			if err != nil {
				return ClearRuntimeSessionResult{}, err
			}
			if status != "active" {
				return ClearRuntimeSessionResult{}, ErrConflict
			}
		}
		contextRow, err := lockContext(ctx, queries, input.ContextKey)
		if err != nil {
			return ClearRuntimeSessionResult{}, err
		}
		stored, err := queries.GetAgentRuntimeSession(ctx, input.ContextKey)
		if isNoRows(err) {
			return ClearRuntimeSessionResult{Cleared: true}, nil
		}
		if err != nil {
			return ClearRuntimeSessionResult{}, err
		}
		session, err := sessionFromRow(stored)
		if err != nil {
			return ClearRuntimeSessionResult{}, err
		}
		if session.ConfigurationRevision != input.ConfigurationRevision {
			return ClearRuntimeSessionResult{}, ErrConflict
		}
		if input.ExpectedCurrentConfigurationRevision != nil {
			// The registration lock stays held until this automatic clear commits.
			registration, err := queries.GetMaterializableAgentRuntimeRegistrationByManagementID(ctx, contextRow.AgentManagementID)
			if isNoRows(err) {
				return ClearRuntimeSessionResult{}, ErrConflict
			}
			if err != nil {
				return ClearRuntimeSessionResult{}, err
			}
			if registration.Status != "active" || registration.ConfigurationRevision != *input.ExpectedCurrentConfigurationRevision ||
				registration.ConfigurationRevision <= session.ConfigurationRevision {
				return ClearRuntimeSessionResult{}, ErrConflict
			}
			if profileOnlySince(contextRow, registration, session.ProviderKind, session.ConfigurationRevision) {
				return ClearRuntimeSessionResult{}, ErrConflict
			}
		}
		if contextRow.TargetResidency != "suspended" {
			// A restarted process may clear an idle active Context's stale
			// Session, but never the Session of a running loaded revision.
			if contextRow.TargetResidency != "active" {
				return ClearRuntimeSessionResult{}, ErrConflict
			}
			if _, err := queries.GetRunningAgentLocalRun(ctx, input.ContextKey); err == nil {
				return ClearRuntimeSessionResult{}, ErrConflict
			} else if !isNoRows(err) {
				return ClearRuntimeSessionResult{}, err
			}
			registration, err := queries.GetMaterializableAgentRuntimeRegistrationByManagementID(ctx, contextRow.AgentManagementID)
			if err != nil {
				if isNoRows(err) {
					return ClearRuntimeSessionResult{}, ErrNotFound
				}
				return ClearRuntimeSessionResult{}, err
			}
			if registration.Status != "active" ||
				registration.ConfigurationRevision <= session.ConfigurationRevision {
				return ClearRuntimeSessionResult{}, ErrConflict
			}
		}
		changed, err := queries.DeleteAgentRuntimeSessionAtConfigurationRevision(ctx, store.DeleteAgentRuntimeSessionAtConfigurationRevisionParams{
			ContextKey: input.ContextKey, ConfigurationRevision: input.ConfigurationRevision,
		})
		if err != nil {
			return ClearRuntimeSessionResult{}, err
		}
		if changed != 1 {
			return ClearRuntimeSessionResult{}, ErrConflict
		}
		if _, err := queries.BumpAgentExecutionContextStateRevision(ctx, input.ContextKey); err != nil {
			return ClearRuntimeSessionResult{}, err
		}
		return ClearRuntimeSessionResult{Cleared: true}, nil
	})
}

func (s *Service) CheckpointRuntimeSession(ctx context.Context, input CheckpointSessionInput) (RuntimeSession, error) {
	return executeEpochTx(ctx, s, input.Epoch, func(ctx context.Context, _ pgx.Tx, queries *store.Queries) (RuntimeSession, error) {
		contextRow, err := lockContext(ctx, queries, input.ContextKey)
		if err != nil {
			return RuntimeSession{}, err
		}
		checkpointed, err := checkpointSessionInTx(ctx, queries, contextRow, input.Epoch, input.Checkpoint, nil)
		if err != nil {
			return RuntimeSession{}, err
		}
		if _, err := queries.BumpAgentExecutionContextStateRevision(ctx, input.ContextKey); err != nil {
			return RuntimeSession{}, err
		}
		return checkpointed, nil
	})
}

func localRunFromRow(ctx context.Context, queries *store.Queries, row store.AgentLocalRun) (LocalRun, error) {
	relations, err := queries.ListAgentLocalRunInputs(ctx, row.RunID)
	if err != nil {
		return LocalRun{}, err
	}
	result := LocalRun{
		CancellationRequested: row.CancellationRequested,
		RunID:                 row.RunID, ContextKey: row.ContextKey, Status: row.Status, AttemptCount: int(row.AttemptCount),
	}
	for _, relation := range relations {
		if relation.RunRelation == "initial" {
			result.InitialInputIDs = append(result.InitialInputIDs, relation.InputID)
		} else if relation.RunRelation == "steer" {
			result.SteerInputIDs = append(result.SteerInputIDs, relation.InputID)
		}
	}
	if len(row.Terminal) > 0 {
		result.Terminal = append(json.RawMessage(nil), row.Terminal...)
	}
	return result, nil
}

func storedInputFromRunRow(row store.ListAgentLocalRunInputsRow) (StoredRuntimeInput, error) {
	return storedInputFromRow(store.AgentRuntimeInput{
		ContextKey: row.ContextKey, InputID: row.InputID, InputSequence: row.InputSequence,
		Payload: row.Payload, PayloadHash: row.PayloadHash, SourceKind: row.SourceKind,
		SourceMessageID: row.SourceMessageID, SourceInboxID: row.SourceInboxID,
		Status: row.Status, SelectionResult: row.SelectionResult, SteerGroupID: row.SteerGroupID,
		LocalRunID: row.LocalRunID, SteerOutcome: row.SteerOutcome,
		CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt,
	})
}

func checkpointSessionInTx(ctx context.Context, queries *store.Queries, contextRow contextRecord, epoch string, checkpoint RuntimeSessionCheckpoint, finishingRun *store.AgentLocalRun) (RuntimeSession, error) {
	if checkpoint.ExpectedRevision < 0 || checkpoint.SchemaVersion < 1 || checkpoint.ConfigurationRevision < 1 ||
		strings.TrimSpace(checkpoint.ProviderKind) == "" || len(checkpoint.ProviderKind) > 64 {
		return RuntimeSession{}, ErrInvalid
	}
	sessionJSON, err := validateRuntimeSession(checkpoint)
	if err != nil {
		return RuntimeSession{}, err
	}
	registration, err := queries.GetMaterializableAgentRuntimeRegistrationByManagementID(ctx, contextRow.AgentManagementID)
	if err != nil {
		if isNoRows(err) {
			return RuntimeSession{}, ErrNotFound
		}
		return RuntimeSession{}, err
	}
	existing, err := currentRuntimeSession(ctx, queries, contextRow.ContextKey)
	if err != nil {
		return RuntimeSession{}, err
	}
	if existing != nil && existing.Revision == checkpoint.ExpectedRevision+1 && sameCheckpoint(existing.RuntimeSessionCheckpoint, checkpoint, sessionJSON) {
		// A repeated checkpoint finds its own write.
		return *existing, nil
	}
	if registration.ConfigurationRevision != checkpoint.ConfigurationRevision {
		// A profile-only change preserves the running Context's loaded
		// revision. Its first Session additionally needs the Run this epoch
		// claimed under that revision; ordinary checkpoints cannot create a
		// stale Session.
		if existing == nil {
			if checkpoint.ExpectedRevision != 0 {
				return RuntimeSession{}, ErrConflict
			}
			if err := validateFirstSessionAfterProfileChange(contextRow, registration, epoch, checkpoint, finishingRun); err != nil {
				return RuntimeSession{}, err
			}
		} else if contextRow.TargetResidency != "active" || registration.Status != "active" ||
			registration.ConfigurationRevision <= checkpoint.ConfigurationRevision ||
			existing.ConfigurationRevision != checkpoint.ConfigurationRevision ||
			existing.ProviderKind != checkpoint.ProviderKind || existing.SchemaVersion != checkpoint.SchemaVersion ||
			existing.ThreadID != checkpoint.ThreadID {
			return RuntimeSession{}, ErrConflict
		}
	}
	row, err := queries.CheckpointAgentRuntimeSession(ctx, store.CheckpointAgentRuntimeSessionParams{
		ContextKey: contextRow.ContextKey, ProviderKind: checkpoint.ProviderKind,
		SessionSchemaVersion: checkpoint.SchemaVersion, Session: sessionJSON,
		ThreadID: optionalText(checkpoint.ThreadID), ConfigurationRevision: checkpoint.ConfigurationRevision,
		ExpectedSessionRevision: checkpoint.ExpectedRevision,
	})
	if isNoRows(err) {
		return RuntimeSession{}, ErrConflict
	}
	if err != nil {
		return RuntimeSession{}, err
	}
	return sessionFromRow(store.GetAgentRuntimeSessionRow(row))
}

func sameCheckpoint(stored, checkpoint RuntimeSessionCheckpoint, sessionJSON []byte) bool {
	return stored.ProviderKind == checkpoint.ProviderKind && stored.SchemaVersion == checkpoint.SchemaVersion &&
		stored.ThreadID == checkpoint.ThreadID && stored.ConfigurationRevision == checkpoint.ConfigurationRevision &&
		sameJSON(stored.Session, sessionJSON)
}

func validateRuntimeSession(checkpoint RuntimeSessionCheckpoint) ([]byte, error) {
	canonical, err := canonicalJSON(checkpoint.Session)
	if err != nil {
		return nil, ErrInvalid
	}
	var session map[string]any
	if json.Unmarshal(canonical, &session) != nil || session == nil {
		return nil, ErrInvalid
	}
	if checkpoint.SchemaVersion == 2 {
		if err := validateExecutionResourcesSession(canonical, checkpoint); err != nil {
			return nil, err
		}
		if containsRuntimeCredential(session) {
			return nil, ErrInvalid
		}
		return canonical, nil
	}
	if checkpoint.ProviderKind == "codex" && checkpoint.ThreadID == "" {
		return nil, ErrInvalid
	}
	if indexed, ok := session["threadId"].(string); ok && indexed != checkpoint.ThreadID {
		return nil, ErrConflict
	}
	if containsRuntimeCredential(session) {
		return nil, ErrInvalid
	}
	return canonical, nil
}

func validateExecutionResourcesSession(canonical []byte, checkpoint RuntimeSessionCheckpoint) error {
	var envelope struct {
		NativeSession json.RawMessage `json:"nativeSession"`
		Resources     *struct {
			Version         int    `json:"version"`
			EffectiveSHA256 string `json:"effectiveSha256"`
			Skills          []struct {
				SkillID         string         `json:"skillId"`
				ManifestID      string         `json:"manifestId"`
				ManifestVersion string         `json:"manifestVersion"`
				Name            string         `json:"name"`
				PackageName     string         `json:"packageName"`
				PackageSHA256   string         `json:"packageSha256"`
				Config          map[string]any `json:"config"`
				Source          string         `json:"source"`
			} `json:"skills"`
		} `json:"executionResources"`
	}
	decoder := json.NewDecoder(bytes.NewReader(canonical))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&envelope) != nil || len(envelope.NativeSession) == 0 || envelope.Resources == nil {
		return ErrInvalid
	}
	r := envelope.Resources
	if r.Version != 1 || !runtimeResourceSHA256.MatchString(r.EffectiveSHA256) || r.Skills == nil || len(r.Skills) > 100 {
		return ErrInvalid
	}
	skillIDs, manifests, names := map[string]bool{}, map[string]bool{}, map[string]bool{}
	for _, item := range r.Skills {
		if !runtimeResourceID.MatchString(item.SkillID) || !runtimeResourceID.MatchString(item.ManifestID) ||
			!runtimeResourceVersion.MatchString(item.ManifestVersion) ||
			len(item.Name) < 1 || len(utf16.Encode([]rune(item.Name))) > 120 || !runtimeResourcePackage.MatchString(item.PackageName) || len(item.PackageName) > 64 ||
			!runtimeResourceSHA256.MatchString(item.PackageSHA256) || item.Config == nil ||
			(item.Source != "default" && item.Source != "explicit") || skillIDs[item.SkillID] || manifests[item.ManifestID] || names[item.PackageName] {
			return ErrInvalid
		}
		skillIDs[item.SkillID], manifests[item.ManifestID], names[item.PackageName] = true, true, true
	}
	if string(envelope.NativeSession) == "null" {
		if checkpoint.ThreadID != "" {
			return ErrInvalid
		}
		return nil
	}
	var native map[string]any
	if json.Unmarshal(envelope.NativeSession, &native) != nil || native == nil || (checkpoint.ProviderKind == "codex" && checkpoint.ThreadID == "") {
		return ErrInvalid
	}
	indexed, present := native["threadId"]
	if (present && indexed != checkpoint.ThreadID) || (!present && checkpoint.ThreadID != "") {
		return ErrConflict
	}
	return nil
}

var (
	runtimeResourceID      = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,511}$`)
	runtimeResourceSHA256  = regexp.MustCompile(`^[a-f0-9]{64}$`)
	runtimeResourcePackage = regexp.MustCompile(`^[a-z0-9]+(?:-[a-z0-9]+)*$`)
	runtimeResourceVersion = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$`)
)

func containsRuntimeCredential(value any) bool {
	switch current := value.(type) {
	case string:
		return runtimeCredentialPattern.MatchString(current)
	case []any:
		for _, item := range current {
			if containsRuntimeCredential(item) {
				return true
			}
		}
	case map[string]any:
		for key, item := range current {
			normalized := strings.ReplaceAll(strings.ToLower(key), "_", "")
			if normalized == "authorization" || normalized == "httpheaders" || containsRuntimeCredential(item) {
				return true
			}
		}
	}
	return false
}

func sessionFromRow(row store.GetAgentRuntimeSessionRow) (RuntimeSession, error) {
	if !json.Valid(row.Session) || !row.SessionUpdatedAt.Valid || !row.SessionProviderKind.Valid ||
		!row.SessionSchemaVersion.Valid || !row.SessionConfigurationRevision.Valid || row.SessionRevision < 1 {
		return RuntimeSession{}, errors.New("stored Agent RuntimeSession is invalid")
	}
	return RuntimeSession{
		RuntimeSessionCheckpoint: RuntimeSessionCheckpoint{
			ExpectedRevision: row.SessionRevision, ProviderKind: row.SessionProviderKind.String,
			SchemaVersion: row.SessionSchemaVersion.Int64, Session: append(json.RawMessage(nil), row.Session...),
			ThreadID: row.SessionThreadID.String, ConfigurationRevision: row.SessionConfigurationRevision.Int64,
		},
		Revision: row.SessionRevision, UpdatedAt: row.SessionUpdatedAt.Time,
	}, nil
}

func sameJSON(left, right []byte) bool {
	leftCanonical, leftErr := canonicalJSON(json.RawMessage(left))
	rightCanonical, rightErr := canonicalJSON(json.RawMessage(right))
	return leftErr == nil && rightErr == nil && bytes.Equal(leftCanonical, rightCanonical)
}

func boundedRuntimeStatusReason(reason string) string {
	characters := []rune(reason)
	if len(characters) > 1000 {
		return string(characters[:1000])
	}
	return reason
}

// cancelQueuedRun cancels a Run the caller found queued under its Context lock.
func cancelQueuedRun(ctx context.Context, queries *store.Queries, runID string) error {
	terminated, err := TerminateLocalRuns(ctx, queries, []string{runID}, json.RawMessage(`{"type":"canceled"}`))
	if err != nil {
		return err
	}
	if len(terminated) != 1 {
		return ErrConflict
	}
	return nil
}

// A native question cannot outlive its execution. Permission cards can: their
// decision reaches the Agent as a new Inbox input.
func expireRuntimeHumanInteractions(ctx context.Context, queries *store.Queries, runID, tenantID, actorID string) error {
	ids, err := queries.ExpireRunNativeQuestions(ctx, runID)
	if err != nil {
		return err
	}
	return messagecreation.AdvanceCards(ctx, queries, tenantID, actorID, ids)
}
