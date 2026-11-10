// CommentService owns TeamHub's durable Room Document Comment state.

package document

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

// Errors returned by CommentService.
var (
	ErrCommentIdempotencyConflict    = errors.New("document Comment idempotency key reused")
	ErrCommentInvalidInput           = errors.New("invalid document Comment input")
	ErrCommentConflict               = errors.New("document Comment version conflict")
	ErrCommentForbidden              = errors.New("document Comment mutation forbidden")
	ErrCommentCapacity               = errors.New("document Comment capacity reached")
	ErrCommentRecoveryBudgetExceeded = errors.New("document Comment recovery bundle exceeds its configured limit")
)

const (
	maxCommentsPerThread   = 1000
	maxReactionsPerComment = 1000
)

// CommentService owns durable Room Document Comment state.
type CommentService struct {
	pool    *pgxpool.Pool
	runtime Runtime
}

// CommentActor is the author of a Comment.
type CommentActor struct {
	ID          string `json:"id"`
	TenantID    string `json:"tenant_id"`
	Kind        string `json:"kind"`
	DisplayName string `json:"display_name"`
}

type Segment struct {
	Type    string `json:"type"`
	Content string `json:"content"`
	ActorID string `json:"actor_id,omitempty"`
}

type AnchorInput struct {
	QuotedText    string `json:"quoted_text"`
	BlockID       string `json:"block_id"`
	ContextBefore string `json:"context_before"`
	ContextAfter  string `json:"context_after"`
}

type CreateThreadInput struct {
	AccountID         string                  `json:"-"`
	DocumentID        string                  `json:"document_id"`
	Anchor            *AnchorInput            `json:"anchor,omitempty"`
	DocumentVersionID string                  `json:"document_version_id,omitempty"`
	Segments          []Segment               `json:"segments"`
	DurableHead       *DurableHeadSelector    `json:"durable_head,omitempty"`
	CurrentContext    *CurrentContextSelector `json:"current_context,omitempty"`
}

type CurrentContextSelector struct {
	BindingKind string `json:"binding_kind"`
	ContextID   string `json:"context_id"`
}

type DurableHeadSelector struct {
	PersistedSeq     int64  `json:"persisted_seq"`
	StateHash        string `json:"state_hash"`
	StateHashVersion int32  `json:"state_hash_version"`
}

type Anchor struct {
	ID                string       `json:"id"`
	Kind              string       `json:"kind"`
	DocumentVersionID string       `json:"document_version_id,omitempty"`
	QuotedText        string       `json:"quoted_text"`
	BlockID           string       `json:"block_id"`
	ContextBefore     string       `json:"context_before"`
	ContextAfter      string       `json:"context_after"`
	CreatedBy         CommentActor `json:"created_by"`
	CreatedAt         time.Time    `json:"created_at"`
}

type Reaction struct {
	Emoji     string    `json:"emoji"`
	ActorIDs  []string  `json:"actor_ids"`
	CreatedAt time.Time `json:"created_at"`
}

type Comment struct {
	ID              string       `json:"id"`
	ThreadID        string       `json:"thread_id"`
	ParentCommentID *string      `json:"parent_comment_id,omitempty"`
	Author          CommentActor `json:"author"`
	Body            string       `json:"body"`
	Segments        []Segment    `json:"segments"`
	VersionNumber   int64        `json:"version_number"`
	Reactions       []Reaction   `json:"reactions"`
	DeletedAt       *time.Time   `json:"deleted_at,omitempty"`
	CreatedAt       time.Time    `json:"created_at"`
	UpdatedAt       time.Time    `json:"updated_at"`
}

type Thread struct {
	ID           string        `json:"id"`
	DocumentID   string        `json:"document_id"`
	AnchorStatus string        `json:"anchor_status"`
	Resolved     bool          `json:"resolved"`
	Anchor       Anchor        `json:"anchor"`
	Comments     []Comment     `json:"comments"`
	CreatedBy    CommentActor  `json:"created_by"`
	ResolvedBy   *CommentActor `json:"resolved_by,omitempty"`
	ResolvedAt   *time.Time    `json:"resolved_at,omitempty"`
	CreatedAt    time.Time     `json:"created_at"`
	UpdatedAt    time.Time     `json:"updated_at"`
}

type Result struct {
	Thread Thread
	Body   []byte
	Status int
}

type createAnchor struct {
	Kind, DocumentVersionID, QuotedText, BlockID string
	ContextBefore, ContextAfter, Status          string
}

