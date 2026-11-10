package taskexecution

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentruntimestate"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

const (
	// MaxTaskInputRunes bounds one Meta message or system notice to a Task.
	MaxTaskInputRunes         = 20000
	taskReportMaxRunes        = 49000
	taskReportFailureMaxRunes = 4000
	taskReportTruncation      = "\n[truncated]"
	checkReportMaxRunes       = 4000
	checkRecentActivityLimit  = 5
)

// Delegated Task input causes: the Meta's task send, and system
// notices such as approval-card results.
const (
	TaskInputMetaMessage = "meta_message"
	TaskInputSystem      = "system"
)

// DelegatedAttemptPolicyV1 never retries: a failed turn leaves the Task
// failed, and the Meta decides whether to send it another message. One turn
// may run for a whole day.
func DelegatedAttemptPolicyV1() AttemptPolicyV1 {
	return AttemptPolicyV1{PolicyVersion: 1, MaxRetries: 0, TimeoutSeconds: 24 * 60 * 60}
}

type TaskInput struct {
	TaskID string
	Cause  string
	Body   string
	Steer  bool
}

type TaskInputResult struct {
	// Delivery is started (a new turn of an idle, waiting, failed or canceled
	// Task), queued (the next turn of a running Task) or steered (requested
	// into the running turn; the Agent falls back to queuing it).
	Delivery string
	Status   string
	// ExecutionRevision is the Task revision this input committed.
	ExecutionRevision int64
}

