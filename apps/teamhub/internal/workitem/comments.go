package workitem

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/idempotency"
	idgen "github.com/simplexai-labs/linger/apps/teamhub/internal/ids"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

type commentActorCommand struct {
	tx      pgx.Tx
	queries *store.Queries
	actor   store.Actor
	item    store.WorkItem
}

func (s *Service) ListCommentsForHuman(ctx context.Context, accountID, workItemID, cursor string, limit int32) (CommentPage, error) {
	queries := store.New(s.pool)
	if _, err := queries.GetWorkItemForHuman(ctx, store.GetWorkItemForHumanParams{ID: workItemID, AccountID: accountID}); errors.Is(err, pgx.ErrNoRows) {
		return CommentPage{}, ErrNotFound
	} else if err != nil {
		return CommentPage{}, err
	}
	return listComments(ctx, queries, workItemID, cursor, limit)
}

func (s *Service) ListCommentsForAgent(ctx context.Context, agentManagementID, workItemID, cursor string, limit int32) (CommentPage, error) {
	queries := store.New(s.pool)
	actor, err := agentActor(ctx, queries, agentManagementID)
	if err != nil {
		return CommentPage{}, err
	}
	if _, err := queries.GetWorkItemForAgent(ctx, store.GetWorkItemForAgentParams{
		ID: workItemID, TenantID: actor.TenantID, AgentActorID: actor.ID,
	}); errors.Is(err, pgx.ErrNoRows) {
		return CommentPage{}, ErrNotFound
	} else if err != nil {
		return CommentPage{}, err
	}
	return listComments(ctx, queries, workItemID, cursor, limit)
}

func listComments(ctx context.Context, queries *store.Queries, workItemID, cursor string, limit int32) (CommentPage, error) {
	if limit < 1 || limit > 200 || len(cursor) > 1024 {
		return CommentPage{}, ErrInvalid
	}
	cursorTime, cursorID, err := decodePageCursor(cursor)
	if err != nil {
		return CommentPage{}, ErrInvalid
	}
	records, err := queries.ListWorkItemComments(ctx, store.ListWorkItemCommentsParams{
		WorkItemID: workItemID, HasCursor: cursor != "",
		CursorCreatedAt: pgtype.Timestamptz{Time: cursorTime, Valid: cursor != ""},
		CursorID:        cursorID, PageLimit: limit + 1,
	})
	if err != nil {
		return CommentPage{}, err
	}
	hasMore := len(records) > int(limit)
	if hasMore {
		records = records[:limit]
	}
	comments, err := loadComments(ctx, queries, records)
	if err != nil {
		return CommentPage{}, err
	}
	page := CommentPage{Items: comments, HasMore: hasMore}
	if hasMore {
		last := records[len(records)-1]
		page.NextCursor = encodePageCursorValue(last.CreatedAt.Time, last.ID)
	}
	return page, nil
}

func (s *Service) CreateCommentForHuman(ctx context.Context, accountID, workItemID, key string, input CommentInput) (Result[Comment], error) {
	command, err := s.beginHumanCommentCommand(ctx, accountID, workItemID)
	if err != nil {
		return Result[Comment]{}, err
	}
	return createComment(ctx, command, key, input)
}

func (s *Service) CreateCommentForAgent(ctx context.Context, agentManagementID, workItemID, key string, input CommentInput) (Result[Comment], error) {
	command, err := s.beginAgentCommentCommand(ctx, agentManagementID, workItemID)
	if err != nil {
		return Result[Comment]{}, err
	}
	return createComment(ctx, command, key, input)
}

func createComment(ctx context.Context, command commentActorCommand, key string, input CommentInput) (Result[Comment], error) {
	defer command.tx.Rollback(ctx)
	normalized, references, encoded, err := normalizeComment(input)
	if err != nil {
		return Result[Comment]{}, err
	}
	operation := "create-comment:" + command.item.ID
	hash := requestHash(normalized)
	if err := idempotency.Lock(ctx, command.tx, idempotency.ActorKey(command.actor.ID, operation, key)); err != nil {
		return Result[Comment]{}, err
	}
	if replay, found, err := lookupReplay[Comment](ctx, command.tx, command.actor.ID, operation, key, hash); err != nil {
		return Result[Comment]{}, err
	} else if found {
		return replay, commitResult(ctx, command.tx, replay)
	}
	if err := lockDeliveryScope(ctx, command.tx, command.queries, command.item); err != nil {
		return Result[Comment]{}, err
	}
	actors, err := resolveActors(ctx, command.queries, command.item.TenantID, references)
	if err != nil {
		return Result[Comment]{}, err
	}
	record, err := command.queries.CreateWorkItemComment(ctx, store.CreateWorkItemCommentParams{
		ID: idgen.New("comment"), WorkItemID: command.item.ID, TenantID: command.item.TenantID,
		AuthorActorID: command.actor.ID, Body: normalized.Body, Segments: encoded,
	})
	if err != nil {
		return Result[Comment]{}, err
	}
	if err := replaceCommentReferences(ctx, command.tx, command.queries, command.item, record.ID, actors, false); err != nil {
		return Result[Comment]{}, err
	}
	if err := recomputeCommentReferenceAgentAccess(ctx, command, actors); err != nil {
		return Result[Comment]{}, err
	}
	if err := command.queries.TouchWorkItem(ctx, store.TouchWorkItemParams{
		ID: command.item.ID, TenantID: command.item.TenantID, UpdatedByActorID: command.actor.ID,
	}); err != nil {
		return Result[Comment]{}, err
	}
	comment, err := loadComment(ctx, command.queries, record)
	if err != nil {
		return Result[Comment]{}, err
	}
	result := Result[Comment]{Value: comment}
	if err := createReplay(ctx, command.tx, command.actor.ID, operation, key, hash, command.item.ID, http.StatusCreated, result.Value); err != nil {
		return Result[Comment]{}, err
	}
	return result, commitResult(ctx, command.tx, result)
}

