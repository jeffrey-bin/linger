package app

import (
	"context"
	"errors"

	"github.com/riverqueue/river"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/taskdelegation"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/typedcard"
)

// wakeTaskWithSystemInput gives a delegated Task's AlterEgo a card result
// through the Task input path: it wakes a Task that is not
// running, or queues as the running Task's next turn.
func (a *App) wakeTaskWithSystemInput(ctx context.Context, agentID, taskID, notice string) error {
	_, err := a.taskDelegation.SendSystemInput(ctx, agentID, taskID, notice)
	if errors.Is(err, taskdelegation.ErrNotFound) {
		// The Task is archived or gone; nobody is waiting for the result.
		return nil
	}
	return err
}

// stoppedTaskApprovalsWorker expires the decisions a stopped Task's AlterEgo
// was waiting on, without waking it.
type stoppedTaskApprovalsWorker struct {
	river.WorkerDefaults[typedcard.StoppedTaskApprovalsArgs]
	app *App
}

func (w *stoppedTaskApprovalsWorker) Work(ctx context.Context, job *river.Job[typedcard.StoppedTaskApprovalsArgs]) error {
	return w.app.typedCards.ExpireStoppedTaskApprovals(ctx, job.Args.TenantID, job.Args.TaskID)
}
