package collaboration

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/oapi-codegen/runtime/types"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/messagereaction"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

// Page is one cursor page of a list read.
type Page struct {
	Cursor string
	Limit  int32
}

func pageMeta(hasMore bool, cursor string) httpapi.PageMeta {
	page := httpapi.PageMeta{HasMore: hasMore}
	if hasMore && cursor != "" {
		page.NextCursor = &cursor
	}
	return page
}

// ListActors lists the Tenant's Actors the Account can see.
func (s *Service) ListActors(ctx context.Context, accountID, tenantID string, page Page) (httpapi.ActorPage, error) {
	items, err := s.queries.ListActorsForTenantAccount(ctx, store.ListActorsForTenantAccountParams{
		TenantID: tenantID, AccountID: accountID, Cursor: page.Cursor, PageLimit: page.Limit + 1,
	})
	if err != nil {
		return httpapi.ActorPage{}, internal("list actors", err)
	}
	hasMore := len(items) > int(page.Limit)
	if hasMore {
		items = items[:page.Limit]
	}
	models := make([]httpapi.Actor, 0, len(items))
	for _, item := range items {
		model := ActorModel(store.Actor{
			ID: item.ID, TenantID: item.TenantID, Kind: item.Kind,
			DisplayName: item.DisplayName, AccountID: item.AccountID,
			Handle: item.Handle, CreatedAt: item.CreatedAt,
		})
		// Tenant members already share a workspace, so the picker may match an
		// invited address against people who are registered here.
		if item.AccountEmail.Valid {
			email := types.Email(item.AccountEmail.String)
			model.Email = &email
		}
		models = append(models, model)
	}
	lastID := ""
	if len(items) > 0 {
		lastID = items[len(items)-1].ID
	}
	return httpapi.ActorPage{Items: models, Page: pageMeta(hasMore, lastID)}, nil
}

// GetActor reads one Tenant Actor the Account can see.
func (s *Service) GetActor(ctx context.Context, accountID, tenantID, actorID string) (httpapi.Actor, error) {
	actor, err := s.queries.GetActorForTenantAccount(ctx, store.GetActorForTenantAccountParams{
		TenantID: tenantID, ID: actorID, AccountID: textValue(accountID),
	})
	if err != nil {
		return httpapi.Actor{}, err
	}
	return ActorModel(actor), nil
}

// ListRooms lists the Account's Rooms in the Tenant.
func (s *Service) ListRooms(ctx context.Context, accountID, tenantID string, page Page) (httpapi.RoomPage, error) {
	items, err := s.queries.ListRoomsForTenantAccount(ctx, store.ListRoomsForTenantAccountParams{
		TenantID: tenantID, AccountID: accountID, Cursor: page.Cursor, PageLimit: page.Limit + 1,
	})
	if err != nil {
		return httpapi.RoomPage{}, internal("list rooms", err)
	}
	models := make([]httpapi.RoomListItem, 0, min(len(items), int(page.Limit)))
	hasMore := len(items) > int(page.Limit)
	if hasMore {
		items = items[:page.Limit]
	}
	// One query resolves every creator on the page; Rooms come from one tenant.
	creatorIDs := make([]string, 0, len(items))
	for _, item := range items {
		creatorIDs = append(creatorIDs, item.CreatedByActorID)
	}
	creators, err := s.queries.ListActorsByTenantIDs(ctx, store.ListActorsByTenantIDsParams{
		TenantID: tenantID, ActorIds: creatorIDs,
	})
	if err != nil {
		return httpapi.RoomPage{}, internal("resolve room creators", err)
	}
	creatorByID := make(map[string]store.Actor, len(creators))
	for _, creator := range creators {
		creatorByID[creator.ID] = creator
	}
	for _, item := range items {
		creator, ok := creatorByID[item.CreatedByActorID]
		if !ok {
			return httpapi.RoomPage{}, internal("resolve room creator", pgx.ErrNoRows)
		}
		models = append(models, roomListItemModel(item, creator))
	}
	return httpapi.RoomPage{Items: models, Page: pageMeta(hasMore, lastRoomID(items))}, nil
}

