package agentsendmessage

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/idempotency"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/messagecreation"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

// ErrPresentationSequenceInvalid reports invalid presentation sequence input.
var ErrPresentationSequenceInvalid = errors.New("presentation sequence input is invalid")

// ErrPresentationSequenceNotFound reports a missing Room Agent.
var ErrPresentationSequenceNotFound = errors.New("presentation sequence room agent was not found")

// ErrPresentationSequenceReplySourceUnavailable reports a reply source that
// cannot be used.
var ErrPresentationSequenceReplySourceUnavailable = errors.New("Agent reply source is unavailable")

// ErrPresentationSequenceIdempotencyConflict reports a reused idempotency key.
var ErrPresentationSequenceIdempotencyConflict = errors.New("presentation sequence idempotency key was reused")
var errInvalidIdempotencyRecord = errors.New("presentation sequence idempotency record is invalid")

// PresentationPause is the delay before one presentation item.
type PresentationPause string

// Supported presentation pauses.
const (
	PresentationPauseNone    PresentationPause = "none"
	PresentationPauseBrief   PresentationPause = "brief"
	PresentationPauseNatural PresentationPause = "natural"
)

// PresentationItem is one message of a presentation sequence.
type PresentationItem struct {
	Content     string
	PauseBefore PresentationPause
}

// AuthorizedPresentationSequenceInput is used when business authorization has
// already established the calling agent identity.
type AuthorizedPresentationSequenceInput struct {
	RoomID, TenantID, AgentActorID, AgentManagementID string
	IdempotencyKey                                    string
	SourceMessageID                                   string
	Items                                             []PresentationItem
}

// PresentationSequenceResult reports the created presentation sequence.
type PresentationSequenceResult struct {
	SequenceID string
	Replay     bool
}

// presentationIdleWait bounds how long the worker sleeps without a wake or a
// due item, so a lost wake delays delivery by at most this long.
const presentationIdleWait = time.Minute

// presentationErrorRetry is the first retry delay after a failed pass; it
// doubles up to presentationIdleWait so an unavailable database is not polled
// in a tight loop.
const presentationErrorRetry = time.Second

// presentationContentionWait is the shortest sleep after a pass that delivered
// nothing although an item was due, which happens when another transaction
// holds that item's lock.
const presentationContentionWait = 50 * time.Millisecond

// PresentationSequenceService creates and delivers paced message sequences.
type PresentationSequenceService struct {
	pool *pgxpool.Pool
	wake chan struct{}
}

// NewPresentationSequenceService returns a PresentationSequenceService.
func NewPresentationSequenceService(pool *pgxpool.Pool) *PresentationSequenceService {
	return &PresentationSequenceService{pool: pool, wake: make(chan struct{}, 1)}
}

// Wake makes Run deliver due items and recompute its sleep. Call it after the
// transaction that queued a sequence commits.
func (s *PresentationSequenceService) Wake() {
	select {
	case s.wake <- struct{}{}:
	default:
	}
}

// CreateAuthorizedInTx keeps business authorization locks through sequence admission.
func (s *PresentationSequenceService) CreateAuthorizedInTx(ctx context.Context, tx pgx.Tx, input AuthorizedPresentationSequenceInput) (PresentationSequenceResult, error) {
	if s == nil || s.pool == nil || tx == nil || input.RoomID == "" || input.TenantID == "" || input.AgentActorID == "" || input.AgentManagementID == "" || input.IdempotencyKey == "" || len(input.Items) < 2 || len(input.Items) > 8 || input.Items[0].PauseBefore != PresentationPauseNone {
		return PresentationSequenceResult{}, ErrPresentationSequenceInvalid
	}
	for _, item := range input.Items {
		if item.Content == "" || len([]rune(item.Content)) > 50000 || !validPause(item.PauseBefore) {
			return PresentationSequenceResult{}, ErrPresentationSequenceInvalid
		}
	}
	q := store.New(tx)
	authority, err := q.GetRoomAgentMessageAuthority(ctx, store.GetRoomAgentMessageAuthorityParams{RoomID: input.RoomID, AgentManagementID: input.AgentManagementID})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return PresentationSequenceResult{}, ErrPresentationSequenceNotFound
		}
		return PresentationSequenceResult{}, err
	}
	if authority.TenantID != input.TenantID || authority.AgentID != input.AgentActorID {
		return PresentationSequenceResult{}, ErrPresentationSequenceNotFound
	}
	return s.createWithAuthority(ctx, tx, input.RoomID, input.TenantID, input.AgentActorID, input.IdempotencyKey, input.SourceMessageID, input.Items)
}

