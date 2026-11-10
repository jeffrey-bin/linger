package reminder

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/ids"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

// EventRouter takes a listener Routine's new events inside the poll
// transaction; a listener never wakes the mentioned Agent itself.
type EventRouter func(ctx context.Context, tx pgx.Tx, record store.RoomReminder, events []ListenerEvent) error

// routeListenerEventsTx records the routed events as delivered so a later poll
// never hands them over again.
func routeListenerEventsTx(ctx context.Context, tx pgx.Tx, queries *store.Queries, record store.RoomReminder, events []ListenerEvent, router EventRouter) error {
	if err := router(ctx, tx, record, events); err != nil {
		return err
	}
	for _, event := range events {
		if event.EventID == "" {
			continue
		}
		if _, err := queries.InsertRoutineEventDelivery(ctx, store.InsertRoutineEventDeliveryParams{
			RoutineID: record.ID, Source: event.Source, UpstreamEventID: event.EventID,
		}); err != nil {
			return err
		}
	}
	return nil
}

// InstallListenerInTx installs a listener Routine that an Agent owns under a
// template key and that mentions that Agent, in the caller's transaction.
func InstallListenerInTx(ctx context.Context, tx pgx.Tx, queries *store.Queries, authority Authority, agentID, key, name, instruction string, trigger json.RawMessage) error {
	specs, canonical, err := parseTriggerSpec(trigger)
	if err != nil {
		return err
	}
	// Lock the granted connections before inserting the Routine: the auto
	// reminders switch locks the connection and then inserts this template
	// Routine, so the reverse order deadlocks on the template-origin key.
	if err := lockListenerConnectionsTx(ctx, queries, authority.TenantID, agentID, specs); err != nil {
		return err
	}
	count, err := queries.CountRoomReminders(ctx, store.CountRoomRemindersParams{TenantID: authority.TenantID, RoomID: authority.RoomID})
	if err != nil {
		return err
	}
	if count >= maxRemindersPerRoom {
		return ErrLimitReached
	}
	record, err := queries.CreateRoomReminder(ctx, store.CreateRoomReminderParams{
		ID: ids.New("routine"), TenantID: authority.TenantID, RoomID: authority.RoomID, CreatedByActorID: agentID,
		TemplateAgentActorID: optionalText(&agentID), TemplateRoutineKey: optionalText(&key),
		Name: name, Instruction: instruction, MentionActorID: optionalText(&agentID),
		Timezone: "UTC", Enabled: true, TriggerSpec: canonical,
	})
	if err != nil {
		return err
	}
	if err := insertListenerBindingsTx(ctx, tx, queries, authority.TenantID, authority.RoomID, record.ID, agentID, specs); err != nil {
		return err
	}
	_, err = appendChanged(ctx, queries, authority, record.ID, "created", record.Revision)
	return err
}

// DeleteTemplateRoutinesTx deletes every Routine installed under one template
// key, with its listener bindings, in the caller's transaction. Each deletion
// is recorded in its Room as made by the Routine's creator.
func DeleteTemplateRoutinesTx(ctx context.Context, queries *store.Queries, key string) error {
	deleted, err := queries.DeleteTemplateRoomReminders(ctx, key)
	if err != nil {
		return err
	}
	for _, record := range deleted {
		if _, err := appendChanged(ctx, queries, Authority{
			TenantID: record.TenantID, RoomID: record.RoomID, ActorID: record.CreatedByActorID,
		}, record.ID, "deleted", record.Revision); err != nil {
			return err
		}
	}
	return nil
}

// lockListenerConnectionsTx verifies the Agent's grant for every connection
// the listener specs reference and share-locks it for the transaction.
func lockListenerConnectionsTx(ctx context.Context, queries *store.Queries, tenantID, agentActorID string, specs []ListenerSpec) error {
	for _, spec := range specs {
		if _, err := queries.LockGrantedConnectionForListener(ctx, store.LockGrantedConnectionForListenerParams{
			ConnectionID: spec.Account, AgentActorID: agentActorID, TenantID: tenantID,
		}); errors.Is(err, pgx.ErrNoRows) {
			return errors.Join(ErrForbidden, errors.New("no active grant for connection "+spec.Account))
		} else if err != nil {
			return err
		}
	}
	return nil
}

// insertListenerBindingsTx writes one polling binding row per listener spec
// inside the create transaction, after lockListenerConnectionsTx. The Routine
// starts polling immediately; the first poll bootstraps the cursor without
// replaying history.
func insertListenerBindingsTx(ctx context.Context, tx pgx.Tx, queries *store.Queries, tenantID, roomID, routineID, agentActorID string, specs []ListenerSpec) error {
	now := pgtype.Timestamptz{Time: time.Now().UTC(), Valid: true}
	for ordinal, spec := range specs {
		interval := spec.PollIntervalSeconds
		if interval <= 0 {
			interval = defaultPollIntervalSec
		}
		if _, err := queries.InsertRoomRoutineListener(ctx, store.InsertRoomRoutineListenerParams{
			ID: ids.New("lstr"), TenantID: tenantID, RoomID: roomID, RoutineID: routineID,
			Ordinal: int32(ordinal), Kind: spec.Type, ConnectionID: spec.Account, PollNextAt: now,
			PollIntervalSeconds: pgtype.Int4{Int32: int32(interval), Valid: true},
		}); err != nil {
			return err
		}
	}
	return nil
}

// resumeListenerBindingsTx nudges a paused listener Routine's bindings so the
// sweep picks them up on the next tick; pausing needs nothing since the sweep
// already skips disabled routines.
func resumeListenerBindingsTx(ctx context.Context, tx pgx.Tx, queries *store.Queries, tenantID, routineID string) error {
	return queries.ResumeRoomRoutineListeners(ctx, store.ResumeRoomRoutineListenersParams{
		RoutineID: routineID, TenantID: tenantID,
	})
}

// deleteInvalidListenersTx deletes the listener Routines whose connection is no
// longer active or no longer granted to the Agent they serve. The install sweep
// adds a new listener, from the current position, once the app is connected
// and granted again.
func deleteInvalidListenersTx(ctx context.Context, queries *store.Queries) error {
	invalid, err := queries.LockInvalidRoutineListeners(ctx)
	if err != nil || len(invalid) == 0 {
		return err
	}
	deleted, err := queries.DeleteRoomRemindersByID(ctx, invalid)
	if err != nil {
		return err
	}
	return recordDeletedTx(ctx, queries, deleted)
}

// recordDeletedTx records Routines deleted for their Room, not by a caller.
func recordDeletedTx(ctx context.Context, queries *store.Queries, deleted []store.RoomReminder) error {
	for _, record := range deleted {
		authority := Authority{TenantID: record.TenantID, RoomID: record.RoomID, ActorID: record.CreatedByActorID}
		if _, err := appendChanged(ctx, queries, authority, record.ID, "deleted", record.Revision); err != nil {
			return err
		}
	}
	return nil
}
