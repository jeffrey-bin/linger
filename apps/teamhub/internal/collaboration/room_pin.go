package collaboration

import (
	"context"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

// UpdateRoomPin records a pin private to the Human; repeating a pin keeps its original time.
func (s *Service) UpdateRoomPin(ctx context.Context, accountID, roomID string, pinned bool) (httpapi.RoomPinState, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return httpapi.RoomPinState{}, err
	}
	defer tx.Rollback(ctx)
	queries := s.queries.WithTx(tx)
	authority, err := queries.GetRoomReadStateAuthority(ctx, store.GetRoomReadStateAuthorityParams{
		ID: roomID, AccountID: textValue(accountID),
	})
	if err != nil {
		return httpapi.RoomPinState{}, err
	}
	row, err := queries.SetRoomMemberPin(ctx, store.SetRoomMemberPinParams{
		RoomID: roomID, ActorID: authority.ActorID, Pinned: pinned,
	})
	if err != nil {
		return httpapi.RoomPinState{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return httpapi.RoomPinState{}, err
	}
	state := httpapi.RoomPinState{RoomId: row.RoomID}
	if row.PinnedAt.Valid {
		pinnedAt := row.PinnedAt.Time
		state.PinnedAt = &pinnedAt
	}
	return state, nil
}
