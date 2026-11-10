package proactive

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/jobs"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/reminder"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

// Event is one outside change that may deserve a reminder: a meeting about to
// start, a new mail, a flight status. Connectors hand events in through
// EnqueueEventTx; nothing is stored besides the job and the day's records.
type Event struct {
	Grant        *reminder.GrantReference `json:"grant,omitempty"`
	TenantID     string                   `json:"tenant_id"`
	OwnerActorID string                   `json:"owner_actor_id"`
	// Source and ExternalID name the thing in its own system, e.g. gmail and a
	// thread ID. State is its current status (a delay length, a gate): a new
	// state is judged again the same day, a repeated one is not.
	Source     string     `json:"source"`
	ExternalID string     `json:"external_id"`
	State      string     `json:"state,omitempty"`
	Kind       string     `json:"kind"`
	Summary    string     `json:"summary"`
	OccursAt   *time.Time `json:"occurs_at,omitempty"`
	// Urgent events (a cancellation, a boarding call) pass the quiet hours and
	// the daily limit.
	Urgent bool `json:"urgent,omitempty"`
}

const (
	maxEventSummaryRunes = 12000
	// maxEventWakesPerDay bounds how often events may ask AnotherMe for a
	// reminder for one Human; later ones only ask it to record them.
	maxEventWakesPerDay = 5
	eventMaxAttempts    = 8
)

// ErrInvalidEvent means an event lacks what is needed to judge it.
var ErrInvalidEvent = errors.New("proactive event is invalid")

func (e Event) validate() error {
	for _, value := range []string{e.TenantID, e.OwnerActorID, e.Source, e.ExternalID, e.Kind, e.Summary} {
		if strings.TrimSpace(value) == "" {
			return ErrInvalidEvent
		}
	}
	if utf8.RuneCountInString(e.Summary) > maxEventSummaryRunes {
		return ErrInvalidEvent
	}
	return nil
}

// EventArgs carries one event through River.
type EventArgs struct {
	Event Event `json:"event"`
}

func (EventArgs) Kind() string { return "proactive.event" }

func (EventArgs) InsertOpts() river.InsertOpts {
	return river.InsertOpts{Queue: jobs.QueueDefault, MaxAttempts: eventMaxAttempts, UniqueOpts: jobs.UniqueUnfinished}
}

// EnqueueEventTx queues an event in the caller's transaction.
func EnqueueEventTx(ctx context.Context, tx pgx.Tx, event Event) error {
	if err := event.validate(); err != nil {
		return err
	}
	if event.Grant == nil {
		return reminder.ErrGrantRevoked
	}
	return jobs.InsertTx(ctx, tx, EventArgs{Event: event}, nil)
}

// AddEventWorker registers the event worker.
func AddEventWorker(workers *river.Workers, service *Service, logger *slog.Logger) {
	river.AddWorker(workers, &eventWorker{service: service, logger: logger})
}

type eventWorker struct {
	river.WorkerDefaults[EventArgs]
	service *Service
	logger  *slog.Logger
}

// Give a rolling Agent restart time to recover. Eight attempts span at least
// 22 minutes rather than exhausting the event in seconds.
func (w *eventWorker) NextRetry(job *river.Job[EventArgs]) time.Time {
	delay := 30 * time.Second * time.Duration(1<<min(max(job.Attempt-1, 0), 4))
	return time.Now().Add(min(delay, 5*time.Minute))
}

func (w *eventWorker) Work(ctx context.Context, job *river.Job[EventArgs]) error {
	outcome, err := w.service.HandleEvent(ctx, job.Args.Event)
	if err != nil {
		return err
	}
	w.logger.InfoContext(ctx, "proactive event handled",
		"job_id", job.ID, "attempt", job.Attempt, "event_id", job.Args.Event.ExternalID,
		"tenant_id", job.Args.Event.TenantID, "owner_actor_id", job.Args.Event.OwnerActorID,
		"source", job.Args.Event.Source, "kind", job.Args.Event.Kind, "skipped", outcome.Skipped)
	return nil
}

// ErrNoJudge means no proactive event rules source is configured, so events
// cannot be handed to AnotherMe.
var ErrNoJudge = errors.New("proactive event judge is unavailable")

