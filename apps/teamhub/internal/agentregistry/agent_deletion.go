package agentregistry

import (
	"context"
	"errors"
	"net/http"
	"slices"

	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentruntimestate"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/collaboration"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/idempotency"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/reminder"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/roomcreation"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/tenantmembership"
)

var (
	// ErrAgentHasActiveRuns reports an Agent change that must wait for its active Run.
	ErrAgentHasActiveRuns = errors.New("Agent has active Runs")
	// ErrAgentDeletionUnavailable reports an Agent that cannot be removed from its current state.
	ErrAgentDeletionUnavailable = errors.New("Agent cannot be removed from its current state")
	errAgentRoomsChanged        = errors.New("Agent joined a Room during deletion")
)

// agentDeletionAttempts bounds retries after admissions that committed while
// a deletion waited for the Agent lock.
const agentDeletionAttempts = 3

// ExecuteTenantAgentDeletion revokes a Sponsor's Agent in one transaction:
// its queued and running local work is cancelled, its Room memberships end,
// and the Sponsor's Direct Room with it starts deletion. Agent Service is told
// afterwards so it stops the Agent's Contexts and removes its Runner, on an
// offline Computer when that Computer reconnects.
func (s *Service) ExecuteTenantAgentDeletion(
	ctx context.Context, accountID, tenantID, actorID string,
) (idempotency.Result, error) {
	for attempt := 1; ; attempt++ {
		result, err := s.executeTenantAgentDeletionAttempt(ctx, accountID, tenantID, actorID)
		if !errors.Is(err, errAgentRoomsChanged) || attempt == agentDeletionAttempts {
			return result, err
		}
	}
}

func (s *Service) executeTenantAgentDeletionAttempt(
	ctx context.Context, accountID, tenantID, actorID string,
) (idempotency.Result, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return idempotency.Result{}, err
	}
	defer tx.Rollback(ctx)
	queries := s.queries.WithTx(tx)
	caller, err := queries.GetHumanActor(ctx, store.GetHumanActorParams{
		TenantID: tenantID, AccountID: textValue(accountID),
	})
	if err != nil {
		return idempotency.Result{}, err
	}
	roomIDs, err := lockAgentRoomMembershipsForPendingDecisionCheck(ctx, queries, tenantID, actorID)
	if err != nil {
		return idempotency.Result{}, err
	}
	// Admissions take Room locks before the Agent lock, so the Agent lock
	// follows the scan. An admission that held it first has committed a Room
	// the scan missed; that Room cannot be locked now without inverting the
	// order, so the deletion starts over and scans it.
	if err := tenantmembership.LockAgent(ctx, queries, actorID); err != nil {
		return idempotency.Result{}, err
	}
	currentRoomIDs, err := queries.ListAgentRoomIDsForPendingDecisionCheck(ctx, store.ListAgentRoomIDsForPendingDecisionCheckParams{
		TenantID: tenantID, ActorID: actorID,
	})
	if err != nil {
		return idempotency.Result{}, err
	}
	for _, roomID := range currentRoomIDs {
		if !slices.Contains(roomIDs, roomID) {
			return idempotency.Result{}, errAgentRoomsChanged
		}
	}
	// The registration row is locked later, after the membership rows, in the
	// order Room reception and deletion take them.
	registration, err := queries.GetAgentRegistrationByActor(ctx, store.GetAgentRegistrationByActorParams{
		ActorID: actorID, TenantID: tenantID,
	})
	if err != nil {
		return idempotency.Result{}, err
	}
	if registration.CreatedByActorID != caller.ID {
		return idempotency.Result{}, collaboration.ErrAgentSponsorRequired
	}
	if registration.AgentType == "anotherme" {
		return idempotency.Result{}, ErrAgentDeletionUnavailable
	}
	// Serialize the selected Direct Room membership before finalization.
	var directRoomID string
	room, lookupErr := queries.GetDirectRoomByPair(ctx, store.GetDirectRoomByPairParams{
		TenantID: tenantID, HumanActorID: registration.CreatedByActorID, AgentActorID: actorID,
	})
	if lookupErr != nil && !errors.Is(lookupErr, pgx.ErrNoRows) {
		return idempotency.Result{}, lookupErr
	}
	if lookupErr == nil && !room.DeletedAt.Valid && !room.DeletionStartedAt.Valid {
		directRoomID = room.ID
	}
	result := idempotency.Result{Status: http.StatusNoContent}
	if registration.Status == "revoked" {
		return result, tx.Commit(ctx)
	}
	for _, roomID := range roomIDs {
		hasPendingDecision, pendingErr := queries.HasPendingTypedCardDecisionForMember(ctx, store.HasPendingTypedCardDecisionForMemberParams{
			RoomID: roomID, ActorID: actorID,
		})
		if pendingErr != nil {
			return idempotency.Result{}, pendingErr
		}
		if hasPendingDecision {
			return idempotency.Result{}, collaboration.ErrPendingCardDecision
		}
	}
	// Stop copies before taking Room sequence or account delivery row locks.
	// Routine delivery takes its Routine row before those same locks.
	if err := reminder.PauseTemplateRoutinesInTx(ctx, queries, actorID, caller.ID); err != nil {
		return idempotency.Result{}, err
	}
	if directRoomID != "" {
		if err := roomcreation.LockMemberships(ctx, queries, directRoomID); err != nil {
			return idempotency.Result{}, err
		}
	}
	if err := s.revokeTenantAgentInTx(ctx, tx, tenantID, actorID, registration.CreatedByActorID, directRoomID); err != nil {
		return idempotency.Result{}, err
	}
	if directRoomID != "" {
		if err := s.collaboration.DeleteRoomInTx(ctx, tx, accountID, directRoomID); err != nil {
			return idempotency.Result{}, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return idempotency.Result{}, err
	}
	s.NotifyAgentRegistrationChanged(ctx, registration.AgentManagementID.String)
	return result, nil
}

