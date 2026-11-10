package roomcreation

import (
	"context"
	"errors"
	"slices"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentruntimestate"
	idgen "github.com/simplexai-labs/linger/apps/teamhub/internal/ids"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/roomevent"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/tenantmembership"
)

var (
	ErrNotFound             = errors.New("room creation authority or member not found")
	ErrInvalid              = errors.New("invalid room creation input")
	ErrAgentUnavailable     = errors.New("initial Room Agent is not actively registered")
	ErrAgentSponsorRequired = errors.New("initial Room Agent must be admitted by its sponsor")
)

// ErrDirectRoomDeleting means the pair's direct Room is being deleted. It can
// be opened again once the deletion finishes.
var ErrDirectRoomDeleting = errors.New("the direct Room is being deleted")

// Spec is one Room to create. The Human Owner owns it; the Creator is the
// owner or an Agent. Members join beside them and exclude both.
type Spec struct {
	TenantID       string
	Name           string
	Description    *string
	Creator        store.Actor
	Owner          store.Actor
	MemberActorIDs []string
	// AgentsAuthorized admits any active Agent the caller already authorized:
	// a Human approved the creation, or a Human opens a direct Room with an
	// Agent visible to them. Otherwise an Agent joins only when the owner
	// sponsors it.
	AgentsAuthorized bool
	// SuppressAgentMetaContexts leaves the Agents' Room Contexts to the caller.
	SuppressAgentMetaContexts bool
}

type Result struct {
	Room    store.Room
	Creator store.Actor
}

type actorValue struct {
	ID          string `json:"id"`
	TenantID    string `json:"tenant_id"`
	Kind        string `json:"kind"`
	DisplayName string `json:"display_name"`
}

type roomValue struct {
	ID          string     `json:"id"`
	TenantID    string     `json:"tenant_id"`
	Name        string     `json:"name"`
	Description *string    `json:"description,omitempty"`
	CreatedBy   actorValue `json:"created_by"`
	CreatedAt   time.Time  `json:"created_at"`
	UpdatedAt   time.Time  `json:"updated_at"`
}

type roomMemberValue struct {
	RoomID    string     `json:"room_id"`
	Actor     actorValue `json:"actor"`
	Role      string     `json:"role"`
	AddedBy   actorValue `json:"added_by"`
	JoinedAt  time.Time  `json:"joined_at"`
	UpdatedAt time.Time  `json:"updated_at"`
}

// DirectSpec is one Human-Agent pair. The Human opens its direct Room, or the
// Agent opens it to write to its sponsor. Name names a new Room.
type DirectSpec struct {
	TenantID string
	Human    store.Actor
	Agent    store.Actor
	ByAgent  bool
	Name     string
}

type DirectResult struct {
	Room    store.Room
	Created bool
}

// OpenOrCreateDirectRoom returns the pair's direct Room. It creates one when
// the pair has none or its last one finished deletion, and the pair then
// names the new Room; a Room still being deleted is ErrDirectRoomDeleting.
// Call it before taking any row lock: a new Room admits the Agent, so it takes
// the Agent lock, which a caller already holding it takes again at no cost.
func OpenOrCreateDirectRoom(ctx context.Context, queries *store.Queries, spec DirectSpec) (DirectResult, error) {
	if spec.TenantID == "" || spec.Human.Kind != "human" || spec.Agent.Kind != "agent" {
		return DirectResult{}, ErrInvalid
	}
	if err := tenantmembership.LockAgent(ctx, queries, spec.Agent.ID); err != nil {
		return DirectResult{}, err
	}
	if err := queries.AcquireAdvisoryTransactionLock(ctx, "direct-room|"+spec.TenantID+"|"+spec.Human.ID+"|"+spec.Agent.ID); err != nil {
		return DirectResult{}, err
	}
	existing, err := queries.GetDirectRoomByPair(ctx, store.GetDirectRoomByPairParams{
		TenantID: spec.TenantID, HumanActorID: spec.Human.ID, AgentActorID: spec.Agent.ID,
	})
	switch {
	case err == nil && !existing.DeletionStartedAt.Valid:
		return DirectResult{Room: existing}, nil
	case err == nil && !existing.DeletedAt.Valid:
		return DirectResult{}, ErrDirectRoomDeleting
	case err != nil && !errors.Is(err, pgx.ErrNoRows):
		return DirectResult{}, err
	}
	room := Spec{
		TenantID: spec.TenantID, Name: spec.Name, Creator: spec.Human, Owner: spec.Human,
		MemberActorIDs: []string{spec.Agent.ID}, AgentsAuthorized: true, SuppressAgentMetaContexts: true,
	}
	if spec.ByAgent {
		room.Creator, room.MemberActorIDs, room.AgentsAuthorized = spec.Agent, nil, false
	}
	// The pair's last Room finished deletion: it stays as history and stops
	// holding the pair, which one Room at a time holds.
	if err := queries.ReleaseFinishedDirectRoomPair(ctx, store.ReleaseFinishedDirectRoomPairParams{
		TenantID: spec.TenantID, HumanActorID: spec.Human.ID, AgentActorID: spec.Agent.ID,
	}); err != nil {
		return DirectResult{}, err
	}
	created, err := Create(ctx, queries, room)
	if err != nil {
		return DirectResult{}, err
	}
	if _, err := queries.MarkDirectRoom(ctx, store.MarkDirectRoomParams{
		RoomID: created.Room.ID, TenantID: spec.TenantID, HumanActorID: spec.Human.ID, AgentActorID: spec.Agent.ID,
	}); err != nil {
		return DirectResult{}, err
	}
	created.Room.DirectHumanActorID = pgtype.Text{String: spec.Human.ID, Valid: true}
	created.Room.DirectAgentActorID = pgtype.Text{String: spec.Agent.ID, Valid: true}
	// Only now does the Agent's Room Context see the Room as direct.
	if err := agentruntimestate.EnsurePerRoomMetaContexts(ctx, queries, spec.Agent.ID); err != nil {
		return DirectResult{}, err
	}
	return DirectResult{Room: created.Room, Created: true}, nil
}

