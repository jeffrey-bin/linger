package reminder

// Quiet wakes hold proactive wakes for a Human's AnotherMe direct Room until
// the Room has been quiet for three minutes. Routine fires, outside events and
// conversation reviews all queue here; the worker then delivers the queue in
// order as hidden agent_runtime messages that AnotherMe answers.

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/jobs"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/messagecreation"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

// Window is how long the Human and AnotherMe must both be silent before a
// proactive wake goes out. AnotherMe's answers to earlier wakes do not count.
const Window = 3 * time.Minute

// Sources of a wake. Every source but Scheduled is proactive: its answer is
// recorded for the Human's nightly learning.
const (
	SourceReview    = "review"
	SourceRoutine   = "routine"
	SourceEvent     = "event"
	SourcePlan      = "plan"
	SourceScheduled = "scheduled"
)

// Wake is one queued proactive wake.
type Wake struct {
	// Source names what queued the wake, one of the Source constants.
	Source   string
	TenantID string
	RoomID   string
	// Author speaks the hidden message, normally the Human, so AnotherMe does
	// not ignore it as its own.
	Author store.Actor
	Agent  store.Actor
	// Body is the full text after the @AnotherMe reference, label included.
	Body string
	// TrackingItemID cancels the wake when that Tracking Item is deleted.
	TrackingItemID string
	Grant          *GrantReference
	// FiredRoutine is set only by the Routine scheduler; the delivered
	// Message records it.
	FiredRoutine *messagecreation.FiredRoutine
}

// AnotherMeRoom reports the AnotherMe of a Human's direct Room, if roomID is one.
func AnotherMeRoom(ctx context.Context, queries *store.Queries, tenantID, roomID string) (store.GetAnotherMeDirectRoomAgentRow, bool, error) {
	row, err := queries.GetAnotherMeDirectRoomAgent(ctx, store.GetAnotherMeDirectRoomAgentParams{RoomID: roomID, TenantID: tenantID})
	if errors.Is(err, pgx.ErrNoRows) {
		return row, false, nil
	}
	return row, err == nil, err
}

// EnqueueTx queues a wake in the caller's transaction. Each wake gets its own
// job; whichever job finds the Room quiet first delivers the whole queue.
func EnqueueTx(ctx context.Context, tx pgx.Tx, wake Wake) error {
	switch wake.Source {
	case SourceReview, SourceRoutine, SourceEvent, SourcePlan, SourceScheduled:
	default:
		return errors.New("quiet wake source is unknown")
	}
	if strings.TrimSpace(wake.Body) == "" || wake.TenantID == "" || wake.RoomID == "" {
		return errors.New("quiet wake is incomplete")
	}
	if wake.Source == SourceEvent && wake.Grant == nil {
		return ErrGrantRevoked
	}
	id := newID()
	var tracking pgtype.Text
	if wake.TrackingItemID != "" {
		tracking = pgtype.Text{String: wake.TrackingItemID, Valid: true}
	}
	var firedRoutineID, firedRoutineInstruction pgtype.Text
	if wake.FiredRoutine != nil {
		firedRoutineID = pgtype.Text{String: wake.FiredRoutine.ID, Valid: true}
		firedRoutineInstruction = pgtype.Text{String: wake.FiredRoutine.Instruction, Valid: true}
	}
	grant, err := json.Marshal(wake.Grant)
	if err != nil {
		return err
	}
	if err := store.New(tx).InsertPendingWake(ctx, store.InsertPendingWakeParams{
		ID: id, TenantID: wake.TenantID, RoomID: wake.RoomID, AuthorActorID: wake.Author.ID,
		ConnectionGrant: grant, AgentActorID: wake.Agent.ID, Body: wake.Body, TrackingItemID: tracking, Source: wake.Source,
		FiredRoutineID: firedRoutineID, FiredRoutineInstruction: firedRoutineInstruction,
	}); err != nil {
		return err
	}
	if err := store.New(tx).NotifyVoiceLiveRoomAlert(ctx, store.NotifyVoiceLiveRoomAlertParams{RoomID: wake.RoomID, WakeID: id}); err != nil {
		return err
	}
	return jobs.InsertTx(ctx, tx, deliverArgs{WakeID: id}, nil)
}

type deliverArgs struct {
	WakeID string `json:"wake_id"`
}

func (deliverArgs) Kind() string { return "proactive.quiet_wake" }

func (deliverArgs) InsertOpts() river.InsertOpts {
	return river.InsertOpts{Queue: jobs.QueueDefault, MaxAttempts: 10}
}

