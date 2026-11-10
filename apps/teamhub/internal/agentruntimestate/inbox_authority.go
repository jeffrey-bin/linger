package agentruntimestate

import (
	"bytes"
	"context"
	"encoding/json"
	"slices"
	"strings"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

func runtimeInputsForAuthority(rows []store.AgentRuntimeInput) []RuntimeInput {
	inputs := make([]RuntimeInput, len(rows))
	for index, row := range rows {
		inputs[index] = RuntimeInput{InputID: row.InputID, Payload: row.Payload, SourceInboxID: row.SourceInboxID.String}
	}
	return inputs
}

// Source hints cannot authorize a different Input set after waiting on locks.
// Selection/recovery still re-read mutable statuses and apply their original CAS.
func sameRuntimeInputAuthority(hint, locked []store.AgentRuntimeInput) bool {
	if len(hint) != len(locked) {
		return false
	}
	for index := range hint {
		if hint[index].InputID != locked[index].InputID || !bytes.Equal(hint[index].PayloadHash, locked[index].PayloadHash) || !sameOptionalText(hint[index].SourceInboxID, locked[index].SourceInboxID) {
			return false
		}
	}
	return true
}

// inboxAuthority is what a reception lock established, read once under it:
// the Rooms whose membership the caller holds and the Agent's registration type.
type inboxAuthority struct {
	memberRooms map[string]bool
	agentType   string
}

func lockRuntimeInputsContext(ctx context.Context, queries *store.Queries, contextKey string, inputs []RuntimeInput, receiving bool) (contextRecord, inboxAuthority, error) {
	stored, err := queries.GetAgentExecutionContext(ctx, contextKey)
	owner := stored
	if isNoRows(err) {
		return owner, inboxAuthority{}, ErrNotFound
	}
	if err != nil {
		return owner, inboxAuthority{}, err
	}
	var inboxIDs []string
	for _, input := range inputs {
		var payload struct {
			SourceInboxIDs []string `json:"sourceInboxIds"`
		}
		if json.Unmarshal(input.Payload, &payload) != nil {
			return owner, inboxAuthority{}, ErrInvalid
		}
		inboxIDs = append(inboxIDs, payload.SourceInboxIDs...)
		if input.SourceInboxID != "" {
			inboxIDs = append(inboxIDs, input.SourceInboxID)
		}
	}
	return lockInboxContextForOwner(ctx, queries, owner, inboxIDs, receiving && owner.ContextKind == "meta")
}

func lockInboxContext(ctx context.Context, queries *store.Queries, contextKey string, inboxIDs []string, receiving bool) (contextRecord, inboxAuthority, error) {
	stored, err := queries.GetAgentExecutionContext(ctx, contextKey)
	owner := stored
	if isNoRows(err) {
		return owner, inboxAuthority{}, ErrNotFound
	}
	if err != nil {
		return owner, inboxAuthority{}, err
	}
	return lockInboxContextForOwner(ctx, queries, owner, inboxIDs, receiving)
}

// Membership/epoch locks come before Context and Room locks, in the canonical
// order documented on document.Lock. Waiting for membership after
// locking a Context or Room would invert that order. The unlocked owner is only
// an identity hint: identity is checked again after acquiring the Context lock.
func lockInboxContextForOwner(ctx context.Context, queries *store.Queries, owner contextRecord, inboxIDs []string, receiving bool) (contextRecord, inboxAuthority, error) {
	taskIDs := make([]string, 0)
	publicTasks := make(map[string]string)
	roomIDs := make([]string, 0)
	requiredRooms := make(map[string]bool)
	if owner.ContextKind == "meta" && owner.RoomID.Valid {
		roomIDs = append(roomIDs, owner.RoomID.String)
		requiredRooms[owner.RoomID.String] = true
	}
	for _, inboxID := range inboxIDs {
		switch {
		case strings.HasPrefix(inboxID, "room:"), strings.HasPrefix(inboxID, "thread:"):
			roomID := strings.TrimPrefix(strings.TrimPrefix(inboxID, "room:"), "thread:")
			roomIDs = append(roomIDs, roomID)
			if receiving {
				requiredRooms[roomID] = true
			}
		case strings.HasPrefix(inboxID, "task:"):
			taskID := strings.TrimPrefix(inboxID, "task:")
			taskIDs = append(taskIDs, taskID)
			publicTasks[taskID] = ""
		case strings.HasPrefix(inboxID, "taskmeta:"):
			taskIDs = append(taskIDs, strings.TrimPrefix(inboxID, "taskmeta:"))
		case strings.HasPrefix(inboxID, "meta:"):
			taskIDs = append(taskIDs, owner.TaskID.String)
		}
	}
	// Binding already holds Task UPDATE before adding coordination members.
	// SHARE stabilizes its Work Room link without opposing the Context FK lock.
	slices.Sort(taskIDs)
	taskIDs = slices.Compact(taskIDs)
	for _, taskID := range taskIDs {
		if _, err := queries.LockDirectInboxTaskAuthority(ctx, store.LockDirectInboxTaskAuthorityParams{TenantID: owner.TenantID, TaskID: taskID}); err != nil {
			return owner, inboxAuthority{}, err
		}
		link, err := queries.GetWorkItemRoomLink(ctx, store.GetWorkItemRoomLinkParams{WorkItemID: taskID, LinkType: "work"})
		if err != nil && !isNoRows(err) {
			return owner, inboxAuthority{}, err
		}
		if err == nil && link.TenantID == owner.TenantID {
			// Task coordination authority does not require Work Room membership.
			// Lock any existing membership used by the queued status projection.
			roomIDs = append(roomIDs, link.RoomID)
			if _, public := publicTasks[taskID]; public {
				publicTasks[taskID] = link.RoomID
			}
		}
	}
	memberRooms := make(map[string]bool)
	inboxAuthorized := true
	if len(roomIDs) != 0 {
		slices.Sort(roomIDs)
		members, err := queries.LockDirectInboxMembershipAuthority(ctx, store.LockDirectInboxMembershipAuthorityParams{TenantID: owner.TenantID, AgentActorID: owner.AgentActorID, RoomIds: slices.Compact(roomIDs)})
		if err != nil {
			return owner, inboxAuthority{}, err
		}
		for _, member := range members {
			delete(requiredRooms, member.SourceRoomID)
			memberRooms[member.MembershipRoomID] = true
		}
		if len(requiredRooms) != 0 {
			inboxAuthorized = false
		}
	}
	if receiving {
		for _, taskID := range taskIDs {
			roomID, public := publicTasks[taskID]
			if !public || memberRooms[roomID] {
				continue
			}
			// A coordinator/assignee/current participant can receive without a
			// member. A member arriving after the prelock cannot supply a grant.
			independent, err := queries.HasDirectTaskInboxNonmemberAuthority(ctx, store.HasDirectTaskInboxNonmemberAuthorityParams{TenantID: owner.TenantID, TaskID: taskID, AgentActorID: owner.AgentActorID})
			if err != nil {
				return owner, inboxAuthority{}, err
			}
			if !independent {
				inboxAuthorized = false
			}
		}
	}
	locked, err := lockContext(ctx, queries, owner.ContextKey)
	if err != nil {
		return owner, inboxAuthority{}, err
	}
	if locked.TenantID != owner.TenantID || locked.AgentActorID != owner.AgentActorID || locked.AgentManagementID != owner.AgentManagementID || locked.ContextKind != owner.ContextKind ||
		!sameOptionalText(locked.RoomID, owner.RoomID) || !sameOptionalText(locked.TaskID, owner.TaskID) || !sameOptionalText(locked.MembershipEpochID, owner.MembershipEpochID) {
		return locked, inboxAuthority{}, ErrFenced
	}
	// The Context lock already checked its Room authority.
	agentType, err := inboxRegistrationAgentType(ctx, queries, locked)
	if err != nil {
		return locked, inboxAuthority{}, err
	}
	// A missing Inbox grant must not invalidate an otherwise authoritative
	// Context. Its identity is checked first so a real fence still wins.
	if !inboxAuthorized {
		return locked, inboxAuthority{}, ErrInboxNotAuthorized
	}
	return locked, inboxAuthority{memberRooms: memberRooms, agentType: agentType}, nil
}
