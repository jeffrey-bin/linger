package typedcard

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/idempotency"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

func lockCreateReplayByRoomAgent(
	ctx context.Context,
	tx pgx.Tx,
	roomID string,
	agentManagementID string,
	operation string,
	idempotencyKey string,
	requestHash []byte,
) (store.GetRoomAgentMessageAuthorityRow, CreateResult, bool, error) {
	queries := store.New(tx)
	var authority store.GetRoomAgentMessageAuthorityRow
	if err := queries.AcquireAdvisoryTransactionLock(ctx, "room-membership|"+roomID); err != nil {
		return authority, CreateResult{}, false, err
	}
	authority, err := queries.GetRoomAgentMessageAuthority(ctx, store.GetRoomAgentMessageAuthorityParams{
		RoomID: roomID, AgentManagementID: agentManagementID,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return authority, CreateResult{}, false, ErrNotFound
	}
	if err != nil {
		return authority, CreateResult{}, false, err
	}
	if err := idempotency.Lock(ctx, tx, idempotency.AgentKey(authority.AgentID, operation, idempotencyKey)); err != nil {
		return authority, CreateResult{}, false, err
	}
	replay, found, replayErr := lookupReplay(ctx, tx, authority.AgentID, operation, idempotencyKey, requestHash)
	return authority, replay, found, replayErr
}
