package typedcard

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/jobs"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/messagecreation"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

// alterEgoApprovalTTL is how long a delegated Task's AlterEgo waits for the
// Sponsor on a decision. Expiring is one of the decision's results:
// it wakes the AlterEgo like an approval or a refusal.
const alterEgoApprovalTTL = 10 * time.Minute

// StoppedTaskApprovalsArgs expires the cards a stopped Task's AlterEgo was
// waiting on. Stopping locks the Task, and expiring a card locks it the way a
// decision does, so the stop only enqueues this job.
type StoppedTaskApprovalsArgs struct {
	TenantID string `json:"tenant_id"`
	TaskID   string `json:"task_id"`
}

func (StoppedTaskApprovalsArgs) Kind() string { return "task_delegation.expire_stopped_approvals" }

func (StoppedTaskApprovalsArgs) InsertOpts() river.InsertOpts {
	return river.InsertOpts{Queue: jobs.QueueDefault, MaxAttempts: 5}
}

// ExpireStoppedTaskApprovals expires the approvals a stopped Task's AlterEgo
// was waiting on. It wakes nobody: the Task is canceled, and the Meta's next
// task send tells the AlterEgo what changed. Connection and Document access
// cards are left to run their course.
func (s *Service) ExpireStoppedTaskApprovals(ctx context.Context, tenantID, taskID string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	rows, err := tx.Query(ctx, `UPDATE decisions SET status='expired', finished_at=clock_timestamp()
 WHERE tenant_id=$1 AND alter_ego_task_id=$2 AND status='pending'
  AND kind NOT IN ('connection_auth','provider_key','browser_connection')
 RETURNING decider_actor_id, message_id`, tenantID, taskID)
	if err != nil {
		return err
	}
	type expiredCard struct{ DeciderID, MessageID string }
	expired, err := pgx.CollectRows(rows, pgx.RowToStructByPos[expiredCard])
	if err != nil {
		return err
	}
	queries := store.New(tx)
	for _, card := range expired {
		if err := messagecreation.AdvanceCards(ctx, queries, tenantID, card.DeciderID, []string{card.MessageID}); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}
