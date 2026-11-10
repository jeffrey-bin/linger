package collaboration

import (
	"context"
	"errors"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

// ErrReadCursorAhead reports a read cursor past the Room's committed sequence.
var ErrReadCursorAhead = errors.New("read cursor exceeds committed Room sequence")

// UpdateRoomReadState advances the Human's read cursor of a Room.
func (s *Service) UpdateRoomReadState(ctx context.Context, accountID, roomID string, throughRoomSeq int64) (httpapi.RoomReadState, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return httpapi.RoomReadState{}, err
	}
	defer tx.Rollback(ctx)
	queries := s.queries.WithTx(tx)
	authority, err := queries.GetRoomReadStateAuthority(ctx, store.GetRoomReadStateAuthorityParams{
		ID: roomID, AccountID: textValue(accountID),
	})
	if err != nil {
		return httpapi.RoomReadState{}, err
	}
	if throughRoomSeq > authority.NextRoomSeq {
		return httpapi.RoomReadState{}, ErrReadCursorAhead
	}
	state, err := queries.AdvanceRoomMemberReadState(ctx, store.AdvanceRoomMemberReadStateParams{
		RoomID: roomID, ActorID: authority.ActorID, ReadThroughRoomSeq: throughRoomSeq,
	})
	if err != nil {
		return httpapi.RoomReadState{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return httpapi.RoomReadState{}, err
	}
	return httpapi.RoomReadState{
		RoomId: roomID, ReadThroughRoomSeq: state.ReadThroughRoomSeq, UpdatedAt: state.UpdatedAt.Time,
	}, nil
}
