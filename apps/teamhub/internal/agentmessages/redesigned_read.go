package agentmessages

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

// ReadInput selects exactly one read mode. A single repeatable-read snapshot
// owns primary-message, context-message and Thread visibility decisions.
type ReadInput struct {
	InboxID     string
	ThreadID    string
	MessageIDs  []string
	ListInboxes bool
	Cursor      string
	Limit       int
}
type ReadMessage struct {
	Message
	ContextMessages []Message `json:"context_messages"`
	ThreadID        string    `json:"thread_id,omitempty"`
}
type ReadResult struct {
	Mode                  string         `json:"mode"`
	InboxID               string         `json:"inbox_id,omitempty"`
	Messages              *[]ReadMessage `json:"messages,omitempty"`
	Root                  *ReadMessage   `json:"root,omitempty"`
	RequestedMessageIDs   *[]string      `json:"requested_message_ids,omitempty"`
	UnavailableMessageIDs *[]string      `json:"unavailable_message_ids,omitempty"`
	Inboxes               *[]Inbox       `json:"inboxes,omitempty"`
	HasMore               bool           `json:"has_more"`
	NextCursor            string         `json:"next_cursor,omitempty"`
}

func validateReadInput(input ReadInput) error {
	modes := 0
	if input.InboxID != "" {
		modes++
		if !validInbox(input.InboxID) {
			return ErrInvalid
		}
	}
	if input.ThreadID != "" {
		modes++
		if len(input.ThreadID) > 256 || !identityPattern.MatchString(input.ThreadID) {
			return ErrInvalid
		}
	}
	if input.MessageIDs != nil {
		modes++
		if len(input.MessageIDs) < 1 || len(input.MessageIDs) > 50 {
			return ErrInvalid
		}
		seen := map[string]bool{}
		for _, id := range input.MessageIDs {
			if len(id) > 256 || !identityPattern.MatchString(id) || seen[id] {
				return ErrInvalid
			}
			seen[id] = true
		}
	}
	if input.ListInboxes {
		modes++
	}
	if modes != 1 || ((input.MessageIDs != nil || input.ListInboxes) && (input.Limit != 0 || input.Cursor != "")) {
		return ErrInvalid
	}
	return nil
}
func (s *Service) Read(ctx context.Context, reader Reader, input ReadInput) (ReadResult, error) {
	result := ReadResult{}
	if err := validateReadInput(input); err != nil {
		return result, err
	}
	params, err := readParams(reader, input.Cursor, input.Limit)
	if err != nil {
		return result, err
	}
	err = s.snapshot(ctx, reader, func(queries *store.Queries) error {
		if input.ListInboxes {
			result.Mode = "inboxes"
			inboxes := []Inbox{}
			rows, err := queries.ListAgentHistoryInboxes(ctx, store.ListAgentHistoryInboxesParams{TenantID: reader.TenantID, ActorID: reader.ActorID})
			if err != nil {
				return err
			}
			for _, row := range rows {
				inboxes = append(inboxes, Inbox{InboxID: row.InboxID, Kind: row.Kind})
			}
			result.Inboxes = &inboxes
			return nil
		}
		if input.MessageIDs != nil {
			result.Mode = "messages"
			params.MessageIds = input.MessageIDs
			params.PageLimit = int32(len(input.MessageIDs) + 1)
			page, err := readPage(ctx, queries, params)
			if err != nil {
				return err
			}
			ordered, unavailable := orderReadMessages(input.MessageIDs, page.Messages)
			if len(ordered) == 0 {
				return ErrNotFound
			}
			messages, err := expandReadMessages(ctx, queries, reader, ordered)
			if err != nil {
				return err
			}
			requested := append([]string{}, input.MessageIDs...)
			result.Messages = &messages
			result.RequestedMessageIDs = &requested
			result.UnavailableMessageIDs = &unavailable
			return nil
		}
		result.Mode = "inbox"
		result.InboxID = input.InboxID
		if input.ThreadID != "" {
			result.InboxID = "thread:" + input.ThreadID
		}
		if err := requireInbox(ctx, queries, reader, result.InboxID); err != nil {
			return err
		}
		if input.ThreadID != "" {
			thread, err := queries.GetThreadRoomByRoomID(ctx, input.ThreadID)
			if errors.Is(err, pgx.ErrNoRows) {
				return ErrNotFound
			}
			if err != nil {
				return err
			}
			if thread.TenantID != reader.TenantID {
				return ErrNotFound
			}
			root, err := getMessage(ctx, queries, reader, thread.RootMessageID)
			if err != nil {
				return err
			}
			expanded, err := expandReadMessages(ctx, queries, reader, []Message{root})
			if err != nil {
				return err
			}
			result.Root = &expanded[0]
		}
		params.InboxID = result.InboxID
		page, err := readPage(ctx, queries, params)
		if err != nil {
			return err
		}
		messages, err := expandReadMessages(ctx, queries, reader, page.Messages)
		if err != nil {
			return err
		}
		result.Messages = &messages
		result.HasMore, result.NextCursor = page.HasMore, page.NextCursor
		return nil
	})
	return result, err
}
func orderReadMessages(requested []string, visible []Message) ([]Message, []string) {
	byID := make(map[string]Message, len(visible))
	for _, message := range visible {
		byID[message.MessageID] = message
	}
	ordered, unavailable := []Message{}, []string{}
	for _, id := range requested {
		if message, ok := byID[id]; ok {
			ordered = append(ordered, message)
		} else {
			unavailable = append(unavailable, id)
		}
	}
	return ordered, unavailable
}
func expandReadMessages(ctx context.Context, queries *store.Queries, reader Reader, messages []Message) ([]ReadMessage, error) {
	result := make([]ReadMessage, 0, len(messages))
	// Bound every query, but retain all directly referenced messages rather than
	// truncating the union to one history page. References never expand recursively.
	contextIDs := []string{}
	seen := map[string]bool{}
	for _, message := range messages {
		for _, id := range message.ContextMessageIDs {
			if !seen[id] {
				seen[id] = true
				contextIDs = append(contextIDs, id)
			}
		}
	}
	contexts := map[string]Message{}
	for offset := 0; offset < len(contextIDs); offset += 100 {
		end := offset + 100
		if end > len(contextIDs) {
			end = len(contextIDs)
		}
		params, _ := readParams(reader, "", 100)
		params.MessageIds = contextIDs[offset:end]
		page, err := readPage(ctx, queries, params)
		if err != nil {
			return nil, err
		}
		for _, message := range page.Messages {
			contexts[message.MessageID] = message
		}
	}
	for _, message := range messages {
		item := ReadMessage{Message: message, ContextMessages: []Message{}}
		for _, id := range message.ContextMessageIDs {
			if context, ok := contexts[id]; ok {
				item.ContextMessages = append(item.ContextMessages, context)
			}
		}
		thread, err := queries.FindAgentHistoryThread(ctx, store.FindAgentHistoryThreadParams{TenantID: reader.TenantID, MessageID: message.MessageID})
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return nil, err
		}
		if err == nil {
			visible, err := queries.CanReadAgentHistoryInbox(ctx, store.CanReadAgentHistoryInboxParams{TenantID: reader.TenantID, ActorID: reader.ActorID, InboxID: "thread:" + thread.RoomID})
			if err != nil {
				return nil, err
			}
			if visible {
				item.ThreadID = thread.RoomID
			}
		}
		result = append(result, item)
	}
	return result, nil
}
