package document

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

type ResolutionInput struct {
	AccountID string
	ThreadID  string
}

// Resolve marks a Comment Thread resolved; resolving a resolved Thread
// changes nothing.
func (s *CommentService) Resolve(ctx context.Context, input ResolutionInput) (Result, error) {
	return s.setResolution(ctx, input, true)
}

// Reopen marks a resolved Comment Thread open again.
func (s *CommentService) Reopen(ctx context.Context, input ResolutionInput) (Result, error) {
	return s.setResolution(ctx, input, false)
}

func (s *CommentService) setResolution(
	ctx context.Context,
	input ResolutionInput,
	resolved bool,
) (Result, error) {
	if input.AccountID == "" || input.ThreadID == "" {
		return Result{}, ErrCommentInvalidInput
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return Result{}, err
	}
	defer tx.Rollback(ctx)
	queries := store.New(tx)
	authority, err := queries.GetRoomDocumentCommentResolutionAuthority(ctx, store.GetRoomDocumentCommentResolutionAuthorityParams{
		AccountID: input.AccountID, ThreadID: input.ThreadID,
	})
	if err != nil {
		return Result{}, err
	}
	result := Result{}
	if resolved {
		var changed int64
		changed, err = queries.ResolveRoomDocumentCommentThread(ctx, store.ResolveRoomDocumentCommentThreadParams{
			ResolvedByActorID: authority.ActorID, ThreadID: input.ThreadID,
		})
		if err == nil && changed > 0 {
			err = recordCommentChange(ctx, tx, queries, commentChange{
				Kind: "resolution_changed", TenantID: authority.TenantID, RoomID: legacyRoomID(authority.RoomID),
				DocumentID: authority.DocumentID, ThreadID: input.ThreadID,
				ActorID: authority.ActorID, ActorKind: "human",
			}, nil)
			if err == nil {
				err = EnqueueCommentInputsForThreadsTx(ctx, tx, []string{input.ThreadID})
			}
		}
	} else {
		var changed int64
		changed, err = queries.ReopenRoomDocumentCommentThread(ctx, input.ThreadID)
		if err == nil && changed > 0 {
			err = recordCommentChange(ctx, tx, queries, commentChange{
				Kind: "resolution_changed", TenantID: authority.TenantID, RoomID: legacyRoomID(authority.RoomID),
				DocumentID: authority.DocumentID, ThreadID: input.ThreadID,
				ActorID: authority.ActorID, ActorKind: "human",
			}, nil)
		}
	}
	if err != nil {
		return Result{}, err
	}
	record, err := queries.GetRoomDocumentCommentThreadForAccount(ctx, store.GetRoomDocumentCommentThreadForAccountParams{
		AccountID: input.AccountID, ThreadID: input.ThreadID,
	})
	if err != nil {
		return Result{}, err
	}
	threads, err := projectThreads(ctx, queries, []threadProjection{threadProjectionFromGet(record)})
	if err != nil {
		return Result{}, err
	}
	result.Thread = threads[0]
	result.Status = http.StatusOK
	result.Body, err = json.Marshal(result.Thread)
	if err != nil {
		return Result{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Result{}, err
	}
	return result, nil
}
