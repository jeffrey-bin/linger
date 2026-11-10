package proactive

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/reminder"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

// Owner is the one Human every call is scoped to.
type Owner struct {
	TenantID, ActorID string
}

// GuidelineSource returns a Human's current reminder guideline.
type GuidelineSource func(context.Context, Owner) (Guideline, error)

// StoredGuideline reads the Human's latest guideline version, written by
// Memory's nightly dreaming; a Human without one uses the default.
func StoredGuideline(pool *pgxpool.Pool) GuidelineSource {
	return func(ctx context.Context, owner Owner) (Guideline, error) {
		row, err := store.New(pool).GetLatestProactiveGuideline(ctx, store.GetLatestProactiveGuidelineParams{
			TenantID: owner.TenantID, OwnerActorID: owner.ActorID,
		})
		if errors.Is(err, pgx.ErrNoRows) {
			return DefaultGuideline(), nil
		}
		if err != nil {
			return Guideline{}, err
		}
		guideline := Guideline{Version: int(row.Version)}
		if err := json.Unmarshal(row.Specific, &guideline.Specific); err != nil {
			return Guideline{}, err
		}
		if len(guideline.Specific) > MaxSpecific {
			guideline.Specific = guideline.Specific[:MaxSpecific]
		}
		return guideline, nil
	}
}

type Service struct {
	pool      *pgxpool.Pool
	judge     EventJudge
	guideline GuidelineSource
	now       func() time.Time
}

// New returns the proactive Service. judge scores outside events; without one,
// events fail and are retried, while conversation windows still work.
func New(pool *pgxpool.Pool, judge EventJudge, guideline GuidelineSource) *Service {
	if guideline == nil {
		guideline = StoredGuideline(pool)
	}
	return &Service{pool: pool, judge: judge, guideline: guideline, now: time.Now}
}

// WithClock returns the Service judging as if now were the given time.
func (s *Service) WithClock(now func() time.Time) *Service {
	clocked := *s
	clocked.now = now
	return &clocked
}

// Outcome is what one candidate came to.
type Outcome struct {
	Candidate Candidate `json:"candidate"`
	MessageID string    `json:"message_id,omitempty"`
	Skipped   string    `json:"skipped,omitempty"`
}

// ErrNoDirectRoom means the Human has no ready AnotherMe direct Room.
var ErrNoDirectRoom = errors.New("AnotherMe direct Room is unavailable")

// record notes today's judgment of a source item, for dedupe and the daily
// limit; reminded marks a reminder wake.
func record(ctx context.Context, queries *store.Queries, owner Owner, candidate Candidate, reminded bool) error {
	suffix := make([]byte, 16)
	if _, err := rand.Read(suffix); err != nil {
		return err
	}
	_, err := queries.UpsertProactivePotentialItem(ctx, store.UpsertProactivePotentialItemParams{
		ID: "ppi_" + hex.EncodeToString(suffix), TenantID: owner.TenantID, OwnerActorID: owner.ActorID,
		Content: withDue(candidate), Source: candidate.Source, SourceKey: candidate.SourceKey, Reminded: reminded,
	})
	return err
}

// RecordWakeAnswer runs in the transaction of a Message an agent posts: when it
// is the AnotherMe of this direct Room speaking in a Run that a delivered
// proactive wake started, its first Message there answers that wake and is
// recorded, with the wake's source, for the Human's nightly learning. Messages
// of other Runs, such as a late result of something the Human asked for, are
// never outputs, however soon after a wake they come.
func RecordWakeAnswer(ctx context.Context, queries *store.Queries, tenantID, roomID, messageID, localRunID string, author store.Actor) error {
	if author.Kind != "agent" || localRunID == "" {
		return nil
	}
	direct, err := queries.GetAnotherMeDirectRoomAgent(ctx, store.GetAnotherMeDirectRoomAgentParams{RoomID: roomID, TenantID: tenantID})
	if errors.Is(err, pgx.ErrNoRows) || err == nil && direct.AgentActorID != author.ID {
		return nil
	}
	if err != nil {
		return err
	}
	source, err := queries.GetRunProactiveWakeSource(ctx, store.GetRunProactiveWakeSourceParams{RunID: localRunID, RoomID: roomID})
	if errors.Is(err, pgx.ErrNoRows) || err == nil && source == reminder.SourceScheduled {
		return nil
	}
	if err != nil {
		return err
	}
	return queries.CreateProactiveOutput(ctx, store.CreateProactiveOutputParams{
		MessageID: messageID, TenantID: tenantID, OwnerActorID: direct.HumanActorID, RoomID: roomID,
		Source: source, LocalRunID: localRunID,
	})
}