// AddWorker registers delivery after Window of quiet.
func AddWorker(workers *river.Workers, pool *pgxpool.Pool, logger *slog.Logger) {
	river.AddWorker(workers, &worker{pool: pool, logger: logger, now: time.Now})
}

type worker struct {
	river.WorkerDefaults[deliverArgs]
	pool   *pgxpool.Pool
	logger *slog.Logger
	now    func() time.Time
}

func (w *worker) Work(ctx context.Context, job *river.Job[deliverArgs]) error {
	wait, err := Deliver(ctx, w.pool, job.Args.WakeID, w.now(), Window)
	if err != nil {
		return err
	}
	if wait > 0 {
		return river.JobSnooze(wait)
	}
	return nil
}

// Deliver sends the Room's queued wakes in order once the Room is quiet. It
// returns how long to wait when the Room is still in conversation, and zero
// once delivered or when the wake was already delivered or cancelled.
func Deliver(ctx context.Context, pool *pgxpool.Pool, wakeID string, now time.Time, quiet time.Duration) (time.Duration, error) {
	queries := store.New(pool)
	wake, err := queries.GetPendingWakeRoom(ctx, wakeID)
	if errors.Is(err, pgx.ErrNoRows) || err == nil && wake.DeliveredAt.Valid {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	queries = queries.WithTx(tx)
	if err := queries.LockRoomPendingWakes(ctx, wake.RoomID); err != nil {
		return 0, err
	}
	pending, err := queries.ListUndeliveredWakes(ctx, wake.RoomID)
	if err != nil || len(pending) == 0 {
		return 0, err
	}
	last, err := queries.GetRoomLastConversationAt(ctx, wake.RoomID)
	if err != nil {
		return 0, err
	}
	if wait := Wait(last, now, quiet); wait > 0 {
		return wait, nil
	}
	for _, item := range pending {
		var grant *GrantReference
		if err := json.Unmarshal(item.ConnectionGrant, &grant); err != nil {
			return 0, err
		}
		if item.Source == SourceEvent || grant != nil {
			err := grant.Check(ctx, queries)
			if errors.Is(err, ErrGrantRevoked) || err == nil && (grant.TenantID != item.TenantID || grant.AgentActorID != item.AgentActorID) {
				if err := queries.DeletePendingWake(ctx, item.ID); err != nil {
					return 0, err
				}
				continue
			} else if err != nil {
				return 0, err
			}
		}
		if err := deliverOne(ctx, queries, item); err != nil {
			return 0, err
		}
	}
	if err := queries.DeleteOldDeliveredWakes(ctx, wake.RoomID); err != nil {
		return 0, err
	}
	return 0, tx.Commit(ctx)
}

// Wait is how long until the Room has been quiet for the quiet window.
func Wait(lastConversation pgtype.Timestamptz, now time.Time, quiet time.Duration) time.Duration {
	if !lastConversation.Valid || lastConversation.InfinityModifier != pgtype.Finite {
		return 0
	}
	return max(0, lastConversation.Time.Add(quiet).Sub(now))
}

func deliverOne(ctx context.Context, queries *store.Queries, wake store.ProactivePendingWake) error {
	author, err := queries.GetActor(ctx, store.GetActorParams{ID: wake.AuthorActorID, TenantID: wake.TenantID})
	if err != nil {
		return err
	}
	agent, err := queries.GetActor(ctx, store.GetActorParams{ID: wake.AgentActorID, TenantID: wake.TenantID})
	if err != nil {
		return err
	}
	content, err := messagecreation.Normalize([]messagecreation.Segment{
		{Type: "reference", Content: "@" + agent.DisplayName, Target: agent.ID, TargetType: "agent"},
		{Type: "text", Content: " " + wake.Body},
	})
	if err != nil {
		return err
	}
	draft := messagecreation.Draft{
		TenantID: wake.TenantID, RoomID: wake.RoomID, Author: author, Content: content, Kind: "agent_runtime",
	}
	if wake.FiredRoutineID.Valid {
		draft.FiredRoutine = &messagecreation.FiredRoutine{ID: wake.FiredRoutineID.String, Instruction: wake.FiredRoutineInstruction.String}
	}
	created, err := messagecreation.Create(ctx, queries, draft)
	if err != nil {
		return err
	}
	return queries.MarkWakeDelivered(ctx, store.MarkWakeDeliveredParams{ID: wake.ID, MessageID: created.Message.ID})
}

func newID() string {
	bytes := make([]byte, 16)
	if _, err := rand.Read(bytes); err != nil {
		panic(err)
	}
	return "pwake_" + hex.EncodeToString(bytes)
}