func (s *PresentationSequenceService) createWithAuthority(ctx context.Context, tx pgx.Tx, roomID, tenantID, agentActorID, idempotencyKey, sourceMessageID string, items []PresentationItem) (PresentationSequenceResult, error) {
	q := store.New(tx)
	operation := "createAgentPresentationSequence:" + roomID
	requestHash := hashItems(roomID, sourceMessageID, items)
	replayKey := idempotency.AgentKey(agentActorID, operation, idempotencyKey)
	if err := idempotency.Lock(ctx, tx, replayKey); err != nil {
		return PresentationSequenceResult{}, err
	}
	replay, found, err := idempotency.Lookup(ctx, tx, replayKey, requestHash)
	if errors.Is(err, idempotency.ErrConflict) {
		return PresentationSequenceResult{}, ErrPresentationSequenceIdempotencyConflict
	}
	if err != nil {
		return PresentationSequenceResult{}, err
	}
	if found {
		var response struct {
			SequenceID string `json:"sequence_id"`
		}
		if err = json.Unmarshal(replay.Body, &response); err != nil || response.SequenceID == "" {
			if err == nil {
				err = errInvalidIdempotencyRecord
			}
			return PresentationSequenceResult{}, err
		}
		return PresentationSequenceResult{SequenceID: response.SequenceID, Replay: true}, nil
	}
	if err := messagecreation.ValidateAgentReplySource(ctx, q, tenantID, roomID, agentActorID, sourceMessageID); err != nil {
		if errors.Is(err, messagecreation.ErrInvalidReference) {
			return PresentationSequenceResult{}, ErrPresentationSequenceReplySourceUnavailable
		}
		return PresentationSequenceResult{}, err
	}
	id := newID()
	// Each bubble later records this Run, checked once as the sequence is queued.
	localRun, err := messagecreation.ResolveRunClaim(ctx, q, tenantID, agentActorID, roomID)
	if err != nil {
		return PresentationSequenceResult{}, err
	}
	if _, err = q.CreateAgentPresentationSequence(ctx, store.CreateAgentPresentationSequenceParams{
		ID: id, TenantID: tenantID, RoomID: roomID, AgentActorID: agentActorID,
		LocalRunID:       localRun,
		ReplyToMessageID: pgtype.Text{String: sourceMessageID, Valid: sourceMessageID != ""},
	}); err != nil {
		return PresentationSequenceResult{}, err
	}
	notBefore := time.Now()
	for index, item := range items {
		notBefore = notBefore.Add(pauseDuration(item.PauseBefore))
		if _, err = q.CreateAgentPresentationSequenceItem(ctx, store.CreateAgentPresentationSequenceItemParams{SequenceID: id, Position: int32(index + 1), Content: item.Content, PauseBefore: string(item.PauseBefore), NotBefore: pgtype.Timestamptz{Time: notBefore, Valid: true}}); err != nil {
			return PresentationSequenceResult{}, err
		}
	}
	body, err := json.Marshal(map[string]string{"sequence_id": id})
	if err != nil {
		return PresentationSequenceResult{}, err
	}
	if err = idempotency.Save(ctx, tx, replayKey, requestHash, idempotency.Record{
		ResourceID: roomID, Status: http.StatusCreated, Body: body,
	}); err != nil {
		return PresentationSequenceResult{}, err
	}
	return PresentationSequenceResult{SequenceID: id}, nil
}

// Run delivers due sequence items until ctx ends. It sleeps until the next
// item is due, a Wake, or presentationIdleWait, whichever comes first.
func (s *PresentationSequenceService) Run(ctx context.Context, limit int32, report func(error)) {
	drivePresentation(ctx, s.wake, presentationIdleWait, presentationErrorRetry, func(ctx context.Context) (time.Duration, error) {
		return s.deliverAndWait(ctx, limit)
	}, report)
}

