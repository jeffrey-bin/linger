package externalsource

import (
	"context"

	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/jobs"
)

// CompleteConnectionAuthorization checks at once the authorization a returning
// OAuth popup may have finished: the pending connection or reauthorization
// whose upstream is upstreamID, or every pending one of the account when the
// popup did not name its upstream. Composio's account status decides the
// outcome; the callback only makes the checks due.
func (s *Service) CompleteConnectionAuthorization(ctx context.Context, accountID, upstreamID string) error {
	if accountID == "" {
		return ErrInvalid
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	rows, err := tx.Query(ctx, `UPDATE external_connections SET next_status_check_at=now() WHERE account_id=$1 AND status='pending' AND ($2='' OR upstream_connection_id=$2) RETURNING id`, accountID, upstreamID)
	if err != nil {
		return err
	}
	connections, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return err
	}
	rows, err = tx.Query(ctx, `SELECT id FROM external_connections WHERE account_id=$1 AND reauthorization_upstream_id IS NOT NULL AND ($2='' OR reauthorization_upstream_id=$2)`, accountID, upstreamID)
	if err != nil {
		return err
	}
	reauthorizations, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return err
	}
	if upstreamID != "" && len(connections) == 0 && len(reauthorizations) == 0 {
		return ErrNotFound
	}
	for _, id := range connections {
		if err = jobs.InsertOrWakeTx(ctx, tx, ConnectionReconcileArgs{ConnectionID: id}, nil); err != nil {
			return err
		}
	}
	for _, id := range reauthorizations {
		if err = jobs.InsertOrWakeTx(ctx, tx, ReauthorizationArgs{ConnectionID: id}, nil); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}
