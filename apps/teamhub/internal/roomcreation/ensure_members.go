package roomcreation

import (
	"context"
	"sort"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

// LockMembership serializes membership reads and writes with the Human Room API.
func LockMembership(ctx context.Context, queries *store.Queries, roomID string) error {
	if roomID == "" {
		return ErrInvalid
	}
	return queries.AcquireAdvisoryTransactionLock(ctx, "room-membership|"+roomID)
}

// LockMemberships acquires multiple Room membership locks in canonical order.
// Every transaction that can hold more than one membership lock must use this
// helper so concurrent operations cannot form a cyclic wait.
func LockMemberships(ctx context.Context, queries *store.Queries, roomIDs ...string) error {
	ids := append([]string(nil), roomIDs...)
	sort.Strings(ids)
	for index, roomID := range ids {
		if roomID == "" {
			return ErrInvalid
		}
		if index > 0 && roomID == ids[index-1] {
			continue
		}
		if err := LockMembership(ctx, queries, roomID); err != nil {
			return err
		}
	}
	return nil
}
