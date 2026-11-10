package voice

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentruntimestate"
	idgen "github.com/simplexai-labs/linger/apps/teamhub/internal/ids"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/jobs"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/reminder"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/taskdelegation"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/taskexecution"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/typedcard"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voicelive"
	"github.com/simplexai-labs/linger/contracts-go/teamhubinternal"
)

// voiceLiveTaskViews reports the user's tasks in the session's Room from
// their delegated Tasks: the execution state, the latest report and the
// current steps, oldest first.
func (s *Service) voiceLiveTaskViews(ctx context.Context, session voicelive.Session) ([]voicelive.TaskView, error) {
	computer, err := s.queries.GetVoiceLiveAgentComputer(ctx, store.GetVoiceLiveAgentComputerParams{ActorID: session.Agent.ID, TenantID: session.TenantID})
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}
	rows, err := s.queries.ListVoiceLiveTasks(ctx, store.ListVoiceLiveTasksParams{
		RoomID: session.RoomID, OwnerActorID: session.HumanActorID, VoiceSessionID: session.ID,
		Since:            pgtype.Timestamptz{Time: time.Now().Add(-voicelive.RecentTasksSince), Valid: true},
		ContextKeyPrefix: alterEgoContextKeyPrefix(computer.AgentManagementID),
	})
	if err != nil || len(rows) == 0 {
		return nil, err
	}
	slices.Reverse(rows)
	records := make([]voicelive.TaskRecord, len(rows))
	var runs []string
	runTask := map[string]int{}
	runStarted := map[string]time.Time{}
	for index, row := range rows {
		records[index] = voicelive.TaskRecord{
			Ordinal: row.Ordinal, StartedHere: row.StartedHere, Goal: row.Goal, Surface: row.Surface,
			Canceled: row.CanceledAt.Valid, Execution: row.ExecutionStatus,
		}
		if row.ReportID != "" {
			// The live voice coordinates the task: it gets the AlterEgo's own
			// words, without what a Meta is reminded to do with them.
			records[index].Report = &voicelive.TaskReport{
				ID: row.ReportID, Body: row.ReportBody, Delivered: row.ReportDelivered,
			}
		}
		if row.RunID != "" {
			runs = append(runs, row.RunID)
			runTask[row.RunID] = index
			runStarted[row.RunID] = row.RunCreatedAt.Time
		}
	}
	// The cards these tasks wait on that the user answers, by voice too.
	taskIndex := make(map[string]int, len(rows))
	taskIDs := make([]string, 0, len(rows))
	for index, row := range rows {
		taskIndex[row.WorkItemID] = index
		taskIDs = append(taskIDs, row.WorkItemID)
	}
	approvals, err := s.queries.ListVoiceLivePendingApprovals(ctx, store.ListVoiceLivePendingApprovalsParams{
		TaskIds: taskIDs, DeciderActorID: session.HumanActorID,
	})
	if err != nil {
		return nil, err
	}
	for _, approval := range approvals {
		if index, ok := taskIndex[approval.TaskID]; ok {
			records[index].Approvals = append(records[index].Approvals,
				voicelive.ApprovalFromView(approval.ID, approval.Kind, approval.View, approval.CardVersion))
		}
	}
	if len(runs) > 0 {
		progress, err := s.queries.ListRunProgressEvents(ctx, runs)
		if err != nil {
			return nil, err
		}
		events := make([]taskexecution.RunEvent, 0, len(progress))
		for _, row := range progress {
			events = append(events, taskexecution.RunEvent{RunID: row.LocalRunID, Type: row.EventType, Payload: row.Payload, At: row.CreatedAt.Time})
		}
		for _, runID := range runs {
			report := voicelive.RunProgress(time.Now(), voicelive.ProgressRun{ID: runID, CreatedAt: runStarted[runID]}, events)
			if steps, ok := report["recent_steps"].([]string); ok {
				records[runTask[runID]].Steps = steps
			}
			if runningFor, ok := report["running_for"].(string); ok {
				records[runTask[runID]].RunningFor = runningFor
			}
		}
	}
	views := make([]voicelive.TaskView, len(records))
	for index, record := range records {
		views[index] = voicelive.View(record)
	}
	return views, nil
}

