package document

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

type UpdateInput struct {
	AccountID       string
	CommentID       string
	ExpectedVersion int64
	Segments        []Segment
	DurableHead     *DurableHeadSelector
	CurrentContext  *CurrentContextSelector
}

type DeleteInput struct {
	AccountID       string
	CommentID       string
	ExpectedVersion int64
}

// Update edits one Comment.
func (s *CommentService) Update(ctx context.Context, input UpdateInput) (CommentResult, error) {
	body, referenceActorIDs, err := validateContent(input.Segments)
	if err != nil || input.AccountID == "" || input.CommentID == "" || input.ExpectedVersion < 1 {
		return CommentResult{}, ErrCommentInvalidInput
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return CommentResult{}, err
	}
	defer tx.Rollback(ctx)
	queries := store.New(tx)
	scope, err := queries.GetRoomDocumentCommentMutationScope(ctx, input.CommentID)
	if err != nil {
		return CommentResult{}, err
	}
	referenceActors, err := prepareHumanAgentMentionReferences(
		ctx, queries, scope.DocumentID, input.CurrentContext,
		mentionPrincipal{Kind: "human", ID: input.AccountID}, referenceActorIDs,
	)
	if err != nil {
		return CommentResult{}, err
	}
	authority, err := queries.GetRoomDocumentCommentMutationAuthority(ctx, store.GetRoomDocumentCommentMutationAuthorityParams{
		AccountID: input.AccountID, CommentID: input.CommentID,
	})
	if err != nil {
		return CommentResult{}, err
	}
	if authority.CallerActorID != authority.AuthorActorID {
		return CommentResult{}, ErrCommentForbidden
	}
	if authority.DeletedAt.Valid || authority.VersionNumber != input.ExpectedVersion {
		return CommentResult{}, ErrCommentConflict
	}
	segments, err := json.Marshal(input.Segments)
	if err != nil {
		return CommentResult{}, err
	}
	updated, err := queries.UpdateRoomDocumentCommentBody(ctx, store.UpdateRoomDocumentCommentBodyParams{
		Body: body, Segments: segments, CommentID: authority.ID,
	})
	if err != nil {
		return CommentResult{}, err
	}
	comment := commentFromMutation(authority, updated.VersionNumber, body, input.Segments, updated.UpdatedAt.Time, nil)
	err = recordCommentChange(ctx, tx, queries, commentChange{
		Kind: "comment_updated", TenantID: authority.TenantID,
		RoomID:     mentionRoomID(input.CurrentContext, referenceActorIDs),
		DocumentID: authority.DocumentID, ThreadID: authority.ThreadID,
		CommentID: authority.ID, VersionNumber: updated.VersionNumber,
		AnchorID: authority.CurrentAnchorID, DurableHead: input.DurableHead,
		ActorID: authority.CallerActorID, ActorKind: "human",
	}, referenceActors)
	if err != nil {
		return CommentResult{}, err
	}
	return finishCommentMutation(ctx, tx, queries, authority.DocumentID, comment)
}

// Delete removes one Comment.
func (s *CommentService) Delete(ctx context.Context, input DeleteInput) (CommentResult, error) {
	if input.AccountID == "" || input.CommentID == "" || input.ExpectedVersion < 1 {
		return CommentResult{}, ErrCommentInvalidInput
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return CommentResult{}, err
	}
	defer tx.Rollback(ctx)
	queries := store.New(tx)
	authority, err := queries.GetRoomDocumentCommentMutationAuthority(ctx, store.GetRoomDocumentCommentMutationAuthorityParams{
		AccountID: input.AccountID, CommentID: input.CommentID,
	})
	if err != nil {
		return CommentResult{}, err
	}
	if authority.CallerActorID != authority.AuthorActorID {
		return CommentResult{}, ErrCommentForbidden
	}
	if authority.DeletedAt.Valid || authority.VersionNumber != input.ExpectedVersion {
		return CommentResult{}, ErrCommentConflict
	}
	deleted, err := queries.SoftDeleteRoomDocumentComment(ctx, authority.ID)
	if err != nil {
		return CommentResult{}, err
	}
	comment := commentFromMutation(authority, deleted.VersionNumber, "", []Segment{}, deleted.UpdatedAt.Time, &deleted.DeletedAt.Time)
	if err := recordCommentChange(ctx, tx, queries, commentChange{
		Kind: "comment_deleted", TenantID: authority.TenantID, RoomID: legacyRoomID(authority.RoomID),
		DocumentID: authority.DocumentID, ThreadID: authority.ThreadID,
		CommentID: authority.ID, VersionNumber: deleted.VersionNumber,
		ActorID: authority.CallerActorID, ActorKind: "human",
	}, nil); err != nil {
		return CommentResult{}, err
	}
	return finishCommentMutation(ctx, tx, queries, authority.DocumentID, comment)
}

func finishCommentMutation(
	ctx context.Context,
	tx pgx.Tx,
	queries *store.Queries,
	documentID string,
	comment Comment,
) (CommentResult, error) {
	if _, err := queries.TouchRoomDocumentCommentThread(ctx, comment.ThreadID); err != nil {
		return CommentResult{}, err
	}
	body, err := json.Marshal(comment)
	if err != nil {
		return CommentResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return CommentResult{}, err
	}
	return CommentResult{Comment: comment, Body: body, Status: http.StatusOK, DocumentID: documentID}, nil
}

func commentFromMutation(
	authority store.GetRoomDocumentCommentMutationAuthorityRow,
	versionNumber int64,
	body string,
	segments []Segment,
	updatedAt time.Time,
	deletedAt *time.Time,
) Comment {
	comment := Comment{
		ID: authority.ID, ThreadID: authority.ThreadID,
		Author: CommentActor{ID: authority.AuthorActorID, TenantID: authority.TenantID, Kind: authority.AuthorKind, DisplayName: authority.AuthorDisplayName},
		Body:   body, Segments: append([]Segment{}, segments...),
		VersionNumber: versionNumber, Reactions: []Reaction{}, DeletedAt: deletedAt,
		CreatedAt: authority.CreatedAt.Time, UpdatedAt: updatedAt,
	}
	if authority.ParentCommentID.Valid {
		comment.ParentCommentID = &authority.ParentCommentID.String
	}
	return comment
}
