package reminder

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/messagecreation"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

// fireOccurrence delivers one scheduled occurrence and enqueues the next one in
// the same transaction. found is false when the occurrence is stale.
func (s *Service) fireOccurrence(ctx context.Context, reminderID string, dueAt time.Time) (ScheduleResult, bool, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return ScheduleResult{}, false, err
	}
	defer tx.Rollback(ctx)
	queries := store.New(tx)
	record, err := queries.LockDueRoomReminderOccurrence(ctx, store.LockDueRoomReminderOccurrenceParams{
		ID: reminderID, DueAt: requiredTimestamptz(dueAt),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return ScheduleResult{}, false, nil
	}
	if err != nil {
		return ScheduleResult{}, false, err
	}
	status, err := templateAgentStatus(ctx, queries, record)
	if err != nil {
		return ScheduleResult{}, false, err
	}
	nextRunAtTime, err := advanceOccurrenceTx(ctx, tx, queries, record, dueAt)
	if err != nil {
		return ScheduleResult{}, false, err
	}
	// No active Agent speaks for this copy: skip the occurrence, keep the schedule.
	if status != "active" {
		return ScheduleResult{}, false, tx.Commit(ctx)
	}
	// The matter this Routine serves is finished: move on without waking anyone.
	if record.TrackingItemID.Valid {
		closed, err := queries.IsTrackingItemClosed(ctx, record.TrackingItemID.String)
		if err != nil {
			return ScheduleResult{}, false, err
		}
		if closed {
			return ScheduleResult{}, false, tx.Commit(ctx)
		}
	}
	seq, messageID, dropped, err := deliverReminder(ctx, tx, queries, record, true)
	if err != nil {
		return ScheduleResult{}, false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return ScheduleResult{}, false, err
	}
	return ScheduleResult{
		ReminderID: record.ID, MessageID: messageID, ScheduledFor: dueAt,
		NextRunAt: nextRunAtTime, RoomID: record.RoomID, RoomSeq: seq, MentionDropped: dropped,
	}, true, nil
}

