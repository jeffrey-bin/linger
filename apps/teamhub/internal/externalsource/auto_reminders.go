package externalsource

import (
	"context"

	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/proactive"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

// SetAutoRemindersTx is the one write path of the auto reminders switch for
// both the Human and the Agent API: the column and the listener Routines
// change in the caller's transaction.
func (s *Service) SetAutoRemindersTx(ctx context.Context, tx pgx.Tx, accountID, connectionID string, enabled bool) error {
	if err := s.SetAutoRemindersInTx(ctx, tx, accountID, connectionID, enabled); err != nil {
		return err
	}
	return proactive.SyncConnectionListenersTx(ctx, tx, store.New(tx), connectionID, enabled)
}

// SetAutoReminders switches the auto reminders of an Account-owned connection
// in its own transaction.
func (s *Service) SetAutoReminders(ctx context.Context, accountID, connectionID string, enabled bool) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err := s.SetAutoRemindersTx(ctx, tx, accountID, connectionID, enabled); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