// GetRoom reads one Room of the Account with its subtype and participation.
// It reports pgx.ErrNoRows when the Account cannot see the Room.
func (s *Service) GetRoom(ctx context.Context, accountID, roomID string) (httpapi.Room, error) {
	room, err := s.queries.GetRoomForAccount(ctx, store.GetRoomForAccountParams{ID: roomID, AccountID: textValue(accountID)})
	if err != nil {
		return httpapi.Room{}, err
	}
	creator, err := s.queries.GetActor(ctx, store.GetActorParams{TenantID: room.TenantID, ID: room.CreatedByActorID})
	if err != nil {
		return httpapi.Room{}, internal("resolve room creator", err)
	}
	model := roomModel(room, creator)
	peer, directErr := s.queries.GetDirectRoomPeerForAccount(ctx, store.GetDirectRoomPeerForAccountParams{
		RoomID: room.ID, AccountID: accountID,
	})
	if directErr == nil {
		model = directRoomModel(room, creator, store.Actor{
			ID: peer.ID, TenantID: peer.TenantID, Kind: peer.Kind, DisplayName: peer.DisplayName,
			AccountID: peer.AccountID, Handle: peer.Handle, CreatedAt: peer.CreatedAt,
		}, peer.Active)
	} else if !errors.Is(directErr, pgx.ErrNoRows) {
		return httpapi.Room{}, internal("resolve Direct Room peer", directErr)
	}
	thread, threadErr := s.queries.GetThreadRoomByRoomID(ctx, room.ID)
	if threadErr == nil {
		model = threadRoomModel(room, creator, thread.ParentRoomID, thread.RootMessageID)
	} else if !errors.Is(threadErr, pgx.ErrNoRows) {
		return httpapi.Room{}, internal("resolve Thread room", threadErr)
	}
	left, err := s.queries.GetRoomParticipationForAccount(ctx, store.GetRoomParticipationForAccountParams{ID: room.ID, AccountID: textValue(accountID)})
	if err != nil {
		return httpapi.Room{}, internal("get Room participation", err)
	}
	participation := httpapi.RoomParticipationStatus("joined")
	if left.Bool {
		participation = "left"
	}
	model.Participation = &participation
	model.SnapshotRoomSeq = &room.NextRoomSeq
	return model, nil
}

// InternalError marks a failure after the caller's access was established,
// so a pgx.ErrNoRows inside it is an inconsistency rather than a hidden
// resource.
type InternalError struct {
	Action string
	Err    error
}

func (e *InternalError) Error() string { return e.Action + ": " + e.Err.Error() }

func (e *InternalError) Unwrap() error { return e.Err }

// Internal wraps a failure after the caller's access was established.
func Internal(action string, err error) error {
	return &InternalError{Action: action, Err: err}
}

func internal(action string, err error) error { return Internal(action, err) }

// MessageReadStages receives the wall time of each step of a Message read.
type MessageReadStages interface {
	Stage(name string)
	Set(name string, value any)
}

// ListMessages reads one page of the Room's Message history with cards,
// attachments, contexts, reactions, thread summaries and Routine names.
// It reports pgx.ErrNoRows when the Account cannot see the Room.
func (s *Service) ListMessages(ctx context.Context, accountID, roomID string, page Page, stages MessageReadStages) (httpapi.MessagePage, error) {
	authority, err := s.queries.GetRoomForAccount(ctx, store.GetRoomForAccountParams{ID: roomID, AccountID: textValue(accountID)})
	stages.Stage("authorize")
	if err != nil {
		return httpapi.MessagePage{}, err
	}
	items, err := s.queries.ListMessagesForRoomAccount(ctx, store.ListMessagesForRoomAccountParams{RoomID: roomID, AccountID: accountID, Cursor: page.Cursor, PageLimit: page.Limit + 1})
	stages.Stage("messages")
	if err != nil {
		return httpapi.MessagePage{}, internal("list messages", err)
	}
	hasMore := len(items) > int(page.Limit)
	if hasMore {
		items = items[1:]
	}
	stages.Set("message_count", len(items))
	cardMessageIDs := make([]string, 0, len(items))
	messageIDs := make([]string, 0, len(items))
	agentMessageIDs := make([]string, 0, len(items))
	for _, item := range items {
		messageIDs = append(messageIDs, item.ID)
		if item.AuthorKind == "agent" {
			agentMessageIDs = append(agentMessageIDs, item.ID)
		}
		if item.HasCard {
			cardMessageIDs = append(cardMessageIDs, item.ID)
		}
	}
	cards, err := s.typedCards.HydrateCards(ctx, cardMessageIDs)
	stages.Stage("cards")
	if err != nil {
		return httpapi.MessagePage{}, internal("hydrate message cards", err)
	}
	attachments, err := s.hydrateMessageAttachments(ctx, messageIDs)
	stages.Stage("attachments")
	if err != nil {
		return httpapi.MessagePage{}, internal("hydrate message attachments", err)
	}
	contexts, err := s.hydrateMessageContexts(ctx, messageIDs)
	stages.Stage("contexts")
	if err != nil {
		return httpapi.MessagePage{}, internal("hydrate message contexts", err)
	}
	reactionsByMessage, err := messagereaction.ListForMessages(ctx, s.queries, messageIDs)
	stages.Stage("reactions")
	if err != nil {
		return httpapi.MessagePage{}, internal("hydrate message reactions", err)
	}
	threadSummaries, err := s.hydrateMessageThreadSummaries(ctx, roomID, messageIDs)
	stages.Stage("threads")
	if err != nil {
		return httpapi.MessagePage{}, internal("hydrate message thread summaries", err)
	}
	stages.Set("thread_count", len(threadSummaries))
	routineNames, err := s.hydrateRoutineMessageNames(ctx, roomID, agentMessageIDs)
	stages.Stage("routine_names")
	if err != nil {
		return httpapi.MessagePage{}, internal("hydrate Routine Message names", err)
	}
	models := make([]httpapi.Message, 0, len(items))
	for _, item := range items {
		author := store.Actor{
			ID: item.AuthorActorID, TenantID: item.TenantID, Kind: item.AuthorKind,
			DisplayName: item.AuthorDisplayName, AccountID: item.AuthorAccountID,
			Handle: item.AuthorHandle, CreatedAt: item.AuthorCreatedAt,
		}
		model, err := messageModel(item.ID, item.TenantID, item.RoomID, item.Body, item.Segments, item.MessageKind, item.CardContextMessageID, item.ReplyToMessageID, item.CardTitle, item.CardKind, item.CreatedAt, author)
		if err == nil {
			err = ApplyMessageNotice(&model, item.Notice)
		}
		if err != nil {
			return httpapi.MessagePage{}, internal("decode message content", err)
		}
		if name, found := routineNames[item.ID]; found && item.AuthorKind == "agent" {
			model.RoutineName = &name
		}
		if summary, found := threadSummaries[item.ID]; found {
			model.Thread = &summary
		}
		if item.HasCard {
			encoded, found := cards[item.ID]
			if !found {
				return httpapi.MessagePage{}, internal("hydrate message card", errors.New("Message card batch projection is missing"))
			}
			if err := applyMessageCard(&model, encoded); err != nil {
				return httpapi.MessagePage{}, internal("hydrate message card", err)
			}
		}
		model.Attachments = attachments[item.ID]
		if values := contexts[item.ID]; len(values) > 0 {
			model.ContextMessages = &values
		}
		if reactions := messagereaction.Models(reactionsByMessage[item.ID]); reactions != nil {
			model.Reactions = &reactions
		}
		models = append(models, model)
	}
	stages.Stage("projection")
	return httpapi.MessagePage{Items: models, Page: pageMeta(hasMore, firstMessageID(items)), SnapshotRoomSeq: authority.NextRoomSeq}, nil
}

