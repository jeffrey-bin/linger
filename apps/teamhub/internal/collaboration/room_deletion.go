package collaboration

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentruntimestate"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/roomcreation"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/tenantmembership"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

// ErrRoomIsWorkRoom reports a Room a Work Item manages.
var ErrRoomIsWorkRoom = errors.New("room is managed by a Work Item")

// DeleteRoom deletes a Room for its owner in its own transaction. A Room
// already deleted is not found.
func (s *Service) DeleteRoom(ctx context.Context, accountID, roomID string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err := s.DeleteRoomInTx(ctx, tx, accountID, roomID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// DeleteRoomInTx deletes a Room for its owner in the caller's transaction.
func (s *Service) DeleteRoomInTx(ctx context.Context, tx pgx.Tx, accountID, roomID string) error {
	queries := s.queries.WithTx(tx)
	if err := queries.AcquireAdvisoryTransactionLock(ctx, "room-membership|"+roomID); err != nil {
		return err
	}
	if _, err := queries.GetRoomForAccount(ctx, store.GetRoomForAccountParams{ID: roomID, AccountID: textValue(accountID)}); err != nil {
		return err
	}
	if thread, err := queries.IsThreadRoom(ctx, roomID); err != nil {
		return err
	} else if thread {
		return ErrThreadImmutable
	}
	authority, err := queries.GetRoomOwnerAuthority(ctx, store.GetRoomOwnerAuthorityParams{
		ID: roomID, AccountID: textValue(accountID),
	})
	if err != nil {
		return err
	}
	if authority.Role != string(httpapi.Owner) {
		return ErrRoomOwnerRequired
	}
	if direct, err := queries.IsDirectRoom(ctx, roomID); err != nil {
		return err
	} else if direct {
		// A Direct Room is immutable because it is the one place a pair
		// keeps talking. Once its peer Agent is gone the Room can never
		// carry another message, and its owner is left with a dead entry
		// no action could clear, so let them retire it. A live peer, and a
		// Direct Room between two Humans, stay immutable.
		peerActive, peerErr := queries.DirectRoomPeerIsActive(ctx, roomID)
		if peerErr != nil {
			return peerErr
		}
		if peerActive {
			return ErrDirectRoomImmutable
		}
	}
	if managed, err := queries.HasWorkRoomLink(ctx, roomID); err != nil {
		return err
	} else if managed {
		return ErrRoomIsWorkRoom
	}
	roomMembers, err := queries.ListRoomMembersForDeletion(ctx, roomID)
	if err != nil {
		return err
	}
	members := make([]store.GetRoomMemberForUpdateRow, 0, len(roomMembers))
	for _, candidate := range roomMembers {
		var member store.GetRoomMemberForUpdateRow
		lockAndValidate := func() error {
			var lockErr error
			member, lockErr = queries.GetRoomMemberForUpdate(ctx, store.GetRoomMemberForUpdateParams{
				RoomID: roomID, ActorID: candidate.ActorID,
			})
			if lockErr != nil {
				return lockErr
			}
			hasPendingDecision, pendingErr := queries.HasPendingTypedCardDecisionForMember(ctx, store.HasPendingTypedCardDecisionForMemberParams{
				RoomID: roomID, ActorID: candidate.ActorID,
			})
			if pendingErr != nil {
				return pendingErr
			}
			if hasPendingDecision {
				return ErrPendingCardDecision
			}
			return nil
		}
		if candidate.ActorKind == "agent" {
			if err := tenantmembership.LockAgent(ctx, queries, candidate.ActorID); err != nil {
				return err
			}
		}
		if err := lockAndValidate(); err != nil {
			return err
		}
		members = append(members, member)
	}
	// The members' meta Contexts that revocation terminates lock before
	// BeginRoomDeletion updates the rooms row.
	memberIDs := make([]string, 0, len(members))
	for _, member := range members {
		memberIDs = append(memberIDs, member.ActorID)
	}
	if err := agentruntimestate.LockRoomMembershipContexts(ctx, queries, memberIDs, []string{roomID}); err != nil {
		return err
	}
	// The exclusive room-mutation fence is the final commit gate that writers
	// take in shared mode after their own row locks, so it stays right before
	// the rooms write rather than with the leading advisory locks.
	if err := queries.AcquireAdvisoryTransactionLock(ctx, "room-mutation|"+roomID); err != nil {
		return err
	}
	startedAt := time.Now().UTC()
	if _, err := queries.BeginRoomDeletion(ctx, store.BeginRoomDeletionParams{
		DeletionStartedAt:        pgtype.Timestamptz{Time: startedAt, Valid: true},
		DeletionStartedByActorID: authority.CallerActorID,
		RoomID:                   roomID,
	}); err != nil {
		return err
	}
	for _, member := range members {
		if err := revokeRoomMemberForDeletedRoom(ctx, tx, queries, member, authority.CallerActorID); err != nil {
			return err
		}
	}
	finalized, err := roomcreation.FinalizeDeletion(ctx, tx, roomID, startedAt)
	if err != nil {
		return err
	}
	if !finalized {
		return errors.New("Room deletion did not finalize")
	}
	return nil
}

func revokeRoomMemberForDeletedRoom(
	ctx context.Context,
	tx pgx.Tx,
	queries *store.Queries,
	member store.GetRoomMemberForUpdateRow,
	initiatedByActorID string,
) error {
	return revokeRoomMembership(
		ctx, tx, queries, member, initiatedByActorID,
		agentruntimestate.TerminateRoomContextsForRoomDeletion,
	)
}
