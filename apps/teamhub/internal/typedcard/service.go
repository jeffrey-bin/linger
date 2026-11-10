package typedcard

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/idempotency"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

var (
	ErrNotFound             = errors.New("typed card source not found")
	ErrForbidden            = errors.New("typed card decision forbidden")
	ErrInvalid              = errors.New("typed card command invalid")
	ErrConflict             = errors.New("typed card state conflict")
	ErrIdempotencyConflict  = errors.New("typed card idempotency key reused")
	ErrRuntimeModelRequired = errors.New("typed card runtime model required")
	// ErrAssigneeNotMember is the ErrInvalid a caller can name: the card's
	// assignee is not a human member of its Room.
	ErrAssigneeNotMember = fmt.Errorf("%w: assignee is not a human Room member", ErrInvalid)
)

// CreateResult is a card command's response and the card it names.
type CreateResult struct {
	Status     int
	Body       []byte
	Replay     bool
	MessageID  string
	DecisionID string
}

type Service struct {
	pool        *pgxpool.Pool
	connections ConnectionAuthorizer
	// onboardingHandoff and onboardingConnections tell AnotherMe what its
	// setup cards collected; the app installs them.
	onboardingHandoff     OnboardingHandoffWriter
	onboardingConnections OnboardingConnections
	// executors run approved decisions by kind; the app registers them.
	executors map[string]DecisionExecutor
}

func New(pool *pgxpool.Pool) *Service {
	return &Service{pool: pool}
}

func (s *Service) HydrateCard(ctx context.Context, messageID string) (json.RawMessage, bool, error) {
	return hydrateCard(ctx, store.New(s.pool), messageID)
}

// SnapshotCard projects the Human-visible card in the caller's consistent snapshot.
func SnapshotCard(ctx context.Context, queries *store.Queries, messageID string) (json.RawMessage, bool, error) {
	return hydrateCard(ctx, queries, messageID)
}

// hydrateCard projects one Message's card through the batch projection, so a
// single read and a Message page always dispatch the same card intents.
func hydrateCard(ctx context.Context, queries *store.Queries, messageID string) (json.RawMessage, bool, error) {
	if _, err := queries.GetMessageCard(ctx, messageID); errors.Is(err, pgx.ErrNoRows) {
		return nil, false, nil
	} else if err != nil {
		return nil, false, err
	}
	cards, err := hydrateCards(ctx, queries, []string{messageID})
	if err != nil {
		return nil, false, err
	}
	return cards[messageID], true, nil
}

func lookupReplay(
	ctx context.Context,
	db store.DBTX,
	agentActorID, operation, key string,
	requestHash []byte,
) (CreateResult, bool, error) {
	stored, found, err := idempotency.Lookup(ctx, db, idempotency.AgentKey(agentActorID, operation, key), requestHash)
	if errors.Is(err, idempotency.ErrConflict) {
		return CreateResult{}, false, ErrIdempotencyConflict
	}
	if err != nil || !found {
		return CreateResult{}, found, err
	}
	return CreateResult{Status: stored.Status, Body: stored.Body, MessageID: stored.ResourceID, Replay: true}, true, nil
}

type actor struct {
	ID          string `json:"id"`
	TenantID    string `json:"tenant_id"`
	Kind        string `json:"kind"`
	DisplayName string `json:"display_name"`
}

type cardActor struct {
	ID          string `json:"id"`
	Kind        string `json:"kind"`
	DisplayName string `json:"display_name"`
}

type messageResponse struct {
	ID                   string          `json:"id"`
	TenantID             string          `json:"tenant_id"`
	RoomID               string          `json:"room_id"`
	Author               actor           `json:"author"`
	MessageKind          string          `json:"message_kind"`
	RawMessage           string          `json:"raw_message"`
	Segments             json.RawMessage `json:"segments"`
	Attachments          []any           `json:"attachments"`
	Card                 json.RawMessage `json:"card,omitempty"`
	CardContextMessageID *string         `json:"card_context_message_id,omitempty"`
	CreatedAt            time.Time       `json:"created_at"`
}

func actorValue(value store.Actor) actor {
	return actor{ID: value.ID, TenantID: value.TenantID, Kind: value.Kind, DisplayName: value.DisplayName}
}

func cardActorValue(value store.Actor) cardActor {
	return cardActor{ID: value.ID, Kind: value.Kind, DisplayName: value.DisplayName}
}