// HandleEvent wakes the Human's AnotherMe with one new event and the rules it
// judges it by, in its own Run: remind them, record or update a Tracking Item
// without replying, or stay silent. Quiet hours and the daily limit leave a
// non-urgent event only tracking.
func (s *Service) HandleEvent(ctx context.Context, event Event) (Outcome, error) {
	if err := event.validate(); err != nil {
		return Outcome{}, err
	}
	owner := Owner{TenantID: event.TenantID, ActorID: event.OwnerActorID}
	now := s.now()
	candidate := Candidate{
		Source: "event", Kind: event.Kind, Content: strings.TrimSpace(event.Summary), DueAt: event.OccursAt,
		SourceKey: SourceKey("event", event.Source+"\x00"+event.ExternalID+"\x00"+event.State, Day(now)),
	}
	queries := store.New(s.pool)
	if err := event.Grant.Check(ctx, queries); errors.Is(err, reminder.ErrGrantRevoked) {
		return Outcome{Candidate: candidate, Skipped: "authorization_revoked"}, nil
	} else if err != nil {
		return Outcome{}, err
	}
	if s.judge == nil {
		return Outcome{}, ErrNoJudge
	}
	seen, err := queries.HasProactiveSignalForSource(ctx, store.HasProactiveSignalForSourceParams{
		TenantID: owner.TenantID, OwnerActorID: owner.ActorID, Source: candidate.Source, SourceKey: candidate.SourceKey,
	})
	if err != nil {
		return Outcome{}, err
	}
	if seen {
		return Outcome{Candidate: candidate, Skipped: "already_judged"}, nil
	}
	items, err := queries.ListProactiveTrackingItems(ctx, store.ListProactiveTrackingItemsParams{
		TenantID: owner.TenantID, OwnerActorID: owner.ActorID,
	})
	if err != nil {
		return Outcome{}, err
	}
	guideline, err := s.guideline(ctx, owner)
	if err != nil {
		return Outcome{}, err
	}
	request := EventJudgeRequest{Specific: guideline.Specific, OpenItems: []OpenItem{}}
	if request.Specific == nil {
		request.Specific = []string{}
	}
	for _, item := range items {
		open := OpenItem{ID: item.ID, Kind: item.Kind, Content: item.Content}
		if item.DueAt.Valid {
			due := item.DueAt.Time
			open.DueAt = &due
		}
		request.OpenItems = append(request.OpenItems, open)
	}
	instructions, err := s.judge(ctx, request)
	if err != nil {
		return Outcome{}, err
	}
	outcome := Outcome{Candidate: candidate}
	if !event.Urgent {
		woken, err := queries.CountProactiveRemindedEvents(ctx, store.CountProactiveRemindedEventsParams{
			TenantID: owner.TenantID, OwnerActorID: owner.ActorID,
		})
		if err != nil {
			return Outcome{}, err
		}
		// AnotherMe may tell, so quiet hours and the daily limit leave it only
		// tracking; a woken decision counts toward the limit.
		if gated(now, woken) {
			outcome.Skipped = "gated_to_tracking"
			instructions += "\n" + reminder.Prompt(reminder.EventTrackOnly, nil)
		}
	}
	err = s.wake(ctx, owner, candidate, eventText(instructions, event), outcome.Skipped == "", event.Grant)
	if errors.Is(err, reminder.ErrGrantRevoked) {
		outcome.Skipped = "authorization_revoked"
		return outcome, nil
	}
	return outcome, err
}

// gated reports whether a non-urgent event may only be tracked: during quiet
// hours or once the Human has had maxEventWakesPerDay event reminders today.
func gated(now time.Time, remindedToday int64) bool {
	return quietHour(now) || remindedToday >= maxEventWakesPerDay
}

// quietHour is 22:00-08:00 local time, when nothing non-urgent interrupts.
func quietHour(now time.Time) bool {
	hour := now.In(time.Local).Hour()
	return hour >= 22 || hour < 8
}

// wake queues a hidden message for the Human's AnotherMe in their direct Room,
// spoken by the Human so it is not ignored as AnotherMe's own, and records the
// day's judgment of the event; reminded counts toward the daily limit.
func (s *Service) wake(ctx context.Context, owner Owner, candidate Candidate, body string, reminded bool, grant *reminder.GrantReference) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	queries := store.New(s.pool).WithTx(tx)
	if err := grant.Check(ctx, queries); err != nil {
		return err
	}
	chat, err := queries.GetAnotherMeChat(ctx, store.GetAnotherMeChatParams{
		TenantID: owner.TenantID, HumanActorID: owner.ActorID,
	})
	if errors.Is(err, pgx.ErrNoRows) || err == nil && !chat.RoomID.Valid {
		return ErrNoDirectRoom
	}
	if err != nil {
		return err
	}
	if grant.TenantID != owner.TenantID || grant.AgentActorID != chat.AgentActorID {
		return reminder.ErrGrantRevoked
	}
	agent, err := queries.GetActor(ctx, store.GetActorParams{ID: chat.AgentActorID, TenantID: owner.TenantID})
	if err != nil {
		return err
	}
	human, err := queries.GetActor(ctx, store.GetActorParams{ID: owner.ActorID, TenantID: owner.TenantID})
	if err != nil {
		return err
	}
	if err := reminder.EnqueueTx(ctx, tx, reminder.Wake{
		Grant: grant, Source: reminder.SourceEvent, TenantID: owner.TenantID, RoomID: chat.RoomID.String, Author: human, Agent: agent, Body: body,
	}); err != nil {
		return err
	}
	if err := record(ctx, queries, owner, candidate, reminded); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// eventText fences the event and marks it as outside data, never instructions.
func eventText(label string, event Event) string {
	facts := []string{"source: " + event.Source, "kind: " + event.Kind}
	if event.State != "" {
		facts = append(facts, "state: "+event.State)
	}
	if event.OccursAt != nil {
		facts = append(facts, "time: "+event.OccursAt.In(time.Local).Format("2006-01-02 15:04 -07:00"))
	}
	return label + "\n" + strings.Join(facts, "; ") + "\n<event>\n" + strings.TrimSpace(event.Summary) +
		"\n</event>\n" + reminder.Prompt(reminder.EventData, nil)
}