// deliverAndWait delivers one batch and returns how long to sleep before the
// next pass.
func (s *PresentationSequenceService) deliverAndWait(ctx context.Context, limit int32) (time.Duration, error) {
	delivered, err := s.RunOnce(ctx, limit)
	if err != nil {
		return 0, err
	}
	if delivered == int(limit) {
		return 0, nil
	}
	waitMilliseconds, err := store.New(s.pool).NextAgentPresentationSequenceItemWaitMilliseconds(ctx)
	if errors.Is(err, pgx.ErrNoRows) {
		return presentationIdleWait, nil
	}
	if err != nil {
		return 0, err
	}
	wait := time.Duration(waitMilliseconds) * time.Millisecond
	if delivered == 0 {
		wait = max(wait, presentationContentionWait)
	}
	return min(max(wait, 0), presentationIdleWait), nil
}

// drivePresentation runs pass at once and then whenever wake fires or the
// wait returned by the previous pass elapses. Failed passes retry with a
// backoff that starts at retry and doubles up to idle.
func drivePresentation(ctx context.Context, wake <-chan struct{}, idle, retry time.Duration, pass func(context.Context) (time.Duration, error), report func(error)) {
	backoff := retry
	timer := time.NewTimer(0)
	defer timer.Stop()
	for {
		wait, err := pass(ctx)
		if ctx.Err() != nil {
			return
		}
		if err != nil {
			if report != nil {
				report(err)
			}
			wait = backoff
			backoff = min(2*backoff, idle)
		} else {
			backoff = retry
		}
		if !timer.Stop() {
			select {
			case <-timer.C:
			default:
			}
		}
		timer.Reset(min(wait, idle))
		select {
		case <-ctx.Done():
			return
		case <-wake:
		case <-timer.C:
		}
	}
}

// RunOnce delivers up to limit due sequence items.
func (s *PresentationSequenceService) RunOnce(ctx context.Context, limit int32) (int, error) {
	if s == nil || s.pool == nil || limit < 1 || limit > 100 {
		return 0, ErrPresentationSequenceInvalid
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback(ctx)
	q := store.New(tx)
	items, err := q.LockDueAgentPresentationSequenceItems(ctx, limit)
	if err != nil {
		return 0, err
	}
	for _, item := range items {
		author, err := q.GetActor(ctx, store.GetActorParams{ID: item.AgentActorID, TenantID: item.TenantID})
		if err != nil {
			return 0, err
		}
		content, err := messagecreation.Normalize([]messagecreation.Segment{{Type: "text", Content: item.Content}})
		if err != nil {
			return 0, err
		}
		created, err := messagecreation.Create(ctx, q, messagecreation.Draft{
			TenantID: item.TenantID, RoomID: item.RoomID, Author: author, Content: content,
			ReplyToMessageID: item.ReplyToMessageID.String, TrustedRunID: item.LocalRunID.String,
		})
		if err != nil {
			return 0, err
		}
		if _, err = q.MarkAgentPresentationSequenceItemDelivered(ctx, store.MarkAgentPresentationSequenceItemDeliveredParams{MessageID: created.Message.ID, SequenceID: item.SequenceID, Position: item.Position}); err != nil {
			return 0, err
		}
		if _, err = q.MarkAgentPresentationSequenceDelivering(ctx, item.SequenceID); err != nil {
			return 0, err
		}
		if _, err = q.CompleteAgentPresentationSequenceIfDelivered(ctx, item.SequenceID); err != nil {
			return 0, err
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return 0, err
	}
	return len(items), nil
}

func validPause(value PresentationPause) bool {
	return value == PresentationPauseNone || value == PresentationPauseBrief || value == PresentationPauseNatural
}
func pauseDuration(value PresentationPause) time.Duration {
	if value == PresentationPauseBrief {
		return time.Second
	}
	if value == PresentationPauseNatural {
		return 1500 * time.Millisecond
	}
	return 0
}
func newID() string {
	bytes := make([]byte, 12)
	_, _ = rand.Read(bytes)
	return "sequence_" + hex.EncodeToString(bytes)
}

func hashItems(roomID, sourceMessageID string, items []PresentationItem) []byte {
	payload, _ := json.Marshal(struct {
		RoomID          string             `json:"room_id"`
		Items           []PresentationItem `json:"items"`
		SourceMessageID string             `json:"source_message_id,omitempty"`
	}{RoomID: roomID, Items: items, SourceMessageID: sourceMessageID})
	sum := sha256.Sum256(payload)
	return sum[:]
}
