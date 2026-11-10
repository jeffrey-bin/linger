// Package agentmessages owns read-only, resource-authorized Agent message history.
package agentmessages

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/keywordsearch"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

var ErrInvalid = errors.New("invalid message history request")
var ErrNotFound = errors.New("message history is unavailable")

var identityPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$`)

type Service struct{ pool *pgxpool.Pool }

func New(pool *pgxpool.Pool) *Service { return &Service{pool: pool} }

type Reader struct{ TenantID, ActorID string }
type Inbox struct {
	InboxID string `json:"inbox_id"`
	Kind    string `json:"kind"`
}
type Resource struct {
	DocumentID string `json:"document_id"`
}
type Message struct {
	MessageID          string          `json:"message_id"`
	InboxID            string          `json:"inbox_id"`
	AuthorActorID      string          `json:"author_actor_id"`
	Author             string          `json:"author"`
	AuthorKind         string          `json:"author_kind"`
	Body               string          `json:"body"`
	Segments           json.RawMessage `json:"segments"`
	MessageKind        string          `json:"message_kind"`
	CreatedAt          time.Time       `json:"created_at"`
	ContextMessageIDs  []string        `json:"context_message_ids"`
	ResourceReferences []Resource      `json:"resource_references"`
}
type Page struct {
	Messages   []Message `json:"messages"`
	HasMore    bool      `json:"has_more"`
	NextCursor string    `json:"next_cursor,omitempty"`
}
type SearchInput struct {
	Query    string
	InboxIDs []string
	Cursor   string
	Limit    int
}

func (s *Service) snapshot(ctx context.Context, reader Reader, read func(*store.Queries) error) error {
	if reader.TenantID == "" || reader.ActorID == "" {
		return ErrInvalid
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err := read(store.New(tx)); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Service) Search(ctx context.Context, reader Reader, input SearchInput) (Page, error) {
	result := Page{Messages: []Message{}}
	query, ok := keywordsearch.Normalize(input.Query, keywordsearch.AgentQueryChars)
	if !ok || len(input.InboxIDs) > 100 {
		return result, ErrInvalid
	}
	for _, id := range input.InboxIDs {
		if !validInbox(id) {
			return result, ErrInvalid
		}
	}
	params, err := readParams(reader, input.Cursor, input.Limit)
	if err != nil {
		return result, err
	}
	params.Query, params.InboxIds = query, input.InboxIDs
	if params.InboxIds == nil {
		params.InboxIds = []string{}
	}
	err = s.snapshot(ctx, reader, func(queries *store.Queries) error {
		if err := queries.LimitSearchStatementTime(ctx); err != nil {
			return err
		}
		for _, inboxID := range input.InboxIDs {
			if err := requireInbox(ctx, queries, reader, inboxID); err != nil {
				return err
			}
		}
		result, err = readPage(ctx, queries, params)
		return err
	})
	return result, err
}

func requireInbox(ctx context.Context, queries *store.Queries, reader Reader, inboxID string) error {
	allowed, err := queries.CanReadAgentHistoryInbox(ctx, store.CanReadAgentHistoryInboxParams{TenantID: reader.TenantID, ActorID: reader.ActorID, InboxID: inboxID})
	if err != nil {
		return err
	}
	if !allowed {
		return ErrNotFound
	}
	return nil
}

func getMessage(ctx context.Context, queries *store.Queries, reader Reader, messageID string) (Message, error) {
	params, _ := readParams(reader, "", 2)
	params.MessageID = messageID
	page, err := readPage(ctx, queries, params)
	if err != nil {
		return Message{}, err
	}
	if len(page.Messages) != 1 {
		return Message{}, ErrNotFound
	}
	return page.Messages[0], nil
}

func readPage(ctx context.Context, queries *store.Queries, params store.ReadAgentHistoryMessagesParams) (Page, error) {
	result := Page{Messages: []Message{}}
	var rows []store.ReadAgentHistoryMessagesRow
	var err error
	if params.InboxID == "" && len(params.InboxIds) == 0 {
		unscoped, readErr := queries.ReadUnscopedAgentHistoryMessages(ctx, store.ReadUnscopedAgentHistoryMessagesParams{
			TenantID: params.TenantID, ActorID: params.ActorID, MessageID: params.MessageID,
			MessageIds: params.MessageIds, Query: params.Query, CursorID: params.CursorID,
			CursorTime: params.CursorTime, PageLimit: params.PageLimit,
		})
		err = readErr
		for _, row := range unscoped {
			rows = append(rows, store.ReadAgentHistoryMessagesRow(row))
		}
	} else {
		rows, err = queries.ReadAgentHistoryMessages(ctx, params)
	}
	if err != nil {
		return result, err
	}
	limit := int(params.PageLimit) - 1
	if len(rows) > limit {
		result.HasMore = true
		rows = rows[:limit]
	}
	for _, row := range rows {
		message := Message{MessageID: row.MessageID, InboxID: row.InboxID, AuthorActorID: row.AuthorActorID,
			Author: row.Author, AuthorKind: row.AuthorKind, Body: row.Body, Segments: row.Segments,
			MessageKind: row.MessageKind, CreatedAt: row.CreatedAt.Time,
			ContextMessageIDs: []string{}, ResourceReferences: []Resource{}}
		if err := json.Unmarshal(row.ContextMessageIds, &message.ContextMessageIDs); err != nil {
			return result, err
		}
		if err := json.Unmarshal(row.ResourceReferences, &message.ResourceReferences); err != nil {
			return result, err
		}
		result.Messages = append(result.Messages, message)
	}
	if result.HasMore {
		result.NextCursor = encodeCursor(result.Messages[len(result.Messages)-1])
	}
	return result, nil
}

type historyCursor struct {
	Time      time.Time `json:"time"`
	MessageID string    `json:"message_id"`
}

func encodeCursor(message Message) string {
	raw, _ := json.Marshal(historyCursor{Time: message.CreatedAt, MessageID: message.MessageID})
	return base64.RawURLEncoding.EncodeToString(raw)
}
func readParams(reader Reader, cursor string, limit int) (store.ReadAgentHistoryMessagesParams, error) {
	params := store.ReadAgentHistoryMessagesParams{TenantID: reader.TenantID, ActorID: reader.ActorID,
		MessageIds: []string{}, InboxIds: []string{}, CursorTime: pgtype.Timestamptz{Time: time.Unix(0, 0), Valid: true}}
	if limit == 0 {
		limit = 20
	}
	if limit < 1 || limit > 100 || len(cursor) > 1024 {
		return params, ErrInvalid
	}
	params.PageLimit = int32(limit + 1)
	if cursor == "" {
		return params, nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(cursor)
	if err != nil {
		return params, ErrInvalid
	}
	var position historyCursor
	if json.Unmarshal(raw, &position) != nil || position.Time.IsZero() || !identityPattern.MatchString(position.MessageID) {
		return params, ErrInvalid
	}
	params.CursorID, params.CursorTime = position.MessageID, pgtype.Timestamptz{Time: position.Time, Valid: true}
	return params, nil
}
func validInbox(id string) bool {
	if !identityPattern.MatchString(id) {
		return false
	}
	for _, prefix := range []string{"room:", "thread:", "task:", "meta:", "taskmeta:"} {
		if strings.HasPrefix(id, prefix) && len(id) > len(prefix) {
			return true
		}
	}
	return false
}