// AppendTaskInput wakes a delegated Task's AlterEgo with one message in the
// caller's transaction. A Task that is not running starts a new Attempt; a
// running Task gets the message as its next turn. The Task's own Agent
// authors the private wake, so the AlterEgo reads it as trusted input.
func AppendTaskInput(ctx context.Context, queries *store.Queries, input TaskInput) (TaskInputResult, error) {
	input.Body = strings.TrimSpace(input.Body)
	if queries == nil || strings.TrimSpace(input.TaskID) == "" ||
		input.Cause != TaskInputMetaMessage && input.Cause != TaskInputSystem ||
		input.Body == "" || utf8.RuneCountInString(input.Body) > MaxTaskInputRunes {
		return TaskInputResult{}, ErrInvalid
	}
	snapshot, err := queries.LockTaskExecutionSnapshot(ctx, input.TaskID)
	if errors.Is(err, pgx.ErrNoRows) {
		return TaskInputResult{}, ErrNotFound
	}
	if err != nil {
		return TaskInputResult{}, err
	}
	if !snapshot.TaskExecutionGeneration.Valid || !snapshot.TaskExecutionRevision.Valid || !snapshot.TaskExecutionStatus.Valid {
		return TaskInputResult{}, ErrNotFound
	}
	generation := snapshot.TaskExecutionGeneration.Int64
	status := snapshot.TaskExecutionStatus.String
	author, err := queries.GetActor(ctx, store.GetActorParams{ID: snapshot.ResultAgentActorID, TenantID: snapshot.TenantID})
	if err != nil {
		return TaskInputResult{}, err
	}
	participants, err := queries.ListTaskExecutionParticipants(ctx, store.ListTaskExecutionParticipantsParams{
		TaskID: input.TaskID, Generation: generation,
	})
	if err != nil {
		return TaskInputResult{}, err
	}
	recipients := make([]string, len(participants))
	for index, participant := range participants {
		recipients[index] = participant.ActorID
	}
	recipients, err = normalizedUniqueIDs(recipients)
	if err != nil {
		return TaskInputResult{}, ErrConflict
	}
	segments, err := json.Marshal([]map[string]string{{"type": "text", "content": input.Body}})
	if err != nil {
		return TaskInputResult{}, err
	}
	message, err := normalizeTurnMessage(TurnMessageInput{
		MessageID: newID("task_input_message_"), RawMessage: input.Body, Segments: segments,
		Author: &TurnMessageAuthor{ActorID: author.ID, Kind: author.Kind, DisplayName: author.DisplayName},
	})
	if err != nil {
		return TaskInputResult{}, err
	}
	attempts, err := queries.ListTaskAttempts(ctx, store.ListTaskAttemptsParams{TaskID: input.TaskID, Generation: generation})
	if err != nil {
		return TaskInputResult{}, err
	}
	current, hasRunningAttempt := currentRunningAttempt(attempts)
	if (status == "running") != hasRunningAttempt {
		return TaskInputResult{}, ErrConflict
	}

	// Private Meta wakes take Account and projection locks before the
	// execution Event; lock the Task's delivery Rooms first.
	if err := queries.LockWorkItemDeliveryRooms(ctx, store.LockWorkItemDeliveryRoomsParams{
		TenantID: snapshot.TenantID, WorkItemID: input.TaskID, OriginRoomID: snapshot.EventRoomID,
	}); err != nil {
		return TaskInputResult{}, err
	}
	wakes, err := AppendParticipantMetaWakes(ctx, queries, input.TaskID, snapshot.TenantID, author.ID, recipients, message)
	if err != nil {
		return TaskInputResult{}, err
	}
	baseManifest, _, err := canonicalHash(map[string]any{"room_id": snapshot.EventRoomID, "source": input.Cause})
	if err != nil {
		return TaskInputResult{}, err
	}
	manifest, err := FreezeParticipantWakeManifest(baseManifest, message, wakes)
	if err != nil {
		return TaskInputResult{}, err
	}
	capability, err := randomToken(32)
	if err != nil {
		return TaskInputResult{}, err
	}

	result := TaskInputResult{Status: "running"}
	attemptID, inputRevision := current.ID, current.CurrentInputRevision+1
	if hasRunningAttempt {
		result.Delivery = "queued"
		if input.Steer {
			result.Delivery = "steered"
		}
	} else {
		var spec RunSpecV1
		if json.Unmarshal(snapshot.Spec, &spec) != nil || spec.AttemptPolicy.TimeoutSeconds < 1 {
			return TaskInputResult{}, ErrConflict
		}
		now, err := queries.TaskExecutionDatabaseNow(ctx)
		if err != nil {
			return TaskInputResult{}, err
		}
		attemptNumber := int64(1)
		for _, attempt := range attempts {
			attemptNumber = max(attemptNumber, attempt.AttemptNumber+1)
		}
		attemptID, inputRevision = newID("task_attempt_"), 1
		if _, err := queries.InsertTaskAttempt(ctx, store.InsertTaskAttemptParams{
			ID: attemptID, TaskID: input.TaskID, TenantID: snapshot.TenantID, Generation: generation,
			AttemptNumber: attemptNumber, RuntimeGenerationKey: newID("runtime_generation_"),
			Status: "running", CurrentInputRevision: 1,
			DeadlineAt: pgtype.Timestamptz{Time: now.Time.Add(time.Duration(spec.AttemptPolicy.TimeoutSeconds) * time.Second), Valid: true},
		}); err != nil {
			return TaskInputResult{}, err
		}
		result.Delivery = "started"
	}
	effectID := newID("task_effect_")
	recipientJSON, _ := json.Marshal(recipients)
	effectIDs, _ := json.Marshal([]string{effectID})
	if _, err := queries.InsertTaskInputRevision(ctx, store.InsertTaskInputRevisionParams{
		TaskID: input.TaskID, TenantID: snapshot.TenantID, Generation: generation,
		AttemptID: attemptID, InputRevision: inputRevision, Cause: input.Cause,
		RecipientActorIds: recipientJSON, InputManifest: manifest,
		MessageEffectIds: effectIDs, CapabilityHash: tokenHash(capability),
	}); err != nil {
		return TaskInputResult{}, err
	}
	effectPayload, err := NewRoutedSubmitTurnEffectPayload(attemptID, inputRevision, recipients, manifest, message, wakes, capability)
	if err != nil {
		return TaskInputResult{}, err
	}
	effectPayload.Steer = result.Delivery == "steered"
	effectJSON, effectHash, err := canonicalHash(effectPayload)
	if err != nil {
		return TaskInputResult{}, err
	}
	rootOperationID := taskInputOperationID(input.TaskID, generation, attemptID, inputRevision)
	if _, err := queries.InsertTaskEffect(ctx, store.InsertTaskEffectParams{
		ID: effectID, TaskID: input.TaskID, TenantID: snapshot.TenantID, Generation: generation,
		RootOperationID: rootOperationID, EffectKey: rootOperationID + ":submit", Operation: "submit_agent_turn",
		OwnerID: input.TaskID, Payload: effectJSON, PayloadHash: effectHash, RootPayloadHash: effectHash,
		DispatchSequence: 1, Status: "pending",
	}); err != nil {
		return TaskInputResult{}, err
	}
	if hasRunningAttempt {
		if updated, err := queries.AdvanceRunningTaskAttemptInput(ctx, store.AdvanceRunningTaskAttemptInputParams{
			NextInputRevision: inputRevision, AttemptID: attemptID, TaskID: input.TaskID,
			Generation: generation, ExpectedInputRevision: current.CurrentInputRevision,
		}); err != nil {
			return TaskInputResult{}, err
		} else if updated != 1 {
			return TaskInputResult{}, ErrConflict
		}
	}
	result.ExecutionRevision, err = setDelegatedTaskStatus(ctx, queries, snapshot, status, "running", "", input.Cause, author.ID, map[string]any{
		"attempt_id": attemptID, "input_revision": inputRevision, "effect_id": effectID, "delivery": result.Delivery,
	})
	return result, err
}

