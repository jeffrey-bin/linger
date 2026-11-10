package taskexecution

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"reflect"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

const maxWorkerPayloadBytes = 1 << 20

type effectIDPayload struct {
	EffectID string `json:"effect_id"`
}

type participantRun struct {
	ActorID           string `json:"actor_id"`
	AgentManagementID string `json:"agent_management_id"`
	AgentRunRef       string `json:"agent_run_ref"`
}

type recordAgentTurnPayload struct {
	EffectID        string           `json:"effect_id"`
	ParticipantRuns []participantRun `json:"participant_runs"`
}

type recordAgentTurnFailurePayload struct {
	EffectID    string `json:"effect_id"`
	FailureCode string `json:"failure_code"`
	Retryable   bool   `json:"retryable"`
}

type participantTerminal struct {
	AgentRunRef     string `json:"agent_run_ref"`
	Status          string `json:"status"`
	TerminalCode    string `json:"terminal_code,omitempty"`
	TerminalMessage string `json:"terminal_message,omitempty"`
}

type recordAgentTerminalPayload struct {
	EffectID             string                `json:"effect_id"`
	ParticipantTerminals []participantTerminal `json:"participant_terminals"`
}

type completeRuntimeCleanupPayload struct {
	EffectID     string `json:"effect_id"`
	AgentRunRef  string `json:"agent_run_ref"`
	CancelStatus string `json:"cancel_status"`
	RunStatus    string `json:"run_status,omitempty"`
}

type scheduleReconcilePayload struct {
	ReconcileAfterSeconds int `json:"reconcile_after_seconds"`
}

