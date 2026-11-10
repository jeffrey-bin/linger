package reminder

// Connection grant references recheck the current authority behind queued app
// data.

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

// ErrGrantRevoked reports that the grant behind queued data no longer admits
// it.
var ErrGrantRevoked = errors.New("connection grant is no longer authorized")

// GrantReference is the exact grant generation that admitted the data. Regranting
// access must not revive events admitted under an earlier generation.
type GrantReference struct {
	ID           string `json:"id"`
	Revision     int64  `json:"revision"`
	ConnectionID string `json:"connection_id"`
	AgentActorID string `json:"agent_actor_id"`
	TenantID     string `json:"tenant_id"`
}

// Check locks the granted connection and returns ErrGrantRevoked unless the
// grant generation still matches.
func (r *GrantReference) Check(ctx context.Context, queries *store.Queries) error {
	if r == nil || r.ID == "" || r.Revision < 1 {
		return ErrGrantRevoked
	}
	current, err := queries.LockGrantedConnectionForListener(ctx, store.LockGrantedConnectionForListenerParams{
		ConnectionID: r.ConnectionID, AgentActorID: r.AgentActorID, TenantID: r.TenantID,
	})
	if errors.Is(err, pgx.ErrNoRows) || err == nil && (current.GrantID != r.ID || current.GrantRevision != r.Revision) {
		return ErrGrantRevoked
	}
	return err
}
