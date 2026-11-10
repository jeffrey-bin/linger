package taskexecution

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

// CoordinatorProgress is what a Meta's Task progress check reads: whether
// Live holds the Meta's foreground, when its Agent last spoke in its Room,
// and every Task it coordinates that is still at work.
type CoordinatorProgress struct {
	// LiveForeground is set while a Live call coordinates the Meta's work;
	// nothing else is read then.
	LiveForeground bool
	// AgentLastSpokeAt is nil when the Agent never spoke in the Room.
	AgentLastSpokeAt *time.Time
	Tasks            []ActiveTask
}

// ActiveTask is one coordinated Task that is running or waiting for an
// approval.
type ActiveTask struct {
	TaskID, Title, Status string
	StatusSince           time.Time
	PendingApprovals      int
	// LastReportAt is nil before the Task's first report.
	LastReportAt *time.Time
	// LatestStep is the newest step title its latest Run reported, if any.
	LatestStep *RunStep
}

// ReadCoordinatorProgress reads the progress of the Tasks one Meta Context
// coordinates. ErrNotFound means the key names no Meta Context.
func ReadCoordinatorProgress(ctx context.Context, queries *store.Queries, contextKey string) (CoordinatorProgress, error) {
	meta, err := queries.GetAgentExecutionContext(ctx, contextKey)
	if errors.Is(err, pgx.ErrNoRows) || err == nil && (meta.ContextKind != "meta" || !meta.RoomID.Valid) {
		return CoordinatorProgress{}, ErrNotFound
	}
	if err != nil {
		return CoordinatorProgress{}, err
	}
	live, err := queries.VoiceLiveOwnsContext(ctx, contextKey)
	if err != nil || live {
		return CoordinatorProgress{LiveForeground: live}, err
	}
	rows, err := queries.ListCoordinatorActiveTasks(ctx, store.ListCoordinatorActiveTasksParams{
		TenantID: meta.TenantID, CoordinatorContextKey: contextKey,
	})
	if err != nil || len(rows) == 0 {
		return CoordinatorProgress{}, err
	}
	var progress CoordinatorProgress
	spoke, err := queries.GetActorLastRoomMessageAt(ctx, store.GetActorLastRoomMessageAtParams{
		RoomID: meta.RoomID.String, ActorID: meta.AgentActorID,
	})
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return CoordinatorProgress{}, err
	}
	if spoke.Valid {
		progress.AgentLastSpokeAt = &spoke.Time
	}
	var runIDs []string
	for _, row := range rows {
		if row.RunID != "" {
			runIDs = append(runIDs, row.RunID)
		}
	}
	var events []RunEvent
	if len(runIDs) > 0 {
		eventRows, err := queries.ListRunProgressEvents(ctx, runIDs)
		if err != nil {
			return CoordinatorProgress{}, err
		}
		for _, row := range eventRows {
			events = append(events, RunEvent{RunID: row.LocalRunID, Type: row.EventType, Payload: row.Payload, At: row.CreatedAt.Time, OutputBody: row.OutputBody})
		}
	}
	for _, row := range rows {
		view, err := ReadTask(ctx, queries, row.TaskID)
		if errors.Is(err, ErrNotFound) {
			continue
		}
		if err != nil {
			return CoordinatorProgress{}, err
		}
		// The Task may have settled since it was listed.
		if view.Status != "running" && view.Status != "waiting_for_approval" {
			continue
		}
		task := ActiveTask{
			TaskID: row.TaskID, Title: row.Title, Status: view.Status,
			StatusSince: view.StatusSince, PendingApprovals: len(view.PendingApprovals),
		}
		if view.LastReport != nil {
			task.LastReportAt = &view.LastReport.At
		}
		if row.RunID != "" {
			if steps := ReadRunActivity(row.RunID, events).Steps; len(steps) > 0 {
				task.LatestStep = &steps[len(steps)-1]
			}
		}
		progress.Tasks = append(progress.Tasks, task)
	}
	return progress, nil
}
