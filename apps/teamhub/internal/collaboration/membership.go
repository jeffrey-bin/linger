package collaboration

import (
	"context"
	"errors"
	"net/http"
	"slices"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentruntimestate"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/messagecreation"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/roomcreation"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/roomevent"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/tenantmembership"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

var (
	// ErrRoomOwnerRequired reports a Room change only an owner may make.
	ErrRoomOwnerRequired = errors.New("room owner role is required")
	// ErrLastRoomOwner reports a change that would leave a Room without an owner.
	ErrLastRoomOwner = errors.New("room must retain an owner")
	// ErrPendingCardDecision reports a member pending typed card work still needs.
	ErrPendingCardDecision = errors.New("room member is required by pending typed card work")
	// ErrAgentCannotOwnRoom reports an Agent named as a Room owner.
	ErrAgentCannotOwnRoom = errors.New("agent cannot own a room")
	// ErrAgentNotRegistered reports an Agent without an active registration.
	ErrAgentNotRegistered = errors.New("Agent is not actively registered")
	// ErrAgentSponsorRequired reports an Agent change only its Sponsor may make.
	ErrAgentSponsorRequired = errors.New("Agent Sponsor is required")
	// ErrDirectRoomImmutable reports a change to a Direct Room's members or metadata.
	ErrDirectRoomImmutable = errors.New("direct room membership and metadata are immutable")
	// ErrDirectRoomPeerInactive reports a Direct Room whose Agent is gone.
	ErrDirectRoomPeerInactive = errors.New("direct room peer is inactive")
	// ErrThreadImmutable reports a change to a Thread's members or metadata.
	ErrThreadImmutable = errors.New("thread room membership and metadata are immutable")
)

type roomMemberRecord struct {
	roomID, tenantID, actorID, role, addedByActorID string
	actorKind, actorDisplayName                     string
	adderKind, adderDisplayName                     string
	joinedAt, updatedAt                             pgtype.Timestamptz
}

func roomMemberModel(record roomMemberRecord) httpapi.RoomMember {
	return httpapi.RoomMember{
		RoomId: record.roomID,
		Actor: httpapi.ActorRef{
			Id: record.actorID, TenantId: record.tenantID,
			Kind: httpapi.ActorKind(record.actorKind), DisplayName: record.actorDisplayName,
		},
		Role: httpapi.RoomMemberRole(record.role),
		AddedBy: httpapi.ActorRef{
			Id: record.addedByActorID, TenantId: record.tenantID,
			Kind: httpapi.ActorKind(record.adderKind), DisplayName: record.adderDisplayName,
		},
		JoinedAt: record.joinedAt.Time, UpdatedAt: record.updatedAt.Time,
	}
}

func listRoomMemberModel(row store.ListRoomMembersForAccountRow, listedRoomID string) httpapi.RoomMember {
	return roomMemberModel(roomMemberRecord{
		roomID: listedRoomID, tenantID: row.TenantID, actorID: row.ActorID, role: row.Role,
		addedByActorID: row.AddedByActorID, actorKind: row.ActorKind, actorDisplayName: row.ActorDisplayName,
		adderKind: row.AdderKind, adderDisplayName: row.AdderDisplayName,
		joinedAt: row.JoinedAt, updatedAt: row.UpdatedAt,
	})
}

func lockedRoomMemberModel(row store.GetRoomMemberForUpdateRow) httpapi.RoomMember {
	return roomMemberModel(roomMemberRecord{
		roomID: row.RoomID, tenantID: row.TenantID, actorID: row.ActorID, role: row.Role,
		addedByActorID: row.AddedByActorID, actorKind: row.ActorKind, actorDisplayName: row.ActorDisplayName,
		adderKind: row.AdderKind, adderDisplayName: row.AdderDisplayName,
		joinedAt: row.JoinedAt, updatedAt: row.UpdatedAt,
	})
}

// AddedByAgent names the Agent that admits a member for its Sponsor's
// Account; Created reports that it also just created that member.
type AddedByAgent struct {
	ActorID string
	Created bool
}

// PutRoomMember takes the Room membership lock, then the Agent locks of the
// Actors it admits, so a concurrent Agent deletion cannot miss this admission
// in its Room scan. A new member gets a Room notice: by its Agent when by names
// one, saying it created and added the member when by.Created; otherwise by the
// caller.
func (s *Service) PutRoomMember(ctx context.Context, accountID, roomID, targetActorID string, role httpapi.RoomMemberRole, by AddedByAgent) (httpapi.RoomMember, []string, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return httpapi.RoomMember{}, nil, err
	}
	defer tx.Rollback(ctx)
	queries := s.queries.WithTx(tx)
	tenantID, err := queries.GetRoomTenantID(ctx, roomID)
	if err != nil {
		return httpapi.RoomMember{}, nil, err
	}
	if err := roomcreation.LockMembership(ctx, queries, roomID); err != nil {
		return httpapi.RoomMember{}, nil, err
	}
	if err := rejectImmutableRoomSubtype(ctx, queries, roomID); err != nil {
		return httpapi.RoomMember{}, nil, err
	}
	authority, err := queries.GetRoomOwnerAuthority(ctx, store.GetRoomOwnerAuthorityParams{
		ID: roomID, AccountID: textValue(accountID),
	})
	if err != nil {
		return httpapi.RoomMember{}, nil, err
	}
	if authority.TenantID != tenantID {
		return httpapi.RoomMember{}, nil, pgx.ErrNoRows
	}
	caller, err := queries.GetActor(ctx, store.GetActorParams{ID: authority.CallerActorID, TenantID: authority.TenantID})
	if err != nil {
		return httpapi.RoomMember{}, nil, err
	}
	target, err := queries.GetActor(ctx, store.GetActorParams{ID: targetActorID, TenantID: authority.TenantID})
	if err != nil {
		return httpapi.RoomMember{}, nil, err
	}
	// The member write below fires a trigger that locks rooms, so every
	// membership lock must come first. AnotherMe's membership locks with the
	// target's, in Actor order, before that write.
	anotherMeAgentID := ""
	if target.Kind == "human" {
		registration, registrationErr := queries.GetAnotherMeRegistration(ctx, store.GetAnotherMeRegistrationParams{
			TenantID: authority.TenantID, RepresentedHumanActorID: target.ID,
		})
		if registrationErr != nil && !errors.Is(registrationErr, pgx.ErrNoRows) {
			return httpapi.RoomMember{}, nil, registrationErr
		}
		if registrationErr == nil && registration.Status == "active" {
			anotherMeAgentID = registration.ActorID
		}
	}
	lockActorIDs := []string{targetActorID}
	if anotherMeAgentID != "" {
		lockActorIDs = append(lockActorIDs, anotherMeAgentID)
	}
	if err := tenantmembership.LockAgents(ctx, queries, lockActorIDs...); err != nil {
		return httpapi.RoomMember{}, nil, err
	}
	slices.Sort(lockActorIDs)
	for _, actorID := range lockActorIDs {
		if err := lockRoomMembershipForUpdate(ctx, queries, roomID, actorID); err != nil {
			return httpapi.RoomMember{}, nil, err
		}
	}
	if err := agentruntimestate.LockRoomMembershipContexts(ctx, queries, lockActorIDs, []string{roomID}); err != nil {
		return httpapi.RoomMember{}, nil, err
	}
	existing, err := queries.GetRoomMemberForUpdate(ctx, store.GetRoomMemberForUpdateParams{RoomID: roomID, ActorID: targetActorID})
	if err == nil && existing.Role == string(role) {
		if role != httpapi.Member && authority.Role != string(httpapi.Owner) {
			return httpapi.RoomMember{}, nil, ErrRoomOwnerRequired
		}
		if err := tx.Commit(ctx); err != nil {
			return httpapi.RoomMember{}, nil, err
		}
		return lockedRoomMemberModel(existing), nil, nil
	}
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return httpapi.RoomMember{}, nil, err
	}
	isNewMembership := errors.Is(err, pgx.ErrNoRows)
	if (!isNewMembership || role == httpapi.Owner) && authority.Role != string(httpapi.Owner) {
		return httpapi.RoomMember{}, nil, ErrRoomOwnerRequired
	}
	if role == httpapi.Owner && target.Kind != "human" {
		return httpapi.RoomMember{}, nil, ErrAgentCannotOwnRoom
	}
	if isNewMembership && target.Kind == "agent" {
		registration, registrationErr := queries.GetActiveAgentRegistrationForAdmission(ctx, store.GetActiveAgentRegistrationForAdmissionParams{
			ActorID: target.ID, TenantID: target.TenantID,
		})
		if errors.Is(registrationErr, pgx.ErrNoRows) {
			return httpapi.RoomMember{}, nil, ErrAgentNotRegistered
		}
		if registrationErr != nil {
			return httpapi.RoomMember{}, nil, registrationErr
		}
		if registration.VisibilityScope != "workspace" && registration.CreatedByActorID != caller.ID {
			return httpapi.RoomMember{}, nil, ErrAgentSponsorRequired
		}
	}
	if err == nil && existing.Role == string(httpapi.Owner) && role != httpapi.Owner {
		owners, countErr := queries.CountRoomOwners(ctx, roomID)
		if countErr != nil {
			return httpapi.RoomMember{}, nil, countErr
		}
		if owners <= 1 {
			return httpapi.RoomMember{}, nil, ErrLastRoomOwner
		}
	}

	// Documents lock before the delivery Accounts that the write below takes.
	roomDocumentIDs, lockListErr := queries.ListRoomBoundDocumentIDsForLock(ctx, roomID)
	if lockListErr != nil {
		return httpapi.RoomMember{}, nil, lockListErr
	}
	if err := document.Lock(ctx, tx, roomDocumentIDs); err != nil {
		return httpapi.RoomMember{}, nil, err
	}

	eventType := "room.member.added"
	var membership store.RoomMember
	if errors.Is(err, pgx.ErrNoRows) {
		membership, err = queries.CreateRoomMember(ctx, store.CreateRoomMemberParams{
			RoomID: roomID, TenantID: authority.TenantID, ActorID: target.ID,
			Role: string(role), AddedByActorID: caller.ID,
		})
	} else {
		eventType = "room.member.role_changed"
		membership, err = queries.UpdateRoomMemberRole(ctx, store.UpdateRoomMemberRoleParams{RoomID: roomID, ActorID: target.ID, Role: string(role)})
	}
	if err != nil {
		return httpapi.RoomMember{}, nil, err
	}
	if isNewMembership {
		if err := document.RecomputeRoomMemberAdmissionAccess(
			ctx, tx, authority.TenantID, roomID, target.ID, caller.ID,
		); err != nil {
			return httpapi.RoomMember{}, nil, err
		}
	}
	member := roomMemberModel(roomMemberRecord{
		roomID: membership.RoomID, tenantID: membership.TenantID, actorID: membership.ActorID,
		role: membership.Role, addedByActorID: membership.AddedByActorID,
		actorKind: target.Kind, actorDisplayName: target.DisplayName,
		adderKind: caller.Kind, adderDisplayName: caller.DisplayName,
		joinedAt: membership.JoinedAt, updatedAt: membership.UpdatedAt,
	})
	seq, err := roomevent.Append(ctx, queries, roomevent.Input{
		TenantID: authority.TenantID, RoomID: roomID, EventType: eventType,
		ActorID: caller.ID, ResourceID: target.ID,
		Payload: map[string]any{"kind": eventType, "member": member},
	})
	if err != nil {
		return httpapi.RoomMember{}, nil, err
	}
	// addedAgentIDs lists Agents whose membership this call newly created.
	var addedAgentIDs []string
	if isNewMembership && target.Kind == "agent" {
		if err := agentruntimestate.EnsurePerRoomMetaContexts(ctx, queries, target.ID); err != nil {
			return httpapi.RoomMember{}, nil, err
		}
		addedAgentIDs = append(addedAgentIDs, target.ID)
	}
	if eventType == "room.member.added" && target.Kind == "human" {
		if err := queries.CreateRoomMemberState(ctx, store.CreateRoomMemberStateParams{
			RoomID: roomID, ActorID: target.ID, ReadThroughRoomSeq: seq,
		}); err != nil {
			return httpapi.RoomMember{}, nil, err
		}

		// A Human's AnotherMe follows them into every Room by default. Keep this
		// in the same transaction so the pair cannot diverge during admission.
		if anotherMeAgentID != "" {
			agent, agentErr := queries.GetActor(ctx, store.GetActorParams{
				ID: anotherMeAgentID, TenantID: authority.TenantID,
			})
			if agentErr != nil {
				return httpapi.RoomMember{}, nil, agentErr
			}
			if _, agentErr = queries.GetRoomMemberForUpdate(ctx, store.GetRoomMemberForUpdateParams{
				RoomID: roomID, ActorID: agent.ID,
			}); errors.Is(agentErr, pgx.ErrNoRows) {
				agentMembership, createErr := queries.CreateRoomMember(ctx, store.CreateRoomMemberParams{
					RoomID: roomID, TenantID: authority.TenantID, ActorID: agent.ID,
					Role: string(httpapi.Member), AddedByActorID: caller.ID,
				})
				if createErr != nil {
					return httpapi.RoomMember{}, nil, createErr
				}
				agentMember := roomMemberModel(roomMemberRecord{
					roomID: agentMembership.RoomID, tenantID: agentMembership.TenantID,
					actorID: agentMembership.ActorID, role: agentMembership.Role,
					addedByActorID: agentMembership.AddedByActorID, actorKind: agent.Kind,
					actorDisplayName: agent.DisplayName, adderKind: caller.Kind,
					adderDisplayName: caller.DisplayName, joinedAt: agentMembership.JoinedAt,
					updatedAt: agentMembership.UpdatedAt,
				})
				_, err = roomevent.Append(ctx, queries, roomevent.Input{
					TenantID: authority.TenantID, RoomID: roomID, EventType: "room.member.added",
					ActorID: caller.ID, ResourceID: agent.ID,
					Payload: map[string]any{
						"kind": "room.member.added", "member": agentMember,
					},
				})
				if err != nil {
					return httpapi.RoomMember{}, nil, err
				}
				if err := agentruntimestate.EnsurePerRoomMetaContexts(ctx, queries, agent.ID); err != nil {
					return httpapi.RoomMember{}, nil, err
				}
				addedAgentIDs = append(addedAgentIDs, agent.ID)
			} else if agentErr != nil {
				return httpapi.RoomMember{}, nil, agentErr
			}
		}
	}
	if isNewMembership {
		// One line per new member; the AnotherMe that follows a Human needs none.
		author, notice := caller, messagecreation.MemberAdded(target)
		if by.ActorID != "" {
			author, err = queries.GetActor(ctx, store.GetActorParams{ID: by.ActorID, TenantID: authority.TenantID})
			if err != nil {
				return httpapi.RoomMember{}, nil, err
			}
			if by.Created {
				notice = messagecreation.AgentCreated(target, nil)
			}
		}
		if _, err := messagecreation.CreateNotice(ctx, queries, authority.TenantID, roomID, author, notice); err != nil {
			return httpapi.RoomMember{}, nil, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return httpapi.RoomMember{}, nil, err
	}
	return member, addedAgentIDs, nil
}