// StopTask cancels a delegated Task's current turn. Its Runs are
// canceled through Runtime cleanup; the AlterEgo Context, its session and
// playground stay, so a later Meta message resumes the same conversation.
// Stopping a canceled Task changes nothing and returns revision 0.
func StopTask(ctx context.Context, queries *store.Queries, taskID, actorID string) (int64, error) {
	if queries == nil || strings.TrimSpace(taskID) == "" || strings.TrimSpace(actorID) == "" {
		return 0, ErrInvalid
	}
	snapshot, err := queries.LockTaskExecutionSnapshot(ctx, taskID)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, ErrNotFound
	}
	if err != nil {
		return 0, err
	}
	if !snapshot.TaskExecutionGeneration.Valid || !snapshot.TaskExecutionRevision.Valid || !snapshot.TaskExecutionStatus.Valid {
		return 0, ErrNotFound
	}
	status := snapshot.TaskExecutionStatus.String
	if status == "canceled" {
		return 0, nil
	}
	generation := snapshot.TaskExecutionGeneration.Int64
	attempts, err := queries.ListTaskAttempts(ctx, store.ListTaskAttemptsParams{TaskID: taskID, Generation: generation})
	if err != nil {
		return 0, err
	}
	payload := map[string]any{}
	if current, running := currentRunningAttempt(attempts); running {
		if updated, err := queries.StopTaskAttemptForReconcile(ctx, store.StopTaskAttemptForReconcileParams{
			StopReasonCode: "stopped", AttemptID: current.ID, TaskID: taskID,
			Generation: generation, ExpectedInputRevision: current.CurrentInputRevision,
		}); err != nil {
			return 0, err
		} else if updated != 1 {
			return 0, ErrConflict
		}
		inputs, err := queries.ListTaskInputRevisions(ctx, store.ListTaskInputRevisionsParams{TaskID: taskID, Generation: generation})
		if err != nil {
			return 0, err
		}
		if err := EnqueueKnownParticipantRuns(ctx, queries, taskID, snapshot.TenantID, generation); err != nil {
			return 0, err
		}
		if err := cancelStoppedAttemptSubmissions(ctx, queries, taskID, generation, current.ID, inputs); err != nil {
			return 0, err
		}
		payload["attempt_id"] = current.ID
	}
	return setDelegatedTaskStatus(ctx, queries, snapshot, status, "canceled", "stopped", "stopped", actorID, payload)
}

