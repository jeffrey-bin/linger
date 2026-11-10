// Package tenantmembership holds the advisory locks that serialize Room
// admission with Agent authority changes.
//
// Lock order: Room membership locks (roomcreation.LockMemberships), then Agent
// locks, then row locks. A path that learns which Agents it admits only after
// it holds Room locks takes their Agent locks then, never the reverse.
package tenantmembership

import (
	"context"
	"errors"
	"slices"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

var ErrInvalidTenant = errors.New("Tenant ID is required")

// Lock takes the Space-wide advisory lock. Only Work Item creation takes it;
// Room admission serializes on Agent locks instead.
func Lock(ctx context.Context, queries *store.Queries, tenantID string) error {
	if tenantID == "" {
		return ErrInvalidTenant
	}
	return queries.AcquireAdvisoryTransactionLock(ctx, "tenant-membership|"+tenantID)
}

// LockAgent takes the authority lock of one Agent for the current
// transaction. Its creation, its deletion and every admission into a Room take
// it, so a deleting Agent's Room scan cannot miss a concurrent admission.
func LockAgent(ctx context.Context, queries *store.Queries, agentActorID string) error {
	return queries.AcquireAdvisoryTransactionLock(ctx, "agent-authority|"+agentActorID)
}

// LockAgents takes LockAgent for each Actor in id order. Callers may pass
// member candidates whose kind is not known yet; a Human Actor's key then
// serializes only admissions of that Human.
func LockAgents(ctx context.Context, queries *store.Queries, actorIDs ...string) error {
	ids := slices.Clone(actorIDs)
	slices.Sort(ids)
	for _, actorID := range slices.Compact(ids) {
		if actorID == "" {
			continue
		}
		if err := LockAgent(ctx, queries, actorID); err != nil {
			return err
		}
	}
	return nil
}
