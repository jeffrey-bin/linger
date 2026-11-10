package typedcard

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/roomattention"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/workitem"
)

func appendWorkItemChangedEvent(
	ctx context.Context,
	queries *store.Queries,
	item workitem.Item,
	actorID string,
) error {
	roomSeq, err := workitem.AppendChangedRoomEvent(ctx, queries, workitem.ChangeEventContext{
		TenantID: item.TenantID, WorkItemID: item.ID, OriginRoomID: item.OriginRoomID,
		Version: item.Version,
	}, actorID)
	if err != nil || roomSeq == 0 {
		return err
	}
	return roomattention.AppendForTenantHumans(ctx, queries, roomattention.RoomSummaryUpdate{
		TenantID: item.TenantID, RoomID: *item.OriginRoomID, RoomSeq: roomSeq, Reason: "work_item.changed",
	})
}

func loadTypedCardMessageResponse(ctx context.Context, queries *store.Queries, messageID string) ([]byte, error) {
	message, err := queries.GetTypedCardMessage(ctx, messageID)
	if err != nil {
		return nil, err
	}
	card, found, err := hydrateCard(ctx, queries, messageID)
	if err != nil {
		return nil, err
	}
	if !found {
		return nil, errors.New("typed card Message has no card projection")
	}
	author := store.Actor{
		ID: message.AuthorID, TenantID: message.TenantID, Kind: message.AuthorKind,
		DisplayName: message.AuthorDisplayName, AccountID: message.AuthorAccountID,
		Handle: message.AuthorHandle, CreatedAt: message.AuthorCreatedAt,
	}
	model := messageResponse{
		ID: message.ID, TenantID: message.TenantID, RoomID: message.RoomID,
		Author: actorValue(author), MessageKind: message.MessageKind, RawMessage: message.Body,
		Segments: json.RawMessage(message.Segments), Attachments: []any{}, Card: card,
		CreatedAt: message.CreatedAt.Time,
	}
	attachments, err := queries.ListMessageAttachments(ctx, []string{messageID})
	if err != nil {
		return nil, err
	}
	for _, attachment := range attachments {
		model.Attachments = append(model.Attachments, map[string]any{
			"id": attachment.ID, "document_id": attachment.DocumentID,
			"document_version_id": attachment.DocumentVersionID, "filename": attachment.Filename,
			"media_type": attachment.MediaType, "size_bytes": attachment.SizeBytes,
			"sha256": attachment.Sha256, "available": attachment.Available,
		})
	}
	if message.CardContextMessageID.Valid {
		model.CardContextMessageID = &message.CardContextMessageID.String
	}
	return json.Marshal(model)
}
