package reminder

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentcredential"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/idempotency"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

// Caller is the Human or Agent a Routine write runs for.
type Caller struct {
	accountID string
	agent     Authority
}

// HumanCaller writes for the Human of an Account, who must still be an active
// member of the Routine's Room when the write runs.
func HumanCaller(accountID string) Caller { return Caller{accountID: accountID} }

// AgentCaller writes for an Agent admitted to one Room. Its credential and
// membership are rechecked when the write runs, even for a replay; an
// Authority without a Principal comes from a trusted internal caller.
func AgentCaller(authority Authority) Caller { return Caller{agent: authority} }

func (c Caller) isAgent() bool { return c.accountID == "" }

// replayKey deduplicates an Agent's write by its invocation key. A Human's
// write is not deduplicated.
func (c Caller) replayKey(operation, key string) idempotency.Key {
	if !c.isAgent() {
		return idempotency.Key{}
	}
	return idempotency.AgentKey(c.agent.ActorID, operation, key)
}

// routineRoom is the Room a write on routineID authorizes in. An Agent acts
// only in its admitted Room; a Routine elsewhere is not found when locked.
func (c Caller) routineRoom(ctx context.Context, queries *store.Queries, routineID string) (string, error) {
	if c.isAgent() {
		return c.agent.RoomID, nil
	}
	roomID, err := queries.GetRoomReminderRoomID(ctx, routineID)
	return roomID, notFound(err)
}

// authorize resolves the caller's authority in roomID inside the write. The
// membership lock comes before the Room fence, the shared lock order, so a
// member removed while the request waited is seen.
func (c Caller) authorize(ctx context.Context, tx pgx.Tx, queries *store.Queries, roomID string) (Authority, error) {
	if c.isAgent() && roomID != c.agent.RoomID {
		return Authority{}, ErrNotFound
	}
	if c.isAgent() && c.agent.Principal == nil {
		return c.agent, nil
	}
	if err := queries.AcquireAdvisoryTransactionLock(ctx, "room-membership|"+roomID); err != nil {
		return Authority{}, err
	}
	if !c.isAgent() {
		if _, err := queries.LockActiveRoomForMutation(ctx, roomID); err != nil {
			return Authority{}, notFound(err)
		}
		record, err := queries.ResolveReminderHumanRoomAuthority(ctx, store.ResolveReminderHumanRoomAuthorityParams{
			AccountID: c.accountID, RoomID: roomID,
		})
		if err != nil {
			return Authority{}, notFound(err)
		}
		return Authority{TenantID: record.TenantID, RoomID: roomID, ActorID: record.ActorID}, nil
	}
	p := c.agent.Principal
	if p.AgentActorID != c.agent.ActorID || p.TenantID != c.agent.TenantID {
		return Authority{}, ErrNotFound
	}
	if err := agentcredential.RevalidateInTx(ctx, tx, *p); err != nil {
		if errors.Is(err, agentcredential.ErrInvalid) {
			return Authority{}, ErrNotFound
		}
		return Authority{}, err
	}
	if _, err := queries.LockActiveRoomForMutation(ctx, roomID); err != nil {
		return Authority{}, notFound(err)
	}
	current, err := queries.ResolveReminderAgentRoomAuthority(ctx, store.ResolveReminderAgentRoomAuthorityParams{
		ActorID: p.AgentActorID, AgentManagementID: p.AgentID, RoomID: roomID,
	})
	if err != nil {
		return Authority{}, notFound(err)
	}
	if current.TenantID != c.agent.TenantID || current.ActorID != c.agent.ActorID {
		return Authority{}, ErrNotFound
	}
	return c.agent, nil
}

func notFound(err error) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	return err
}
