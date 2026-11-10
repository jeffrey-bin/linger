package collaboration

import (
	"context"
	"errors"
	"sort"

	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentruntimestate"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/messagecreation"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/roomevent"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

// ErrInvalidMention reports a reference that does not name an eligible Room member.
var ErrInvalidMention = errors.New("message reference target is not a matching Room member")

func resolveAndAdmitMessageMentions(ctx context.Context, queries *store.Queries, tenantID, roomID string, caller store.Actor, content MessageContent) ([]store.Actor, error) {
	expectedKinds := make(map[string]string)
	for _, segment := range content.segments {
		discriminator, err := segment.Discriminator()
		if err != nil {
			return nil, err
		}
		if discriminator != "reference" {
			continue
		}
		reference, err := segment.AsReferenceSegment()
		if err != nil {
			return nil, err
		}
		expectedKind := "human"
		if reference.TargetType == httpapi.ReferenceSegmentTargetTypeAgent {
			expectedKind = "agent"
		}
		if existing, found := expectedKinds[reference.Target]; found && existing != expectedKind {
			return nil, ErrInvalidMention
		}
		expectedKinds[reference.Target] = expectedKind
	}
	if len(expectedKinds) == 0 {
		return nil, nil
	}
	targetIDs := make([]string, 0, len(expectedKinds))
	for targetID := range expectedKinds {
		targetIDs = append(targetIDs, targetID)
	}
	sort.Strings(targetIDs)
	targets, err := queries.ListTenantMentionTargets(ctx, store.ListTenantMentionTargetsParams{TenantID: tenantID, Column2: targetIDs})
	if err != nil {
		return nil, err
	}
	if len(targets) != len(targetIDs) {
		return nil, ErrInvalidMention
	}
	membershipRoomID, neverAdmit, err := mentionMembershipRoom(ctx, queries, roomID)
	if err != nil {
		return nil, err
	}
	for _, target := range targets {
		if expectedKinds[target.ID] != target.Kind {
			return nil, ErrInvalidMention
		}
		_, membershipErr := queries.GetRoomMemberForNoKeyUpdate(ctx, store.GetRoomMemberForNoKeyUpdateParams{
			RoomID: membershipRoomID, ActorID: target.ID,
		})
		if membershipErr == nil {
			continue
		}
		if !errors.Is(membershipErr, pgx.ErrNoRows) {
			return nil, membershipErr
		}
		if neverAdmit {
			return nil, ErrInvalidMention
		}
		if direct, directErr := queries.IsDirectRoom(ctx, roomID); directErr != nil {
			return nil, directErr
		} else if direct {
			return nil, ErrInvalidMention
		}
		if target.Kind == "agent" {
			registration, registrationErr := queries.GetActiveAgentRegistrationForAdmission(ctx, store.GetActiveAgentRegistrationForAdmissionParams{
				ActorID: target.ID, TenantID: tenantID,
			})
			if registrationErr != nil || registration.VisibilityScope != "workspace" && registration.CreatedByActorID != caller.ID {
				return nil, ErrInvalidMention
			}
		}
		membership, createErr := queries.CreateRoomMember(ctx, store.CreateRoomMemberParams{
			RoomID: roomID, TenantID: tenantID, ActorID: target.ID,
			Role: string(httpapi.Member), AddedByActorID: caller.ID,
		})
		if createErr != nil {
			return nil, createErr
		}
		member := roomMemberModel(roomMemberRecord{
			roomID: membership.RoomID, tenantID: membership.TenantID, actorID: membership.ActorID,
			role: membership.Role, addedByActorID: membership.AddedByActorID,
			actorKind: target.Kind, actorDisplayName: target.DisplayName,
			adderKind: caller.Kind, adderDisplayName: caller.DisplayName,
			joinedAt: membership.JoinedAt, updatedAt: membership.UpdatedAt,
		})
		seq, eventErr := roomevent.Append(ctx, queries, roomevent.Input{
			TenantID: tenantID, RoomID: roomID, EventType: "room.member.added",
			ActorID: caller.ID, ResourceID: target.ID,
			Payload: map[string]any{
				"kind": "room.member.added", "member": member,
			},
		})
		if eventErr != nil {
			return nil, eventErr
		}
		if target.Kind == "agent" {
			if err := agentruntimestate.EnsurePerRoomMetaContexts(ctx, queries, target.ID); err != nil {
				return nil, err
			}
		}
		if target.Kind == "human" {
			if stateErr := queries.CreateRoomMemberState(ctx, store.CreateRoomMemberStateParams{
				RoomID: roomID, ActorID: target.ID, ReadThroughRoomSeq: seq,
			}); stateErr != nil {
				return nil, stateErr
			}
		}
		// The notice precedes the Message that mentioned the new member.
		if _, err := messagecreation.CreateNotice(ctx, queries, tenantID, roomID, caller, messagecreation.MemberAdded(target)); err != nil {
			return nil, err
		}
	}
	return targets, nil
}

func mentionMembershipRoom(ctx context.Context, queries *store.Queries, roomID string) (string, bool, error) {
	thread, err := queries.GetThreadRoomByRoomID(ctx, roomID)
	if errors.Is(err, pgx.ErrNoRows) {
		return roomID, false, nil
	}
	if err != nil {
		return "", false, err
	}
	return thread.ParentRoomID, true, nil
}
