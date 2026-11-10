package document

import (
	"context"
	"strings"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

type ReactionInput struct {
	AccountID string
	CommentID string
	Emoji     string
}

// PutReaction adds a reaction to a Comment.
func (s *CommentService) PutReaction(ctx context.Context, input ReactionInput) error {
	return s.mutateReaction(ctx, input, true)
}

// DeleteReaction removes a reaction from a Comment.
func (s *CommentService) DeleteReaction(ctx context.Context, input ReactionInput) error {
	return s.mutateReaction(ctx, input, false)
}

func (s *CommentService) mutateReaction(ctx context.Context, input ReactionInput, put bool) error {
	if input.AccountID == "" || input.CommentID == "" || input.Emoji == "" ||
		utf8.RuneCountInString(input.Emoji) > 64 || strings.ContainsRune(input.Emoji, '\x00') {
		return ErrCommentInvalidInput
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	queries := store.New(tx)
	authority, err := queries.GetRoomDocumentCommentReactionAuthority(ctx, store.GetRoomDocumentCommentReactionAuthorityParams{
		AccountID: input.AccountID, CommentID: input.CommentID,
	})
	if err != nil {
		return err
	}
	var changed int64
	if put {
		reactionCount, countErr := queries.CountRoomDocumentCommentReactions(ctx, authority.CommentID)
		if countErr != nil {
			return countErr
		}
		if reactionCount >= maxReactionsPerComment {
			exists, existsErr := queries.RoomDocumentCommentReactionExists(ctx, store.RoomDocumentCommentReactionExistsParams{
				CommentID: authority.CommentID, ActorID: authority.ActorID, Emoji: input.Emoji,
			})
			if existsErr != nil {
				return existsErr
			}
			if !exists {
				return ErrCommentCapacity
			}
		}
		changed, err = queries.PutRoomDocumentCommentReaction(ctx, store.PutRoomDocumentCommentReactionParams{
			TenantID: authority.TenantID, RoomID: legacyRoomID(authority.RoomID),
			DocumentID: authority.DocumentID, ThreadID: authority.ThreadID,
			CommentID: authority.CommentID, ActorID: authority.ActorID, Emoji: input.Emoji,
		})
	} else {
		changed, err = queries.DeleteRoomDocumentCommentReaction(ctx, store.DeleteRoomDocumentCommentReactionParams{
			CommentID: authority.CommentID, ActorID: authority.ActorID, Emoji: input.Emoji,
		})
	}
	if err != nil {
		return err
	}
	if changed == 0 {
		return tx.Commit(ctx)
	}
	if _, err := queries.TouchRoomDocumentCommentThread(ctx, authority.ThreadID); err != nil {
		return err
	}
	if err := recordCommentChange(ctx, tx, queries, commentChange{
		Kind: "reaction_changed", TenantID: authority.TenantID, RoomID: legacyRoomID(authority.RoomID),
		DocumentID: authority.DocumentID, ThreadID: authority.ThreadID, CommentID: authority.CommentID,
		ActorID: authority.ActorID, ActorKind: "human",
	}, nil); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func listProjectedReactions(
	ctx context.Context,
	queries *store.Queries,
	threadIDs []string,
) (map[string][]Reaction, error) {
	records, err := queries.ListRoomDocumentCommentReactionsForThreads(ctx, threadIDs)
	if err != nil {
		return nil, err
	}
	result := make(map[string][]Reaction)
	for _, record := range records {
		reactions := result[record.CommentID]
		if len(reactions) == 0 || reactions[len(reactions)-1].Emoji != record.Emoji {
			reactions = append(reactions, Reaction{
				Emoji: record.Emoji, ActorIDs: []string{record.ActorID}, CreatedAt: record.CreatedAt.Time,
			})
		} else {
			last := &reactions[len(reactions)-1]
			last.ActorIDs = append(last.ActorIDs, record.ActorID)
			if record.CreatedAt.Time.Before(last.CreatedAt) {
				last.CreatedAt = record.CreatedAt.Time
			}
		}
		result[record.CommentID] = reactions
	}
	return result, nil
}