// CreateThread creates a Comment Thread with its first Comment.
func (s *CommentService) CreateThread(ctx context.Context, input CreateThreadInput) (Result, error) {
	body, referenceActorIDs, err := validateCreateInput(input)
	if err != nil {
		return Result{}, err
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return Result{}, err
	}
	defer tx.Rollback(ctx)
	queries := store.New(tx)
	referenceActors, err := prepareHumanAgentMentionReferences(
		ctx, queries, input.DocumentID, input.CurrentContext,
		mentionPrincipal{Kind: "human", ID: input.AccountID}, referenceActorIDs,
	)
	if err != nil {
		return Result{}, err
	}
	authority, err := queries.GetRoomDocumentCommentCreateAuthority(ctx, store.GetRoomDocumentCommentCreateAuthorityParams{
		AccountID: input.AccountID, DocumentID: input.DocumentID,
	})
	if err != nil {
		return Result{}, err
	}
	anchor, err := resolveCreateAnchor(ctx, queries, input)
	if err != nil {
		return Result{}, err
	}
	result, err := createThreadEvidence(ctx, queries, authority, input, anchor, body)
	if err != nil {
		return Result{}, err
	}
	err = recordCommentChange(ctx, tx, queries, commentChange{
		Kind: "thread_created", TenantID: authority.TenantID,
		RoomID:     mentionRoomID(input.CurrentContext, referenceActorIDs),
		DocumentID: authority.DocumentID, ThreadID: result.Thread.ID,
		CommentID: result.Thread.Comments[0].ID, VersionNumber: result.Thread.Comments[0].VersionNumber,
		AnchorID: result.Thread.Anchor.ID, ActorID: authority.ActorID, ActorKind: authority.ActorKind,
		DurableHead: input.DurableHead,
	}, referenceActors)
	if err != nil {
		return Result{}, err
	}
	result.Body, err = json.Marshal(result.Thread)
	if err != nil {
		return Result{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Result{}, err
	}
	return result, nil
}

func resolveCreateAnchor(
	ctx context.Context,
	queries *store.Queries,
	input CreateThreadInput,
) (createAnchor, error) {
	if input.Anchor != nil {
		return createAnchor{
			Kind: "selection", QuotedText: input.Anchor.QuotedText,
			BlockID: input.Anchor.BlockID, ContextBefore: input.Anchor.ContextBefore,
			ContextAfter: input.Anchor.ContextAfter, Status: "pending",
		}, nil
	}
	version, err := queries.GetDocumentCommentVersionAnchor(ctx, store.GetDocumentCommentVersionAnchorParams{
		DocumentVersionID: input.DocumentVersionID, DocumentID: input.DocumentID,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return createAnchor{}, ErrCommentInvalidInput
	}
	if err != nil {
		return createAnchor{}, err
	}
	return createAnchor{
		Kind: "document_version", DocumentVersionID: version.ID,
		QuotedText: version.Filename, Status: "attached",
	}, nil
}

func validateCreateInput(input CreateThreadInput) (string, []string, error) {
	hasSelection := input.Anchor != nil
	hasVersion := input.DocumentVersionID != ""
	if input.AccountID == "" || input.DocumentID == "" ||
		hasSelection == hasVersion || (hasSelection && !validAnchorInput(*input.Anchor)) ||
		(hasVersion && input.DurableHead != nil) {
		return "", nil, ErrCommentInvalidInput
	}
	return validateContent(input.Segments)
}

func validAnchorInput(anchor AnchorInput) bool {
	return strings.TrimSpace(anchor.QuotedText) != "" && utf8.RuneCountInString(anchor.QuotedText) <= 10000 &&
		strings.TrimSpace(anchor.BlockID) != "" && utf8.RuneCountInString(anchor.BlockID) <= 255 &&
		utf8.RuneCountInString(anchor.ContextBefore) <= 2000 && utf8.RuneCountInString(anchor.ContextAfter) <= 2000
}

func validateContent(segments []Segment) (string, []string, error) {
	if len(segments) == 0 || len(segments) > 1000 {
		return "", nil, ErrCommentInvalidInput
	}
	var body strings.Builder
	bodyLength := 0
	references := make(map[string]struct{})
	for _, segment := range segments {
		segmentLength := utf8.RuneCountInString(segment.Content)
		if segmentLength == 0 || segmentLength > 50000 || strings.ContainsRune(segment.Content, '\x00') {
			return "", nil, ErrCommentInvalidInput
		}
		switch segment.Type {
		case "text":
			if segment.ActorID != "" {
				return "", nil, ErrCommentInvalidInput
			}
		case "reference":
			if segment.ActorID == "" {
				return "", nil, ErrCommentInvalidInput
			}
			references[segment.ActorID] = struct{}{}
		default:
			return "", nil, ErrCommentInvalidInput
		}
		body.WriteString(segment.Content)
		bodyLength += segmentLength
		if bodyLength > 50000 {
			return "", nil, ErrCommentInvalidInput
		}
	}
	if bodyLength == 0 {
		return "", nil, ErrCommentInvalidInput
	}
	actorIDs := make([]string, 0, len(references))
	for actorID := range references {
		actorIDs = append(actorIDs, actorID)
	}
	sort.Strings(actorIDs)
	return body.String(), actorIDs, nil
}

func createThreadEvidence(
	ctx context.Context,
	queries *store.Queries,
	authority store.GetRoomDocumentCommentCreateAuthorityRow,
	input CreateThreadInput,
	anchor createAnchor,
	body string,
) (Result, error) {
	threadID := newCommentID("document_thread_")
	anchorID := newCommentID("document_comment_anchor_")
	commentID := newCommentID("document_comment_")
	threadRecord, err := queries.CreateRoomDocumentCommentThread(ctx, store.CreateRoomDocumentCommentThreadParams{
		ID: threadID, TenantID: authority.TenantID, RoomID: authority.RoomID,
		DocumentID: authority.DocumentID, CurrentAnchorID: anchorID,
		AnchorStatus: anchor.Status, CreatedByActorID: authority.ActorID,
		AnchorKind: anchor.Kind, AnchorDocumentVersionID: anchor.DocumentVersionID,
		AnchorQuotedText: anchor.QuotedText, AnchorBlockID: anchor.BlockID,
		AnchorContextBefore: anchor.ContextBefore, AnchorContextAfter: anchor.ContextAfter,
	})
	if err != nil {
		return Result{}, err
	}
	segments, err := json.Marshal(input.Segments)
	if err != nil {
		return Result{}, err
	}
	commentRecord, err := queries.CreateRoomDocumentComment(ctx, store.CreateRoomDocumentCommentParams{
		ID: commentID, TenantID: authority.TenantID, RoomID: authority.RoomID,
		DocumentID: authority.DocumentID, ThreadID: threadID, ParentCommentID: pgtype.Text{},
		AuthorActorID: authority.ActorID, Body: body, Segments: segments,
	})
	if err != nil {
		return Result{}, err
	}
	author := CommentActor{
		ID: authority.ActorID, TenantID: authority.TenantID,
		Kind: authority.ActorKind, DisplayName: authority.ActorDisplayName,
	}
	thread := Thread{
		ID: threadRecord.ID, DocumentID: threadRecord.DocumentID,
		AnchorStatus: threadRecord.AnchorStatus, Resolved: false,
		Anchor: Anchor{
			ID: threadRecord.CurrentAnchorID, Kind: anchor.Kind, DocumentVersionID: anchor.DocumentVersionID,
			QuotedText: threadRecord.AnchorQuotedText, BlockID: threadRecord.AnchorBlockID,
			ContextBefore: threadRecord.AnchorContextBefore, ContextAfter: threadRecord.AnchorContextAfter,
			CreatedBy: author, CreatedAt: threadRecord.AnchorCreatedAt.Time,
		},
		Comments: []Comment{{
			ID: commentRecord.ID, ThreadID: commentRecord.ThreadID, Author: author,
			Body: commentRecord.Body, Segments: append([]Segment{}, input.Segments...),
			VersionNumber: commentRecord.VersionNumber,
			Reactions:     []Reaction{}, CreatedAt: commentRecord.CreatedAt.Time,
			UpdatedAt: commentRecord.UpdatedAt.Time,
		}},
		CreatedBy: author, CreatedAt: threadRecord.CreatedAt.Time, UpdatedAt: threadRecord.UpdatedAt.Time,
	}
	responseBody, err := json.Marshal(thread)
	if err != nil {
		return Result{}, err
	}
	return Result{Thread: thread, Body: responseBody, Status: http.StatusCreated}, nil
}

func newCommentID(prefix string) string {
	return prefix + strings.ReplaceAll(uuid.NewString(), "-", "")
}

func legacyRoomID(value pgtype.Text) string {
	if !value.Valid {
		return ""
	}
	return value.String
}
