package taskexecution

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

type reconcileAttemptPayload struct{}

type currentAttemptRuns struct {
	allTerminal    bool
	allSucceeded   bool
	failed         bool
	failureMessage string
	canceled       bool
	// lastRun is the Local Run whose reply reports the Task when it goes idle.
	lastRun participantRun
}

// reconcileTaskAttempt reduces only PostgreSQL-authoritative facts for the
// current Attempt/InputRevision. When the current turn has ended,
// the Task becomes idle and reports the Run's last reply to its Meta, waits
// for the AlterEgo's approval cards, or fails and reports the error. Nothing
// is retried and the generation never ends: a Meta message or an approval
// result starts the next Attempt.
func reconcileTaskAttempt(
	ctx context.Context,
	queries *store.Queries,
	lease store.WorkItem,
	input WorkerTransitionInput,
) (bool, error) {
	var payload reconcileAttemptPayload
	if decodeWorkerPayload(input.Payload, &payload) != nil || input.ExpectedControlRevision == nil ||
		strings.TrimSpace(input.OperationID) == "" {
		return false, ErrInvalid
	}
	if !lease.TaskExecutionStatus.Valid || lease.TaskExecutionStatus.String != "running" {
		return false, nil
	}
	snapshot, err := queries.LockTaskExecutionSnapshot(ctx, input.TaskID)
	if err != nil {
		return false, err
	}
	if !snapshot.TaskExecutionGeneration.Valid || snapshot.TaskExecutionGeneration.Int64 != input.ExecutionGeneration ||
		!snapshot.TaskExecutionRevision.Valid || snapshot.TaskExecutionRevision.Int64 != input.ExpectedExecutionRevision ||
		!snapshot.TaskControlRevision.Valid || snapshot.TaskControlRevision.Int64 != *input.ExpectedControlRevision {
		return false, ErrConflict
	}

	attempts, err := queries.ListTaskAttempts(ctx, store.ListTaskAttemptsParams{
		TaskID: input.TaskID, Generation: input.ExecutionGeneration,
	})
	if err != nil {
		return false, err
	}
	current, found := currentRunningAttempt(attempts)
	if !found {
		return false, nil
	}
	inputs, err := queries.ListTaskInputRevisions(ctx, store.ListTaskInputRevisionsParams{
		TaskID: input.TaskID, Generation: input.ExecutionGeneration,
	})
	if err != nil {
		return false, err
	}
	currentInput, found := taskInputRevision(inputs, current.ID, current.CurrentInputRevision)
	if !found {
		return false, ErrConflict
	}
	effects, err := queries.ListTaskEffects(ctx, store.ListTaskEffectsParams{
		TaskID: input.TaskID, Generation: input.ExecutionGeneration,
	})
	if err != nil {
		return false, err
	}
	runs, err := inspectCurrentAttemptRuns(currentInput, effects)
	if err != nil {
		return false, err
	}
	now, err := queries.TaskExecutionDatabaseNow(ctx)
	if err != nil {
		return false, err
	}

	stopReason, failure := "", ""
	switch {
	case current.DeadlineAt.Valid && !now.Time.Before(current.DeadlineAt.Time):
		stopReason, failure = "attempt_timeout", "the Run did not finish within its time limit"
	case runs.failed:
		stopReason, failure = "agent_run_failed", runs.failureMessage
	case runs.canceled:
		stopReason, failure = "agent_run_canceled", "the Run was canceled"
	}
	if stopReason != "" {
		return false, failTaskAttempt(ctx, queries, lease, snapshot, input, current, inputs, stopReason, failure)
	}
	if runs.allTerminal && runs.allSucceeded {
		return false, settleTaskTurn(ctx, queries, lease, snapshot, input, current, runs.lastRun)
	}
	return false, nil
}

func currentRunningAttempt(attempts []store.TaskAttempt) (store.TaskAttempt, bool) {
	var current store.TaskAttempt
	found := false
	for _, attempt := range attempts {
		if attempt.Status != "running" {
			continue
		}
		if found {
			return store.TaskAttempt{}, false
		}
		current = attempt
		found = true
	}
	return current, found
}

func taskInputRevision(inputs []store.TaskInputRevision, attemptID string, revision int64) (store.TaskInputRevision, bool) {
	for _, item := range inputs {
		if item.AttemptID == attemptID && item.InputRevision == revision {
			return item, true
		}
	}
	return store.TaskInputRevision{}, false
}

