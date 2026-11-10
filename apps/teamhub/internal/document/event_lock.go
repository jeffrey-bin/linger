// Lock takes the Document event locks in the canonical order.
//
// Lock order is fixed: advisory locks -> Task -> Room memberships (sorted by
// Actor) -> agent execution Contexts -> rooms (sorted) -> Document advisory
// locks (sorted, taken here). A room_members insert or delete locks its Room
// and the Room's bound Documents in a trigger, so any membership lock must
// come before the first membership write. Exception: the room-mutation fence
// (store.LockActiveRoomForMutation, shared) is a final commit gate taken after
// a writer's row locks; Room deletion takes it exclusively just before its
// rooms write. A transaction that writes Room state and later needs Document
// locks deadlocks against Document event inserts, so callers lock their
// complete Room set before calling Lock.
//
// A transaction never upgrades a documents row lock after it has taken a
// Document advisory lock. Documents rows are locked FOR NO KEY UPDATE, which
// leaves FK child inserts (KEY SHARE) unblocked. Paths that transition lifecycle
// (trash, restore, archive, corruption retirement) or depend on child inserts
// keep FOR UPDATE and take it before any Document advisory lock.

package document

import (
	"context"

	"github.com/jackc/pgx/v5/pgconn"
)

type execer interface {
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
}

// Lock takes the advisory Document locks for documentIDs in sorted order. The
// SQL function is idempotent within a transaction, so it is safe to call again
// for Documents already locked.
func Lock(ctx context.Context, tx execer, documentIDs []string) error {
	if len(documentIDs) == 0 {
		return nil
	}
	_, err := tx.Exec(ctx, `SELECT lock_document_event_scopes($1::text[])`, documentIDs)
	return err
}
