package proactive

import (
	"context"
	"errors"
	"fmt"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

// SweepListeners gives each listenable connection a Human granted to their
// AnotherMe one listener Routine, so its new events reach proactive
// judgement.
func (s *Service) SweepListeners(ctx context.Context) error {
	missing, err := store.New(s.pool).ListAnotherMeConnectionsWithoutListener(ctx, store.ListAnotherMeConnectionsWithoutListenerParams{
		Providers: ListenerProviders(), RoutineKeyPrefix: ListenerRoutineKey + ":",
	})
	if err != nil {
		return err
	}
	var failed error
	for _, row := range missing {
		if err := SweepInstallListener(ctx, s.pool, row); err != nil {
			failed = errors.Join(failed, fmt.Errorf("AnotherMe %s connection %s: %w", row.AgentActorID, row.ConnectionID, err))
		}
	}
	return failed
}