func inspectCurrentAttemptRuns(input store.TaskInputRevision, effects []store.TaskEffect) (currentAttemptRuns, error) {
	var effectIDs []string
	if json.Unmarshal(input.MessageEffectIds, &effectIDs) != nil || len(effectIDs) == 0 {
		return currentAttemptRuns{}, ErrConflict
	}
	byID := make(map[string]store.TaskEffect, len(effects))
	for _, effect := range effects {
		byID[effect.ID] = effect
	}
	totalRuns := 0
	var lastRun participantRun
	terminals := make(map[string]participantTerminal)
	for _, effectID := range effectIDs {
		effect, ok := byID[effectID]
		if !ok || effect.Operation != "submit_agent_turn" {
			return currentAttemptRuns{}, ErrConflict
		}
		if effect.Status == "failed" {
			var failure struct {
				FailureCode string `json:"failure_code"`
				Retryable   *bool  `json:"retryable"`
			}
			if json.Unmarshal(effect.Observation, &failure) != nil ||
				!strings.HasPrefix(failure.FailureCode, "CONTEXT_ACTIVATION_") ||
				failure.Retryable == nil {
				return currentAttemptRuns{}, ErrConflict
			}
			return currentAttemptRuns{failed: true, failureMessage: "the AlterEgo could not start: " + failure.FailureCode}, nil
		}
		if effect.Status != "succeeded" {
			return currentAttemptRuns{}, nil
		}
		var observation struct {
			ParticipantRuns      []participantRun      `json:"participant_runs"`
			ParticipantTerminals []participantTerminal `json:"participant_terminals,omitempty"`
		}
		if json.Unmarshal(effect.Observation, &observation) != nil || len(observation.ParticipantRuns) == 0 {
			return currentAttemptRuns{}, ErrConflict
		}
		allowed := make(map[string]struct{}, len(observation.ParticipantRuns))
		for _, run := range observation.ParticipantRuns {
			if strings.TrimSpace(run.AgentRunRef) == "" {
				return currentAttemptRuns{}, ErrConflict
			}
			allowed[run.AgentRunRef] = struct{}{}
			lastRun = run
			totalRuns++
		}
		for _, terminal := range observation.ParticipantTerminals {
			if _, ok := allowed[terminal.AgentRunRef]; !ok {
				return currentAttemptRuns{}, ErrConflict
			}
			terminals[terminal.AgentRunRef] = terminal
		}
	}
	result := currentAttemptRuns{allTerminal: totalRuns > 0 && len(terminals) == totalRuns, lastRun: lastRun}
	result.allSucceeded = result.allTerminal
	for _, terminal := range terminals {
		switch terminal.Status {
		case "succeeded":
		case "failed":
			result.failed = true
			result.allSucceeded = false
			result.failureMessage = strings.TrimSpace(terminal.TerminalMessage)
			if result.failureMessage == "" {
				result.failureMessage = strings.TrimSpace(terminal.TerminalCode)
			}
			if result.failureMessage == "" {
				result.failureMessage = "the Run failed"
			}
		case "canceled":
			result.canceled = true
			result.allSucceeded = false
		default:
			return currentAttemptRuns{}, ErrConflict
		}
	}
	return result, nil
}

// settleTaskTurn ends a turn whose Runs all succeeded. While the AlterEgo
// still has approval cards pending, their results wake it again, so the
// Task waits and reports nothing; otherwise it is idle and reports the
// Run's last reply to the Meta.
func settleTaskTurn(
	ctx context.Context,
	queries *store.Queries,
	lease store.WorkItem,
	snapshot store.LockTaskExecutionSnapshotRow,
	input WorkerTransitionInput,
	attempt store.TaskAttempt,
	lastRun participantRun,
) error {
	if updated, err := queries.PassTaskAttemptForReconcile(ctx, store.PassTaskAttemptForReconcileParams{
		AttemptID: attempt.ID, TaskID: input.TaskID, Generation: input.ExecutionGeneration,
		ExpectedInputRevision: attempt.CurrentInputRevision,
	}); err != nil {
		return err
	} else if updated != 1 {
		return ErrConflict
	}
	contextKey, err := alterEgoContextKey(lastRun.AgentManagementID, input.TaskID)
	if err != nil {
		return ErrConflict
	}
	pending, err := queries.ListDelegatedTaskPendingApprovals(ctx, store.ListDelegatedTaskPendingApprovalsParams{
		TenantID: lease.TenantID, ContextKey: contextKey, TaskID: input.TaskID,
	})
	if err != nil {
		return err
	}
	status, reason := "idle", "run_succeeded"
	report := ""
	if len(pending) > 0 {
		status, reason = "waiting_for_approval", "pending_approval"
	} else {
		reply, err := queries.GetAgentLocalRunFinalResponse(ctx, store.GetAgentLocalRunFinalResponseParams{
			RunID: lastRun.AgentRunRef, ContextKey: contextKey,
		})
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		if reply = strings.TrimSpace(reply); reply == "" {
			reply = "(no reply)"
		}
		report = "Task " + snapshot.Title + " (" + input.TaskID + ") is idle. " + taskDoneReminder(input.TaskID) + "\n" + reply
	}
	return settleTaskStatus(ctx, queries, lease, snapshot, input, status, reason, report, map[string]any{
		"attempt_id": attempt.ID, "input_revision": attempt.CurrentInputRevision,
		"agent_run_ref": lastRun.AgentRunRef, "pending_approvals": len(pending),
	})
}