// DeleteRoomMember shares the Room lock with add and role-change, so concurrent operations cannot both remove the last owner.
func (s *Service) DeleteRoomMember(ctx context.Context, accountID, roomID, targetActorID string) (int, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback(ctx)
	queries := s.queries.WithTx(tx)
	if err := queries.AcquireAdvisoryTransactionLock(ctx, "room-membership|"+roomID); err != nil {
		return 0, err
	}
	if err := rejectImmutableRoomSubtype(ctx, queries, roomID); err != nil {
		return 0, err
	}
	authority, err := queries.GetRoomOwnerAuthority(ctx, store.GetRoomOwnerAuthorityParams{
		ID: roomID, AccountID: textValue(accountID),
	})
	if err != nil {
		return 0, err
	}
	if authority.Role != string(httpapi.Owner) {
		return 0, ErrRoomOwnerRequired
	}
	// The per-Agent authority lock linearizes the removal before the membership row lock.
	if err := tenantmembership.LockAgent(ctx, queries, targetActorID); err != nil {
		return 0, err
	}
	var member store.GetRoomMemberForUpdateRow
	err = func() error {
		member, err = queries.GetRoomMemberForUpdate(ctx, store.GetRoomMemberForUpdateParams{RoomID: roomID, ActorID: targetActorID})
		if err != nil {
			return err
		}
		if member.Role != string(httpapi.Owner) {
			// Non-owner removals still need the pending decision guard below.
		} else {
			owners, countErr := queries.CountRoomOwners(ctx, roomID)
			if countErr != nil {
				return countErr
			}
			if owners <= 1 {
				return ErrLastRoomOwner
			}
		}
		hasPendingDecision, err := queries.HasPendingTypedCardDecisionForMember(ctx, store.HasPendingTypedCardDecisionForMemberParams{
			RoomID: roomID, ActorID: targetActorID,
		})
		if err != nil {
			return err
		}
		if hasPendingDecision {
			return ErrPendingCardDecision
		}
		return agentruntimestate.LockRoomMembershipContexts(ctx, queries, []string{targetActorID}, []string{roomID})
	}()
	if err != nil {
		return 0, err
	}
	if err := RemoveRoomMember(ctx, tx, queries, member, authority.CallerActorID); err != nil {
		return 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return http.StatusNoContent, nil
}

// RemoveRoomMember revokes a membership in the caller's transaction: it
// deletes the membership, suspends the member's Contexts, recomputes its
// Document access, which disconnects its open Document connections after
// commit, and records room.member.removed.
func RemoveRoomMember(
	ctx context.Context,
	tx pgx.Tx,
	queries *store.Queries,
	member store.GetRoomMemberForUpdateRow,
	initiatedByActorID string,
) error {
	if err := revokeRoomMembership(
		ctx, tx, queries, member, initiatedByActorID,
		agentruntimestate.SuspendRoomContextsForMembershipRevocation,
	); err != nil {
		return err
	}
	_, err := roomevent.Append(ctx, queries, roomevent.Input{
		TenantID: member.TenantID, RoomID: member.RoomID, EventType: "room.member.removed",
		ActorID: initiatedByActorID, ResourceID: member.ActorID,
		Payload: roomevent.MemberRemoved(lockedRoomMemberModel(member)),
	})
	return err
}

// revokeRoomMembership deletes the membership row, transitions the member's
// Contexts in this Room and recomputes the member's Document access, all in
// the caller's transaction. The delete takes the Room, Document and delivery
// Account locks first. Work bound to this admission's membership_epoch_id no
// longer matches any membership row.
func revokeRoomMembership(
	ctx context.Context,
	tx pgx.Tx,
	queries *store.Queries,
	member store.GetRoomMemberForUpdateRow,
	initiatedByActorID string,
	transitionContexts func(context.Context, *store.Queries, string, string, string) error,
) error {
	if err := queries.DeleteRoomMemberForMembershipEpoch(ctx, member.MembershipEpochID); err != nil {
		return err
	}
	if err := transitionContexts(ctx, queries, member.ActorID, member.RoomID, member.MembershipEpochID); err != nil {
		return err
	}
	return document.RecomputeRoomMemberRevocationAccess(
		ctx, tx, member.TenantID, member.RoomID, member.ActorID, initiatedByActorID,
	)
}

// UpdateRoom changes a Room's name or description for its owner.
func (s *Service) UpdateRoom(ctx context.Context, accountID, roomID string, request httpapi.RoomUpdateRequest) (httpapi.Room, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return httpapi.Room{}, err
	}
	defer tx.Rollback(ctx)
	queries := s.queries.WithTx(tx)
	if err := rejectImmutableRoomSubtype(ctx, queries, roomID); err != nil {
		return httpapi.Room{}, err
	}
	authority, err := queries.GetRoomOwnerAuthority(ctx, store.GetRoomOwnerAuthorityParams{ID: roomID, AccountID: textValue(accountID)})
	if err != nil {
		return httpapi.Room{}, err
	}
	if authority.Role != string(httpapi.Owner) {
		return httpapi.Room{}, ErrRoomOwnerRequired
	}
	room, err := queries.GetRoomForAccount(ctx, store.GetRoomForAccountParams{ID: roomID, AccountID: textValue(accountID)})
	if err != nil {
		return httpapi.Room{}, err
	}
	name, description := room.Name, room.Description
	if request.Name != nil {
		name = strings.TrimSpace(*request.Name)
	}
	if request.Description != nil {
		description = pgtype.Text{String: *request.Description, Valid: true}
	}
	room, err = queries.UpdateRoom(ctx, store.UpdateRoomParams{ID: roomID, Name: name, Description: description})
	if err != nil {
		return httpapi.Room{}, err
	}
	creator, err := queries.GetActor(ctx, store.GetActorParams{ID: room.CreatedByActorID, TenantID: room.TenantID})
	if err != nil {
		return httpapi.Room{}, err
	}
	model := roomModel(room, creator)
	if _, err := roomevent.Append(ctx, queries, roomevent.Input{
		TenantID: room.TenantID, RoomID: roomID, EventType: "room.updated",
		ActorID: authority.CallerActorID, ResourceID: roomID,
		Payload: map[string]any{"kind": "room.updated", "room": model},
	}); err != nil {
		return httpapi.Room{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return httpapi.Room{}, err
	}
	return model, nil
}

func rejectImmutableRoomSubtype(ctx context.Context, queries *store.Queries, roomID string) error {
	if direct, err := queries.IsDirectRoom(ctx, roomID); err != nil {
		return err
	} else if direct {
		return ErrDirectRoomImmutable
	}
	if thread, err := queries.IsThreadRoom(ctx, roomID); err != nil {
		return err
	} else if thread {
		return ErrThreadImmutable
	}
	return nil
}

// lockRoomMembershipForUpdate locks an Actor's membership in a Room when one
// exists. It performs no validation.
func lockRoomMembershipForUpdate(ctx context.Context, queries *store.Queries, roomID, actorID string) error {
	_, err := queries.GetRoomMemberForUpdate(ctx, store.GetRoomMemberForUpdateParams{RoomID: roomID, ActorID: actorID})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	return err
}