// revokeTenantAgentInTx ends the Agent's Room memberships and revokes its
// active registration in the caller's transaction, which holds the Agent lock.
func (s *Service) revokeTenantAgentInTx(ctx context.Context, tx pgx.Tx, tenantID, actorID, creatorActorID, deletingDirectRoomID string) error {
	queries := s.queries.WithTx(tx)
	roomIDs, err := lockAgentRoomMembershipsForDeletion(ctx, queries, tenantID, actorID)
	if err != nil {
		return err
	}
	if err := lockAgentDeletionFinalizationMembers(ctx, queries, actorID, deletingDirectRoomID, roomIDs); err != nil {
		return err
	}
	registration, err := queries.GetAgentRegistrationForDeletion(ctx, store.GetAgentRegistrationForDeletionParams{
		ActorID: actorID, TenantID: tenantID,
	})
	if err != nil {
		return err
	}
	if registration.Status != "active" {
		return ErrAgentDeletionUnavailable
	}
	affectedRoomIDs := append(append([]string(nil), roomIDs...), deletingDirectRoomID)
	// Lock the Agent's open Contexts and the meta Contexts its membership
	// revocations suspend in one ordered pass before Room rows (member ->
	// Context -> Room); a late callback holding a Context may still allocate
	// Room seqs.
	if err := agentruntimestate.LockContextsForAgentRevocation(ctx, queries, tenantID, actorID, affectedRoomIDs); err != nil {
		return err
	}
	for _, roomID := range roomIDs {
		if roomID == deletingDirectRoomID {
			// Room deletion owns terminalization and revocation for this Room.
			continue
		}
		member, err := queries.GetRoomMemberForUpdate(ctx, store.GetRoomMemberForUpdateParams{
			RoomID: roomID, ActorID: actorID,
		})
		if errors.Is(err, pgx.ErrNoRows) {
			continue
		}
		if err != nil {
			return err
		}
		if err := collaboration.RemoveRoomMember(ctx, tx, queries, member, creatorActorID); err != nil {
			return err
		}
	}
	revoked, err := queries.RevokeAgentRegistration(ctx, store.RevokeAgentRegistrationParams{
		ActorID: actorID, TenantID: tenantID,
	})
	if err != nil {
		return err
	}
	if revoked != 1 {
		return errors.New("Agent deletion finalization lost its registration")
	}
	if err := agentruntimestate.TerminateContextsForAgentRevocation(ctx, queries, tenantID, actorID); err != nil {
		return err
	}
	return createTenantAgentDirectoryDeliveries(ctx, queries, tenantID)
}

// Room membership locks must precede the registration row lock. Typed Card
// creation uses the same order, so deletion cannot deadlock while checking
// whether a pending decision still requires the Agent.
func lockAgentRoomMembershipsForDeletion(
	ctx context.Context,
	queries *store.Queries,
	tenantID string,
	actorID string,
) ([]string, error) {
	roomIDs, err := queries.ListAgentRoomIDsForDeletion(ctx, store.ListAgentRoomIDsForDeletionParams{
		TenantID: tenantID, ActorID: actorID,
	})
	if err != nil {
		return nil, err
	}
	if err := roomcreation.LockMemberships(ctx, queries, roomIDs...); err != nil {
		return nil, err
	}
	return roomIDs, nil
}

func lockAgentRoomMembershipsForPendingDecisionCheck(
	ctx context.Context,
	queries *store.Queries,
	tenantID string,
	actorID string,
) ([]string, error) {
	roomIDs, err := queries.ListAgentRoomIDsForPendingDecisionCheck(ctx, store.ListAgentRoomIDsForPendingDecisionCheckParams{
		TenantID: tenantID, ActorID: actorID,
	})
	if err != nil {
		return nil, err
	}
	if err := roomcreation.LockMemberships(ctx, queries, roomIDs...); err != nil {
		return nil, err
	}
	return roomIDs, nil
}

// Take membership rows before registration and Room sequence locks. Reception,
// Human mentions and Room deletion all use membership -> Context/Room; advisory
// membership locks alone do not serialize with those reception row locks.
func lockAgentDeletionFinalizationMembers(ctx context.Context, queries *store.Queries, actorID, deletingDirectRoomID string, roomIDs []string) error {
	ids := append(append([]string(nil), roomIDs...), deletingDirectRoomID)
	slices.Sort(ids)
	for _, roomID := range slices.Compact(ids) {
		if roomID == "" {
			continue
		}
		actorIDs := []string{actorID}
		if roomID == deletingDirectRoomID {
			// deleteRoomInTx will revoke every member, including the Human peer.
			members, err := queries.ListRoomMembersForDeletion(ctx, roomID)
			if err != nil {
				return err
			}
			actorIDs = actorIDs[:0]
			for _, member := range members {
				actorIDs = append(actorIDs, member.ActorID)
			}
		}
		slices.Sort(actorIDs)
		for _, memberActorID := range slices.Compact(actorIDs) {
			if _, err := queries.GetRoomMemberForUpdate(ctx, store.GetRoomMemberForUpdateParams{RoomID: roomID, ActorID: memberActorID}); err != nil && !errors.Is(err, pgx.ErrNoRows) {
				return err
			}
		}
	}
	return nil
}
