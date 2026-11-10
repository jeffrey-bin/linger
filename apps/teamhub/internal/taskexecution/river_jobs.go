package taskexecution

import (
	"context"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/jobs"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

// ParticipantRunFinishedArgs makes a running Task due after one of its
// participant Local Runs turned terminal. Only the agent_local_runs trigger
// enqueue_task_due_on_participant_run_terminal inserts it, mirroring these
// options.
type ParticipantRunFinishedArgs struct {
	TaskID string `json:"task_id"`
}

// Kind names the job in river_job.
func (ParticipantRunFinishedArgs) Kind() string { return "task_execution.participant_run_finished" }

// InsertOpts matches the trigger's insert.
func (ParticipantRunFinishedArgs) InsertOpts() river.InsertOpts {
	return river.InsertOpts{Queue: jobs.QueueDefault, MaxAttempts: 25}
}

// AddJobWorkers registers the Task jobs. The trigger enqueues them whenever a
// participant Run finishes, so every TeamHub process must register them.
func AddJobWorkers(workers *river.Workers, pool *pgxpool.Pool) {
	river.AddWorker(workers, &participantRunFinishedWorker{pool: pool})
}

type participantRunFinishedWorker struct {
	river.WorkerDefaults[ParticipantRunFinishedArgs]
	pool *pgxpool.Pool
}

// Work holds only the Task row lock, taken after the Run transaction
// committed, so it cannot join a lock cycle.
func (w *participantRunFinishedWorker) Work(ctx context.Context, job *river.Job[ParticipantRunFinishedArgs]) error {
	_, err := store.New(w.pool).MakeRunningTaskDue(ctx, job.Args.TaskID)
	return err
}