// skipOccurrence moves past an occurrence that failed on its last attempt
// without delivering it, so the occurrences after it still run.
func (s *Service) skipOccurrence(ctx context.Context, reminderID string, dueAt time.Time) (bool, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer tx.Rollback(ctx)
	queries := store.New(tx)
	record, err := queries.LockDueRoomReminderOccurrence(ctx, store.LockDueRoomReminderOccurrenceParams{
		ID: reminderID, DueAt: requiredTimestamptz(dueAt),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if _, err := advanceOccurrenceTx(ctx, tx, queries, record, dueAt); err != nil {
		return false, err
	}
	return true, tx.Commit(ctx)
}

// advanceOccurrenceTx moves a locked Reminder to its next occurrence and enqueues
// that occurrence in the caller's transaction. A one-shot Routine is done after
// its occurrence: it is disabled and nothing more is scheduled.
func advanceOccurrenceTx(ctx context.Context, tx pgx.Tx, queries *store.Queries, record store.RoomReminder, dueAt time.Time) (time.Time, error) {
	if record.CadenceKind.String == "once" {
		_, err := queries.FinishRoomReminderSchedule(ctx, store.FinishRoomReminderScheduleParams{
			ID: record.ID, ExpectedNextRunAt: record.NextRunAt,
		})
		return time.Time{}, err
	}
	next, err := nextRunAt(cadenceFromRecord(record), maxTime(time.Now().UTC(), dueAt))
	if err != nil {
		return time.Time{}, err
	}
	if _, err := queries.AdvanceRoomReminderSchedule(ctx, store.AdvanceRoomReminderScheduleParams{
		NextRunAt: requiredTimestamptz(next), ID: record.ID,
		ExpectedNextRunAt: record.NextRunAt,
	}); err != nil {
		return time.Time{}, err
	}
	if err := enqueueFireTx(ctx, tx, record.ID, next); err != nil {
		return time.Time{}, err
	}
	return next, nil
}

// templateAgentStatus is the registration status of a template copy's Agent:
// "active" for a Routine without a template Agent, "" when the Agent is gone.
func templateAgentStatus(ctx context.Context, queries *store.Queries, record store.RoomReminder) (string, error) {
	if !record.TemplateAgentActorID.Valid {
		return "active", nil
	}
	registration, err := queries.GetAgentRegistrationByActor(ctx, store.GetAgentRegistrationByActorParams{
		ActorID: record.TemplateAgentActorID.String, TenantID: record.TenantID,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return registration.Status, nil
}

// requireTemplateAgentActive guards running or enabling a template copy.
func requireTemplateAgentActive(ctx context.Context, queries *store.Queries, record store.RoomReminder) error {
	status, err := templateAgentStatus(ctx, queries, record)
	if err != nil {
		return err
	}
	if status != "active" {
		return ErrTemplateAgentUnavailable
	}
	return nil
}

// deliverReminder posts one fire; the caller has checked the template Agent. A
// scheduled fire for the AnotherMe of a Human's direct Room joins the quiet-wake
// queue instead (queue), so it never interrupts a conversation; a manual run
// goes out at once.
func deliverReminder(ctx context.Context, tx pgx.Tx, queries *store.Queries, record store.RoomReminder, queue bool) (int64, string, bool, error) {
	creator, err := queries.GetActor(ctx, store.GetActorParams{ID: record.CreatedByActorID, TenantID: record.TenantID})
	if err != nil {
		return 0, "", false, err
	}
	mention, dropped := resolveFireMention(ctx, queries, record)
	author, err := routineMessageAuthor(ctx, queries, record, creator, mention)
	if err != nil {
		return 0, "", dropped, err
	}
	instruction := record.Instruction + trackingNote(record)
	origin := &messagecreation.FiredRoutine{ID: record.ID, Instruction: strings.TrimSpace(instruction)}
	seq := func() (int64, error) {
		return appendChangedWithName(ctx, queries, Authority{
			TenantID: record.TenantID, RoomID: record.RoomID, ActorID: record.CreatedByActorID,
		}, record.ID, "fired", record.Revision, record.Name)
	}
	if queue && mention != nil {
		room, ok, err := AnotherMeRoom(ctx, queries, record.TenantID, record.RoomID)
		if err != nil {
			return 0, "", dropped, err
		}
		if ok && room.AgentActorID == mention.ID {
			source := SourceScheduled
			if record.TrackingItemID.Valid {
				source = SourceRoutine
			}
			if err := EnqueueTx(ctx, tx, Wake{
				Source: source, TenantID: record.TenantID, RoomID: record.RoomID, Author: author, Agent: *mention,
				Body: scheduleLabel(record.Name) + instruction, TrackingItemID: record.TrackingItemID.String,
				FiredRoutine: origin,
			}); err != nil {
				return 0, "", dropped, err
			}
			value, err := seq()
			return value, "", dropped, err
		}
	}
	content, err := fireContent(scheduleLabel(record.Name), instruction, mention)
	if err != nil {
		return 0, "", dropped, err
	}
	draft := messagecreation.Draft{
		TenantID: record.TenantID, RoomID: record.RoomID, Author: author, Content: content, Kind: "conversation",
	}
	if mention != nil {
		draft.Kind, draft.FiredRoutine = "agent_runtime", origin
	}
	created, err := messagecreation.Create(ctx, queries, draft)
	if err != nil {
		return 0, "", dropped, err
	}
	value, err := seq()
	if err != nil {
		return 0, "", dropped, err
	}
	return value, created.Message.ID, dropped, nil
}

// trackingNote names the Tracking Item a Routine serves, so the woken Agent
// checks that matter and adjusts its Routines as it changes.
func trackingNote(record store.RoomReminder) string {
	if !record.TrackingItemID.Valid {
		return ""
	}
	return "\n" + Prompt(RoutineTrackingItem, map[string]string{
		"id": record.TrackingItemID.String, "purpose": record.TrackingPurpose.String,
	})
}

// A Human-created Routine keeps that Human as the message author. An Agent
// mentioning itself would otherwise be ignored as its own message, in both
// direct and collaboration rooms. Those fires are spoken by a Human member.
func routineMessageAuthor(ctx context.Context, queries *store.Queries, record store.RoomReminder, creator store.Actor, mention *store.Actor) (store.Actor, error) {
	if creator.Kind != "agent" || mention == nil || mention.ID != creator.ID {
		return creator, nil
	}
	humanID, err := routineWakeHumanID(ctx, queries, record, creator)
	if err != nil || humanID == "" {
		return creator, err
	}
	return queries.GetActor(ctx, store.GetActorParams{ID: humanID, TenantID: record.TenantID})
}

func routineWakeHumanID(ctx context.Context, queries *store.Queries, record store.RoomReminder, creator store.Actor) (string, error) {
	humans, err := queries.ListActiveHumanRoomMemberIDs(ctx, store.ListActiveHumanRoomMemberIDsParams{
		RoomID: record.RoomID, TenantID: record.TenantID,
	})
	if err != nil {
		return "", err
	}
	present := make(map[string]struct{}, len(humans))
	for _, id := range humans {
		present[id] = struct{}{}
	}
	direct, err := queries.GetDirectRoom(ctx, record.RoomID)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return "", err
	}
	if err == nil && direct.TenantID == record.TenantID && direct.AgentActorID == creator.ID {
		if _, ok := present[direct.HumanActorID]; ok {
			return direct.HumanActorID, nil
		}
	}
	if len(humans) == 1 {
		return humans[0], nil
	}
	if len(humans) == 0 || !record.CreatedAt.Valid {
		return "", nil
	}
	latest, err := queries.GetLatestActiveHumanMessageAuthorID(ctx, store.GetLatestActiveHumanMessageAuthorIDParams{
		RoomID: record.RoomID, TenantID: record.TenantID, Before: record.CreatedAt,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	if _, ok := present[latest]; !ok {
		return "", nil
	}
	return latest, nil
}

func resolveFireMention(ctx context.Context, queries *store.Queries, record store.RoomReminder) (*store.Actor, bool) {
	if !record.MentionActorID.Valid {
		return nil, false
	}
	targets, err := queries.ListRoomMentionTargets(ctx, store.ListRoomMentionTargetsParams{
		RoomID: record.RoomID, ActorIds: []string{record.MentionActorID.String},
	})
	if err != nil || len(targets) != 1 || targets[0].Kind != "agent" {
		return nil, true
	}
	target := targets[0]
	return &target, false
}

// scheduleLabel tells a woken Agent where the message came from. It is for
// the model only: the Routine origin is recorded on the Message itself.
func scheduleLabel(name string) string {
	return `[Routine "` + name + `" fired: this is your own saved standing instruction, not a new message from the user. Follow it; if there is nothing worth saying, do not reply.]` + "\n"
}

// fireContent builds the fired message. A wake for an Agent says it is the
// Agent's own standing order, not a message someone just typed, and that
// ending without a reply is fine when there is nothing worth saying.
func fireContent(label, prompt string, mention *store.Actor) (messagecreation.Content, error) {
	segments := []messagecreation.Segment{{Type: "text", Content: prompt}}
	if mention != nil {
		segments = []messagecreation.Segment{
			{Type: "reference", Content: "@" + mention.DisplayName, Target: mention.ID, TargetType: "agent"},
			{Type: "text", Content: " " + label + prompt},
		}
	}
	return messagecreation.Normalize(segments)
}
