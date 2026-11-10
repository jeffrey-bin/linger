package reminder

import (
	"context"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

// HumanOwner resolves the Human whose Memory tracks items. It reports
// pgx.ErrNoRows for an Actor that is not a Human.
func (s *TrackingService) HumanOwner(ctx context.Context, actorID string) (TrackingOwner, error) {
	tenantID, err := store.New(s.pool).GetHumanActorTenantID(ctx, actorID)
	if err != nil {
		return TrackingOwner{}, err
	}
	return TrackingOwner{TenantID: tenantID, ActorID: actorID}, nil
}