// ClaimExecution claims the next claimable Task. When none is claimable it
// returns how long until one becomes claimable without another commit, or nil
// when no Task is pending.
func (s *Service) ClaimExecution(ctx context.Context, input WorkerClaimInput) (WorkerExecution, bool, *time.Duration, error) {
	input.WorkerID = strings.TrimSpace(input.WorkerID)
	if input.WorkerID == "" || len(input.WorkerID) > 255 || input.LeaseSeconds < 5 || input.LeaseSeconds > 300 {
		return WorkerExecution{}, false, nil, ErrInvalid
	}
	token, err := randomToken(32)
	if err != nil {
		return WorkerExecution{}, false, nil, err
	}
	queries := store.New(s.pool)
	row, err := queries.ClaimTaskExecutionForWorker(ctx, store.ClaimTaskExecutionForWorkerParams{
		WorkerID: input.WorkerID, LeaseTokenHash: tokenHash(token), LeaseSeconds: int32(input.LeaseSeconds),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		delay, err := queries.NextTaskExecutionClaimDelay(ctx)
		if errors.Is(err, pgx.ErrNoRows) {
			return WorkerExecution{}, false, nil, nil
		}
		if err != nil {
			return WorkerExecution{}, false, nil, err
		}
		next := time.Duration(delay) * time.Millisecond
		return WorkerExecution{}, false, &next, nil
	}
	if err != nil {
		return WorkerExecution{}, false, nil, err
	}
	lease, err := claimedWorkerLease(row.TaskID, row.TaskWorkerID, row.TaskLeaseGeneration, row.TaskLeaseExpiresAt, token)
	if err != nil {
		return WorkerExecution{}, false, nil, err
	}
	execution, err := s.GetExecution(ctx, row.TaskID)
	if err != nil {
		return WorkerExecution{}, false, nil, err
	}
	return WorkerExecution{Lease: &lease, Execution: execution}, true, nil, nil
}

func (s *Service) GetExecutionForWorker(ctx context.Context, input WorkerLeaseInput) (WorkerExecution, error) {
	if err := validateWorkerLeaseInput(input); err != nil {
		return WorkerExecution{}, err
	}
	row, err := store.New(s.pool).GetTaskExecutionWorkerLease(ctx, store.GetTaskExecutionWorkerLeaseParams{
		TaskID: input.TaskID, WorkerID: input.WorkerID, LeaseGeneration: input.LeaseGeneration,
		LeaseTokenHash: tokenHash(input.LeaseToken),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return WorkerExecution{}, ErrConflict
	}
	if err != nil {
		return WorkerExecution{}, err
	}
	lease, err := claimedWorkerLease(row.TaskID, row.TaskWorkerID, row.TaskLeaseGeneration, row.TaskLeaseExpiresAt, input.LeaseToken)
	if err != nil {
		return WorkerExecution{}, err
	}
	execution, err := s.GetExecution(ctx, input.TaskID)
	if err != nil {
		return WorkerExecution{}, err
	}
	return WorkerExecution{Lease: &lease, Execution: execution}, nil
}

func (s *Service) HeartbeatExecution(ctx context.Context, input WorkerHeartbeatInput) (WorkerLease, error) {
	if err := validateWorkerLeaseInput(input.WorkerLeaseInput); err != nil || input.LeaseSeconds < 5 || input.LeaseSeconds > 300 {
		return WorkerLease{}, ErrInvalid
	}
	row, err := store.New(s.pool).ExtendTaskExecutionWorkerLease(ctx, store.ExtendTaskExecutionWorkerLeaseParams{
		LeaseSeconds: int32(input.LeaseSeconds), TaskID: input.TaskID, WorkerID: input.WorkerID,
		LeaseGeneration: input.LeaseGeneration, LeaseTokenHash: tokenHash(input.LeaseToken),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return WorkerLease{}, ErrConflict
	}
	if err != nil {
		return WorkerLease{}, err
	}
	return claimedWorkerLease(row.TaskID, row.TaskWorkerID, row.TaskLeaseGeneration, row.TaskLeaseExpiresAt, input.LeaseToken)
}

func (s *Service) TransitionExecution(ctx context.Context, input WorkerTransitionInput) (WorkerExecution, error) {
	if err := validateWorkerTransition(input); err != nil {
		return WorkerExecution{}, err
	}
	switch input.Transition {
	case "advance":
		return s.advanceExecution(ctx, input)
	case "begin_effect_dispatch", "record_agent_turn", "record_agent_turn_failure", "record_agent_terminal", "complete_runtime_cleanup", "schedule_reconcile":
		return s.applyExecutionTransition(ctx, input)
	default:
		return WorkerExecution{}, ErrInvalid
	}
}

func (s *Service) applyExecutionTransition(ctx context.Context, input WorkerTransitionInput) (WorkerExecution, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return WorkerExecution{}, err
	}
	defer tx.Rollback(ctx)
	queries := store.New(tx)
	leaseRow, err := queries.LockTaskExecutionWorkerLease(ctx, store.LockTaskExecutionWorkerLeaseParams{
		TaskID: input.TaskID, WorkerID: input.WorkerID, LeaseGeneration: input.LeaseGeneration,
		LeaseTokenHash: tokenHash(input.LeaseToken),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return WorkerExecution{}, ErrConflict
	}
	if err != nil {
		return WorkerExecution{}, err
	}
	if !leaseRow.TaskExecutionGeneration.Valid || leaseRow.TaskExecutionGeneration.Int64 != input.ExecutionGeneration ||
		!leaseRow.TaskExecutionRevision.Valid || leaseRow.TaskExecutionRevision.Int64 != input.ExpectedExecutionRevision ||
		input.ExpectedControlRevision != nil && (!leaseRow.TaskControlRevision.Valid || leaseRow.TaskControlRevision.Int64 != *input.ExpectedControlRevision) {
		return WorkerExecution{}, ErrConflict
	}
	releaseLease := false
	switch input.Transition {
	case "begin_effect_dispatch":
		err = beginEffectDispatch(ctx, queries, leaseRow, input)
	case "record_agent_turn":
		err = recordAgentTurn(ctx, queries, leaseRow, input)
	case "record_agent_turn_failure":
		err = recordAgentTurnFailure(ctx, queries, input)
	case "record_agent_terminal":
		err = recordAgentTerminal(ctx, queries, input)
	case "complete_runtime_cleanup":
		releaseLease, err = completeRuntimeCleanup(ctx, queries, leaseRow, input)
	case "reconcile_attempt":
		releaseLease, err = reconcileTaskAttempt(ctx, queries, leaseRow, input)
	case "schedule_reconcile":
		err = scheduleTaskReconcile(ctx, queries, leaseRow, input)
		releaseLease = err == nil
	default:
		return WorkerExecution{}, ErrInvalid
	}
	if err != nil {
		return WorkerExecution{}, err
	}
	execution, err := getExecution(ctx, queries, input.TaskID)
	if err != nil {
		return WorkerExecution{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return WorkerExecution{}, err
	}
	if releaseLease {
		return WorkerExecution{Execution: execution}, nil
	}
	lease := workerLeaseFromWorkItem(leaseRow, input.LeaseToken)
	return WorkerExecution{Lease: &lease, Execution: execution}, nil
}

func scheduleTaskReconcile(
	ctx context.Context,
	queries *store.Queries,
	lease store.WorkItem,
	input WorkerTransitionInput,
) error {
	var payload scheduleReconcilePayload
	if decodeWorkerPayload(input.Payload, &payload) != nil || payload.ReconcileAfterSeconds < 1 ||
		payload.ReconcileAfterSeconds > 300 || input.ExpectedControlRevision == nil {
		return ErrInvalid
	}
	_, err := queries.ScheduleTaskExecutionReconcile(ctx, store.ScheduleTaskExecutionReconcileParams{
		ReconcileAfterSeconds:     int32(payload.ReconcileAfterSeconds),
		TaskID:                    input.TaskID,
		TenantID:                  lease.TenantID,
		Generation:                input.ExecutionGeneration,
		ExpectedExecutionRevision: input.ExpectedExecutionRevision,
		ExpectedControlRevision:   *input.ExpectedControlRevision,
		WorkerID:                  input.WorkerID,
		LeaseGeneration:           input.LeaseGeneration,
		LeaseTokenHash:            tokenHash(input.LeaseToken),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrConflict
	}
	return err
}

func beginEffectDispatch(ctx context.Context, queries *store.Queries, lease store.WorkItem, input WorkerTransitionInput) error {
	var payload effectIDPayload
	if decodeWorkerPayload(input.Payload, &payload) != nil || strings.TrimSpace(payload.EffectID) == "" {
		return ErrInvalid
	}
	effect, err := queries.GetTaskEffect(ctx, store.GetTaskEffectParams{
		ID: payload.EffectID, TaskID: input.TaskID, Generation: input.ExecutionGeneration,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	if effect.Operation != "submit_agent_turn" && effect.Operation != "cleanup_runtime" {
		return ErrInvalid
	}
	// Only a running Task starts turns; Runtime cleanup drains in any state.
	if effect.Operation != "cleanup_runtime" && (!lease.TaskExecutionStatus.Valid || lease.TaskExecutionStatus.String != "running") {
		return ErrConflict
	}
	_, err = queries.BeginTaskEffectDispatch(ctx, store.BeginTaskEffectDispatchParams{
		WorkerID: input.WorkerID, LeaseTokenHash: tokenHash(input.LeaseToken),
		LeaseExpiresAt: lease.TaskLeaseExpiresAt, EffectID: payload.EffectID,
		TaskID: input.TaskID, Generation: input.ExecutionGeneration,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrConflict
	}
	return err
}

func completeRuntimeCleanup(
	ctx context.Context,
	queries *store.Queries,
	lease store.WorkItem,
	input WorkerTransitionInput,
) (bool, error) {
	var payload completeRuntimeCleanupPayload
	if decodeWorkerPayload(input.Payload, &payload) != nil || strings.TrimSpace(payload.EffectID) == "" ||
		strings.TrimSpace(payload.AgentRunRef) == "" ||
		payload.CancelStatus != "canceled" && payload.CancelStatus != "already_terminal" && payload.CancelStatus != "not_found" && payload.CancelStatus != "cancel_requested" ||
		payload.RunStatus != "" && payload.RunStatus != "succeeded" && payload.RunStatus != "failed" && payload.RunStatus != "canceled" ||
		payload.CancelStatus == "cancel_requested" && payload.RunStatus == "" ||
		input.ExpectedControlRevision == nil || !lease.TaskExecutionStatus.Valid {
		return false, ErrInvalid
	}
	effect, err := queries.GetTaskEffect(ctx, store.GetTaskEffectParams{
		ID: payload.EffectID, TaskID: input.TaskID, Generation: input.ExecutionGeneration,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return false, ErrNotFound
	}
	if err != nil {
		return false, err
	}
	var effectPayload struct {
		ActorID           string `json:"actor_id"`
		AgentManagementID string `json:"agent_management_id"`
		AgentRunRef       string `json:"agent_run_ref"`
		ReconcileSubmit   *struct {
			SourceEffectID  string          `json:"source_effect_id"`
			RootOperationID string          `json:"root_operation_id"`
			SubmitPayload   json.RawMessage `json:"submit_payload"`
		} `json:"reconcile_submit"`
	}
	if effect.Operation != "cleanup_runtime" || effect.Status != "dispatching" || json.Unmarshal(effect.Payload, &effectPayload) != nil {
		return false, ErrConflict
	}
	if effectPayload.AgentRunRef != "" {
		if effectPayload.ReconcileSubmit != nil || effectPayload.AgentRunRef != payload.AgentRunRef {
			return false, ErrConflict
		}
	} else if effectPayload.ReconcileSubmit == nil {
		return false, ErrConflict
	} else {
		source, sourceErr := queries.GetTaskEffect(ctx, store.GetTaskEffectParams{
			ID: effectPayload.ReconcileSubmit.SourceEffectID, TaskID: input.TaskID, Generation: input.ExecutionGeneration,
		})
		if sourceErr != nil || source.Operation != "submit_agent_turn" ||
			source.RootOperationID != effectPayload.ReconcileSubmit.RootOperationID ||
			!jsonBytesEqual(source.Payload, effectPayload.ReconcileSubmit.SubmitPayload) {
			return false, ErrConflict
		}
		if source.Status == "pending" || source.Status == "dispatching" {
			// Older replicas stopped the Attempt without settling its submit.
			// Recover only a submit durably linked to a stopped Attempt.
			updated, err := queries.CancelStoppedTaskSubmitEffects(ctx, store.CancelStoppedTaskSubmitEffectsParams{
				TaskID: input.TaskID, Generation: input.ExecutionGeneration, EffectIds: []string{source.ID},
			})
			if err != nil {
				return false, err
			}
			if updated != 1 {
				return false, ErrConflict
			}
		} else if source.Status != "canceled" && source.Status != "failed" {
			return false, ErrConflict
		}
		var submit struct {
			RecipientActorIDs []string `json:"recipient_actor_ids"`
		}
		if json.Unmarshal(source.Payload, &submit) != nil || !containsString(submit.RecipientActorIDs, effectPayload.ActorID) {
			return false, ErrConflict
		}
		participants, participantErr := queries.ListTaskExecutionParticipants(ctx, store.ListTaskExecutionParticipantsParams{
			TaskID: input.TaskID, Generation: input.ExecutionGeneration,
		})
		if participantErr != nil {
			return false, participantErr
		}
		matched := false
		for _, participant := range participants {
			if participant.ActorID == effectPayload.ActorID && participant.AgentManagementID == effectPayload.AgentManagementID {
				matched = true
				break
			}
		}
		if !matched {
			return false, ErrConflict
		}
	}
	observation := map[string]any{
		"agent_run_ref": payload.AgentRunRef, "cancel_status": payload.CancelStatus,
	}
	if payload.RunStatus != "" {
		observation["run_status"] = payload.RunStatus
	}
	encoded, digest, err := canonicalHash(observation)
	if err != nil {
		return false, err
	}
	if _, err := queries.CompleteTaskRuntimeCleanupEffect(ctx, store.CompleteTaskRuntimeCleanupEffectParams{
		Observation: encoded, ObservationHash: digest,
		EffectID: payload.EffectID, TaskID: input.TaskID, Generation: input.ExecutionGeneration,
		WorkerID: input.WorkerID, LeaseTokenHash: tokenHash(input.LeaseToken),
		LeaseGeneration: input.LeaseGeneration,
	}); errors.Is(err, pgx.ErrNoRows) {
		return false, ErrConflict
	} else if err != nil {
		return false, err
	}
	released, err := queries.ReleaseTaskExecutionLeaseAfterRuntimeCleanup(ctx, store.ReleaseTaskExecutionLeaseAfterRuntimeCleanupParams{
		TaskID: input.TaskID, TenantID: lease.TenantID, Generation: input.ExecutionGeneration,
		ExpectedExecutionRevision: input.ExpectedExecutionRevision,
		ExpectedControlRevision:   *input.ExpectedControlRevision,
		WorkerID:                  input.WorkerID, LeaseGeneration: input.LeaseGeneration,
		LeaseTokenHash: tokenHash(input.LeaseToken),
	})
	if err != nil {
		return false, err
	}
	return released == 1, nil
}

func recordAgentTurn(ctx context.Context, queries *store.Queries, lease store.WorkItem, input WorkerTransitionInput) error {
	var payload recordAgentTurnPayload
	if decodeWorkerPayload(input.Payload, &payload) != nil || payload.EffectID == "" || len(payload.ParticipantRuns) == 0 {
		return ErrInvalid
	}
	effect, err := queries.GetTaskEffect(ctx, store.GetTaskEffectParams{ID: payload.EffectID, TaskID: input.TaskID, Generation: input.ExecutionGeneration})
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	if effect.Operation != "submit_agent_turn" || effect.Status != "pending" && effect.Status != "dispatching" {
		return ErrConflict
	}
	var effectPayload struct {
		RecipientActorIDs []string `json:"recipient_actor_ids"`
	}
	if json.Unmarshal(effect.Payload, &effectPayload) != nil {
		return ErrConflict
	}
	participants, err := queries.ListTaskExecutionParticipants(ctx, store.ListTaskExecutionParticipantsParams{TaskID: input.TaskID, Generation: input.ExecutionGeneration})
	if err != nil {
		return err
	}
	byActor := make(map[string]store.TaskExecutionParticipant, len(participants))
	for _, participant := range participants {
		byActor[participant.ActorID] = participant
	}
	recipients := append([]string(nil), effectPayload.RecipientActorIDs...)
	sort.Strings(recipients)
	runs := append([]participantRun(nil), payload.ParticipantRuns...)
	sort.Slice(runs, func(i, j int) bool { return runs[i].ActorID < runs[j].ActorID })
	seenRunRefs := make(map[string]struct{}, len(runs))
	if len(recipients) != len(runs) {
		return ErrInvalid
	}
	for index, run := range runs {
		participant, ok := byActor[run.ActorID]
		if !ok || recipients[index] != run.ActorID || participant.AgentManagementID != run.AgentManagementID ||
			strings.TrimSpace(run.AgentRunRef) == "" || len(run.AgentRunRef) > 500 {
			return ErrInvalid
		}
		if _, duplicate := seenRunRefs[run.AgentRunRef]; duplicate {
			return ErrInvalid
		}
		seenRunRefs[run.AgentRunRef] = struct{}{}
	}
	observation, observationHash, err := canonicalHash(map[string]any{"participant_runs": runs})
	if err != nil {
		return err
	}
	_, err = queries.CompleteTaskEffect(ctx, store.CompleteTaskEffectParams{
		EffectStatus: "succeeded", Observation: observation, ObservationHash: observationHash,
		EffectID: payload.EffectID, TaskID: input.TaskID, Generation: input.ExecutionGeneration,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrConflict
	}
	return err
}

func recordAgentTurnFailure(ctx context.Context, queries *store.Queries, input WorkerTransitionInput) error {
	var payload recordAgentTurnFailurePayload
	if decodeWorkerPayload(input.Payload, &payload) != nil || payload.EffectID == "" ||
		!strings.HasPrefix(payload.FailureCode, "CONTEXT_ACTIVATION_") ||
		!strings.HasSuffix(payload.FailureCode, "_FAILED") || len(payload.FailureCode) > 255 {
		return ErrInvalid
	}
	effect, err := queries.GetTaskEffect(ctx, store.GetTaskEffectParams{
		ID: payload.EffectID, TaskID: input.TaskID, Generation: input.ExecutionGeneration,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	if effect.Operation != "submit_agent_turn" || effect.Status != "pending" && effect.Status != "dispatching" {
		return ErrConflict
	}
	observation, observationHash, err := canonicalHash(map[string]any{
		"failure_code": payload.FailureCode,
		"retryable":    payload.Retryable,
	})
	if err != nil {
		return err
	}
	_, err = queries.CompleteTaskEffect(ctx, store.CompleteTaskEffectParams{
		EffectStatus: "failed", Observation: observation, ObservationHash: observationHash,
		Error: optionalText(payload.FailureCode), EffectID: payload.EffectID,
		TaskID: input.TaskID, Generation: input.ExecutionGeneration,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrConflict
	}
	return err
}

func recordAgentTerminal(ctx context.Context, queries *store.Queries, input WorkerTransitionInput) error {
	var payload recordAgentTerminalPayload
	if decodeWorkerPayload(input.Payload, &payload) != nil || payload.EffectID == "" || len(payload.ParticipantTerminals) == 0 {
		return ErrInvalid
	}
	effect, err := queries.GetTaskEffect(ctx, store.GetTaskEffectParams{ID: payload.EffectID, TaskID: input.TaskID, Generation: input.ExecutionGeneration})
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	if effect.Operation != "submit_agent_turn" || effect.Status != "succeeded" {
		return ErrConflict
	}
	var observation struct {
		ParticipantRuns      []participantRun      `json:"participant_runs"`
		ParticipantTerminals []participantTerminal `json:"participant_terminals,omitempty"`
	}
	if json.Unmarshal(effect.Observation, &observation) != nil || len(observation.ParticipantRuns) == 0 {
		return ErrConflict
	}
	allowed := make(map[string]struct{}, len(observation.ParticipantRuns))
	for _, run := range observation.ParticipantRuns {
		allowed[run.AgentRunRef] = struct{}{}
	}
	existing := make(map[string]participantTerminal, len(observation.ParticipantTerminals))
	for _, terminal := range observation.ParticipantTerminals {
		existing[terminal.AgentRunRef] = terminal
	}
	for _, terminal := range payload.ParticipantTerminals {
		terminal.AgentRunRef = strings.TrimSpace(terminal.AgentRunRef)
		if _, ok := allowed[terminal.AgentRunRef]; !ok || terminal.Status != "succeeded" && terminal.Status != "failed" && terminal.Status != "canceled" ||
			len(terminal.TerminalCode) > 255 || len(terminal.TerminalMessage) > 50000 {
			return ErrInvalid
		}
		if old, ok := existing[terminal.AgentRunRef]; ok && old != terminal {
			return ErrConflict
		}
		existing[terminal.AgentRunRef] = terminal
	}
	observation.ParticipantTerminals = observation.ParticipantTerminals[:0]
	for _, terminal := range existing {
		observation.ParticipantTerminals = append(observation.ParticipantTerminals, terminal)
	}
	sort.Slice(observation.ParticipantTerminals, func(i, j int) bool {
		return observation.ParticipantTerminals[i].AgentRunRef < observation.ParticipantTerminals[j].AgentRunRef
	})
	encoded, digest, err := canonicalHash(observation)
	if err != nil {
		return err
	}
	_, err = queries.UpdateTaskAgentTerminalObservation(ctx, store.UpdateTaskAgentTerminalObservationParams{
		Observation: encoded, ObservationHash: digest, EffectID: payload.EffectID,
		TaskID: input.TaskID, Generation: input.ExecutionGeneration,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrConflict
	}
	return err
}

func containsString(values []string, wanted string) bool {
	for _, value := range values {
		if value == wanted {
			return true
		}
	}
	return false
}

func validateWorkerTransition(input WorkerTransitionInput) error {
	if err := validateWorkerLeaseInput(input.WorkerLeaseInput); err != nil || input.ExecutionGeneration < 1 ||
		input.ExpectedExecutionRevision < 1 || len(input.Payload) > maxWorkerPayloadBytes ||
		strings.TrimSpace(input.Transition) == "" || len(input.OperationID) > 255 {
		return ErrInvalid
	}
	if input.ExpectedControlRevision != nil && *input.ExpectedControlRevision < 0 {
		return ErrInvalid
	}
	return nil
}

func validateWorkerLeaseInput(input WorkerLeaseInput) error {
	if strings.TrimSpace(input.TaskID) == "" || strings.TrimSpace(input.WorkerID) == "" || len(input.WorkerID) > 255 ||
		len(input.LeaseToken) < 32 || len(input.LeaseToken) > 256 || input.LeaseGeneration < 1 {
		return ErrInvalid
	}
	return nil
}

func decodeWorkerPayload(raw json.RawMessage, output any) error {
	if len(raw) == 0 {
		raw = json.RawMessage(`{}`)
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(output); err != nil {
		return err
	}
	if err := decoder.Decode(new(any)); !errors.Is(err, io.EOF) {
		return ErrInvalid
	}
	return nil
}

func claimedWorkerLease(taskID string, workerID pgtype.Text, generation pgtype.Int8, expiresAt pgtype.Timestamptz, token string) (WorkerLease, error) {
	if !workerID.Valid || !generation.Valid || !expiresAt.Valid || generation.Int64 < 1 || token == "" {
		return WorkerLease{}, ErrConflict
	}
	return WorkerLease{TaskID: taskID, WorkerID: workerID.String, LeaseToken: token, LeaseGeneration: generation.Int64, LeaseExpiresAt: expiresAt.Time}, nil
}

func workerLeaseFromWorkItem(item store.WorkItem, token string) WorkerLease {
	return WorkerLease{TaskID: item.ID, WorkerID: item.TaskWorkerID.String, LeaseToken: token,
		LeaseGeneration: item.TaskLeaseGeneration.Int64, LeaseExpiresAt: item.TaskLeaseExpiresAt.Time}
}

func jsonBytesEqual(left, right []byte) bool {
	var leftValue, rightValue any
	return json.Unmarshal(left, &leftValue) == nil && json.Unmarshal(right, &rightValue) == nil &&
		reflect.DeepEqual(leftValue, rightValue)
}
