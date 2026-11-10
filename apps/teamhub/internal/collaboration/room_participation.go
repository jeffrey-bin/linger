package collaboration

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/roomcreation"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/roomevent"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

// ErrRoomParticipationLeft reports a Human who left the Room.
var ErrRoomParticipationLeft = errors.New("rejoin the Room before sending messages")

// SetRoomParticipation leaves or rejoins an ordinary Room. Repeating the
// current status changes nothing.
func (s *Service) SetRoomParticipation(ctx context.Context, accountID, roomID string, input httpapi.RoomParticipationRequest) (httpapi.Room, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return httpapi.Room{}, err
	}
	defer tx.Rollback(ctx)
	queries := s.queries.WithTx(tx)
	if err := roomcreation.LockMembership(ctx, queries, roomID); err != nil {
		return httpapi.Room{}, err
	}
	room, err := queries.GetRoomForAccount(ctx, store.GetRoomForAccountParams{ID: roomID, AccountID: textValue(accountID)})
	if err != nil {
		return httpapi.Room{}, err
	}
	if room.DeletionStartedAt.Valid {
		return httpapi.Room{}, pgx.ErrNoRows
	}
	if err := rejectImmutableRoomSubtype(ctx, queries, roomID); err != nil {
		return httpapi.Room{}, err
	}
	caller, err := queries.GetHumanActor(ctx, store.GetHumanActorParams{TenantID: room.TenantID, AccountID: textValue(accountID)})
	if err != nil {
		return httpapi.Room{}, err
	}
	hasLeft, err := queries.GetRoomParticipationForAccount(ctx, store.GetRoomParticipationForAccountParams{ID: roomID, AccountID: textValue(accountID)})
	if err != nil {
		return httpapi.Room{}, err
	}
	nextLeft := input.Status == "left"
	if hasLeft.Bool != nextLeft {
		seq, err := roomevent.Append(ctx, queries, roomevent.Input{
			TenantID: room.TenantID, RoomID: roomID, EventType: "room.participation.changed",
			ActorID: caller.ID, ResourceID: caller.ID,
			Payload: map[string]any{"kind": "room.participation.changed", "actor_id": caller.ID, "status": input.Status},
		})
		if err != nil {
			return httpapi.Room{}, err
		}
		if err := queries.SetRoomParticipation(ctx, store.SetRoomParticipationParams{RoomID: roomID, ActorID: caller.ID, RoomSeq: seq, HasLeft: nextLeft}); err != nil {
			return httpapi.Room{}, err
		}
		if err := queries.SetThreadParticipationReadStates(ctx, store.SetThreadParticipationReadStatesParams{RoomID: roomID, ActorID: caller.ID, HasLeft: nextLeft}); err != nil {
			return httpapi.Room{}, err
		}
	}
	creator, err := queries.GetActor(ctx, store.GetActorParams{ID: room.CreatedByActorID, TenantID: room.TenantID})
	if err != nil {
		return httpapi.Room{}, err
	}
	model := roomModel(room, creator)
	model.Participation = &input.Status
	if err := tx.Commit(ctx); err != nil {
		return httpapi.Room{}, err
	}
	return model, nil
}

func roomParticipationAllowed(ctx context.Context, queries *store.Queries, accountID, roomID string) bool {
	left, err := queries.GetRoomParticipationForAccount(ctx, store.GetRoomParticipationForAccountParams{ID: roomID, AccountID: textValue(accountID)})
	return err == nil && left.Valid && !left.Bool
}
