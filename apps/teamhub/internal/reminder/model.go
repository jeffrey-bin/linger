package reminder

import (
	"encoding/json"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

func reminderFromRecord(record store.RoomReminder) Reminder {
	value := Reminder{
		ID: record.ID, RoomID: record.RoomID, CreatedByActorID: record.CreatedByActorID,
		Name: record.Name, Instruction: record.Instruction, Cadence: cadenceFromRecord(record), Enabled: record.Enabled,
		Revision: record.Revision, CreatedAt: record.CreatedAt.Time, UpdatedAt: record.UpdatedAt.Time,
	}
	if record.MentionActorID.Valid {
		mention := record.MentionActorID.String
		value.MentionActorID = &mention
	}
	if record.NextRunAt.Valid {
		next := record.NextRunAt.Time.UTC()
		value.NextRunAt = &next
	}
	if len(record.Trigger) > 0 {
		value.Listener = listenerOf(record.Trigger)
	}
	if record.TrackingItemID.Valid {
		tracking := record.TrackingItemID.String
		value.TrackingItemID = &tracking
	}
	return value
}

func cadenceFromRecord(record store.RoomReminder) Cadence {
	cadence := Cadence{Kind: record.CadenceKind.String, Timezone: record.Timezone, Weekdays: record.Weekdays}
	if record.Hour.Valid {
		hour := int(record.Hour.Int32)
		cadence.Hour = &hour
	}
	if record.Minute.Valid {
		minute := int(record.Minute.Int32)
		cadence.Minute = &minute
	}
	if record.IntervalHours.Valid {
		hours := int(record.IntervalHours.Int32)
		cadence.IntervalHours = &hours
	}
	if record.RunAt.Valid {
		runAt := record.RunAt.Time.UTC()
		cadence.RunAt = &runAt
	}
	return cadence
}

func optionalText(value *string) pgtype.Text {
	if value == nil || *value == "" {
		return pgtype.Text{}
	}
	return pgtype.Text{String: *value, Valid: true}
}

func optionalInt4(value *int) pgtype.Int4 {
	if value == nil {
		return pgtype.Int4{}
	}
	return pgtype.Int4{Int32: int32(*value), Valid: true}
}

func optionalTimestamptz(value *time.Time) pgtype.Timestamptz {
	if value == nil {
		return pgtype.Timestamptz{}
	}
	return pgtype.Timestamptz{Time: value.UTC(), Valid: true}
}

func requiredTimestamptz(value time.Time) pgtype.Timestamptz {
	return pgtype.Timestamptz{Time: value.UTC(), Valid: true}
}

func routineTimezone(cadence Cadence) string {
	if cadence.Timezone == "" {
		return "UTC"
	}
	return cadence.Timezone
}

// listenerOf names the app of a listener Routine's trigger. The installer
// gives every listener one spec.
func listenerOf(trigger []byte) *Listener {
	var specs []ListenerSpec
	if json.Unmarshal(trigger, &specs) != nil || len(specs) == 0 {
		return nil
	}
	app := specs[0].Type
	if app == ListenerGCal {
		app = "google_calendar"
	}
	return &Listener{App: app}
}