// alterEgoContextKeyPrefix is the start of an Agent's Task context keys; the
// Task ID and the closing of the key follow it.
func alterEgoContextKeyPrefix(agentManagementID string) string {
	const placeholder = "workitem_0"
	key, err := agentruntimestate.EncodeContextRef(agentruntimestate.ContextRef{
		Kind: "alter_ego", AgentID: agentManagementID, TaskID: placeholder,
	})
	if err != nil {
		return "-"
	}
	return strings.TrimSuffix(key, placeholder+`"]`)
}

// startVoiceLiveTask starts the work as its own delegated Task of the Room's
// Agent, so several tasks run side by side. Irreversible work
// starts only from a confirmation the user gave in a later turn.
func (s *Service) startVoiceLiveTask(ctx context.Context, session voicelive.Session, request teamhubinternal.VoiceLiveToolCall) (string, error) {
	var args voicelive.StartTaskArguments
	if voicelive.DecodeArguments(request.Arguments, &args) != nil {
		return "", voicelive.ErrInvalid
	}
	goal := strings.TrimSpace(args.Goal)
	if goal == "" || utf8.RuneCountInString(goal) > voicelive.MaxTaskGoalRunes || !slices.Contains(voicelive.Surfaces, args.Surface) || request.CallId == "" {
		return "", voicelive.ErrInvalid
	}
	confirmationID := strings.TrimSpace(args.ConfirmationID)
	since := pgtype.Timestamptz{Time: time.Now().Add(-voicelive.ConfirmationValidFor), Valid: true}
	if confirmationID != "" {
		confirmed, err := s.queries.GetVoiceLiveConfirmation(ctx, store.GetVoiceLiveConfirmationParams{
			ID: confirmationID, VoiceSessionID: session.ID, Tool: voicelive.ToolStartTask, TurnID: request.TurnId, Since: since,
		})
		if errors.Is(err, pgx.ErrNoRows) {
			return voicelive.ErrorOutput("confirmation_invalid"), nil
		}
		if err != nil {
			return "", err
		}
		// The work done is exactly what the user heard and agreed to.
		goal, args.Surface = confirmed.Goal, confirmed.Surface
	} else if args.Irreversible {
		id := idgen.New("confirm")
		if err := s.queries.CreateVoiceLiveConfirmation(ctx, store.CreateVoiceLiveConfirmationParams{
			ID: id, VoiceSessionID: session.ID, TurnID: request.TurnId, Tool: voicelive.ToolStartTask,
			ArgumentsHash: id, Goal: goal, Surface: args.Surface,
		}); err != nil {
			return "", err
		}
		return voicelive.Output(map[string]string{"status": "needs_confirmation", "goal": goal, "confirmation_id": id}), nil
	}
	computer, err := s.queries.GetVoiceLiveAgentComputer(ctx, store.GetVoiceLiveAgentComputerParams{ActorID: session.Agent.ID, TenantID: session.TenantID})
	if errors.Is(err, pgx.ErrNoRows) || err == nil && computer.AgentManagementID == "" {
		return voicelive.ErrorOutput("agent_unavailable"), nil
	}
	if err != nil {
		return "", err
	}
	// With others in the call's Room, the task lives in the user's direct
	// Room with the Agent: only they see its replies and manage it.
	homeRoomID := session.RoomID
	humans, err := s.queries.CountVoiceLiveRoomHumans(ctx, session.RoomID)
	if err != nil {
		return "", err
	}
	if humans > 1 {
		direct, err := s.collaboration.OpenDirectRoom(ctx, session.AccountID, session.TenantID, session.Agent.ID)
		if err != nil {
			return "", err
		}
		// The direct Room event is published by its transaction.
		homeRoomID = direct.Room.Id
	}
	if args.Surface == voicelive.SurfaceWeb || args.Surface == voicelive.SurfaceDesktop {
		if computer.ComputerStatus != "online" {
			return voicelive.ErrorOutput("computer_offline"), nil
		}
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer tx.Rollback(ctx)
	queries := store.New(tx)
	// Numbering and repeats are per Room and user.
	if err := queries.AcquireAdvisoryTransactionLock(ctx, "voice-live-task|"+session.RoomID+"|"+session.HumanActorID); err != nil {
		return "", err
	}
	if ordinal, err := queries.FindVoiceLiveRepeatedTask(ctx, store.FindVoiceLiveRepeatedTaskParams{
		RoomID: session.RoomID, OwnerActorID: session.HumanActorID, Goal: goal,
		Since: pgtype.Timestamptz{Time: time.Now().Add(-voicelive.RepeatedTaskWithin), Valid: true},
	}); err == nil {
		return voicelive.Output(map[string]string{"status": "started", "task_id": voicelive.TaskID(ordinal)}), nil
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return "", err
	}
	if _, err := queries.LockActiveRoomForMutation(ctx, session.RoomID); errors.Is(err, pgx.ErrNoRows) {
		return voicelive.ErrorOutput("room_unavailable"), nil
	} else if err != nil {
		return "", err
	}
	// Counted under the per-Agent lock Task creation uses, so the cap holds.
	if err := queries.AcquireAdvisoryTransactionLock(ctx, "task-delegation|"+session.Agent.ID); err != nil {
		return "", err
	}
	running, err := queries.CountRunningDelegatedTasksForAgent(ctx, store.CountRunningDelegatedTasksForAgentParams{
		TenantID: session.TenantID, AgentActorID: session.Agent.ID,
	})
	if err != nil {
		return "", err
	}
	if running >= taskdelegation.MaxRunningTasks {
		return voicelive.ErrorOutput("too_many_tasks"), nil
	}
	// The confirmation is used only together with the Task it starts.
	if confirmationID != "" {
		if _, err := queries.UseVoiceLiveConfirmation(ctx, store.UseVoiceLiveConfirmationParams{
			ID: confirmationID, VoiceSessionID: session.ID, Tool: voicelive.ToolStartTask, TurnID: request.TurnId, Since: since,
		}); errors.Is(err, pgx.ErrNoRows) {
			return voicelive.ErrorOutput("confirmation_invalid"), nil
		} else if err != nil {
			return "", err
		}
	}
	sponsor, err := queries.GetActor(ctx, store.GetActorParams{ID: session.HumanActorID, TenantID: session.TenantID})
	if err != nil {
		return "", err
	}
	name := goal
	if runes := []rune(name); len(runes) > 120 {
		name = string(runes[:119]) + "…"
	}
	created, err := typedcard.CreateDelegatedTaskInTx(ctx, tx, queries, typedcard.DelegatedTaskInput{
		TenantID: session.TenantID, OriginRoomID: homeRoomID,
		Agent: session.Agent, AgentManagementID: computer.AgentManagementID, Sponsor: sponsor,
		Name: name, Requirement: voicelive.TaskRequirement(goal, args.Surface),
		SourceKey: "voice_live:" + session.ID + ":" + request.CallId,
		// The task stays out of the Room; its replies are posted as messages.
		Hidden: true,
	})
	if errors.Is(err, typedcard.ErrInvalid) {
		return "", voicelive.ErrInvalid
	}
	if err != nil {
		return "", err
	}
	ordinal, err := queries.CreateVoiceLiveTask(ctx, store.CreateVoiceLiveTaskParams{
		WorkItemID: created.TaskID, RoomID: session.RoomID, OwnerActorID: session.HumanActorID, HomeRoomID: homeRoomID,
		VoiceSessionID: session.ID, Goal: goal, Surface: args.Surface,
	})
	if err != nil {
		return "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", err
	}
	// Task creation publishes its wake transactionally.
	return voicelive.Output(map[string]string{"status": "started", "task_id": voicelive.TaskID(ordinal)}), nil
}

// replyToVoiceLiveTask gives the user's answer or change to the task's own
// Task, which continues from where it stopped.
func (s *Service) replyToVoiceLiveTask(ctx context.Context, session voicelive.Session, request teamhubinternal.VoiceLiveToolCall) (string, error) {
	var args voicelive.ReplyToTaskArguments
	if voicelive.DecodeArguments(request.Arguments, &args) != nil {
		return "", voicelive.ErrInvalid
	}
	details := strings.TrimSpace(args.Details)
	ordinal, ok := voicelive.TaskOrdinal(args.TaskID)
	if !ok || details == "" || utf8.RuneCountInString(details) > voicelive.MaxTaskGoalRunes {
		return "", voicelive.ErrInvalid
	}
	task, err := s.queries.GetVoiceLiveTask(ctx, store.GetVoiceLiveTaskParams{RoomID: session.RoomID, OwnerActorID: session.HumanActorID, Ordinal: ordinal})
	if errors.Is(err, pgx.ErrNoRows) {
		return voicelive.ErrorOutput("task_not_found"), nil
	}
	if err != nil {
		return "", err
	}
	if task.CanceledAt.Valid {
		return voicelive.ErrorOutput("task_canceled"), nil
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer tx.Rollback(ctx)
	if _, err := taskexecution.AppendTaskInput(ctx, store.New(tx), taskexecution.TaskInput{
		TaskID: task.WorkItemID, Cause: taskexecution.TaskInputSystem, Body: voicelive.TaskAnswer(details), Steer: true,
	}); errors.Is(err, taskexecution.ErrNotFound) {
		return voicelive.ErrorOutput("task_not_found"), nil
	} else if err != nil {
		return "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", err
	}
	return voicelive.Output(map[string]string{"status": "passed_on", "task_id": voicelive.TaskID(ordinal)}), nil
}

// cancelVoiceLiveTask stops the task's own Task; other tasks go on.
func (s *Service) cancelVoiceLiveTask(ctx context.Context, session voicelive.Session, request teamhubinternal.VoiceLiveToolCall) (string, error) {
	var args voicelive.CancelTaskArguments
	if voicelive.DecodeArguments(request.Arguments, &args) != nil {
		return "", voicelive.ErrInvalid
	}
	ordinal, ok := voicelive.TaskOrdinal(args.TaskID)
	if !ok {
		return "", voicelive.ErrInvalid
	}
	views, err := s.voiceLiveTaskViews(ctx, session)
	if err != nil {
		return "", err
	}
	index := slices.IndexFunc(views, func(view voicelive.TaskView) bool { return view.Ordinal == ordinal })
	if index < 0 {
		return voicelive.ErrorOutput("task_not_found"), nil
	}
	if views[index].State == voicelive.TaskCanceled {
		return voicelive.Output(map[string]string{"status": "canceled"}), nil
	}
	task, err := s.queries.GetVoiceLiveTask(ctx, store.GetVoiceLiveTaskParams{RoomID: session.RoomID, OwnerActorID: session.HumanActorID, Ordinal: ordinal})
	if err != nil {
		return "", err
	}
	if err := s.stopVoiceLiveTask(ctx, session.TenantID, task.WorkItemID, session.HumanActorID); err != nil {
		return "", err
	}
	return voicelive.Output(map[string]string{"status": "canceled"}), nil
}

// stopVoiceLiveTask cancels a voice task's Task and the approval cards it
// was waiting on, as a Meta's task stop does.
func (s *Service) stopVoiceLiveTask(ctx context.Context, tenantID, workItemID, actorID string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	queries := store.New(tx)
	if _, err := taskexecution.StopTask(ctx, queries, workItemID, actorID); err != nil && !errors.Is(err, taskexecution.ErrNotFound) {
		return err
	}
	if err := jobs.InsertTx(ctx, tx, typedcard.StoppedTaskApprovalsArgs{TenantID: tenantID, TaskID: workItemID}, nil); err != nil {
		return err
	}
	if _, err := queries.CancelVoiceLiveTask(ctx, workItemID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Service) listVoiceLiveTasks(ctx context.Context, session voicelive.Session, request teamhubinternal.VoiceLiveToolCall) (string, error) {
	var args voicelive.ProgressArguments
	if voicelive.DecodeArguments(request.Arguments, &args) != nil ||
		(args.Scope != "" && args.Scope != voicelive.ProgressScopeMyRequests && args.Scope != voicelive.ProgressScopeRoom) {
		return "", voicelive.ErrInvalid
	}
	roomID := strings.TrimSpace(args.RoomID)
	if roomID != "" && roomID != session.RoomID {
		// Another Room is reported only to its members.
		room, err := s.queries.GetRoomForAccount(ctx, store.GetRoomForAccountParams{ID: roomID, AccountID: textValue(session.AccountID)})
		if errors.Is(err, pgx.ErrNoRows) || err == nil && room.TenantID != session.TenantID {
			return voicelive.ErrorOutput("room_not_found"), nil
		}
		if err != nil {
			return "", err
		}
		return s.voiceLiveRoomProgress(ctx, session, room.ID)
	}
	if args.Scope == voicelive.ProgressScopeRoom {
		return s.voiceLiveRoomProgress(ctx, session, session.RoomID)
	}
	views, err := s.voiceLiveTaskViews(ctx, session)
	if err != nil {
		return "", err
	}
	// Longer work the Room's Meta passed to a background Task is listed too.
	background, err := s.queries.ListRoomBackgroundTasks(ctx, store.ListRoomBackgroundTasksParams{RoomID: session.RoomID, TenantID: session.TenantID})
	if err != nil {
		return "", err
	}
	tasks := make([]voicelive.ProgressTask, 0, len(background))
	for _, row := range background {
		tasks = append(tasks, voicelive.ProgressTask{Title: row.Title, Status: row.TaskExecutionStatus.String, CreatedAt: row.CreatedAt.Time})
	}
	output := voicelive.TaskListOutput(views)
	output["background_tasks"] = voicelive.TaskProgress(time.Now(), tasks)
	return voicelive.Output(output), nil
}

// LiveTasks lists the live call's Tasks and the event alerts waiting for it,
// and renews the call's foreground lease. Updates still arrive while the
// last answer of a just-closed call plays.
func (s *Service) LiveTasks(ctx context.Context, voiceSessionID string) (teamhubinternal.VoiceLiveTaskList, error) {
	// Updates still arrive while the last answer of a just-closed call plays.
	session, err := voicelive.ActiveSession(ctx, s.queries, voiceSessionID)
	if err != nil {
		return teamhubinternal.VoiceLiveTaskList{}, err
	}
	renewed, err := s.queries.RenewVoiceLiveLease(ctx, session.ID)
	if err != nil {
		return teamhubinternal.VoiceLiveTaskList{}, fmt.Errorf("renew live foreground: %w", err)
	}
	if renewed != 1 {
		return teamhubinternal.VoiceLiveTaskList{}, voicelive.ErrNotFound
	}
	views, err := s.voiceLiveTaskViews(ctx, session)
	if err != nil {
		return teamhubinternal.VoiceLiveTaskList{}, fmt.Errorf("read live Voice tasks: %w", err)
	}
	response := teamhubinternal.VoiceLiveTaskList{Tasks: make([]teamhubinternal.VoiceLiveTask, 0, len(views))}
	for _, view := range views {
		task := teamhubinternal.VoiceLiveTask{
			TaskId: voicelive.TaskID(view.Ordinal), Goal: view.Goal,
			Surface:           teamhubinternal.VoiceLiveTaskSurface(view.Surface),
			State:             teamhubinternal.VoiceLiveTaskState(view.State),
			Replies:           []teamhubinternal.VoiceLiveTaskReply{},
			StartedInThisCall: view.StartedHere,
		}
		if view.Report != nil {
			text, _ := voicelive.Truncate(view.Report.Body, 20000)
			task.Replies = append(task.Replies, teamhubinternal.VoiceLiveTaskReply{MessageId: view.Report.ID, Text: text, Delivered: &view.Report.Delivered})
		}
		response.Tasks = append(response.Tasks, task)
	}
	// Events proactive reminders judged worth telling now wait for this call
	// to end; the live voice tells them during the call instead.
	wakes, err := s.queries.ListVoiceLiveRoomPendingWakes(ctx, session.RoomID)
	if err != nil {
		return teamhubinternal.VoiceLiveTaskList{}, fmt.Errorf("read live Voice alerts: %w", err)
	}
	notify := reminder.Prompt(reminder.EventData, nil)
	alerts := []teamhubinternal.VoiceLiveAlert{}
	for _, wake := range wakes {
		if wake.Source != reminder.SourceEvent || wake.AgentActorID != session.Agent.ID || wake.TenantID != session.TenantID {
			continue
		}
		var grant *reminder.GrantReference
		if json.Unmarshal(wake.ConnectionGrant, &grant) != nil || grant == nil {
			continue
		}
		if err := grant.Check(ctx, s.queries); errors.Is(err, reminder.ErrGrantRevoked) {
			continue
		} else if err != nil {
			return teamhubinternal.VoiceLiveTaskList{}, fmt.Errorf("authorize live alert: %w", err)
		}
		text, _ := voicelive.Truncate(strings.TrimSpace(strings.TrimPrefix(wake.Body, notify)), 20000)
		alerts = append(alerts, teamhubinternal.VoiceLiveAlert{AlertId: wake.ID, Text: text})
	}
	if len(alerts) > 0 {
		response.Alerts = &alerts
	}
	return response, nil
}

// decideVoiceLiveApproval answers an approval card one of the user's tasks
// waits on, as its Approve or Deny button does, once the user said yes to
// exactly that answer in a later turn. Only the user's own pending cards on
// their tasks in this Room can be answered.
func (s *Service) decideVoiceLiveApproval(ctx context.Context, session voicelive.Session, request teamhubinternal.VoiceLiveToolCall) (string, error) {
	var args voicelive.ApprovalArguments
	if voicelive.DecodeArguments(request.Arguments, &args) != nil || strings.TrimSpace(args.ApprovalID) == "" ||
		args.Decision != "approve" && args.Decision != "deny" || utf8.RuneCountInString(args.Comment) > 2000 {
		return "", voicelive.ErrInvalid
	}
	views, err := s.voiceLiveTaskViews(ctx, session)
	if err != nil {
		return "", err
	}
	for _, view := range views {
		for _, approval := range view.Approvals {
			if approval.ID != strings.TrimSpace(args.ApprovalID) {
				continue
			}
			taskID, comment := voicelive.TaskID(view.Ordinal), strings.TrimSpace(args.Comment)
			summary := voicelive.ApprovalSummary(taskID, approval, args.Decision)
			ok, err := s.voiceLiveConfirmed(ctx, session, request, bool(args.Confirmed),
				fmt.Sprintf("%s\x00%s\x00%d\x00%s", summary, approval.ID, approval.Version, comment))
			if err != nil {
				return "", err
			}
			if !ok {
				return voicelive.NeedsConfirmation(summary), nil
			}
			_, err = s.typedCards.DecideDecision(ctx, session.AccountID, approval.ID, typedcard.DecisionAnswerCommand{
				ExpectedVersion: approval.Version, Decision: args.Decision, Comment: comment,
			})
			switch {
			case errors.Is(err, typedcard.ErrConflict):
				return voicelive.ErrorOutput("approval_changed"), nil
			case errors.Is(err, typedcard.ErrNotFound), errors.Is(err, typedcard.ErrForbidden):
				return voicelive.ErrorOutput("approval_not_found"), nil
			case errors.Is(err, typedcard.ErrInvalid):
				return "", voicelive.ErrInvalid
			case err != nil:
				return "", err
			}
			status := "approved"
			if args.Decision == "deny" {
				status = "denied"
			}
			return voicelive.Output(map[string]string{"status": status, "task_id": taskID}), nil
		}
	}
	return voicelive.ErrorOutput("approval_not_found"), nil
}
