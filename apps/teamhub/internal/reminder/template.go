package reminder

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/ids"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

// TemplateRoutine contains no live Room, Actor, schedule cursor, or run history.
type TemplateRoutine struct {
	Key           string  `json:"key"`
	Name          string  `json:"name"`
	Instruction   string  `json:"instruction"`
	Cadence       Cadence `json:"cadence"`
	Enabled       bool    `json:"enabled"`
	CreatedByRole string  `json:"created_by_role"`
	MentionRole   *string `json:"mention_role,omitempty"`
}

func ValidateTemplateRoutines(items []TemplateRoutine) error {
	if len(items) > maxRemindersPerRoom {
		return ErrLimitReached
	}
	seen := map[string]bool{}
	for _, item := range items {
		if strings.TrimSpace(item.Key) == "" || seen[item.Key] {
			return fmt.Errorf("%w: duplicate or empty template Routine key", ErrInvalid)
		}
		seen[item.Key] = true
		if _, err := normalizeName(item.Name); err != nil {
			return err
		}
		if _, err := normalizePrompt(item.Instruction); err != nil {
			return err
		}
		if _, err := validateCadence(item.Cadence); err != nil {
			return err
		}
		// A template installs standing schedules; a one-shot time would be stale.
		if item.Cadence.Kind == "once" {
			return fmt.Errorf("%w: template Routine cannot be one-shot", ErrInvalid)
		}
		if item.CreatedByRole != "human" && item.CreatedByRole != "agent" {
			return ErrInvalid
		}
		if item.MentionRole != nil && *item.MentionRole != "agent" {
			return ErrInvalid
		}
	}
	return nil
}

// SnapshotTemplateInTx reads the entire authorized source DM in one snapshot.
// A stale mention of a previous Builder must not become a new Agent mention.
// Only standing schedules are copied: a one-shot time, queued or done, would be
// stale, and a listener is bound to the source's own app connection.
func SnapshotTemplateInTx(ctx context.Context, queries *store.Queries, tenantID, roomID, agentID string) ([]TemplateRoutine, error) {
	records, err := queries.ListRoomReminders(ctx, store.ListRoomRemindersParams{TenantID: tenantID, RoomID: roomID, ListLimit: maxRemindersPerRoom + 1})
	if err != nil {
		return nil, err
	}
	items := make([]TemplateRoutine, 0, len(records))
	for _, record := range records {
		if !record.CadenceKind.Valid || record.CadenceKind.String == "once" {
			continue
		}
		value := reminderFromRecord(record)
		creator, err := queries.GetActor(ctx, store.GetActorParams{ID: record.CreatedByActorID, TenantID: tenantID})
		if err != nil {
			return nil, err
		}
		item := TemplateRoutine{Key: value.ID, Name: value.Name, Instruction: value.Instruction, Cadence: value.Cadence, Enabled: value.Enabled, CreatedByRole: creator.Kind}
		if value.MentionActorID != nil && *value.MentionActorID == agentID {
			role := "agent"
			item.MentionRole = &role
		}
		items = append(items, item)
	}
	return items, ValidateTemplateRoutines(items)
}

// InstallTemplateInTx participates in the Agent activation transaction. The
// caller serializes activation/deletion and owns completion replay protection.
func InstallTemplateInTx(ctx context.Context, tx pgx.Tx, queries *store.Queries, authority Authority, agentID string, items []TemplateRoutine) error {
	if err := ValidateTemplateRoutines(items); err != nil {
		return err
	}
	count, err := queries.CountRoomReminders(ctx, store.CountRoomRemindersParams{TenantID: authority.TenantID, RoomID: authority.RoomID})
	if err != nil {
		return err
	}
	if count+int64(len(items)) > maxRemindersPerRoom {
		return ErrLimitReached
	}
	now := time.Now().UTC()
	for _, item := range items {
		creatorID := authority.ActorID
		if item.CreatedByRole == "agent" {
			creatorID = agentID
		}
		var mention *string
		if item.MentionRole != nil {
			mention = &agentID
		}
		cadence, err := validateCadence(item.Cadence)
		if err != nil {
			return err
		}
		var next *time.Time
		if item.Enabled {
			value, err := nextRunAt(cadence, now)
			if err != nil {
				return err
			}
			next = &value
		}
		record, err := queries.CreateRoomReminder(ctx, store.CreateRoomReminderParams{
			ID: ids.New("routine"), TenantID: authority.TenantID, RoomID: authority.RoomID, CreatedByActorID: creatorID,
			TemplateAgentActorID: optionalText(&agentID), TemplateRoutineKey: optionalText(&item.Key),
			Name: item.Name, Instruction: item.Instruction, MentionActorID: optionalText(mention),
			CadenceKind: optionalText(&cadence.Kind), Timezone: cadence.Timezone, Hour: optionalInt4(cadence.Hour), Minute: optionalInt4(cadence.Minute),
			Weekdays: cadence.Weekdays, IntervalHours: optionalInt4(cadence.IntervalHours), Enabled: item.Enabled, NextRunAt: optionalTimestamptz(next),
		})
		if err != nil {
			return err
		}
		if next != nil {
			if err := enqueueFireTx(ctx, tx, record.ID, *next); err != nil {
				return err
			}
		}
		if _, err := appendChanged(ctx, queries, authority, record.ID, "created", record.Revision); err != nil {
			return err
		}
	}
	return nil
}

// PauseTemplateRoutinesInTx stops copies as soon as Agent deletion is reserved,
// including copies authored by a Human and copies with no mention.
// Update paused copies too: their revision fences concurrent enable requests
// that read the registration's old active state before deletion commits.
func PauseTemplateRoutinesInTx(ctx context.Context, queries *store.Queries, agentID, humanID string) error {
	records, err := queries.PauseAgentTemplateRoutines(ctx, optionalText(&agentID))
	if err != nil {
		return err
	}
	for _, record := range records {
		authority := Authority{TenantID: record.TenantID, RoomID: record.RoomID, ActorID: humanID}
		if _, err := appendChanged(ctx, queries, authority, record.ID, "updated", record.Revision); err != nil {
			return err
		}
	}
	return nil
}
