package agentregistry

import (
	"context"
	"net/http"

	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentauth"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/collaboration"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/idempotency"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/typedcard"
	api "github.com/simplexai-labs/linger/contracts-go/teamhubagentapi"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

// Agents create and change Agents of their own Sponsor. TeamHub
// decides whether a change runs now or waits for the Sponsor's card; the
// caller never chooses its Sponsor, Runtime, or Room.

// AgentChange is the outcome of an Agent's create or update command: a
// response body when the change ran or replays, or the Sponsor's decision
// card to request when it must wait for confirmation.
type AgentChange struct {
	Auth    agentauth.Authorization
	Status  int
	Body    []byte
	Created *api.AgentAgentChangeResponse
	Confirm *typedcard.AgentChangeDecision
}

// GetSponsorAgent reads an active General Agent of the caller's Sponsor.
func (s *Service) GetSponsorAgent(ctx context.Context, authorizer agentauth.Authorizer, token, actorID string) (api.AgentAgentProfile, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return api.AgentAgentProfile{}, err
	}
	defer tx.Rollback(ctx)
	auth, err := authorizer.AuthorizeInTx(ctx, tx, token, "get_agent")
	if err != nil {
		return api.AgentAgentProfile{}, err
	}
	target, err := lockSponsorAgent(ctx, store.New(tx), auth.TenantID, auth.SponsorActorID, actorID)
	if err != nil {
		return api.AgentAgentProfile{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return api.AgentAgentProfile{}, err
	}
	return api.AgentAgentProfile{
		ActorId: target.registration.ActorID, Name: target.name,
		Description: target.registration.Description, Prompt: target.registration.Instructions,
	}, nil
}

// UpdateSponsorAgent changes the profile of the caller, or of another
// General Agent of its Sponsor. The change runs at once only while the
// target is still uninitialized and in the caller's Room; otherwise the
// Sponsor must confirm it.
func (s *Service) UpdateSponsorAgent(ctx context.Context, authorizer agentauth.Authorizer, token string, request api.AgentUpdateAgentRequest, change AgentProfileChange) (AgentChange, error) {
	caller, err := authorizer.Authorize(ctx, token, "update_agent")
	if err != nil {
		return AgentChange{}, err
	}
	targetID := caller.AgentActorID
	if request.ActorId != nil {
		targetID = *request.ActorId
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return AgentChange{}, err
	}
	defer tx.Rollback(ctx)
	queries := store.New(tx)
	if err := lockAgentProfileTarget(ctx, queries, caller.TenantID, targetID); err != nil {
		return AgentChange{}, err
	}
	auth, err := authorizer.AuthorizeInTx(ctx, tx, token, "update_agent")
	if err == nil && (auth.TenantID != caller.TenantID || auth.AgentActorID != caller.AgentActorID) {
		err = agentauth.ErrCredentialInvalid
	}
	if err != nil {
		return AgentChange{}, err
	}
	accountID, err := sponsorAccountID(ctx, queries, auth)
	if err != nil {
		return AgentChange{}, err
	}
	target, err := lockSponsorAgent(ctx, queries, auth.TenantID, auth.SponsorActorID, targetID)
	if err != nil {
		return AgentChange{}, err
	}
	operation := "updateAgent:" + auth.TenantID + ":" + auth.AgentActorID
	key := idempotency.AccountKey(accountID, operation, request.InvocationId)
	requestHash := idempotency.HashRequest(struct {
		ActorID string
		Change  AgentProfileChange
	}{targetID, change})
	if err := idempotency.Lock(ctx, tx, key); err != nil {
		return AgentChange{}, err
	}
	record, found, err := idempotency.Lookup(ctx, tx, key, requestHash)
	if err != nil {
		return AgentChange{}, err
	}
	if found {
		return AgentChange{Auth: auth, Status: record.Status, Body: record.Body}, nil
	}
	member := false
	if auth.RoomID != "" {
		member, err = queries.IsActiveRoomMember(ctx, store.IsActiveRoomMemberParams{RoomID: auth.RoomID, TenantID: auth.TenantID, ActorID: targetID})
		if err != nil {
			return AgentChange{}, err
		}
	}
	if !member || !collaboration.IsUninitializedAgentProfile(target.registration.Instructions) {
		if err := tx.Rollback(ctx); err != nil {
			return AgentChange{}, err
		}
		return AgentChange{Auth: auth, Confirm: &typedcard.AgentChangeDecision{
			Request: typedcard.AgentChangeRequest{
				TargetActorID: targetID, ExpectedRevision: target.registration.ConfigurationRevision,
				Change: agentChangeRequestOf(change),
			},
			View: agentUpdateCard(target, change),
		}}, nil
	}
	// The Room's notice follows the change; its lock precedes the change's Accounts.
	if err := queries.LockTenantDeliveryRooms(ctx, store.LockTenantDeliveryRoomsParams{TenantID: auth.TenantID, RoomIds: []string{auth.RoomID}}); err != nil {
		return AgentChange{}, err
	}
	if _, err := ApplyAgentProfileChange(ctx, tx, queries, target.registration, change); err != nil {
		return AgentChange{}, err
	}
	if err := PostAgentProfileNotice(ctx, queries, auth.TenantID, auth.RoomID, auth.AgentActorID, target, change); err != nil {
		return AgentChange{}, err
	}
	body := mustJSON(api.AgentAgentChangeResponse{Status: api.AgentChangeApplied, ActorId: &targetID})
	if err := idempotency.Save(ctx, tx, key, requestHash, idempotency.Record{ResourceID: targetID, Status: http.StatusOK, Body: body}); err != nil {
		return AgentChange{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return AgentChange{}, err
	}
	return AgentChange{Auth: auth, Status: http.StatusOK, Body: body}, nil
}

// CreateSponsorGeneralAgent creates a General Agent of the caller's Sponsor
// and adds it to the caller's Room when it can join; otherwise the Sponsor
// must confirm the creation.
func (s *Service) CreateSponsorGeneralAgent(ctx context.Context, authorizer agentauth.Authorizer, token string, request api.AgentCreateAgentRequest, change AgentProfileChange) (AgentChange, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return AgentChange{}, err
	}
	defer tx.Rollback(ctx)
	auth, err := authorizer.AuthorizeInTx(ctx, tx, token, "create_agent")
	if err != nil {
		return AgentChange{}, err
	}
	queries := store.New(tx)
	accountID, err := sponsorAccountID(ctx, queries, auth)
	if err != nil {
		return AgentChange{}, err
	}
	count, err := queries.CountSponsorGeneralAgents(ctx, store.CountSponsorGeneralAgentsParams{
		TenantID: auth.TenantID, SponsorActorID: auth.SponsorActorID,
	})
	if err == nil && count >= MaxSponsorGeneralAgents {
		err = ErrAgentLimitReached
	}
	if err != nil {
		return AgentChange{}, err
	}
	// The new Agent joins the caller's Room only when it can: a Direct Room has
	// fixed members, and the Sponsor is the one who admits it.
	joinable := false
	if auth.RoomID != "" {
		direct, err := queries.IsTenantDirectRoom(ctx, store.IsTenantDirectRoomParams{RoomID: auth.RoomID, TenantID: auth.TenantID})
		if err != nil {
			return AgentChange{}, err
		}
		sponsorMember, err := queries.IsActiveRoomMember(ctx, store.IsActiveRoomMemberParams{RoomID: auth.RoomID, TenantID: auth.TenantID, ActorID: auth.SponsorActorID})
		if err != nil {
			return AgentChange{}, err
		}
		joinable = !direct && sponsorMember
	}
	if err := tx.Commit(ctx); err != nil {
		return AgentChange{}, err
	}
	if !joinable {
		return AgentChange{Auth: auth, Confirm: &typedcard.AgentChangeDecision{
			Request: typedcard.AgentChangeRequest{Change: agentChangeRequestOf(change)},
			View:    agentCreateCard(change),
		}}, nil
	}
	actorID, err := s.CreateSponsorAgent(ctx, accountID, auth.TenantID, auth.AgentActorID, change, "agent-create:"+request.InvocationId)
	if err != nil {
		return AgentChange{}, err
	}
	if _, _, err := s.collaboration.PutRoomMember(ctx, accountID, auth.RoomID, actorID, httpapi.Member, collaboration.AddedByAgent{ActorID: auth.AgentActorID, Created: true}); err != nil {
		return AgentChange{}, err
	}
	return AgentChange{Auth: auth, Status: http.StatusOK, Created: &api.AgentAgentChangeResponse{
		Status: api.AgentChangeApplied, ActorId: &actorID, RoomId: &auth.RoomID,
	}}, nil
}

// AddSponsorAgentToRoom adds an existing Agent to the caller's Room with its
// Sponsor's authority, as the Sponsor could from the Web. It reports the Room's
// newly admitted Agents, empty when the Agent already was a member.
func (s *Service) AddSponsorAgentToRoom(ctx context.Context, authorizer agentauth.Authorizer, token, actorID string) (api.AgentAddRoomMemberResponse, []string, error) {
	auth, err := authorizer.Authorize(ctx, token, "add_room_member")
	if err != nil {
		return api.AgentAddRoomMemberResponse{}, nil, err
	}
	// Humans join through their own invitation; an Agent admits only Agents.
	target, err := s.queries.GetActor(ctx, store.GetActorParams{ID: actorID, TenantID: auth.TenantID})
	if err == nil && target.Kind != "agent" {
		err = pgx.ErrNoRows
	}
	if err != nil {
		return api.AgentAddRoomMemberResponse{}, nil, err
	}
	accountID, err := sponsorAccountID(ctx, s.queries, auth)
	if err != nil {
		return api.AgentAddRoomMemberResponse{}, nil, err
	}
	sponsorMember, err := s.queries.IsActiveRoomMember(ctx, store.IsActiveRoomMemberParams{RoomID: auth.RoomID, TenantID: auth.TenantID, ActorID: auth.SponsorActorID})
	if err != nil {
		return api.AgentAddRoomMemberResponse{}, nil, err
	}
	if !sponsorMember {
		return api.AgentAddRoomMemberResponse{}, nil, ErrSponsorNotRoomMember
	}
	_, added, err := s.collaboration.PutRoomMember(ctx, accountID, auth.RoomID, actorID, httpapi.Member, collaboration.AddedByAgent{ActorID: auth.AgentActorID})
	if err != nil {
		return api.AgentAddRoomMemberResponse{}, nil, err
	}
	return api.AgentAddRoomMemberResponse{RoomId: auth.RoomID, ActorId: actorID, Added: len(added) > 0}, added, nil
}
