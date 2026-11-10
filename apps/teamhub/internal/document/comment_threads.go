package document

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"net/http"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentcredential"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/idempotency"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

const createReplyOperation = "create_reply"

type ThreadPage struct {
	Items      []Thread
	HasMore    bool
	NextCursor string
}

type ReplyInput struct {
	AccountID       string
	ThreadID        string
	ParentCommentID *string
	Segments        []Segment
	DurableHead     *DurableHeadSelector
	CurrentContext  *CurrentContextSelector
}

type replyMutationInput struct {
	PrincipalID string
	ThreadID    string
	// IdempotencyKey deduplicates an Agent reply; a Human reply carries none.
	IdempotencyKey  string
	ParentCommentID *string
	Segments        []Segment
	DurableHead     *DurableHeadSelector
	CurrentContext  *CurrentContextSelector
}

type replyAuthority struct {
	ThreadID, DocumentID, TenantID, RoomID string
	CurrentAnchorID                        string
	ActorID, ActorKind, ActorDisplayName   string
}

type replyAuthorityResolver func(context.Context, *store.Queries, string) (replyAuthority, error)
type replyAuthorityPreparer func(
	context.Context,
	*store.Queries,
	string,
	[]string,
) ([]store.ListCurrentRoomDocumentCommentReferenceActorsRow, error)

type CommentResult struct {
	Comment Comment
	Body    []byte
	Status  int
	Replay  bool
	// DocumentID is empty on a replay, which stores only the Comment.
	DocumentID string
}

type threadProjection struct {
	ID, DocumentID, AnchorStatus                      string
	CreatedAt, UpdatedAt, ResolvedAt, AnchorCreatedAt pgtype.Timestamptz
	Creator, Resolver, AnchorCreator                  CommentActor
	AnchorID, AnchorKind, AnchorDocumentVersionID     string
	QuotedText, BlockID                               string
	ContextBefore, ContextAfter                       string
}

// GetThread reads one Comment Thread visible to the Account.
func (s *CommentService) GetThread(ctx context.Context, accountID, threadID string) (Thread, error) {
	queries := store.New(s.pool)
	record, err := queries.GetRoomDocumentCommentThreadForAccount(ctx, store.GetRoomDocumentCommentThreadForAccountParams{
		AccountID: accountID, ThreadID: threadID,
	})
	if err != nil {
		return Thread{}, err
	}
	threads, err := projectThreads(ctx, queries, []threadProjection{threadProjectionFromGet(record)})
	if err != nil {
		return Thread{}, err
	}
	return threads[0], nil
}

// ListThreads pages the Comment Threads of a Document.
func (s *CommentService) ListThreads(ctx context.Context, accountID, documentID, cursor string, limit int32) (ThreadPage, error) {
	if limit < 1 || limit > 200 {
		return ThreadPage{}, ErrCommentInvalidInput
	}
	queries := store.New(s.pool)
	if _, err := queries.GetRoomDocumentCommentReadAuthority(ctx, store.GetRoomDocumentCommentReadAuthorityParams{
		AccountID: accountID, DocumentID: documentID,
	}); err != nil {
		return ThreadPage{}, err
	}
	records, err := queries.ListRoomDocumentCommentThreads(ctx, store.ListRoomDocumentCommentThreadsParams{
		DocumentID: documentID, Cursor: cursor, PageLimit: limit + 1,
	})
	if err != nil {
		return ThreadPage{}, err
	}
	hasMore := len(records) > int(limit)
	if hasMore {
		records = records[:limit]
	}
	projections := make([]threadProjection, 0, len(records))
	for _, record := range records {
		projections = append(projections, threadProjectionFromList(record))
	}
	items, err := projectThreads(ctx, queries, projections)
	if err != nil {
		return ThreadPage{}, err
	}
	nextCursor := ""
	if hasMore && len(items) > 0 {
		nextCursor = items[len(items)-1].ID
	}
	return ThreadPage{Items: items, HasMore: hasMore, NextCursor: nextCursor}, nil
}