// taskDoneReminder asks the Meta to hand a finished Task's result to the user
// as one card, followed by one ordinary message for anything the user must
// add or check. Only an idle report carries it; a failure is told in plain
// words.
func taskDoneReminder(taskID string) string {
	return "If it is done, deliver it to the user with teamhub message card: a title, " +
		"a one-line result, and its files from ./playground/" + taskID + "/ with --attach; then say in one " +
		"ordinary message what the user should add or check, if anything."
}

func failTaskAttempt(
	ctx context.Context,
	queries *store.Queries,
	lease store.WorkItem,
	snapshot store.LockTaskExecutionSnapshotRow,
	input WorkerTransitionInput,
	attempt store.TaskAttempt,
	inputs []store.TaskInputRevision,
	stopReason, failure string,
) error {
	if updated, err := queries.StopTaskAttemptForReconcile(ctx, store.StopTaskAttemptForReconcileParams{
		StopReasonCode: stopReason, AttemptID: attempt.ID, TaskID: input.TaskID,
		Generation: input.ExecutionGeneration, ExpectedInputRevision: attempt.CurrentInputRevision,
	}); err != nil {
		return err
	} else if updated != 1 {
		return ErrConflict
	}
	// A timed-out Run, or a turn queued behind a failed one, is canceled;
	// the AlterEgo Context and its session stay for the next message.
	if err := EnqueueKnownParticipantRuns(ctx, queries, input.TaskID, lease.TenantID, input.ExecutionGeneration); err != nil {
		return err
	}
	if err := cancelStoppedAttemptSubmissions(ctx, queries, input.TaskID, input.ExecutionGeneration, attempt.ID, inputs); err != nil {
		return err
	}
	report := "Task " + snapshot.Title + " (" + input.TaskID + ") failed: " + truncateRunes(failure, taskReportFailureMaxRunes)
	return settleTaskStatus(ctx, queries, lease, snapshot, input, "failed", stopReason, report, map[string]any{
		"attempt_id": attempt.ID, "attempt_number": attempt.AttemptNumber, "stop_reason_code": stopReason,
	})
}

// settleTaskStatus moves a running Task to the state its ended turn
// produced and, when report is set, writes it to the Task's hidden callback
// stream, which wakes the coordinating Meta.
func settleTaskStatus(
	ctx context.Context,
	queries *store.Queries,
	lease store.WorkItem,
	snapshot store.LockTaskExecutionSnapshotRow,
	input WorkerTransitionInput,
	status, reason, report string,
	payload map[string]any,
) error {
	nextRevision := input.ExpectedExecutionRevision + 1
	if err := insertFact(ctx, queries, factInput{
		TaskID: input.TaskID, TenantID: lease.TenantID, Generation: input.ExecutionGeneration,
		Revision: nextRevision, Kind: "TASK_EXECUTION_CHANGED", Status: status,
		ControlSettledRevision: intValue(lease.TaskControlSettledRevision), SourceOperationID: input.OperationID,
		ReasonCode: reason, Payload: payload,
	}); err != nil {
		return err
	}
	if _, err := queries.AdvanceTaskExecutionStatus(ctx, store.AdvanceTaskExecutionStatusParams{
		WorkItemState: "in_progress", NextStatus: status, ReasonCode: optionalText(reason),
		TaskID: input.TaskID, TenantID: lease.TenantID, Generation: input.ExecutionGeneration,
		ExpectedExecutionRevision: input.ExpectedExecutionRevision,
		ExpectedControlRevision:   *input.ExpectedControlRevision, ExpectedStatus: "running",
	}); errors.Is(err, pgx.ErrNoRows) {
		return ErrConflict
	} else if err != nil {
		return err
	}
	if report != "" {
		if err := appendTaskReport(ctx, queries, snapshot, input.ExecutionGeneration, report); err != nil {
			return err
		}
	}
	return appendExecutionEvent(ctx, queries, lease.TenantID, snapshot.EventRoomID, input.TaskID,
		snapshot.ResultAgentActorID, snapshot.Version, nextRevision, status)
}

func cancelStoppedAttemptSubmissions(
	ctx context.Context,
	queries *store.Queries,
	taskID string,
	generation int64,
	attemptID string,
	revisions []store.TaskInputRevision,
) error {
	var effectIDs []string
	for _, revision := range revisions {
		if revision.AttemptID != attemptID {
			continue
		}
		var ids []string
		if json.Unmarshal(revision.MessageEffectIds, &ids) != nil {
			return ErrConflict
		}
		effectIDs = append(effectIDs, ids...)
	}
	_, err := queries.CancelStoppedTaskSubmitEffects(ctx, store.CancelStoppedTaskSubmitEffectsParams{
		TaskID: taskID, Generation: generation, EffectIds: effectIDs,
	})
	return err
}

func taskInputOperationID(taskID string, generation int64, attemptID string, inputRevision int64) string {
	return "task:" + taskID + ":g:" + strconv.FormatInt(generation, 10) + ":attempt:" + attemptID +
		":input:" + strconv.FormatInt(inputRevision, 10)
}
