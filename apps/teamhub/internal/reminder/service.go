// Package reminder owns a Human's proactive follow-up: Routines and app
// listeners that fire on a schedule or event, the connection grant checks
// behind queued app data, the quiet-wake queue that delivers wakes to
// AnotherMe, and the tracking items Routines follow.
package reminder

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/idempotency"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/ids"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/roomevent"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

type Service struct {
	pool *pgxpool.Pool
}

func New(pool *pgxpool.Pool) *Service {
	return &Service{pool: pool}
}

func (s *Service) HumanRoomAuthority(ctx context.Context, accountID, roomID string) (Authority, error) {
	record, err := store.New(s.pool).ResolveReminderHumanRoomAuthority(ctx, store.ResolveReminderHumanRoomAuthorityParams{
		AccountID: accountID, RoomID: roomID,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return Authority{}, ErrNotFound
	}
	if err != nil {
		return Authority{}, err
	}
	return Authority{TenantID: record.TenantID, RoomID: roomID, ActorID: record.ActorID}, nil
}

// AgentRoomAuthority admits an Agent to the Routines of the Room it acts in.
func (s *Service) AgentRoomAuthority(ctx context.Context, actorID, agentManagementID, roomID string) (Authority, error) {
	record, err := store.New(s.pool).ResolveReminderAgentRoomAuthority(ctx, store.ResolveReminderAgentRoomAuthorityParams{
		ActorID: actorID, AgentManagementID: agentManagementID, RoomID: roomID,
	})
	if err != nil {
		return Authority{}, notFound(err)
	}
	return Authority{TenantID: record.TenantID, RoomID: roomID, ActorID: record.ActorID}, nil
}

func (s *Service) List(ctx context.Context, authority Authority, cursor string, limit int32) (Page, error) {
	if limit <= 0 {
		limit = defaultListLimit
	}
	if limit > maxListLimit {
		limit = maxListLimit
	}
	params := store.ListRoomRemindersParams{
		RoomID: authority.RoomID, TenantID: authority.TenantID, ListLimit: limit + 1,
	}
	if cursor != "" {
		createdAt, id, err := decodeCursor(cursor)
		if err != nil {
			return Page{}, err
		}
		params.CursorCreatedAt = pgtype.Timestamptz{Time: createdAt.UTC(), Valid: true}
		params.CursorID = pgtype.Text{String: id, Valid: true}
	}
	records, err := store.New(s.pool).ListRoomReminders(ctx, params)
	if err != nil {
		return Page{}, err
	}
	page := Page{Items: make([]Reminder, 0, len(records))}
	for _, record := range records {
		if int32(len(page.Items)) == limit {
			page.HasMore = true
			last := page.Items[len(page.Items)-1]
			page.NextCursor = encodeCursor(last.CreatedAt, last.ID)
			break
		}
		page.Items = append(page.Items, reminderFromRecord(record))
	}
	return page, nil
}

// Create adds a Routine to a Room. A Tracking Item link must name an item of
// the Human the calling AnotherMe represents, so only Agents can make one.
func (s *Service) Create(ctx context.Context, caller Caller, roomID, key string, requestHash []byte, input CreateInput) (Result, error) {
	name, err := normalizeName(input.Name)
	if err != nil {
		return Result{}, err
	}
	instruction, err := normalizePrompt(input.Instruction)
	if err != nil {
		return Result{}, err
	}
	cadence, err := validateCadence(input.Cadence)
	if err != nil {
		return Result{}, err
	}
	enabled := input.Enabled == nil || *input.Enabled
	var trackingID, trackingPurpose pgtype.Text
	if input.TrackingItemID != "" || input.TrackingPurpose != "" {
		purpose := strings.TrimSpace(input.TrackingPurpose)
		if input.TrackingItemID == "" || purpose == "" || utf8.RuneCountInString(purpose) > 500 {
			return Result{}, ErrInvalid
		}
		trackingID = pgtype.Text{String: input.TrackingItemID, Valid: true}
		trackingPurpose = pgtype.Text{String: purpose, Valid: true}
	}
	room := func(*store.Queries) (string, error) { return roomID, nil }
	return s.write(ctx, caller, "createRoutine:"+roomID, key, requestHash, room, func(ctx context.Context, tx pgx.Tx, queries *store.Queries, authority Authority) (Result, error) {
		if err := lockMention(ctx, queries, roomID, input.MentionActorID); err != nil {
			return Result{}, err
		}
		if err := checkLimits(ctx, queries, authority, nil, cadence.Kind, enabled); err != nil {
			return Result{}, err
		}
		if trackingID.Valid {
			if _, err := queries.GetAgentOwnedTrackingItem(ctx, store.GetAgentOwnedTrackingItemParams{
				ID: trackingID.String, AgentActorID: authority.ActorID,
			}); err != nil {
				return Result{}, notFound(err)
			}
		}
		next, err := upcomingRun(cadence, enabled)
		if err != nil {
			return Result{}, err
		}
		record, err := queries.CreateRoomReminder(ctx, store.CreateRoomReminderParams{
			ID: ids.New("routine"), TenantID: authority.TenantID, RoomID: roomID,
			CreatedByActorID: authority.ActorID, Name: name, Instruction: instruction, MentionActorID: optionalText(input.MentionActorID),
			CadenceKind: optionalText(&cadence.Kind), Timezone: routineTimezone(cadence), Hour: optionalInt4(cadence.Hour),
			Minute: optionalInt4(cadence.Minute), Weekdays: cadence.Weekdays,
			IntervalHours: optionalInt4(cadence.IntervalHours), RunAt: optionalTimestamptz(cadence.RunAt), Enabled: enabled,
			NextRunAt:      optionalTimestamptz(next),
			TrackingItemID: trackingID, TrackingPurpose: trackingPurpose,
		})
		if err != nil {
			return Result{}, err
		}
		if err := scheduleTx(ctx, tx, record.ID, next); err != nil {
			return Result{}, err
		}
		return changed(ctx, queries, authority, record, "created", http.StatusCreated)
	})
}

// Update patches a Routine. The row is locked before its revision is
// compared, so a concurrent fire's schedule is never written back stale.
// ExpectedRevision 0 takes the current revision, as Agents pause and resume.
func (s *Service) Update(ctx context.Context, caller Caller, routineID, key string, requestHash []byte, input UpdateInput) (Result, error) {
	if input.ExpectedRevision < 0 {
		return Result{}, ErrInvalid
	}
	var name, instruction string
	var cadence Cadence
	var err error
	if input.Name != nil {
		if name, err = normalizeName(*input.Name); err != nil {
			return Result{}, err
		}
	}
	if input.Instruction != nil {
		if instruction, err = normalizePrompt(*input.Instruction); err != nil {
			return Result{}, err
		}
	}
	if input.Cadence != nil {
		if cadence, err = validateCadence(*input.Cadence); err != nil {
			return Result{}, err
		}
	}
	return s.routineWrite(ctx, caller, "updateRoutine:"+routineID, routineID, key, requestHash, func(ctx context.Context, tx pgx.Tx, queries *store.Queries, authority Authority, current store.RoomReminder) (Result, error) {
		if input.ExpectedRevision != 0 && current.Revision != input.ExpectedRevision {
			return Result{}, ErrConflict
		}
		listener := len(current.Trigger) > 0
		if listener && (input.Name != nil || input.Instruction != nil || input.Cadence != nil || input.MentionActorID != nil) {
			return Result{}, ErrAppListener
		}
		value := reminderFromRecord(current)
		if input.Name != nil {
			value.Name = name
		}
		if input.Instruction != nil {
			value.Instruction = instruction
		}
		if input.Cadence != nil {
			value.Cadence = cadence
		}
		if input.Enabled != nil {
			value.Enabled = *input.Enabled
		}
		// An unchanged mention is not rechecked: a fire drops one that left.
		if input.MentionActorID != nil {
			value.MentionActorID = *input.MentionActorID
			if err := lockMention(ctx, queries, authority.RoomID, value.MentionActorID); err != nil {
				return Result{}, err
			}
		}
		if value.Enabled {
			if err := requireTemplateAgentActive(ctx, queries, current); err != nil {
				return Result{}, err
			}
		}
		if err := checkLimits(ctx, queries, authority, &current, value.Cadence.Kind, value.Enabled); err != nil {
			return Result{}, err
		}
		next := value.NextRunAt
		if listener || !value.Enabled {
			next = nil
		} else if input.Cadence != nil || input.Enabled != nil || next == nil {
			if next, err = upcomingRun(value.Cadence, true); err != nil {
				return Result{}, err
			}
		}
		record, err := queries.UpdateRoomReminder(ctx, store.UpdateRoomReminderParams{
			Name: value.Name, Instruction: value.Instruction, MentionActorID: optionalText(value.MentionActorID),
			CadenceKind: optionalText(&value.Cadence.Kind), Timezone: value.Cadence.Timezone,
			Hour: optionalInt4(value.Cadence.Hour), Minute: optionalInt4(value.Cadence.Minute),
			Weekdays: value.Cadence.Weekdays, IntervalHours: optionalInt4(value.Cadence.IntervalHours), RunAt: optionalTimestamptz(value.Cadence.RunAt),
			Enabled: value.Enabled, NextRunAt: optionalTimestamptz(next),
			ID: routineID, TenantID: authority.TenantID, RoomID: authority.RoomID,
			ExpectedRevision: current.Revision,
		})
		if errors.Is(err, pgx.ErrNoRows) {
			return Result{}, ErrConflict
		}
		if err != nil {
			return Result{}, err
		}
		if err := scheduleTx(ctx, tx, record.ID, next); err != nil {
			return Result{}, err
		}
		if listener && value.Enabled && input.Enabled != nil {
			if err := resumeListenerBindingsTx(ctx, tx, queries, authority.TenantID, record.ID); err != nil {
				return Result{}, err
			}
		}
		return changed(ctx, queries, authority, record, "updated", http.StatusOK)
	})
}

// Delete removes a Routine. expectedRevision 0 takes the current revision.
func (s *Service) Delete(ctx context.Context, caller Caller, routineID, key string, requestHash []byte, expectedRevision int64) (Result, error) {
	if expectedRevision < 0 {
		return Result{}, ErrInvalid
	}
	return s.routineWrite(ctx, caller, "deleteRoutine:"+routineID, routineID, key, requestHash, func(ctx context.Context, tx pgx.Tx, queries *store.Queries, authority Authority, current store.RoomReminder) (Result, error) {
		if expectedRevision != 0 && current.Revision != expectedRevision {
			return Result{}, ErrConflict
		}
		if len(current.Trigger) > 0 {
			return Result{}, ErrAppListener
		}
		deleted, err := queries.DeleteRoomReminder(ctx, store.DeleteRoomReminderParams{
			ID: routineID, TenantID: authority.TenantID, RoomID: authority.RoomID, ExpectedRevision: current.Revision,
		})
		if err != nil {
			return Result{}, notFound(err)
		}
		return changed(ctx, queries, authority, deleted, "deleted", http.StatusNoContent)
	})
}

// RunNow fires a Routine once at once, outside its schedule.
func (s *Service) RunNow(ctx context.Context, caller Caller, routineID, key string, requestHash []byte) (Result, error) {
	return s.routineWrite(ctx, caller, "runRoutine:"+routineID, routineID, key, requestHash, func(ctx context.Context, tx pgx.Tx, queries *store.Queries, authority Authority, record store.RoomReminder) (Result, error) {
		if len(record.Trigger) > 0 {
			return Result{}, ErrAppListener
		}
		if err := requireTemplateAgentActive(ctx, queries, record); err != nil {
			return Result{}, err
		}
		if _, _, _, err := deliverReminder(ctx, tx, queries, record, false); err != nil {
			return Result{}, err
		}
		return Result{Value: reminderFromRecord(record), Status: http.StatusOK}, nil
	})
}

// DeleteTrackingItemRoutinesTx deletes the Routines serving Tracking Items
// about to be deleted, recording each deletion in its Room.
func DeleteTrackingItemRoutinesTx(ctx context.Context, tx pgx.Tx, tenantID string, trackingItemIDs []string) error {
	if len(trackingItemIDs) == 0 {
		return nil
	}
	queries := store.New(tx)
	deleted, err := queries.DeleteTrackingItemRoomReminders(ctx, store.DeleteTrackingItemRoomRemindersParams{
		TenantID: tenantID, TrackingItemIds: trackingItemIDs,
	})
	if err != nil {
		return err
	}
	return recordDeletedTx(ctx, queries, deleted)
}

type writeFunc func(ctx context.Context, tx pgx.Tx, queries *store.Queries, authority Authority) (Result, error)

// write runs one Routine command for caller in the Room room resolves. An
// Agent's write holds its replay lock and returns a stored replay once its
// authority is rechecked; otherwise apply runs and an Agent's result is
// stored.
func (s *Service) write(ctx context.Context, caller Caller, operation, key string, requestHash []byte, room func(*store.Queries) (string, error), apply writeFunc) (Result, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Result{}, err
	}
	defer tx.Rollback(ctx)
	queries := store.New(tx)
	replayKey := caller.replayKey(operation, key)
	if err := idempotency.Lock(ctx, tx, replayKey); err != nil {
		return Result{}, err
	}
	stored, replayed, err := idempotency.Lookup(ctx, tx, replayKey, requestHash)
	if errors.Is(err, idempotency.ErrConflict) {
		return Result{}, ErrIdempotencyConflict
	}
	if err != nil {
		return Result{}, err
	}
	roomID, err := room(queries)
	if err != nil {
		return Result{}, err
	}
	authority, err := caller.authorize(ctx, tx, queries, roomID)
	if err != nil {
		return Result{}, err
	}
	if replayed {
		return replayOf(stored, tx.Commit(ctx))
	}
	result, err := apply(ctx, tx, queries, authority)
	if err != nil {
		return Result{}, err
	}
	body, err := json.Marshal(result.Value)
	if err != nil {
		return Result{}, err
	}
	if err := idempotency.Save(ctx, tx, replayKey, requestHash, idempotency.Record{
		ResourceID: result.Value.ID, Status: result.Status, Body: body,
	}); err != nil {
		return Result{}, err
	}
	return result, tx.Commit(ctx)
}

