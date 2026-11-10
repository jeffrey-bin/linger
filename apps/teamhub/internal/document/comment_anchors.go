package document

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	idgen "github.com/simplexai-labs/linger/apps/teamhub/internal/ids"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

type ReanchorInput struct {
	AccountID string
	ThreadID  string
	Anchor    AnchorInput
}

// Reanchor moves a Comment Thread to a new anchor.
func (s *CommentService) Reanchor(ctx context.Context, input ReanchorInput) (Result, error) {
	if input.AccountID == "" || input.ThreadID == "" || !validAnchorInput(input.Anchor) {
		return Result{}, ErrCommentInvalidInput
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return Result{}, err
	}
	defer tx.Rollback(ctx)
	queries := store.New(tx)
	authority, err := queries.GetRoomDocumentCommentReanchorAuthority(ctx, store.GetRoomDocumentCommentReanchorAuthorityParams{
		AccountID: input.AccountID, ThreadID: input.ThreadID,
	})
	if err != nil {
		return Result{}, err
	}
	if (authority.AnchorStatus != "pending" && authority.AnchorStatus != "orphaned") || authority.ResolvedAt.Valid {
		return Result{}, ErrCommentConflict
	}
	if err := queries.AdvanceRoomDocumentCommentThreadAnchor(ctx, store.AdvanceRoomDocumentCommentThreadAnchorParams{
		AnchorID: newCommentID("document_comment_anchor_"), ThreadID: input.ThreadID,
		QuotedText: input.Anchor.QuotedText, BlockID: input.Anchor.BlockID,
		ContextBefore: input.Anchor.ContextBefore, ContextAfter: input.Anchor.ContextAfter,
		ActorID: authority.ActorID,
	}); err != nil {
		return Result{}, err
	}
	if err := EnqueueCommentInputsForThreadsTx(ctx, tx, []string{input.ThreadID}); err != nil {
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
	result := Result{Thread: threads[0], Status: http.StatusOK}
	result.Body, err = json.Marshal(result.Thread)
	if err != nil {
		return Result{}, err
	}
	err = recordCommentChange(ctx, tx, queries, commentChange{
		Kind: "thread_reanchored", TenantID: authority.TenantID, RoomID: legacyRoomID(authority.RoomID),
		DocumentID: authority.DocumentID, ThreadID: input.ThreadID,
		ActorID: authority.ActorID, ActorKind: "human",
	}, nil)
	if err != nil {
		return Result{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Result{}, err
	}
	return result, nil
}

// ErrCommentRuntimeUnavailable reports that the Document Runtime could not
// mark the Comment selection.
var ErrCommentRuntimeUnavailable = errors.New("document Comment Runtime unavailable")

// AnchorAttachmentInput asks to mark a read-only commenter's pending
// selection on the body the commenter saw.
type AnchorAttachmentInput struct {
	AccountID, ThreadID, ExpectedFullStateFingerprint string
	ExpectedPersistedSeq                              int64
}

// AnchorAttachmentResult reports the attached Thread and the Revision that
// records the marked body.
type AnchorAttachmentResult struct {
	Status, RevisionID string
	Thread             Thread
}

// NewCommentService returns a CommentService whose read-only commenters'
// selection anchors are marked through runtime.
func NewCommentService(pool *pgxpool.Pool, runtime Runtime) *CommentService {
	return &CommentService{pool: pool, runtime: runtime}
}

// AttachSelectionAnchor marks a pending selection anchor in the Document for a
// commenter whose session cannot write the Document; an editable session
// writes the mark itself. The Runtime applies the mark to the body the caller
// saw, at ExpectedPersistedSeq. A Thread already attached reports so.
func (s *CommentService) AttachSelectionAnchor(ctx context.Context, input AnchorAttachmentInput) (AnchorAttachmentResult, error) {
	if s == nil || s.pool == nil || input.AccountID == "" || input.ThreadID == "" ||
		input.ExpectedPersistedSeq < 0 || len(input.ExpectedFullStateFingerprint) != 64 {
		return AnchorAttachmentResult{}, ErrCommentInvalidInput
	}
	if s.runtime == nil {
		return AnchorAttachmentResult{}, ErrCommentRuntimeUnavailable
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return AnchorAttachmentResult{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// No Thread row lock: the Runtime's save attaches the anchor through the
	// document_bodies trigger, which updates this Thread row on the Runtime's
	// connection while this transaction waits for the reply.
	var documentID, actorID, anchorStatus string
	var anchor CommentAnchorChange
	err = tx.QueryRow(ctx, `SELECT thread.document_id,caller.id,thread.anchor_status,
		thread.anchor_quoted_text,thread.anchor_block_id,thread.anchor_context_before,thread.anchor_context_after
		FROM room_document_comment_threads thread
		JOIN documents document ON document.id=thread.document_id AND document.tenant_id=thread.tenant_id
		 AND document.status='active' AND document.format='blocknote'
		JOIN actors caller ON caller.tenant_id=thread.tenant_id AND caller.account_id=$1 AND caller.kind='human'
		JOIN LATERAL resolve_human_document_access_v2($1,thread.document_id) access ON access.can_read AND access.can_comment
		WHERE thread.id=$2 AND thread.anchor_status IN ('pending','attached') AND thread.resolved_at IS NULL
		  AND thread.anchor_kind='selection'`, input.AccountID, input.ThreadID).Scan(
		&documentID, &actorID, &anchorStatus,
		&anchor.QuotedText, &anchor.BlockID, &anchor.ContextBefore, &anchor.ContextAfter)
	if err != nil {
		return AnchorAttachmentResult{}, err
	}
	if anchorStatus == "attached" {
		// A saved body already references the Thread, for example an earlier
		// attempt whose reply was lost after the Runtime saved the mark.
		return s.saveAnchorAttachment(ctx, tx, input, documentID, "already_attached")
	}
	var currentHash string
	if err := tx.QueryRow(ctx, `SELECT encode(sha256(state),'hex') FROM document_bodies
		WHERE document_id=$1 AND seq=$2`, documentID, input.ExpectedPersistedSeq).Scan(&currentHash); errors.Is(err, pgx.ErrNoRows) {
		return AnchorAttachmentResult{}, ErrCommentConflict
	} else if err != nil {
		return AnchorAttachmentResult{}, err
	}
	if currentHash != input.ExpectedFullStateFingerprint {
		return AnchorAttachmentResult{}, ErrCommentConflict
	}
	anchor.ThreadID = input.ThreadID
	applied, err := s.runtime.Apply(ctx, ApplyRequest{
		DocumentID: documentID, ActorID: actorID, ExpectedSeq: &input.ExpectedPersistedSeq,
		OperationID:   idgen.New("document_anchor_attachment"),
		CommentAnchor: &anchor,
	})
	switch {
	case errors.Is(err, ErrInvalidInput):
		// The quoted selection is no longer in the Document.
		return AnchorAttachmentResult{}, ErrCommentConflict
	case err != nil:
		return AnchorAttachmentResult{}, errors.Join(ErrCommentRuntimeUnavailable, err)
	case !applied.Applied:
		return AnchorAttachmentResult{}, ErrCommentConflict
	}
	return s.saveAnchorAttachment(ctx, tx, input, documentID, "attached")
}

// saveAnchorAttachment pins the marked body once the saved body references the
// Thread. The committed save that added the reference already attached the
// anchor and enqueued the Thread's waiting Comment input through the
// document_bodies trigger.
func (s *CommentService) saveAnchorAttachment(
	ctx context.Context, tx pgx.Tx, input AnchorAttachmentInput, documentID, status string,
) (AnchorAttachmentResult, error) {
	revisionID, err := bodyRevisionTx(ctx, tx, documentID)
	if err != nil {
		return AnchorAttachmentResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return AnchorAttachmentResult{}, err
	}
	thread, err := s.GetThread(ctx, input.AccountID, input.ThreadID)
	return AnchorAttachmentResult{Status: status, RevisionID: revisionID, Thread: thread}, err
}