// Reply appends a Comment to an existing Thread.
func (s *CommentService) Reply(ctx context.Context, input ReplyInput) (CommentResult, error) {
	return s.reply(ctx, replyMutationInput{
		PrincipalID: input.AccountID, ThreadID: input.ThreadID, ParentCommentID: input.ParentCommentID,
		Segments: input.Segments, DurableHead: input.DurableHead, CurrentContext: input.CurrentContext,
	}, func(ctx context.Context, queries *store.Queries, threadID string, referenceActorIDs []string) ([]store.ListCurrentRoomDocumentCommentReferenceActorsRow, error) {
		scope, err := queries.GetRoomDocumentCommentReplyScope(ctx, threadID)
		if err != nil {
			return nil, err
		}
		return prepareHumanAgentMentionReferences(
			ctx, queries, scope.DocumentID, input.CurrentContext,
			mentionPrincipal{Kind: "human", ID: input.AccountID}, referenceActorIDs,
		)
	}, func(ctx context.Context, queries *store.Queries, threadID string) (replyAuthority, error) {
		record, err := queries.GetRoomDocumentCommentReplyAuthority(ctx, store.GetRoomDocumentCommentReplyAuthorityParams{
			AccountID: input.AccountID, ThreadID: threadID,
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

func (s *CommentService) reply(
	ctx context.Context,
	input replyMutationInput,
	prepare replyAuthorityPreparer,
	resolve replyAuthorityResolver,
) (CommentResult, error) {
	body, referenceActorIDs, err := validateContent(input.Segments)
	if err != nil || input.PrincipalID == "" || input.ThreadID == "" {
		return CommentResult{}, ErrCommentInvalidInput
	}
	hash := replyRequestHash(input)
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return CommentResult{}, err
	}
	defer tx.Rollback(ctx)
	if p, ok := agentcredential.PrincipalFromContext(ctx); ok {
		if input.PrincipalID != "agent:"+p.AgentID || agentcredential.RevalidateInTx(ctx, tx, p) != nil {
			return CommentResult{}, ErrCommentForbidden
		}
	}
	queries := store.New(tx)
	if err := idempotency.Lock(ctx, tx, idempotency.PrincipalKey(input.PrincipalID, createReplyOperation, input.IdempotencyKey)); err != nil {
		return CommentResult{}, err
	}
	if replay, found, err := lookupCommentReplay(
		ctx, tx, input.PrincipalID, createReplyOperation, input.IdempotencyKey, hash,
	); found || err != nil {
		if err != nil {
			return CommentResult{}, err
		}
		if err := tx.Commit(ctx); err != nil {
			return CommentResult{}, err
		}
		return replay, nil
	}
	var referenceActors []store.ListCurrentRoomDocumentCommentReferenceActorsRow
	if prepare != nil {
		referenceActors, err = prepare(ctx, queries, input.ThreadID, referenceActorIDs)
		if err != nil {
			return CommentResult{}, err
		}
	}
	authority, err := resolve(ctx, queries, input.ThreadID)
	if err != nil {
		return CommentResult{}, err
	}
	commentCount, err := queries.CountRoomDocumentCommentsForThread(ctx, input.ThreadID)
	if err != nil {
		return CommentResult{}, err
	}
	if commentCount >= maxCommentsPerThread {
		return CommentResult{}, ErrCommentCapacity
	}
	if input.ParentCommentID != nil {
		if _, err := queries.GetRoomDocumentCommentParent(ctx, store.GetRoomDocumentCommentParentParams{
			CommentID: *input.ParentCommentID, ThreadID: input.ThreadID,
		}); err != nil {
			return CommentResult{}, err
		}
	}
	if prepare == nil {
		referenceActors, err = referenceActorsFromIDs(ctx, queries, authority.TenantID, authority.RoomID, referenceActorIDs)
		if err != nil {
			return CommentResult{}, err
		}
	}
	result, err := createReplyEvidence(ctx, queries, authority, input, body)
	if err != nil {
		return CommentResult{}, err
	}
	err = recordCommentChange(ctx, tx, queries, commentChange{
		Kind: "comment_replied", TenantID: authority.TenantID,
		RoomID:     mentionRoomID(input.CurrentContext, referenceActorIDs),
		DocumentID: authority.DocumentID, ThreadID: authority.ThreadID,
		CommentID: result.Comment.ID, VersionNumber: result.Comment.VersionNumber,
		AnchorID: authority.CurrentAnchorID, DurableHead: input.DurableHead,
		ActorID: authority.ActorID, ActorKind: authority.ActorKind,
	}, referenceActors)
	if err != nil {
		return CommentResult{}, err
	}
	result.DocumentID = authority.DocumentID
	result.Body, err = json.Marshal(result.Comment)
	if err != nil {
		return CommentResult{}, err
	}
	if err := idempotency.Save(ctx, tx, idempotency.PrincipalKey(input.PrincipalID, createReplyOperation, input.IdempotencyKey), hash, idempotency.Record{
		ResourceID: result.Comment.ID, Status: result.Status, Body: result.Body,
	}); err != nil {
		return CommentResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return CommentResult{}, err
	}
	return result, nil
}

func projectThreads(ctx context.Context, queries *store.Queries, records []threadProjection) ([]Thread, error) {
	if len(records) == 0 {
		return []Thread{}, nil
	}
	threadIDs := make([]string, 0, len(records))
	for _, record := range records {
		threadIDs = append(threadIDs, record.ID)
	}
	commentRecords, err := queries.ListRoomDocumentCommentsForThreads(ctx, threadIDs)
	if err != nil {
		return nil, err
	}
	reactionsByComment, err := listProjectedReactions(ctx, queries, threadIDs)
	if err != nil {
		return nil, err
	}
	comments := make(map[string][]Comment, len(records))
	for _, record := range commentRecords {
		comment, err := projectComment(record)
		if err != nil {
			return nil, err
		}
		if reactions := reactionsByComment[record.ID]; reactions != nil {
			comment.Reactions = reactions
		}
		comments[record.ThreadID] = append(comments[record.ThreadID], comment)
	}
	threads := make([]Thread, 0, len(records))
	for _, record := range records {
		thread := Thread{
			ID: record.ID, DocumentID: record.DocumentID, AnchorStatus: record.AnchorStatus,
			Resolved: record.ResolvedAt.Valid,
			Anchor: Anchor{
				ID: record.AnchorID, Kind: record.AnchorKind,
				DocumentVersionID: record.AnchorDocumentVersionID,
				QuotedText:        record.QuotedText, BlockID: record.BlockID,
				ContextBefore: record.ContextBefore, ContextAfter: record.ContextAfter,
				CreatedBy: record.AnchorCreator, CreatedAt: record.AnchorCreatedAt.Time,
			},
			Comments: comments[record.ID], CreatedBy: record.Creator,
			CreatedAt: record.CreatedAt.Time, UpdatedAt: record.UpdatedAt.Time,
		}
		if thread.Comments == nil {
			thread.Comments = []Comment{}
		}
		if record.ResolvedAt.Valid {
			resolvedAt := record.ResolvedAt.Time
			thread.ResolvedAt = &resolvedAt
			thread.ResolvedBy = &record.Resolver
		}
		threads = append(threads, thread)
	}
	return threads, nil
}

func projectComment(record store.ListRoomDocumentCommentsForThreadsRow) (Comment, error) {
	segments := []Segment{}
	if !record.DeletedAt.Valid {
		if err := json.Unmarshal(record.Segments, &segments); err != nil {
			return Comment{}, err
		}
	}
	comment := Comment{
		ID: record.ID, ThreadID: record.ThreadID,
		Author: CommentActor{ID: record.AuthorID, TenantID: record.AuthorTenantID, Kind: record.AuthorKind, DisplayName: record.AuthorDisplayName},
		Body:   record.Body, Segments: segments,
		VersionNumber: record.VersionNumber, Reactions: []Reaction{},
		CreatedAt: record.CreatedAt.Time, UpdatedAt: record.UpdatedAt.Time,
	}
	if record.ParentCommentID.Valid {
		comment.ParentCommentID = &record.ParentCommentID.String
	}
	if record.DeletedAt.Valid {
		comment.Body = ""
		deletedAt := record.DeletedAt.Time
		comment.DeletedAt = &deletedAt
	}
	return comment, nil
}

func threadProjectionFromGet(record store.GetRoomDocumentCommentThreadForAccountRow) threadProjection {
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

func threadProjectionFromList(record store.ListRoomDocumentCommentThreadsRow) threadProjection {
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

func replyRequestHash(input replyMutationInput) []byte {
	encoded, err := json.Marshal(struct {
		ThreadID        string                  `json:"thread_id"`
		ParentCommentID *string                 `json:"parent_comment_id,omitempty"`
		Segments        []Segment               `json:"segments"`
		DurableHead     *DurableHeadSelector    `json:"durable_head,omitempty"`
		CurrentContext  *CurrentContextSelector `json:"current_context,omitempty"`
	}{ThreadID: input.ThreadID, ParentCommentID: input.ParentCommentID, Segments: input.Segments,
		DurableHead: input.DurableHead, CurrentContext: input.CurrentContext})
	if err != nil {
		panic(err)
	}
	digest := sha256.Sum256(encoded)
	return digest[:]
}

// lookupCommentReplay relies on the request hash to cover the thread and comment
// IDs that the caller addresses.
func lookupCommentReplay(
	ctx context.Context,
	tx pgx.Tx,
	principalID, operation, idempotencyKey string,
	hash []byte,
) (CommentResult, bool, error) {
	record, found, err := idempotency.Lookup(ctx, tx, idempotency.PrincipalKey(principalID, operation, idempotencyKey), hash)
	if errors.Is(err, idempotency.ErrConflict) {
		return CommentResult{}, true, ErrCommentIdempotencyConflict
	}
	if err != nil || !found {
		return CommentResult{}, false, err
	}
	var comment Comment
	if err := json.Unmarshal(record.Body, &comment); err != nil {
		return CommentResult{}, true, err
	}
	return CommentResult{Comment: comment, Body: record.Body, Status: record.Status, Replay: true}, true, nil
}

func createReplyEvidence(
	ctx context.Context,
	queries *store.Queries,
	authority replyAuthority,
	input replyMutationInput,
	body string,
) (CommentResult, error) {
	commentID := newCommentID("document_comment_")
	parent := pgtype.Text{}
	if input.ParentCommentID != nil {
		parent = pgtype.Text{String: *input.ParentCommentID, Valid: true}
	}
	segments, err := json.Marshal(input.Segments)
	if err != nil {
		return CommentResult{}, err
	}
	commentRecord, err := queries.CreateRoomDocumentComment(ctx, store.CreateRoomDocumentCommentParams{
		ID: commentID, TenantID: authority.TenantID, RoomID: authority.RoomID,
		DocumentID: authority.DocumentID, ThreadID: authority.ThreadID,
		ParentCommentID: parent, AuthorActorID: authority.ActorID, Body: body, Segments: segments,
	})
	if err != nil {
		return CommentResult{}, err
	}
	if _, err := queries.TouchRoomDocumentCommentThread(ctx, authority.ThreadID); err != nil {
		return CommentResult{}, err
	}
	author := CommentActor{ID: authority.ActorID, TenantID: authority.TenantID, Kind: authority.ActorKind, DisplayName: authority.ActorDisplayName}
	comment := Comment{
		ID: commentRecord.ID, ThreadID: commentRecord.ThreadID, ParentCommentID: input.ParentCommentID,
		Author: author, Body: commentRecord.Body, Segments: append([]Segment{}, input.Segments...),
		VersionNumber: commentRecord.VersionNumber,
		Reactions:     []Reaction{}, CreatedAt: commentRecord.CreatedAt.Time, UpdatedAt: commentRecord.UpdatedAt.Time,
	}
	responseBody, err := json.Marshal(comment)
	if err != nil {
		return CommentResult{}, err
	}
	return CommentResult{Comment: comment, Body: responseBody, Status: http.StatusCreated}, nil
}
