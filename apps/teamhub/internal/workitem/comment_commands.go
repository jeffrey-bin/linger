package workitem

import (
	"context"
	"errors"
	"net/http"

	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/idempotency"
	idgen "github.com/simplexai-labs/linger/apps/teamhub/internal/ids"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

func (s *Service) UpdateCommentForHuman(ctx context.Context, accountID, workItemID, commentID, key string, input CommentUpdateInput) (Result[Comment], error) {
	command, err := s.beginHumanCommentCommand(ctx, accountID, workItemID)
	if err != nil {
		return Result[Comment]{}, err
	}
	return updateComment(ctx, command, commentID, key, input)
}

func (s *Service) UpdateCommentForAgent(ctx context.Context, agentManagementID, workItemID, commentID, key string, input CommentUpdateInput) (Result[Comment], error) {
	command, err := s.beginAgentCommentCommand(ctx, agentManagementID, workItemID)
	if err != nil {
		return Result[Comment]{}, err
	}
	return updateComment(ctx, command, commentID, key, input)
}

func updateComment(ctx context.Context, command commentActorCommand, commentID, key string, input CommentUpdateInput) (Result[Comment], error) {
	defer command.tx.Rollback(ctx)
	normalized, references, encoded, err := normalizeComment(input.Content)
	if err != nil || input.ExpectedVersion < 1 {
		return Result[Comment]{}, ErrInvalid
	}
	input.Content = normalized
	operation := "update-comment:" + commentID
	hash := requestHash(input)
	if err := idempotency.Lock(ctx, command.tx, idempotency.ActorKey(command.actor.ID, operation, key)); err != nil {
		return Result[Comment]{}, err
	}
	record, err := command.queries.GetWorkItemCommentForUpdate(ctx, store.GetWorkItemCommentForUpdateParams{ID: commentID, WorkItemID: command.item.ID})
	if errors.Is(err, pgx.ErrNoRows) {
		return Result[Comment]{}, ErrNotFound
	}
	if err != nil {
		return Result[Comment]{}, err
	}
	if replay, found, err := lookupReplay[Comment](ctx, command.tx, command.actor.ID, operation, key, hash); err != nil {
		return Result[Comment]{}, err
	} else if found {
		return replay, commitResult(ctx, command.tx, replay)
	}
	if record.AuthorActorID != command.actor.ID {
		return Result[Comment]{}, ErrForbidden
	}
	if record.Version != input.ExpectedVersion || record.DeletedAt.Valid {
		return Result[Comment]{}, ErrConflict
	}
	previousActorIDs, err := command.queries.ListWorkItemCommentReferenceActorIDs(ctx, commentID)
	if err != nil {
		return Result[Comment]{}, err
	}
	affectedActorSet := make(map[string]struct{}, len(previousActorIDs)+len(references))
	for _, actorID := range previousActorIDs {
		affectedActorSet[actorID] = struct{}{}
	}
	for _, actorID := range references {
		affectedActorSet[actorID] = struct{}{}
	}
	affectedActorIDs := make([]string, 0, len(affectedActorSet))
	for actorID := range affectedActorSet {
		affectedActorIDs = append(affectedActorIDs, actorID)
	}
	affectedActors, err := resolveActors(ctx, command.queries, command.item.TenantID, affectedActorIDs)
	if err != nil {
		return Result[Comment]{}, err
	}
	actors := make(map[string]store.Actor, len(references))
	for _, actorID := range references {
		actors[actorID] = affectedActors[actorID]
	}
	record, err = command.queries.UpdateWorkItemComment(ctx, store.UpdateWorkItemCommentParams{
		ID: commentID, WorkItemID: command.item.ID, Body: normalized.Body, Segments: encoded,
	})
	if err != nil {
		return Result[Comment]{}, err
	}
	if err := replaceCommentReferences(ctx, command.tx, command.queries, command.item, commentID, actors, true); err != nil {
		return Result[Comment]{}, err
	}
	if err := recomputeCommentReferenceAgentAccess(ctx, command, affectedActors); err != nil {
		return Result[Comment]{}, err
	}
	if err := touchAndCreateCommentActivity(ctx, command, commentID, "comment_edited"); err != nil {
		return Result[Comment]{}, err
	}
	comment, err := loadComment(ctx, command.queries, record)
	if err != nil {
		return Result[Comment]{}, err
	}
	result := Result[Comment]{Value: comment}
	if err := createReplay(ctx, command.tx, command.actor.ID, operation, key, hash, command.item.ID, http.StatusOK, result.Value); err != nil {
		return Result[Comment]{}, err
	}
	return result, commitResult(ctx, command.tx, result)
}

func (s *Service) DeleteCommentForHuman(ctx context.Context, accountID, workItemID, commentID, key string, input VersionInput) (Result[Comment], error) {
	command, err := s.beginHumanCommentCommand(ctx, accountID, workItemID)
	if err != nil {
		return Result[Comment]{}, err
	}
	return deleteComment(ctx, command, commentID, key, input)
}

func (s *Service) DeleteCommentForAgent(ctx context.Context, agentManagementID, workItemID, commentID, key string, input VersionInput) (Result[Comment], error) {
	command, err := s.beginAgentCommentCommand(ctx, agentManagementID, workItemID)
	if err != nil {
		return Result[Comment]{}, err
	}
	return deleteComment(ctx, command, commentID, key, input)
}

func deleteComment(ctx context.Context, command commentActorCommand, commentID, key string, input VersionInput) (Result[Comment], error) {
	defer command.tx.Rollback(ctx)
	if input.ExpectedVersion < 1 {
		return Result[Comment]{}, ErrInvalid
	}
	operation := "delete-comment:" + commentID
	hash := requestHash(input)
	if err := idempotency.Lock(ctx, command.tx, idempotency.ActorKey(command.actor.ID, operation, key)); err != nil {
		return Result[Comment]{}, err
	}
	record, err := command.queries.GetWorkItemCommentForUpdate(ctx, store.GetWorkItemCommentForUpdateParams{ID: commentID, WorkItemID: command.item.ID})
	if errors.Is(err, pgx.ErrNoRows) {
		return Result[Comment]{}, ErrNotFound
	}
	if err != nil {
		return Result[Comment]{}, err
	}
	if replay, found, err := lookupReplay[Comment](ctx, command.tx, command.actor.ID, operation, key, hash); err != nil {
		return Result[Comment]{}, err
	} else if found {
		return replay, commitResult(ctx, command.tx, replay)
	}
	if record.AuthorActorID != command.actor.ID {
		return Result[Comment]{}, ErrForbidden
	}
	if record.Version != input.ExpectedVersion || record.DeletedAt.Valid {
		return Result[Comment]{}, ErrConflict
	}
	referenceActorIDs, err := command.queries.ListWorkItemCommentReferenceActorIDs(ctx, commentID)
	if err != nil {
		return Result[Comment]{}, err
	}
	referenceActors, err := resolveActors(ctx, command.queries, command.item.TenantID, referenceActorIDs)
	if err != nil {
		return Result[Comment]{}, err
	}
	record, err = command.queries.SoftDeleteWorkItemComment(ctx, store.SoftDeleteWorkItemCommentParams{ID: commentID, WorkItemID: command.item.ID})
	if err != nil {
		return Result[Comment]{}, err
	}
	if err := command.queries.DeleteWorkItemCommentReferences(ctx, commentID); err != nil {
		return Result[Comment]{}, err
	}
	if err := recomputeCommentReferenceAgentAccess(ctx, command, referenceActors); err != nil {
		return Result[Comment]{}, err
	}
	if err := touchAndCreateCommentActivity(ctx, command, commentID, "comment_deleted"); err != nil {
		return Result[Comment]{}, err
	}
	comment, err := loadComment(ctx, command.queries, record)
	if err != nil {
		return Result[Comment]{}, err
	}
	result := Result[Comment]{Value: comment}
	if err := createReplay(ctx, command.tx, command.actor.ID, operation, key, hash, command.item.ID, http.StatusOK, result.Value); err != nil {
		return Result[Comment]{}, err
	}
	return result, commitResult(ctx, command.tx, result)
}

func touchAndCreateCommentActivity(ctx context.Context, command commentActorCommand, commentID, kind string) error {
	if err := command.queries.TouchWorkItem(ctx, store.TouchWorkItemParams{
		ID: command.item.ID, TenantID: command.item.TenantID, UpdatedByActorID: command.actor.ID,
	}); err != nil {
		return err
	}
	_, err := command.queries.CreateWorkItemCommentActivity(ctx, store.CreateWorkItemCommentActivityParams{
		ID: idgen.New("activity"), WorkItemID: command.item.ID, TenantID: command.item.TenantID,
		Kind: kind, ActorID: command.actor.ID, CommentID: optionalText(commentID),
	})
	return err
}