// setDelegatedTaskStatus records a Meta-driven change outside the Worker
// lease: the fact, the Task snapshot (releasing any lease) and its Event.
func setDelegatedTaskStatus(
	ctx context.Context,
	queries *store.Queries,
	snapshot store.LockTaskExecutionSnapshotRow,
	fromStatus, toStatus, workItemReason, factReason, actorID string,
	payload map[string]any,
) (int64, error) {
	generation := snapshot.TaskExecutionGeneration.Int64
	nextRevision := snapshot.TaskExecutionRevision.Int64 + 1
	if err := insertFact(ctx, queries, factInput{
		TaskID: snapshot.TaskID, TenantID: snapshot.TenantID, Generation: generation,
		Revision: nextRevision, Kind: "TASK_EXECUTION_CHANGED", Status: toStatus,
		ControlSettledRevision: intValue(snapshot.TaskControlSettledRevision),
		ReasonCode:             factReason, CausedByActorID: actorID, Payload: payload,
	}); err != nil {
		return 0, err
	}
	updated, err := queries.SetDelegatedTaskStatus(ctx, store.SetDelegatedTaskStatusParams{
		NextStatus: toStatus, ReasonCode: optionalText(workItemReason),
		TaskID: snapshot.TaskID, TenantID: snapshot.TenantID, Generation: generation,
		ExpectedExecutionRevision: snapshot.TaskExecutionRevision.Int64, ExpectedStatus: fromStatus,
	})
	if err != nil {
		return 0, err
	}
	if updated != 1 {
		return 0, ErrConflict
	}
	return nextRevision, appendExecutionEvent(ctx, queries, snapshot.TenantID, snapshot.EventRoomID, snapshot.TaskID,
		actorID, snapshot.Version, nextRevision, toStatus)
}