// routineWrite is write for a command on one Routine, which apply gets locked.
func (s *Service) routineWrite(ctx context.Context, caller Caller, operation, routineID, key string, requestHash []byte,
	apply func(ctx context.Context, tx pgx.Tx, queries *store.Queries, authority Authority, current store.RoomReminder) (Result, error),
) (Result, error) {
	room := func(queries *store.Queries) (string, error) { return caller.routineRoom(ctx, queries, routineID) }
	return s.write(ctx, caller, operation, key, requestHash, room, func(ctx context.Context, tx pgx.Tx, queries *store.Queries, authority Authority) (Result, error) {
		current, err := queries.LockRoomReminder(ctx, store.LockRoomReminderParams{
			ID: routineID, TenantID: authority.TenantID, RoomID: authority.RoomID,
		})
		if err != nil {
			return Result{}, notFound(err)
		}
		return apply(ctx, tx, queries, authority, current)
	})
}

func replayOf(record idempotency.Record, commitErr error) (Result, error) {
	if commitErr != nil {
		return Result{}, commitErr
	}
	var value Reminder
	if err := json.Unmarshal(record.Body, &value); err != nil {
		return Result{}, err
	}
	return Result{Value: value, Status: record.Status, Replay: true}, nil
}

// changed records a Routine change in its Room.
func changed(ctx context.Context, queries *store.Queries, authority Authority, record store.RoomReminder, kind string, status int) (Result, error) {
	value := reminderFromRecord(record)
	if _, err := appendChanged(ctx, queries, authority, value.ID, kind, value.Revision); err != nil {
		return Result{}, err
	}
	return Result{Value: value, Status: status}, nil
}