func (s *Service) beginHumanCommentCommand(ctx context.Context, accountID, workItemID string) (commentActorCommand, error) {
	command, err := s.beginHumanItemCommand(ctx, accountID, workItemID)
	if err != nil {
		return commentActorCommand{}, err
	}
	return commentActorCommand(command), nil
}

func (s *Service) beginAgentCommentCommand(ctx context.Context, agentManagementID, workItemID string) (commentActorCommand, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return commentActorCommand{}, err
	}
	queries := store.New(tx)
	actor, err := agentActor(ctx, queries, agentManagementID)
	if err != nil {
		_ = tx.Rollback(ctx)
		return commentActorCommand{}, err
	}
	item, err := queries.GetWorkItemForAgentForUpdate(ctx, store.GetWorkItemForAgentForUpdateParams{
		ID: workItemID, TenantID: actor.TenantID, AgentActorID: actor.ID,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		_ = tx.Rollback(ctx)
		return commentActorCommand{}, ErrNotFound
	}
	if err != nil {
		_ = tx.Rollback(ctx)
		return commentActorCommand{}, err
	}
	return commentActorCommand{tx: tx, queries: queries, actor: actor, item: item}, nil
}

func normalizeComment(input CommentInput) (CommentInput, []string, []byte, error) {
	if input.Body == "" || utf8.RuneCountInString(input.Body) > 50000 || len(input.Segments) < 1 || len(input.Segments) > 1000 {
		return CommentInput{}, nil, nil, ErrInvalid
	}
	var body strings.Builder
	referenceSet := map[string]struct{}{}
	for _, segment := range input.Segments {
		if segment.Content == "" || utf8.RuneCountInString(segment.Content) > 50000 {
			return CommentInput{}, nil, nil, ErrInvalid
		}
		switch segment.Type {
		case "text":
			if segment.ActorID != "" {
				return CommentInput{}, nil, nil, ErrInvalid
			}
		case "reference":
			if segment.ActorID == "" {
				return CommentInput{}, nil, nil, ErrInvalid
			}
			referenceSet[segment.ActorID] = struct{}{}
		default:
			return CommentInput{}, nil, nil, ErrInvalid
		}
		body.WriteString(segment.Content)
	}
	if body.String() != input.Body {
		return CommentInput{}, nil, nil, ErrInvalid
	}
	references := make([]string, 0, len(referenceSet))
	for actorID := range referenceSet {
		references = append(references, actorID)
	}
	references, err := normalizedActorIDs(references)
	if err != nil {
		return CommentInput{}, nil, nil, err
	}
	encoded, err := json.Marshal(input.Segments)
	if err != nil {
		return CommentInput{}, nil, nil, err
	}
	return input, references, encoded, nil
}

func replaceCommentReferences(ctx context.Context, tx pgx.Tx, queries *store.Queries, item store.WorkItem, commentID string, actors map[string]store.Actor, replace bool) error {
	if replace {
		if err := queries.DeleteWorkItemCommentReferences(ctx, commentID); err != nil {
			return err
		}
	}
	for actorID := range actors {
		if err := queries.CreateWorkItemCommentReference(ctx, store.CreateWorkItemCommentReferenceParams{
			CommentID: commentID, WorkItemID: item.ID, TenantID: item.TenantID, ActorID: actorID,
		}); err != nil {
			return err
		}
	}
	return nil
}

func recomputeCommentReferenceAgentAccess(ctx context.Context, command commentActorCommand, actors map[string]store.Actor) error {
	agentIDs := make([]string, 0, len(actors))
	for actorID, actor := range actors {
		if actor.Kind == "agent" {
			agentIDs = append(agentIDs, actorID)
		}
	}
	sort.Strings(agentIDs)
	for _, actorID := range agentIDs {
		if err := document.RecomputeTaskActorAccess(
			ctx, command.tx, command.item.TenantID, command.item.ID, actorID, command.actor.ID,
		); err != nil {
			return err
		}
	}
	return nil
}
