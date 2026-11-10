package collaboration

import (
	"context"
	"errors"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	idgen "github.com/simplexai-labs/linger/apps/teamhub/internal/ids"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/roomevent"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

var (
	// ErrThreadNested reports a Thread started inside a Thread.
	ErrThreadNested = errors.New("thread rooms cannot contain nested threads")
	// ErrThreadRootInvalid reports a Thread root that is not a parent-timeline conversation Message.
	ErrThreadRootInvalid = errors.New("thread root message is invalid")
)

// CreateOrGetMessageThread opens the Thread of a conversation Message,
// creating it once; the flag reports whether this call created it.
func (s *Service) CreateOrGetMessageThread(ctx context.Context, accountID, parentRoomID, rootMessageID string) (httpapi.ThreadRoom, bool, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return httpapi.ThreadRoom{}, false, err
	}
	defer tx.Rollback(ctx)
	queries := s.queries.WithTx(tx)
	if err := queries.AcquireAdvisoryTransactionLock(ctx, "thread-root|"+parentRoomID+"|"+rootMessageID); err != nil {
		return httpapi.ThreadRoom{}, false, err
	}
	parent, err := queries.GetRoomForAccount(ctx, store.GetRoomForAccountParams{ID: parentRoomID, AccountID: textValue(accountID)})
	if err != nil {
		return httpapi.ThreadRoom{}, false, err
	}
	if isThread, err := queries.IsThreadRoom(ctx, parent.ID); err != nil {
		return httpapi.ThreadRoom{}, false, err
	} else if isThread {
		return httpapi.ThreadRoom{}, false, ErrThreadNested
	}
	root, err := queries.GetMessageInRoom(ctx, store.GetMessageInRoomParams{ID: rootMessageID, RoomID: parent.ID})
	if err != nil {
		return httpapi.ThreadRoom{}, false, err
	}
	if root.MessageKind != "conversation" {
		return httpapi.ThreadRoom{}, false, ErrThreadRootInvalid
	}
	actor, err := queries.GetHumanActor(ctx, store.GetHumanActorParams{TenantID: parent.TenantID, AccountID: textValue(accountID)})
	if err != nil {
		return httpapi.ThreadRoom{}, false, err
	}
	existing, err := queries.GetThreadRoomByRoot(ctx, store.GetThreadRoomByRootParams{
		ParentRoomID: parent.ID, RootMessageID: root.ID,
	})
	if err == nil {
		if err := queries.MarkThreadOpened(ctx, store.MarkThreadOpenedParams{
			RoomID: existing.RoomID, ActorID: actor.ID,
		}); err != nil {
			return httpapi.ThreadRoom{}, false, err
		}
		thread, modelErr := existingThreadRoom(ctx, queries, existing.RoomID, existing.ParentRoomID, existing.RootMessageID)
		if modelErr != nil {
			return httpapi.ThreadRoom{}, false, modelErr
		}
		return thread, false, tx.Commit(ctx)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return httpapi.ThreadRoom{}, false, err
	}
	room, err := queries.CreateRoom(ctx, store.CreateRoomParams{
		ID: idgen.New("room"), TenantID: parent.TenantID, Name: threadRoomName(parent.Name),
		CreatedByActorID: actor.ID,
	})
	if err != nil {
		return httpapi.ThreadRoom{}, false, err
	}
	creator, err := queries.GetActor(ctx, store.GetActorParams{ID: actor.ID, TenantID: parent.TenantID})
	if err != nil {
		return httpapi.ThreadRoom{}, false, err
	}
	threadModel := threadRoomModel(room, creator, parent.ID, root.ID)
	// room.created precedes setting rooms.parent_room_id on purpose: the
	// delivery trigger maps a Thread to its parent Room's members only once
	// the parent is set, so this event reaches no Account. Threads stay out of Room
	// lists; the creator gets the Room from the response, and later Thread
	// events reach the parent Room's members.
	if _, err := roomevent.Append(ctx, queries, roomevent.Input{
		TenantID: room.TenantID, RoomID: room.ID, EventType: "room.created",
		ActorID: actor.ID, ResourceID: room.ID,
		Payload: map[string]any{
			"kind": "room.created", "room": threadModel,
		},
	}); err != nil {
		return httpapi.ThreadRoom{}, false, err
	}
	if _, err := queries.SetThreadRoomParent(ctx, store.SetThreadRoomParentParams{
		RoomID: room.ID, TenantID: room.TenantID, ParentRoomID: parent.ID, RootMessageID: root.ID,
	}); err != nil {
		return httpapi.ThreadRoom{}, false, err
	}
	if err := queries.MarkThreadOpened(ctx, store.MarkThreadOpenedParams{
		RoomID: room.ID, ActorID: actor.ID,
	}); err != nil {
		return httpapi.ThreadRoom{}, false, err
	}
	return httpapi.ThreadRoom{Room: threadModel}, true, tx.Commit(ctx)
}

func existingThreadRoom(ctx context.Context, queries *store.Queries, roomID, parentRoomID, rootMessageID string) (httpapi.ThreadRoom, error) {
	room, err := queries.GetRoomByID(ctx, roomID)
	if err != nil {
		return httpapi.ThreadRoom{}, err
	}
	creator, err := queries.GetActor(ctx, store.GetActorParams{ID: room.CreatedByActorID, TenantID: room.TenantID})
	if err != nil {
		return httpapi.ThreadRoom{}, err
	}
	return httpapi.ThreadRoom{Room: threadRoomModel(room, creator, parentRoomID, rootMessageID)}, nil
}

func threadRoomName(parentName string) string {
	const suffix = " Thread"
	if utf8.RuneCountInString(parentName)+utf8.RuneCountInString(suffix) <= 120 {
		return parentName + suffix
	}
	parentRunes := []rune(parentName)
	limit := 120 - utf8.RuneCountInString(suffix)
	return string(parentRunes[:limit]) + suffix
}

func (s *Service) hydrateMessageThreadSummaries(ctx context.Context, parentRoomID string, messageIDs []string) (map[string]httpapi.MessageThreadSummary, error) {
	result := map[string]httpapi.MessageThreadSummary{}
	if len(messageIDs) == 0 {
		return result, nil
	}
	rows, err := s.queries.ListMessageThreadSummaries(ctx, store.ListMessageThreadSummariesParams{
		ParentRoomID: parentRoomID, MessageIds: messageIDs,
	})
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return result, nil
	}
	threadRoomIDs := make([]string, 0, len(rows))
	for _, row := range rows {
		threadRoomIDs = append(threadRoomIDs, row.RoomID)
	}
	authors, err := s.queries.ListLatestThreadReplyAuthorsBatch(ctx, threadRoomIDs)
	if err != nil {
		return nil, err
	}
	authorsByThread := make(map[string][]httpapi.ActorRef, len(rows))
	for _, author := range authors {
		authorsByThread[author.RoomID] = append(authorsByThread[author.RoomID], ActorRef(author.Actor))
	}
	for _, row := range rows {
		result[row.RootMessageID] = messageThreadSummary(row.RoomID, row.ReplyCount, timestamptzValue(row.LatestReplyAt), authorsByThread[row.RoomID])
	}
	return result, nil
}
