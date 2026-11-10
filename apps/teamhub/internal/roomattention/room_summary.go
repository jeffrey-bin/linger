// Package roomattention tells the Tenant's browsers that a Room's list
// summary changed. The hint is identity-only: each browser
// refetches the Room through its own authorized reads.
package roomattention

import (
	"context"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/realtime"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

// RoomSummaryUpdate names the Room whose summary changed and the room_seq the
// change is visible at. Reason documents the call site; the hint omits it.
type RoomSummaryUpdate struct {
	TenantID string
	RoomID   string
	RoomSeq  int64
	Reason   string
}

// AppendForTenantHumans publishes a room hint after commit for a change that
// a Room Event alone does not announce.
func AppendForTenantHumans(ctx context.Context, queries *store.Queries, update RoomSummaryUpdate) error {
	return realtime.Invalidate(ctx, queries, realtime.Invalidation{
		TenantID: update.TenantID, Resource: realtime.InvalidateRoom, ID: update.RoomID, RoomSeq: update.RoomSeq,
	})
}