// appendTaskReport writes one hidden report to the Task's callback stream,
// which wakes the coordinating Meta of the Task's origin Room. A Task
// without a coordinator has nobody to report to.
func appendTaskReport(ctx context.Context, queries *store.Queries, snapshot store.LockTaskExecutionSnapshotRow, generation int64, body string) error {
	body = truncateRunes(body, taskReportMaxRunes)
	segments, err := json.Marshal([]map[string]string{{"type": "text", "content": body}})
	if err != nil {
		return err
	}
	if err := queries.LockWorkItemDeliveryRooms(ctx, store.LockWorkItemDeliveryRoomsParams{
		TenantID: snapshot.TenantID, WorkItemID: snapshot.TaskID, OriginRoomID: snapshot.EventRoomID,
	}); err != nil {
		return err
	}
	_, err = AppendMetaCallback(ctx, queries, MetaCallbackAppendInput{
		TaskID: snapshot.TaskID, TenantID: snapshot.TenantID, Generation: generation,
		AuthorActorID: snapshot.ResultAgentActorID, Body: body, Segments: segments,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	return err
}

func alterEgoContextKey(agentManagementID, taskID string) (string, error) {
	return agentruntimestate.EncodeContextRef(agentruntimestate.ContextRef{
		Kind: "alter_ego", AgentID: agentManagementID, TaskID: taskID,
	})
}

func truncateRunes(text string, limit int) string {
	if utf8.RuneCountInString(text) <= limit {
		return text
	}
	runes := []rune(text)
	return string(runes[:limit-utf8.RuneCountInString(taskReportTruncation)]) + taskReportTruncation
}

// TaskView is what a Meta's task check shows about one delegated Task.
type TaskView struct {
	Status             string
	ReasonCode         string
	StatusSince        time.Time
	RecentActivity     []TaskActivity
	PendingApprovals   []TaskApproval
	LastReport         *TaskReport
	QueuedMessageCount int
}

type TaskActivity struct {
	At      time.Time
	Kind    string
	Summary string
}

type TaskApproval struct {
	Kind      string
	ID        string
	Title     string
	CreatedAt time.Time
	ExpiresAt *time.Time
}

type TaskReport struct {
	At   time.Time
	Body string
}

// ReadTask projects a delegated Task for its Meta from one transaction.
func ReadTask(ctx context.Context, queries *store.Queries, taskID string) (TaskView, error) {
	execution, err := getExecution(ctx, queries, taskID)
	if err != nil {
		return TaskView{}, err
	}
	view := TaskView{
		Status: execution.Snapshot.Status, ReasonCode: execution.Snapshot.ReasonCode,
		StatusSince: execution.Snapshot.UpdatedAt,
	}
	for index := len(execution.Facts) - 1; index >= 0 && execution.Facts[index].ExecutionStatus == view.Status; index-- {
		view.StatusSince = execution.Facts[index].CreatedAt
	}
	for index := len(execution.Facts) - 1; index >= 0 && len(view.RecentActivity) < checkRecentActivityLimit; index-- {
		view.RecentActivity = append(view.RecentActivity, taskActivity(execution.Facts[index]))
	}
	view.QueuedMessageCount = queuedTaskMessages(execution)
	if len(execution.Participants) != 1 {
		return TaskView{}, ErrConflict
	}
	contextKey, err := alterEgoContextKey(execution.Participants[0].AgentManagementID, taskID)
	if err != nil {
		return TaskView{}, ErrConflict
	}
	approvals, err := queries.ListDelegatedTaskPendingApprovals(ctx, store.ListDelegatedTaskPendingApprovalsParams{
		TenantID: execution.Snapshot.TenantID, ContextKey: contextKey, TaskID: taskID,
	})
	if err != nil {
		return TaskView{}, err
	}
	for _, approval := range approvals {
		view.PendingApprovals = append(view.PendingApprovals, TaskApproval{
			Kind: approval.Kind, ID: approval.ID, Title: approval.Title,
			CreatedAt: approval.CreatedAt.Time, ExpiresAt: timePointer(approval.ExpiresAt),
		})
	}
	report, err := queries.GetLatestTaskMetaCallbackMessage(ctx, store.GetLatestTaskMetaCallbackMessageParams{
		TaskID: taskID, TenantID: execution.Snapshot.TenantID,
	})
	if err == nil {
		view.LastReport = &TaskReport{At: report.CreatedAt.Time, Body: truncateRunes(report.Body, checkReportMaxRunes)}
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return TaskView{}, err
	}
	return view, nil
}

func taskActivity(fact Fact) TaskActivity {
	var payload struct {
		Delivery         string `json:"delivery"`
		PendingApprovals int    `json:"pending_approvals"`
	}
	_ = json.Unmarshal(fact.Payload, &payload)
	activity := TaskActivity{At: fact.CreatedAt, Kind: fact.ExecutionStatus, Summary: fact.ExecutionStatus}
	switch {
	case fact.ExecutionRevision == 1:
		activity.Kind, activity.Summary = "started", "Task created and started"
	case fact.ReasonCode == TaskInputMetaMessage:
		activity.Kind, activity.Summary = "message", "Meta message "+payload.Delivery
	case fact.ReasonCode == TaskInputSystem:
		activity.Kind, activity.Summary = "approval_result", "approval result "+payload.Delivery
	case fact.ExecutionStatus == "idle":
		activity.Summary = "turn finished and reported"
	case fact.ExecutionStatus == "waiting_for_approval":
		activity.Summary = "turn finished; waiting for approval cards"
	case fact.ExecutionStatus == "failed":
		activity.Summary = "failed: " + fact.ReasonCode
	case fact.ExecutionStatus == "canceled":
		activity.Summary = "stopped"
	}
	return activity
}

// queuedTaskMessages counts the current Attempt's turns that wait behind the
// one that is running. A steered message shares the running turn's Run.
func queuedTaskMessages(execution Execution) int {
	attemptID := ""
	for _, attempt := range execution.Attempts {
		if attempt.Status == "running" {
			attemptID = attempt.ID
		}
	}
	if attemptID == "" {
		return 0
	}
	effects := make(map[string]Effect, len(execution.Effects))
	for _, effect := range execution.Effects {
		effects[effect.ID] = effect
	}
	pending := 0
	openRuns := map[string]struct{}{}
	for _, revision := range execution.Inputs {
		var ids []string
		if revision.AttemptID != attemptID || json.Unmarshal(revision.MessageEffectIDs, &ids) != nil {
			continue
		}
		for _, id := range ids {
			effect := effects[id]
			switch effect.Status {
			case "pending", "dispatching":
				pending++
			case "succeeded":
				var observation struct {
					ParticipantRuns      []participantRun      `json:"participant_runs"`
					ParticipantTerminals []participantTerminal `json:"participant_terminals"`
				}
				if json.Unmarshal(effect.Observation, &observation) != nil {
					continue
				}
				ended := map[string]struct{}{}
				for _, terminal := range observation.ParticipantTerminals {
					ended[terminal.AgentRunRef] = struct{}{}
				}
				for _, run := range observation.ParticipantRuns {
					if _, done := ended[run.AgentRunRef]; !done {
						openRuns[run.AgentRunRef] = struct{}{}
					}
				}
			}
		}
	}
	queued := pending + len(openRuns) - 1
	return max(queued, 0)
}
