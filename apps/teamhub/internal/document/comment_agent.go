package document

import (
	"context"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

type AgentReplyInput struct {
	AgentManagementID string
	ThreadID          string
	IdempotencyKey    string
	ParentCommentID   *string
	Segments          []Segment
}

// GetThreadForAgent reads one Comment Thread for an Agent.
func (s *CommentService) GetThreadForAgent(ctx context.Context, agentManagementID, threadID string) (Thread, error) {
	queries := store.New(s.pool)
	record, err := queries.GetRoomDocumentCommentThreadForAgent(ctx, store.GetRoomDocumentCommentThreadForAgentParams{
		AgentManagementID: agentManagementID, ThreadID: threadID,
	})
	if err != nil {
		return Thread{}, err
	}
	threads, err := projectThreads(ctx, queries, []threadProjection{threadProjectionFromAgent(record)})
	if err != nil {
		return Thread{}, err
	}
	return threads[0], nil
}

// ReplyForAgent appends an Agent reply to an existing Comment Thread.
func (s *CommentService) ReplyForAgent(ctx context.Context, input AgentReplyInput) (CommentResult, error) {
	return s.reply(ctx, replyMutationInput{
		PrincipalID: "agent:" + input.AgentManagementID, ThreadID: input.ThreadID,
		IdempotencyKey: input.IdempotencyKey, ParentCommentID: input.ParentCommentID,
		Segments: input.Segments,
	}, func(ctx context.Context, queries *store.Queries, threadID string, referenceActorIDs []string) ([]store.ListCurrentRoomDocumentCommentReferenceActorsRow, error) {
		scope, err := queries.GetRoomDocumentCommentReplyScope(ctx, threadID)
		if err != nil {
			return nil, err
		}
		return prepareHumanAgentMentionReferences(
			ctx, queries, scope.DocumentID, nil,
			mentionPrincipal{Kind: "agent", ID: input.AgentManagementID}, referenceActorIDs,
		)
	}, func(ctx context.Context, queries *store.Queries, threadID string) (replyAuthority, error) {
		record, err := queries.GetRoomDocumentCommentReplyAuthorityForAgent(ctx, store.GetRoomDocumentCommentReplyAuthorityForAgentParams{
			AgentManagementID: input.AgentManagementID, ThreadID: threadID,
		})
		if err != nil {
			return replyAuthority{}, err
		}
		return replyAuthority{
			ThreadID: record.ThreadID, DocumentID: record.DocumentID,
			TenantID: record.TenantID, RoomID: legacyRoomID(record.RoomID),
			CurrentAnchorID: record.CurrentAnchorID,
			ActorID:         record.ActorID, ActorKind: record.ActorKind,
			ActorDisplayName: record.ActorDisplayName,
		}, nil
	})
}

func threadProjectionFromAgent(record store.GetRoomDocumentCommentThreadForAgentRow) threadProjection {
	return threadProjection{
		ID: record.ID, DocumentID: record.DocumentID, AnchorStatus: record.AnchorStatus,
		CreatedAt: record.CreatedAt, UpdatedAt: record.UpdatedAt, ResolvedAt: record.ResolvedAt,
		Creator:  CommentActor{ID: record.CreatorID, TenantID: record.CreatorTenantID, Kind: record.CreatorKind, DisplayName: record.CreatorDisplayName},
		Resolver: CommentActor{ID: record.ResolverID.String, TenantID: record.CreatorTenantID, Kind: record.ResolverKind.String, DisplayName: record.ResolverDisplayName.String},
		AnchorID: record.AnchorID, AnchorKind: record.AnchorKind,
		AnchorDocumentVersionID: record.DocumentVersionID.String,
		QuotedText:              record.QuotedText, BlockID: record.BlockID,
		ContextBefore: record.ContextBefore, ContextAfter: record.ContextAfter, AnchorCreatedAt: record.AnchorCreatedAt,
		AnchorCreator: CommentActor{ID: record.AnchorCreatorID, TenantID: record.CreatorTenantID, Kind: record.AnchorCreatorKind, DisplayName: record.AnchorCreatorDisplayName},
	}
}