// GetMessage reads one Message of a Room the Account can see, fully hydrated.
// It reports pgx.ErrNoRows when the Message is not visible.
func (s *Service) GetMessage(ctx context.Context, accountID, roomID, messageID string) (httpapi.Message, error) {
	message, err := s.queries.GetMessageForAccount(ctx, store.GetMessageForAccountParams{ID: messageID, RoomID: roomID, AccountID: textValue(accountID)})
	if err != nil {
		return httpapi.Message{}, err
	}
	author := store.Actor{
		ID: message.AuthorActorID, TenantID: message.TenantID, Kind: message.AuthorKind,
		DisplayName: message.AuthorDisplayName, AccountID: message.AuthorAccountID,
		Handle: message.AuthorHandle, CreatedAt: message.AuthorCreatedAt,
	}
	model, err := messageModel(message.ID, message.TenantID, message.RoomID, message.Body, message.Segments, message.MessageKind, message.CardContextMessageID, message.ReplyToMessageID, message.CardTitle, message.CardKind, message.CreatedAt, author)
	if err == nil {
		err = ApplyMessageNotice(&model, message.Notice)
	}
	if err != nil {
		return httpapi.Message{}, internal("decode message content", err)
	}
	if message.AuthorKind == "agent" {
		routineNames, err := s.hydrateRoutineMessageNames(ctx, message.RoomID, []string{message.ID})
		if err != nil {
			return httpapi.Message{}, internal("hydrate Routine Message name", err)
		}
		if name, found := routineNames[message.ID]; found {
			model.RoutineName = &name
		}
	}
	threadSummaries, err := s.hydrateMessageThreadSummaries(ctx, message.RoomID, []string{message.ID})
	if err != nil {
		return httpapi.Message{}, internal("hydrate message thread summary", err)
	}
	if summary, found := threadSummaries[message.ID]; found {
		model.Thread = &summary
	}
	if message.HasCard {
		if err := s.hydrateMessageCard(ctx, &model); err != nil {
			return httpapi.Message{}, internal("hydrate message card", err)
		}
	}
	attachments, err := s.hydrateMessageAttachments(ctx, []string{message.ID})
	if err != nil {
		return httpapi.Message{}, internal("hydrate message attachments", err)
	}
	model.Attachments = attachments[message.ID]
	contexts, err := s.hydrateMessageContexts(ctx, []string{message.ID})
	if err != nil {
		return httpapi.Message{}, internal("hydrate message contexts", err)
	}
	if values := contexts[message.ID]; len(values) > 0 {
		model.ContextMessages = &values
	}
	reactionsByMessage, err := messagereaction.ListForMessages(ctx, s.queries, []string{message.ID})
	if err != nil {
		return httpapi.Message{}, internal("hydrate message reactions", err)
	}
	if reactions := messagereaction.Models(reactionsByMessage[message.ID]); reactions != nil {
		model.Reactions = &reactions
	}
	return model, nil
}