// Create writes one Room with its owner, creator and members and their Room
// Events. It takes the Agent lock of every admitted Agent before it reads
// their registrations.
func Create(ctx context.Context, queries *store.Queries, spec Spec) (Result, error) {
	admitted := slices.Clone(spec.MemberActorIDs)
	if spec.Creator.Kind == "agent" {
		admitted = append(admitted, spec.Creator.ID)
	}
	if err := tenantmembership.LockAgents(ctx, queries, admitted...); err != nil {
		return Result{}, err
	}
	members, err := validateAndResolveMembers(ctx, queries, spec)
	if err != nil {
		return Result{}, err
	}
	description := pgtype.Text{}
	if spec.Description != nil {
		description = pgtype.Text{String: *spec.Description, Valid: true}
	}
	room, err := queries.CreateRoom(ctx, store.CreateRoomParams{
		ID: idgen.New("room"), TenantID: spec.TenantID, Name: spec.Name,
		Description: description, CreatedByActorID: spec.Creator.ID,
	})
	if err != nil {
		return Result{}, err
	}
	if _, err := queries.CreateRoomMember(ctx, store.CreateRoomMemberParams{
		RoomID: room.ID, TenantID: room.TenantID, ActorID: spec.Owner.ID,
		Role: "owner", AddedByActorID: spec.Creator.ID,
	}); err != nil {
		return Result{}, err
	}
	createdSeq, err := roomevent.Append(ctx, queries, roomevent.Input{
		TenantID: room.TenantID, RoomID: room.ID, EventType: "room.created",
		ActorID: spec.Creator.ID, ResourceID: room.ID,
		Payload: map[string]any{
			"kind": "room.created", "room": projectRoom(room, spec.Creator),
		},
	})
	if err != nil {
		return Result{}, err
	}
	if err := queries.CreateRoomMemberState(ctx, store.CreateRoomMemberStateParams{
		RoomID: room.ID, ActorID: spec.Owner.ID, ReadThroughRoomSeq: createdSeq,
	}); err != nil {
		return Result{}, err
	}
	if spec.Creator.ID != spec.Owner.ID {
		if err := addMember(ctx, queries, room, spec.Creator, spec.Creator, spec.SuppressAgentMetaContexts); err != nil {
			return Result{}, err
		}
	}
	for _, actorID := range spec.MemberActorIDs {
		if err := addMember(ctx, queries, room, spec.Creator, members[actorID], spec.SuppressAgentMetaContexts); err != nil {
			return Result{}, err
		}
	}
	return Result{Room: room, Creator: spec.Creator}, nil
}

