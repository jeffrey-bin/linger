package collaboration

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/typedcard"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

// ErrHistoryTooLarge reports a conversation over the sharing limit of 10,000 messages or 100 MB.
var ErrHistoryTooLarge = errors.New("this conversation is too large to share")

type historyCard struct {
	Title       string `json:"title"`
	Description string `json:"description"`
	Status      string `json:"status"`
}

type historyAttachment struct {
	ID           string `json:"id"`
	Filename     string `json:"filename"`
	MediaType    string `json:"media_type"`
	SizeBytes    int64  `json:"size_bytes"`
	ImageAssetID string `json:"image_asset_id,omitempty"`
}

type historyMessage struct {
	ID          string                   `json:"id"`
	Position    int64                    `json:"position"`
	Author      httpapi.ActorRef         `json:"author"`
	AvatarImage string                   `json:"avatar_image,omitempty"`
	Body        string                   `json:"body"`
	Segments    []httpapi.MessageSegment `json:"segments"`
	CreatedAt   time.Time                `json:"created_at"`
	Attachments []historyAttachment      `json:"attachments"`
	Card        *historyCard             `json:"card,omitempty"`
}

// Copy only Human-visible presentation fields. No authorization URLs, commands,
// provider state, task inputs, or future mutable records enter the public DTO.
func historyCardPresentation(raw json.RawMessage) *historyCard {
	if len(raw) == 0 {
		return nil
	}
	var value map[string]any
	if json.Unmarshal(raw, &value) != nil {
		return nil
	}
	result := &historyCard{}
	for _, key := range []string{"title", "summary", "question", "intent"} {
		if v, ok := value[key].(string); ok && v != "" {
			result.Title = v
			break
		}
	}
	for _, key := range []string{"completion_summary", "description", "body", "prompt"} {
		if v, ok := value[key].(string); ok {
			result.Description = v
			break
		}
	}
	for _, key := range []string{"review_status", "request_status", "coordination_status", "registration_status", "status"} {
		if v, ok := value[key].(string); ok {
			result.Status = v
			break
		}
	}
	for _, key := range []string{"work_item", "agent_registration"} {
		if item, ok := value[key].(map[string]any); ok {
			if v, ok := item["title"].(string); ok {
				result.Title = v
			}
			if v, ok := item["name"].(string); ok && result.Title == "" {
				result.Title = v
			}
			if v, ok := item["description"].(string); ok && result.Description == "" {
				result.Description = v
			}
			if v, ok := item["status"].(string); ok && result.Status == "" {
				result.Status = v
			}
		}
	}

	return result
}

func (s *Service) copyRoomHistory(ctx context.Context, q *store.Queries, accountID, roomID, shareID string) (int, error) {
	// Use the same Human timeline query and immutable attachment versions as Chat.
	var all []store.ListMessagesForRoomAccountRow
	var sourceBytes int64
	cursor := ""
	for {
		rows, err := q.ListMessagesForRoomAccount(ctx, store.ListMessagesForRoomAccountParams{RoomID: roomID, AccountID: accountID, Cursor: cursor, PageLimit: 200})
		if err != nil {
			return 0, err
		}
		if len(rows) == 0 {
			break
		}
		// Bound the preloaded source as well as the final snapshot.
		for _, row := range rows {
			sourceBytes += int64(len(row.Body) + len(row.Segments))
			if sourceBytes > 100<<20 {
				return 0, ErrHistoryTooLarge
			}
		}
		all = append(rows, all...)
		if len(all) > 10000 {
			return 0, ErrHistoryTooLarge
		}
		cursor = rows[0].ID
		if len(rows) < 200 {
			break
		}
	}
	// A shared history keeps the conversation; Room notices stay behind.
	conversation := all[:0]
	for _, row := range all {
		if row.MessageKind != "room_notice" {
			conversation = append(conversation, row)
		}
	}
	all = conversation
	var totalBytes int64
	for index, row := range all {
		content, err := storedMessageContent(row.Body, row.Segments)
		if err != nil {
			return 0, err
		}
		author := store.Actor{ID: row.AuthorActorID, TenantID: row.TenantID, Kind: row.AuthorKind, DisplayName: row.AuthorDisplayName}
		model := historyMessage{ID: row.ID, Position: int64(index + 1), Author: ActorRef(author), Body: content.rawMessage, Segments: content.segments, CreatedAt: row.CreatedAt.Time, Attachments: []historyAttachment{}}
		if row.HasCard {
			raw, _, err := typedcard.SnapshotCard(ctx, q, row.ID)
			if err != nil {
				return 0, err
			}
			model.Card = historyCardPresentation(raw)
		}
		attachments, err := q.ListMessageAttachments(ctx, []string{row.ID})
		if err != nil {
			return 0, err
		}
		for _, file := range attachments {
			item := historyAttachment{ID: file.ID, Filename: file.Filename, MediaType: file.MediaType, SizeBytes: file.SizeBytes}
			if file.Available && safeHistoryImage(file.MediaType) {
				objectKey, err := q.GetDocumentVersionContentObjectID(ctx, file.DocumentVersionID)
				if err != nil {
					return 0, err
				}
				totalBytes += file.SizeBytes
				if totalBytes > 100<<20 {
					return 0, ErrHistoryTooLarge
				}
				source, err := s.artifacts.Open(ctx, objectKey)
				if err != nil {
					return 0, err
				}
				data, readErr := io.ReadAll(io.LimitReader(source, file.SizeBytes+1))
				closeErr := source.Close()
				if readErr != nil {
					return 0, readErr
				}
				if closeErr != nil {
					return 0, closeErr
				}
				if int64(len(data)) != file.SizeBytes {
					return 0, errors.New("image content size changed")
				}
				item.ImageAssetID = file.ID
				if err = q.CreateRoomHistoryShareAsset(ctx, store.CreateRoomHistoryShareAssetParams{
					ShareID: shareID, ID: file.ID, MediaType: file.MediaType, Content: data,
				}); err != nil {
					return 0, err
				}
			}
			model.Attachments = append(model.Attachments, item)
		}
		if row.AuthorKind == "human" {
			avatar, err := q.GetHumanActorAvatarImage(ctx, store.GetHumanActorAvatarImageParams{
				TenantID: row.TenantID, ActorID: row.AuthorActorID,
			})
			if err != nil && !errors.Is(err, pgx.ErrNoRows) {
				return 0, err
			}
			if strings.HasPrefix(avatar, "data:image/png;base64,") || strings.HasPrefix(avatar, "data:image/jpeg;base64,") {
				model.AvatarImage = avatar
			}
		}
		data, err := json.Marshal(model)
		if err != nil {
			return 0, err
		}
		totalBytes += int64(len(data))
		if totalBytes > 100<<20 {
			return 0, ErrHistoryTooLarge
		}
		if err = q.CreateRoomHistoryShareMessage(ctx, store.CreateRoomHistoryShareMessageParams{
			ShareID: shareID, Position: model.Position, MessageID: row.ID, Presentation: data,
		}); err != nil {
			return 0, err
		}
	}
	return len(all), nil
}

func safeHistoryImage(mediaType string) bool {
	switch mediaType {
	case "image/png", "image/jpeg", "image/gif", "image/webp":
		return true
	}
	return false
}
