// Package retention deletes working data past its retention period in
// bounded batches. Business content (Messages, Room Events,
// Documents, Wiki, recordings) is never deleted by age.
package retention

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

// BatchSize bounds one DELETE. A rule repeats until a batch comes back short,
// so one hourly run clears a backlog in bounded transactions.
const BatchSize = 1000

// Rule deletes at most limit rows of Table past their retention period and
// reports how many it deleted.
type Rule struct {
	Table  string
	Delete func(queries *store.Queries, ctx context.Context, limit int32) (int64, error)
}

// Core is the retention table of the features every process runs; an
// optional feature adds its own rules when it registers.
var Core = []Rule{
	{"auth_sessions", (*store.Queries).DeleteExpiredAuthSessions},
	{"document_events", (*store.Queries).DeleteExpiredDocumentEvents},
	{"routine_event_deliveries", (*store.Queries).DeleteExpiredRoutineEventDeliveries},
	{"room_reminders", (*store.Queries).DeleteFinishedOneShotRoutines},
	{"agent_memories", (*store.Queries).DeleteRevokedAgentMemories},
}

// Voice expires voice working data; a recording and everything it owns stay.
var Voice = []Rule{
	{"voice_transcript_segments", (*store.Queries).DeleteExpiredVoiceTranscriptSegments},
	{"voice_sessions", (*store.Queries).DeleteExpiredVoiceSessions},
	{"voice_transcript_uncertainties", (*store.Queries).DeleteSettledVoiceTranscriptUncertainties},
}

// Sweep runs every rule to completion. A failing rule does not stop the
// others; the next hourly run retries it.
func Sweep(ctx context.Context, pool *pgxpool.Pool, rules []Rule) error {
	queries := store.New(pool)
	var failures []error
	for _, rule := range rules {
		for ctx.Err() == nil {
			deleted, err := rule.Delete(queries, ctx, BatchSize)
			if err != nil {
				failures = append(failures, fmt.Errorf("retention %s: %w", rule.Table, err))
				break
			}
			if deleted < BatchSize {
				break
			}
		}
	}
	return errors.Join(failures...)
}

// Sweeper runs one set of rules over a pool.
type Sweeper struct {
	pool  *pgxpool.Pool
	rules []Rule
}

// NewSweeper builds the Sweeper of rules.
func NewSweeper(pool *pgxpool.Pool, rules []Rule) *Sweeper {
	return &Sweeper{pool: pool, rules: rules}
}

// Sweep runs the Sweeper's rules; see Sweep.
func (s *Sweeper) Sweep(ctx context.Context) error {
	return Sweep(ctx, s.pool, s.rules)
}
