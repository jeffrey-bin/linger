package collaboration

import (
	"context"
	"encoding/json"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

func (s *Service) hydrateMessageCard(ctx context.Context, model *httpapi.Message) error {
	encoded, found, err := s.typedCards.HydrateCard(ctx, model.Id)
	if err != nil || !found {
		return err
	}
	return applyMessageCard(model, encoded)
}

func applyMessageCard(model *httpapi.Message, encoded json.RawMessage) error {
	card := httpapi.DecisionRequestedMessageCard{}
	if err := json.Unmarshal(encoded, &card); err != nil {
		return err
	}
	model.Card = &card
	return nil
}

// ApplyMessageNotice projects the stored notice of a room_notice Message.
func ApplyMessageNotice(model *httpapi.Message, encoded []byte) error {
	if len(encoded) == 0 {
		return nil
	}
	notice := httpapi.MessageNotice{}
	if err := json.Unmarshal(encoded, &notice); err != nil {
		return err
	}
	model.Notice = &notice
	return nil
}

// ActorModel presents an Actor.
func ActorModel(actor store.Actor) httpapi.Actor {
	model := httpapi.Actor{
		Id: actor.ID, TenantId: actor.TenantID, Kind: httpapi.ActorKind(actor.Kind),
		DisplayName: actor.DisplayName, CreatedAt: actor.CreatedAt.Time,
	}
	if actor.AccountID.Valid {
		value := actor.AccountID.String
		model.AccountId = &value
	}
	if actor.Handle.Valid {
		value := actor.Handle.String
		model.Handle = &value
	}
	return model
}

// ActorRef presents an Actor reference.
func ActorRef(actor store.Actor) httpapi.ActorRef {
	return httpapi.ActorRef{Id: actor.ID, TenantId: actor.TenantID, Kind: httpapi.ActorKind(actor.Kind), DisplayName: actor.DisplayName}
}

func roomModel(room store.Room, creator store.Actor) httpapi.Room {
	model := httpapi.Room{
		Id: room.ID, TenantId: room.TenantID, Kind: httpapi.RoomKindRoom,
		Name: room.Name, CreatedBy: ActorRef(creator),
		CreatedAt: room.CreatedAt.Time, UpdatedAt: room.UpdatedAt.Time,
	}
	if room.Description.Valid {
		value := room.Description.String
		model.Description = &value
	}
	return model
}

func directRoomModel(room store.Room, creator, peer store.Actor, peerActive bool) httpapi.Room {
	model := roomModel(room, creator)
	model.Kind = httpapi.RoomKindDirect
	directPeer := ActorRef(peer)
	model.DirectPeer = &directPeer
	model.DirectPeerActive = &peerActive
	return model
}

func threadRoomModel(room store.Room, creator store.Actor, parentRoomID, rootMessageID string) httpapi.Room {
	model := roomModel(room, creator)
	model.Kind = httpapi.RoomKindThread
	model.ParentRoomId = &parentRoomID
	model.RootMessageId = &rootMessageID
	return model
}

func messageThreadSummary(roomID string, replyCount int64, latestReplyAt pgtype.Timestamptz, authors []httpapi.ActorRef) httpapi.MessageThreadSummary {
	summary := httpapi.MessageThreadSummary{RoomId: roomID, ReplyCount: replyCount}
	if latestReplyAt.Valid {
		value := latestReplyAt.Time
		summary.LatestReplyAt = &value
	}
	if len(authors) > 0 {
		summary.LatestReplyAuthors = &authors
	}
	return summary
}

func timestamptzValue(value any) pgtype.Timestamptz {
	switch typed := value.(type) {
	case nil:
		return pgtype.Timestamptz{}
	case time.Time:
		return pgtype.Timestamptz{Time: typed, Valid: true}
	case pgtype.Timestamptz:
		return typed
	default:
		return pgtype.Timestamptz{}
	}
}

func roomListItemModel(row store.ListRoomsForTenantAccountRow, creator store.Actor) httpapi.RoomListItem {
	model := httpapi.RoomListItem{
		Id: row.ID, TenantId: row.TenantID, Kind: httpapi.RoomKindRoom,
		Name: row.Name, CreatedBy: ActorRef(creator),
		CreatedAt: row.CreatedAt.Time, UpdatedAt: row.UpdatedAt.Time,
		LatestRoomSeq: row.NextRoomSeq, ReadThroughRoomSeq: row.ReadThroughRoomSeq,
		UnreadMessageCount: row.UnreadMessageCount, UnreadMentionCount: row.UnreadMentionCount,
	}
	participation := httpapi.RoomParticipationStatus("joined")
	if row.HasLeft {
		participation = "left"
	}
	model.Participation = &participation
	if row.IsDirect {
		model.Kind = httpapi.RoomKindDirect
		model.DirectPeer = &httpapi.ActorRef{
			Id: row.DirectPeerID, TenantId: row.TenantID,
			Kind: httpapi.ActorKind(row.DirectPeerKind), DisplayName: row.DirectPeerDisplayName,
		}
		model.DirectPeerActive = &row.DirectPeerActive
	}
	if row.IsThread {
		model.Kind = httpapi.RoomKindThread
		parentRoomID := row.ParentRoomID
		rootMessageID := row.RootMessageID
		model.ParentRoomId = &parentRoomID
		model.RootMessageId = &rootMessageID
	}
	if row.PinnedAt.Valid {
		pinnedAt := row.PinnedAt.Time
		model.PinnedAt = &pinnedAt
	}
	if len(row.MemberPreviewIds) > 0 {
		preview := make([]httpapi.ActorRef, 0, len(row.MemberPreviewIds))
		for index, id := range row.MemberPreviewIds {
			preview = append(preview, httpapi.ActorRef{
				Id: id, TenantId: row.TenantID,
				Kind:        httpapi.ActorKind(row.MemberPreviewKinds[index]),
				DisplayName: row.MemberPreviewNames[index],
			})
		}
		model.MemberPreview = &preview
	}
	if row.Description.Valid {
		value := row.Description.String
		model.Description = &value
	}
	if row.LatestMessagePresent {
		model.LatestMessage = &httpapi.LatestMessageSummary{
			Id: row.LatestMessageID, RoomSeq: row.LatestMessageRoomSeq,
			RawMessage: row.LatestMessageRawMessage, CreatedAt: row.LatestMessageCreatedAt.Time,
			Author: httpapi.ActorRef{
				Id: row.LatestMessageAuthorID, TenantId: row.TenantID,
				Kind: httpapi.ActorKind(row.LatestMessageAuthorKind), DisplayName: row.LatestMessageAuthorDisplayName,
			},
		}
	}
	return model
}

func messageModel(id, tenantID, roomID, body string, segments []byte, messageKind string, cardContextMessageID, replyToMessageID, cardTitle, cardKind pgtype.Text, createdAt pgtype.Timestamptz, author store.Actor) (httpapi.Message, error) {
	content, err := storedMessageContent(body, segments)
	if err != nil {
		return httpapi.Message{}, err
	}
	model := httpapi.Message{
		Id: id, TenantId: tenantID, RoomId: roomID,
		Author: ActorRef(author), RawMessage: content.rawMessage,
		MessageKind: httpapi.MessageKind(messageKind),
		Segments:    content.segments, Attachments: []httpapi.MessageAttachment{},
		CreatedAt: createdAt.Time,
	}
	if cardContextMessageID.Valid {
		model.CardContextMessageId = &cardContextMessageID.String
	}
	if replyToMessageID.Valid {
		model.ReplyToMessageId = &replyToMessageID.String
	}
	if cardTitle.Valid {
		model.CardTitle = &cardTitle.String
	}
	if cardKind.Valid {
		kind := httpapi.MessageCardKind(cardKind.String)
		model.CardKind = &kind
	}
	return model, nil
}

func messageContextModel(messageID, body string, segments []byte, createdAt pgtype.Timestamptz, author store.Actor) (httpapi.MessageContext, error) {
	content, err := storedMessageContent(body, segments)
	if err != nil {
		return httpapi.MessageContext{}, err
	}
	return httpapi.MessageContext{
		MessageId: messageID, Author: ActorRef(author), RawMessage: content.rawMessage,
		Segments: content.segments, CreatedAt: createdAt.Time,
	}, nil
}

func (s *Service) hydrateMessageContexts(ctx context.Context, messageIDs []string) (map[string][]httpapi.MessageContext, error) {
	result := make(map[string][]httpapi.MessageContext, len(messageIDs))
	if len(messageIDs) == 0 {
		return result, nil
	}
	rows, err := s.queries.ListMessageContextsForMessages(ctx, messageIDs)
	if err != nil {
		return nil, err
	}
	for _, row := range rows {
		author := store.Actor{
			ID: row.AuthorActorID, TenantID: row.AuthorTenantID, Kind: row.AuthorKind,
			DisplayName: row.AuthorDisplayName, AccountID: row.AuthorAccountID,
			Handle: row.AuthorHandle, CreatedAt: row.AuthorCreatedAt,
		}
		model, err := messageContextModel(row.ContextMessageID, row.Body, row.Segments, row.CreatedAt, author)
		if err != nil {
			return nil, err
		}
		result[row.MessageID] = append(result[row.MessageID], model)
	}
	return result, nil
}

func messageAttachmentModel(row store.ListMessageAttachmentsRow) httpapi.MessageAttachment {
	model := httpapi.MessageAttachment{
		Id: row.ID, DocumentId: row.DocumentID, DocumentVersionId: row.DocumentVersionID,
		Filename: row.Filename, MediaType: row.MediaType, SizeBytes: row.SizeBytes,
		Sha256: row.Sha256, Available: row.Available,
	}
	if row.SourceRoomID.Valid {
		value := row.SourceRoomID.String
		model.SourceRoomId = &value
	}
	return model
}