// upcomingRun is the first occurrence of an enabled Routine from now.
func upcomingRun(cadence Cadence, enabled bool) (*time.Time, error) {
	if !enabled {
		return nil, nil
	}
	next, err := nextRunAt(cadence, time.Now().UTC())
	if err != nil {
		return nil, err
	}
	return &next, nil
}

func scheduleTx(ctx context.Context, tx pgx.Tx, routineID string, next *time.Time) error {
	if next == nil {
		return nil
	}
	return enqueueFireTx(ctx, tx, routineID, *next)
}

func lockMention(ctx context.Context, queries *store.Queries, roomID string, mentionActorID *string) error {
	if mentionActorID == nil || strings.TrimSpace(*mentionActorID) == "" {
		return nil
	}
	targets, err := queries.ListRoomMentionTargets(ctx, store.ListRoomMentionTargetsParams{
		RoomID: roomID, ActorIds: []string{*mentionActorID},
	})
	if err != nil {
		return err
	}
	if len(targets) != 1 || targets[0].Kind != "agent" {
		return ErrMentionInvalid
	}
	return nil
}

func appendChanged(ctx context.Context, queries *store.Queries, authority Authority, reminderID, changeKind string, revision int64) (int64, error) {
	return appendChangedWithName(ctx, queries, authority, reminderID, changeKind, revision, "")
}

