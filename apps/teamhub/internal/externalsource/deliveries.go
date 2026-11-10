package externalsource

import (
	"context"

	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/account"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

const externalConnectionsChanged = "tenant.external-connections.changed"

// commitAccountExternalConnectionsChange commits tx and tells the Account's
// Space that its connections changed.
func (s *Service) commitAccountExternalConnectionsChange(ctx context.Context, tx pgx.Tx, accountID string) error {
	tenantID, err := accountSpaceID(ctx, tx, accountID)
	if err != nil {
		return err
	}
	if err := account.PublishTenantChange(ctx, store.New(tx), tenantID, externalConnectionsChanged); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Service) commitAccountExternalConnectionsMutation(
	ctx context.Context,
	accountID string,
	mutate func(pgx.Tx) (bool, error),
) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	changed, err := mutate(tx)
	if err != nil {
		return err
	}
	if !changed {
		return tx.Commit(ctx)
	}
	return s.commitAccountExternalConnectionsChange(ctx, tx, accountID)
}