func validateAndResolveMembers(ctx context.Context, queries *store.Queries, input Spec) (map[string]store.Actor, error) {
	if input.TenantID == "" || input.Name == "" || strings.TrimSpace(input.Name) != input.Name ||
		utf8.RuneCountInString(input.Name) > 120 || input.Description != nil && utf8.RuneCountInString(*input.Description) > 2000 ||
		input.Creator.ID == "" || input.Creator.TenantID != input.TenantID ||
		input.Owner.ID == "" || input.Owner.TenantID != input.TenantID || input.Owner.Kind != "human" ||
		!input.Owner.AccountID.Valid || input.Owner.AccountID.String == "" || len(input.MemberActorIDs) > 100 {
		return nil, ErrInvalid
	}
	if input.Creator.Kind != "human" && input.Creator.Kind != "agent" {
		return nil, ErrInvalid
	}
	ids := append([]string(nil), input.MemberActorIDs...)
	sort.Strings(ids)
	for index, actorID := range ids {
		if actorID == "" || actorID == input.Creator.ID || actorID == input.Owner.ID || index > 0 && actorID == ids[index-1] {
			return nil, ErrInvalid
		}
	}
	if input.Creator.Kind == "agent" {
		if err := validateAgentAdmission(ctx, queries, input, input.Creator.ID); err != nil {
			return nil, err
		}
	}
	if len(ids) == 0 {
		return map[string]store.Actor{}, nil
	}
	actors, err := queries.ListActorsByTenantIDs(ctx, store.ListActorsByTenantIDsParams{TenantID: input.TenantID, ActorIds: ids})
	if err != nil {
		return nil, err
	}
	if len(actors) != len(ids) {
		return nil, ErrNotFound
	}
	result := make(map[string]store.Actor, len(actors))
	for _, actor := range actors {
		if actor.Kind == "agent" {
			if err := validateAgentAdmission(ctx, queries, input, actor.ID); err != nil {
				return nil, err
			}
		} else if actor.Kind != "human" {
			return nil, ErrInvalid
		}
		result[actor.ID] = actor
	}
	return result, nil
}

func validateAgentAdmission(ctx context.Context, queries *store.Queries, spec Spec, actorID string) error {
	registration, err := queries.GetActiveAgentRegistrationForAdmission(ctx, store.GetActiveAgentRegistrationForAdmissionParams{
		ActorID: actorID, TenantID: spec.TenantID,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrAgentUnavailable
	}
	if err != nil {
		return err
	}
	if !spec.AgentsAuthorized && registration.CreatedByActorID != spec.Owner.ID {
		return ErrAgentSponsorRequired
	}
	return nil
}

func addMember(
	ctx context.Context,
	queries *store.Queries,
	room store.Room,
	creator, actor store.Actor,
	suppressAgentMetaContexts bool,
) error {
	membership, err := queries.CreateRoomMember(ctx, store.CreateRoomMemberParams{
		RoomID: room.ID, TenantID: room.TenantID, ActorID: actor.ID,
		Role: "member", AddedByActorID: creator.ID,
	})
	if err != nil {
		return err
	}
	member := roomMemberValue{
		RoomID: membership.RoomID, Actor: projectActor(actor), Role: membership.Role,
		AddedBy: projectActor(creator), JoinedAt: membership.JoinedAt.Time, UpdatedAt: membership.UpdatedAt.Time,
	}
	seq, err := roomevent.Append(ctx, queries, roomevent.Input{
		TenantID: room.TenantID, RoomID: room.ID, EventType: "room.member.added",
		ActorID: creator.ID, ResourceID: actor.ID,
		Payload: map[string]any{
			"kind": "room.member.added", "member": member,
		},
	})
	if err != nil {
		return err
	}
	if actor.Kind == "agent" && !suppressAgentMetaContexts {
		if err := agentruntimestate.EnsurePerRoomMetaContexts(ctx, queries, actor.ID); err != nil {
			return err
		}
	}
	if actor.Kind == "human" {
		return queries.CreateRoomMemberState(ctx, store.CreateRoomMemberStateParams{
			RoomID: room.ID, ActorID: actor.ID, ReadThroughRoomSeq: seq,
		})
	}
	return nil
}

func projectRoom(room store.Room, creator store.Actor) roomValue {
	result := roomValue{
		ID: room.ID, TenantID: room.TenantID, Name: room.Name, CreatedBy: projectActor(creator),
		CreatedAt: room.CreatedAt.Time, UpdatedAt: room.UpdatedAt.Time,
	}
	if room.Description.Valid {
		result.Description = &room.Description.String
	}
	return result
}

func projectActor(actor store.Actor) actorValue {
	return actorValue{ID: actor.ID, TenantID: actor.TenantID, Kind: actor.Kind, DisplayName: actor.DisplayName}
}
