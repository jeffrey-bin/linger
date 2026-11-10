package agentruntimestate

import (
	"context"
	"errors"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

// RuntimeInteractionAuthority is who answers a native Runtime question of a
// live Context and whether its Run may still ask.
type RuntimeInteractionAuthority struct {
	SponsorActorID string
	RuntimeType    string
	Running        bool
}

// InteractionAuthority reads the authority of a native Runtime question. It
// reports pgx.ErrNoRows when the Context is terminated or unknown.
func (s *Service) InteractionAuthority(ctx context.Context, contextKey, runID string) (RuntimeInteractionAuthority, error) {
	row, err := store.New(s.pool).GetRuntimeInteractionAuthority(ctx, store.GetRuntimeInteractionAuthorityParams{
		ContextKey: contextKey, RunID: runID,
	})
	if err != nil {
		return RuntimeInteractionAuthority{}, err
	}
	if !row.LocalRuntimeType.Valid {
		return RuntimeInteractionAuthority{}, errors.New("Agent registration has no Runtime type")
	}
	return RuntimeInteractionAuthority{
		SponsorActorID: row.CreatedByActorID, RuntimeType: row.LocalRuntimeType.String, Running: row.Running,
	}, nil
}
