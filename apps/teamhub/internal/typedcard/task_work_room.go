package typedcard

import (
	"context"
	"unicode/utf8"

	"github.com/jackc/pgx/v5/pgtype"
	idgen "github.com/simplexai-labs/linger/apps/teamhub/internal/ids"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/messagecreation"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/roomcreation"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

// createTaskWorkRoom creates the Task's Work Room in the caller's transaction.
// The creator Agent creates it under the owner's authority, posts the initial
// Task message and links the Room as the Task's Work Room. The Work Room never
// hosts Meta Contexts.
func createTaskWorkRoom(
	ctx context.Context,
	queries *store.Queries,
	tenantID string,
	taskID string,
	title string,
	description string,
	initialMessageSegments []messagecreation.Segment,
	creator store.Actor,
	owner store.Actor,
	memberActorIDs []string,
) (store.Room, error) {
	if tenantID == "" || taskID == "" || creator.ID == "" || owner.ID == "" {
		return store.Room{}, ErrInvalid
	}

	roomDescription := description
	created, err := roomcreation.Create(ctx, queries, roomcreation.Spec{
		TenantID: tenantID,
		Name:     taskWorkRoomName(title),
		Description: func() *string {
			if roomDescription == "" {
				return nil
			}
			return &roomDescription
		}(),
		Creator:                   creator,
		Owner:                     owner,
		MemberActorIDs:            creationRoomMemberIDs(memberActorIDs, creator.ID, owner.ID),
		AgentsAuthorized:          true,
		SuppressAgentMetaContexts: true,
	})
	if err != nil {
		return store.Room{}, err
	}
	room := created.Room
	content, err := messagecreation.Normalize(initialMessageSegments)
	if err != nil {
		return store.Room{}, ErrInvalid
	}
	if _, err := messagecreation.Create(ctx, queries, messagecreation.Draft{
		TenantID: tenantID, RoomID: room.ID, Author: creator, Content: content,
	}); err != nil {
		return store.Room{}, err
	}
	if _, err := queries.CreateWorkItemRoomLink(ctx, store.CreateWorkItemRoomLinkParams{
		WorkItemID: taskID, TenantID: tenantID, LinkType: "work", RoomID: room.ID,
		OriginMessageID: pgtype.Text{}, LinkedByActorID: owner.ID,
	}); err != nil {
		return store.Room{}, err
	}
	if _, err := queries.CreateWorkItemRoomActivity(ctx, store.CreateWorkItemRoomActivityParams{
		ID: idgen.New("activity"), WorkItemID: taskID, TenantID: tenantID,
		ActorID: owner.ID, RoomID: pgtype.Text{String: room.ID, Valid: true},
	}); err != nil {
		return store.Room{}, err
	}
	if err := queries.TouchWorkItem(ctx, store.TouchWorkItemParams{
		ID: taskID, TenantID: tenantID, UpdatedByActorID: owner.ID,
	}); err != nil {
		return store.Room{}, err
	}
	return room, nil
}

func taskWorkRoomName(title string) string {
	const prefix = "Task · "
	maximumTitleLength := 120 - utf8.RuneCountInString(prefix)
	return prefix + string([]rune(title)[:min(utf8.RuneCountInString(title), maximumTitleLength)])
}