func appendChangedWithName(ctx context.Context, queries *store.Queries, authority Authority, reminderID, changeKind string, revision int64, name string) (int64, error) {
	payload := map[string]any{
		"kind": "routine.changed", "routine_id": reminderID,
		"change_kind": changeKind, "revision": revision,
	}
	if name != "" {
		payload["routine_name"] = name
	}
	return roomevent.Append(ctx, queries, roomevent.Input{
		TenantID: authority.TenantID, RoomID: authority.RoomID, EventType: "routine.changed",
		ActorID: authority.ActorID, ResourceID: reminderID,
		Payload: payload,
	})
}

// checkLimits bounds a Room's Routines when a write makes one count: a
// recurring Routine counts while it exists and a one-shot one until it fires,
// and at most maxPendingOncePerRoom one-shot Routines wait to fire.
func checkLimits(ctx context.Context, queries *store.Queries, authority Authority, before *store.RoomReminder, kind string, enabled bool) error {
	counts := func(kind string, enabled bool) bool { return kind != "once" || enabled }
	waits := func(kind string, enabled bool) bool { return kind == "once" && enabled }
	if counts(kind, enabled) && (before == nil || !counts(before.CadenceKind.String, before.Enabled)) {
		count, err := queries.CountRoomReminders(ctx, store.CountRoomRemindersParams{
			RoomID: authority.RoomID, TenantID: authority.TenantID,
		})
		if err != nil {
			return err
		}
		if count >= maxRemindersPerRoom {
			return ErrLimitReached
		}
	}
	if waits(kind, enabled) && (before == nil || !waits(before.CadenceKind.String, before.Enabled)) {
		pending, err := queries.CountEnabledOnceRoomReminders(ctx, store.CountEnabledOnceRoomRemindersParams{
			RoomID: authority.RoomID, TenantID: authority.TenantID,
		})
		if err != nil {
			return err
		}
		if pending >= maxPendingOncePerRoom {
			return ErrPendingOnceLimit
		}
	}
	return nil
}
