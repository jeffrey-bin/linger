package roomcreation

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/roomattention"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/roomevent"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

// FinalizeDeletion commits room.deleted only after every membership is
// revoked, and reports whether it did. The caller commits the
// surrounding transaction.
func FinalizeDeletion(ctx context.Context, tx pgx.Tx, roomID string, deletedAt time.Time) (bool, error) {
	queries := store.New(tx)
	room, err := queries.GetDeletingRoomForUpdate(ctx, roomID)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	pending, err := queries.HasUnfinalizedRoomMembershipsForDeletion(ctx, roomID)
	if err != nil {
		return false, err
	}
	if pending {
		return false, nil
	}
	if !room.DeletionStartedByActorID.Valid {
		return false, errors.New("deleting Room is missing deletion identity")
	}
	seq, err := roomevent.Append(ctx, queries, roomevent.Input{
		TenantID: room.TenantID, RoomID: roomID, EventType: "room.deleted",
		ActorID: room.DeletionStartedByActorID.String, ResourceID: roomID,
		Payload: map[string]any{"kind": "room.deleted", "room_id": roomID, "deleted_at": deletedAt},
		// A deleting Room still allocates; room.deleted has one identity per Room.
		Allocation: roomevent.DeletingRoomSeq, EventID: stableID("room-deleted-event", roomID),
	})
	if err != nil {
		return false, err
	}
	if err := roomattention.AppendForTenantHumans(ctx, queries, roomattention.RoomSummaryUpdate{
		TenantID: room.TenantID, RoomID: roomID, RoomSeq: seq, Reason: "membership.changed",
	}); err != nil {
		return false, err
	}
	if _, err := queries.FinalizeRoomDeletion(ctx, store.FinalizeRoomDeletionParams{
		DeletedAt: pgtype.Timestamptz{Time: deletedAt, Valid: true}, RoomID: roomID,
	}); err != nil {
		return false, err
	}
	return true, nil
}

func stableID(namespace, value string) string {
	digest := sha256.Sum256([]byte(namespace + ":" + value))
	return "event_" + hex.EncodeToString(digest[:16])
}
