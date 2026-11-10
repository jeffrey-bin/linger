package agentsendmessage

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"regexp"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentauth"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentruntimestate"
	artifactstore "github.com/simplexai-labs/linger/apps/teamhub/internal/artifact"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/idempotency"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/messagecreation"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/proactive"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

const (
	sendMessageToolName  = "send_message"
	idempotencyOperation = "send_message"
)

var (
	ErrInvalid                = errors.New("Agent Send Message input is invalid")
	ErrForbidden              = errors.New("Agent Send Message is forbidden")
	ErrInboxUnavailable       = errors.New("Agent Send Message Inbox is unavailable")
	ErrReplySourceUnavailable = errors.New("Agent reply source is unavailable")
	ErrIdempotencyConflict    = errors.New("Agent Send Message invocation was reused with different input")
	ErrUnavailable            = errors.New("Agent Send Message service is unavailable")

	invocationPattern = regexp.MustCompile(`^agent-invocation-sha256:[a-f0-9]{64}$`)
	roomIDPattern     = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`)
	threadIDPattern   = roomIDPattern
	taskIDPattern     = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)
)

type Input struct {
	Atomic          *AtomicInput
	SourceInboxIDs  []string
	InvocationID    string
	InboxID         string
	SourceMessageID string
	// Continues declares that more work in the same turn follows this message.
	Continues bool
	// messageSegments is the Atomic message projected for canonical
	// normalization; callers supply Atomic only.
	messageSegments []messagecreation.Segment
	// CardTitle presents the Message as a light card with this title
	// (`teamhub message card`); empty for an ordinary Message.
	CardTitle string
	// CardKind names what the card is, only "profile"; it needs CardTitle.
	CardKind string
}

type Result struct {
	Resources []Resource
	Accepted  bool
	InboxID   string
	MessageID string
	Replay    bool
}

type persistedResult struct {
	Resources []Resource `json:"resources,omitempty"`
	Accepted  bool       `json:"accepted"`
	InboxID   string     `json:"inbox_id"`
	MessageID string     `json:"message_id"`
}

type inboxTarget struct {
	kind string
	id   string
	raw  string
}

type resolvedTarget struct {
	inboxID string
	roomID  string
	// A Thread Room owns no Document binding, so an Agent Document created while
	// replying in a Thread binds to the parent Room the projection scopes it to.
	collaborationRoomID string
	tenantID            string
	author              store.Actor
}

// documentRoomID is the Room an Agent Document created for this target binds to.
// Only a Thread separates it from the Message Room.
func (target resolvedTarget) documentRoomID() string {
	if target.collaborationRoomID != "" {
		return target.collaborationRoomID
	}
	return target.roomID
}

type canonicalRequest struct {
	SourceInboxIDs  []string                  `json:"source_inbox_ids"`
	InboxID         string                    `json:"inbox_id"`
	Segments        []messagecreation.Segment `json:"message_segments"`
	SourceMessageID string                    `json:"source_message_id,omitempty"`
	Continues       bool                      `json:"continues,omitempty"`
	CardTitle       string                    `json:"card_title,omitempty"`
	CardKind        string                    `json:"card_kind,omitempty"`
}

type normalizedInput struct {
	target               inboxTarget
	content              messagecreation.Content
	sourceInboxIDs       []string
	sourceMessageID      string
	invocationID         string
	canonicalRequestHash [sha256.Size]byte
}

type Service struct {
	pool       *pgxpool.Pool
	authorizer *agentauth.Service
	documents  *document.Service
	objects    artifactstore.ObjectStore
}

func New(
	pool *pgxpool.Pool,
	authorizer *agentauth.Service,
	documents *document.Service,
	objects artifactstore.ObjectStore,
) *Service {
	return &Service{pool: pool, authorizer: authorizer, documents: documents, objects: objects}
}

func (s *Service) Send(
	ctx context.Context,
	contextToken string,
	input Input,
) (Result, error) {
	normalized, err := normalizeAtomicInput(input)
	if err != nil {
		return Result{}, err
	}
	if s == nil || s.pool == nil || s.authorizer == nil {
		return Result{}, ErrUnavailable
	}

	commitAttempted := false
	defer func() {
		if !commitAttempted && s.objects != nil {
			for _, upload := range input.Atomic.Uploads {
				if upload.ObjectKey != "" {
					_ = artifactstore.DeleteDetached(ctx, s.objects, upload.ObjectKey)
				}
			}
		}
	}()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Result{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	authorization, err := s.authorizer.AuthorizeInTx(
		ctx,
		tx,
		contextToken,
		sendMessageToolName,
	)
	if err != nil {
		return Result{}, err
	}

	queries := store.New(tx)

	idempotencyKey := agentauth.IdempotencyKey(idempotencyOperation, normalized.invocationID)
	if err := idempotency.Lock(ctx, tx, idempotency.AgentKey(authorization.AgentActorID, idempotencyOperation, idempotencyKey)); err != nil {
		return Result{}, err
	}
	replayRecord, replayFound, err := lookupReplayRecord(
		ctx,
		tx,
		authorization.AgentActorID,
		idempotencyOperation,
		idempotencyKey,
		normalized.canonicalRequestHash[:],
	)
	if err != nil {
		return Result{}, err
	}
	resolved, err := resolveTarget(ctx, queries, authorization, normalized.target)
	if err != nil {
		return Result{}, err
	}
	if normalized.target.kind == "room" && !agentauth.AllowsRoomTarget(authorization, resolved.roomID) {
		return Result{}, ErrForbidden
	}
	if replayFound {
		replay, err := validateSendMessageReplay(
			ctx, queries, resolved, replayRecord, authorization, normalized.invocationID,
		)
		if err != nil {
			return Result{}, err
		}
		if err := tx.Commit(ctx); err != nil {
			return Result{}, err
		}
		return replay, nil
	}

	if normalized.sourceMessageID != "" {
		err = messagecreation.ValidateAgentReplySource(ctx, queries, resolved.tenantID, resolved.roomID, resolved.author.ID, normalized.sourceMessageID)
		if err != nil {
			if errors.Is(err, messagecreation.ErrInvalidReference) {
				return Result{}, ErrReplySourceUnavailable
			}
			return Result{}, err
		}
	}

	if hasFragment(input.Atomic) {
		if _, err := s.authorizer.AuthorizeInTx(ctx, tx, contextToken, showFragmentToolName); err != nil {
			return Result{}, err
		}
	}
	content, resources, preparedVersions, err := s.prepareAtomic(ctx, tx, authorization, resolved, input, idempotencyKey)
	if err != nil {
		return Result{}, err
	}
	err = messagecreation.ValidateRoomDocumentReferences(
		ctx, queries, resolved.tenantID, resolved.roomID, content.Segments,
	)
	if errors.Is(err, messagecreation.ErrInvalidDocument) {
		return Result{}, ErrInvalid
	}
	if err != nil {
		return Result{}, err
	}
	created, err := messagecreation.Create(ctx, queries, messagecreation.Draft{
		TenantID: resolved.tenantID, RoomID: resolved.roomID, Author: resolved.author, Content: content,
		ReplyToMessageID:     normalized.sourceMessageID,
		AttachmentVersionIDs: preparedVersions, AttachmentRoomID: resolved.documentRoomID(),
		AttachmentRule: messagecreation.PreparedAttachments,
		CardTitle:      input.CardTitle,
		CardKind:       input.CardKind,
	})
	if err != nil {
		if errors.Is(err, messagecreation.ErrInvalid) ||
			errors.Is(err, messagecreation.ErrInvalidReference) ||
			errors.Is(err, messagecreation.ErrInvalidSkill) {
			return Result{}, ErrInvalid
		}
		return Result{}, err
	}
	// AnotherMe's answers to proactive wakes feed nightly learning.
	if err := proactive.RecordWakeAnswer(ctx, queries, resolved.tenantID, resolved.roomID, created.Message.ID, created.Message.LocalRunID, resolved.author); err != nil {
		return Result{}, err
	}
	stored := persistedResult{
		Resources: resources,
		Accepted:  true, InboxID: resolved.inboxID, MessageID: created.Message.ID,
	}
	responseBody, err := json.Marshal(stored)
	if err != nil {
		return Result{}, err
	}
	if err := idempotency.Save(ctx, tx, idempotency.AgentKey(resolved.author.ID, idempotencyOperation, idempotencyKey),
		normalized.canonicalRequestHash[:], idempotency.Record{
			ResourceID: created.Message.ID, Status: http.StatusOK, Body: responseBody,
			InvocationID: normalized.invocationID,
		}); err != nil {
		// One Agent invocation has one receipt. A receipt already holding this
		// invocation under another key makes this different input, not a new message.
		var postgresError *pgconn.PgError
		if errors.As(err, &postgresError) && postgresError.Code == "23505" &&
			postgresError.ConstraintName == "command_replays_invocation_idx" {
			return Result{}, ErrIdempotencyConflict
		}
		return Result{}, err
	}

	if _, err := agentruntimestate.RecordPresentationOutput(ctx, queries, agentruntimestate.PresentationOutput{
		LocalRunID: created.Message.LocalRunID, TenantID: resolved.tenantID,
		RoomID: resolved.roomID, AgentActorID: resolved.author.ID,
		InvocationID: normalized.invocationID, OutputID: created.Message.ID,
		OutputKind: "message", Surface: "room_timeline", MessageID: created.Message.ID,
		Continues: input.Continues,
	}); err != nil {
		return Result{}, err
	}
	commitAttempted = true
	if err := tx.Commit(ctx); err != nil {
		return Result{}, err
	}
	return resultFromPersisted(stored, false), nil
}

func normalizeInput(input Input) (normalizedInput, error) {
	if !invocationPattern.MatchString(input.InvocationID) || len(input.SourceInboxIDs) > 1024 ||
		hasDuplicateStrings(input.SourceInboxIDs) {
		return normalizedInput{}, ErrInvalid
	}
	for _, inboxID := range input.SourceInboxIDs {
		if !validSourceInboxID(inboxID) {
			return normalizedInput{}, ErrInvalid
		}
	}
	target, err := parseInbox(input.InboxID)
	if err != nil {
		return normalizedInput{}, err
	}
	for _, segment := range input.messageSegments {
		if segment.Type != "text" && segment.Type != "reference" && segment.Type != "file" && segment.Type != "document" {
			return normalizedInput{}, ErrInvalid
		}
	}
	content, err := messagecreation.NormalizeFileRequest(input.messageSegments)
	if err != nil {
		return normalizedInput{}, ErrInvalid
	}
	sourceInboxIDs := append([]string{}, input.SourceInboxIDs...)
	encoded, err := json.Marshal(canonicalRequest{
		SourceInboxIDs: sourceInboxIDs,
		InboxID:        target.raw, Segments: content.Segments, SourceMessageID: input.SourceMessageID,
		Continues: input.Continues, CardTitle: input.CardTitle, CardKind: input.CardKind,
	})
	if err != nil {
		return normalizedInput{}, ErrUnavailable
	}
	return normalizedInput{
		target: target, content: content,
		sourceInboxIDs: sourceInboxIDs, sourceMessageID: input.SourceMessageID,
		invocationID: input.InvocationID, canonicalRequestHash: sha256.Sum256(encoded),
	}, nil
}

func parseInbox(value string) (inboxTarget, error) {
	if id, ok := strings.CutPrefix(value, "thread:"); ok && threadIDPattern.MatchString(id) {
		return inboxTarget{kind: "thread", id: id, raw: value}, nil
	}
	if id, ok := strings.CutPrefix(value, "room:"); ok && roomIDPattern.MatchString(id) {
		return inboxTarget{kind: "room", id: id, raw: value}, nil
	}
	return inboxTarget{}, ErrInvalid
}

// validSourceInboxID also accepts the Task and private Meta Inboxes a Run
// was woken from; only Room and Thread Inboxes receive messages.
func validSourceInboxID(value string) bool {
	if _, err := parseInbox(value); err == nil {
		return true
	}
	if taskID, ok := strings.CutPrefix(value, "task:"); ok {
		return taskIDPattern.MatchString(taskID)
	}
	meta, ok := strings.CutPrefix(value, "meta:")
	if ok {
		actorID, taskID, found := strings.Cut(meta, ":")
		return found && roomIDPattern.MatchString(actorID) && taskIDPattern.MatchString(taskID)
	}
	taskID, ok := strings.CutPrefix(value, "taskmeta:")
	return ok && taskIDPattern.MatchString(taskID)
}

func hasDuplicateStrings(values []string) bool {
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		if _, exists := seen[value]; exists {
			return true
		}
		seen[value] = struct{}{}
	}
	return false
}

func resolveTarget(
	ctx context.Context,
	queries *store.Queries,
	authorization agentauth.Authorization,
	target inboxTarget,
) (resolvedTarget, error) {
	identity := authorization
	if target.kind == "thread" {
		row, err := queries.GetAgentSendMessageThreadRoom(ctx, store.GetAgentSendMessageThreadRoomParams{
			ThreadID: target.id, TenantID: identity.TenantID, AgentActorID: identity.AgentActorID,
		})
		if errors.Is(err, pgx.ErrNoRows) {
			return resolvedTarget{}, ErrInboxUnavailable
		}
		if err != nil {
			return resolvedTarget{}, err
		}
		if row.RoomID != target.id || row.ParentRoomID == "" || row.TenantID != identity.TenantID ||
			row.AgentID != identity.AgentActorID || row.AgentKind != "agent" || !row.AgentCreatedAt.Valid {
			return resolvedTarget{}, ErrInboxUnavailable
		}
		if !agentauth.AllowsRoomTarget(identity, row.ParentRoomID) {
			return resolvedTarget{}, ErrForbidden
		}
		return resolvedTarget{
			inboxID: target.raw, roomID: row.RoomID, tenantID: row.TenantID,
			collaborationRoomID: row.ParentRoomID,
			author: store.Actor{
				ID: row.AgentID, TenantID: row.TenantID, Kind: row.AgentKind,
				DisplayName: row.AgentDisplayName, AccountID: row.AgentAccountID,
				Handle: row.AgentHandle, CreatedAt: row.AgentCreatedAt,
			},
		}, nil
	}
	roomID := target.id

	authority, err := queries.GetRoomAgentMessageAuthority(ctx, store.GetRoomAgentMessageAuthorityParams{
		RoomID: roomID, AgentManagementID: identity.AgentID,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return resolvedTarget{}, ErrInboxUnavailable
	}
	if err != nil {
		return resolvedTarget{}, err
	}
	activeRoomID, err := queries.LockActiveRoomForMutation(ctx, roomID)
	if errors.Is(err, pgx.ErrNoRows) {
		return resolvedTarget{}, ErrInboxUnavailable
	}
	if err != nil {
		return resolvedTarget{}, err
	}
	if activeRoomID != roomID || authority.RoomID != roomID || authority.TenantID != identity.TenantID ||
		authority.AgentID != identity.AgentActorID || authority.AgentKind != "agent" ||
		!authority.AgentCreatedAt.Valid {
		return resolvedTarget{}, ErrInboxUnavailable
	}
	return resolvedTarget{
		inboxID: target.raw, roomID: roomID, tenantID: identity.TenantID,
		author: store.Actor{
			ID: authority.AgentID, TenantID: authority.TenantID, Kind: authority.AgentKind,
			DisplayName: authority.AgentDisplayName, AccountID: authority.AgentAccountID,
			Handle: authority.AgentHandle, CreatedAt: authority.AgentCreatedAt,
		},
	}, nil
}

func lookupReplayRecord(
	ctx context.Context,
	db store.DBTX,
	agentActorID, operation, key string,
	requestHash []byte,
) (idempotency.Record, bool, error) {
	record, found, err := idempotency.Lookup(ctx, db, idempotency.AgentKey(agentActorID, operation, key), requestHash)
	if errors.Is(err, idempotency.ErrConflict) {
		return idempotency.Record{}, false, ErrIdempotencyConflict
	}
	return record, found, err
}

func validateSendMessageReplay(
	ctx context.Context,
	queries *store.Queries,
	target resolvedTarget,
	record idempotency.Record,
	authorization agentauth.Authorization,
	invocationID string,
) (Result, error) {
	if record.InvocationID != invocationID {
		return Result{}, ErrUnavailable
	}
	return validateReplay(ctx, queries, target, record, authorization)
}

func validateReplay(
	ctx context.Context,
	queries *store.Queries,
	target resolvedTarget,
	record idempotency.Record,
	authorization agentauth.Authorization,
) (Result, error) {
	var stored persistedResult
	if record.Status != http.StatusOK || decodeStrict(record.Body, &stored) != nil ||
		!stored.Accepted || stored.InboxID != target.inboxID || stored.MessageID != record.ResourceID {
		return Result{}, ErrUnavailable
	}
	messageID, err := queries.GetAgentSendMessageReplayMessage(ctx, store.GetAgentSendMessageReplayMessageParams{
		MessageID: stored.MessageID, TenantID: target.tenantID, RoomID: target.roomID,
		AgentActorID: target.author.ID,
	})
	if err != nil || messageID != stored.MessageID {
		return Result{}, ErrUnavailable
	}
	message, err := queries.GetMessageInRoom(ctx, store.GetMessageInRoomParams{
		ID: stored.MessageID, RoomID: target.roomID,
	})
	if err != nil || message.ID != stored.MessageID || message.TenantID != target.tenantID ||
		message.AuthorActorID != target.author.ID || message.MessageKind != "conversation" ||
		message.RoomID != target.roomID {
		return Result{}, ErrUnavailable
	}
	return resultFromPersisted(stored, true), nil
}

func decodeStrict(encoded []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(encoded))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return ErrUnavailable
	}
	return nil
}

func resultFromPersisted(stored persistedResult, replay bool) Result {
	return Result{
		Accepted: stored.Accepted, InboxID: stored.InboxID, MessageID: stored.MessageID,
		Replay: replay, Resources: append([]Resource{}, stored.Resources...),
	}
}
