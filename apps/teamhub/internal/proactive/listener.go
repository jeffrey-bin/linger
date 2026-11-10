package proactive

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"maps"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/reminder"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

// ListenerRoutineKey is the template key family of AnotherMe's app listeners:
// each connection gets one Routine keyed ListenerRoutineKey+":"+connection ID.
// Their new events are judged as proactive events instead of waking AnotherMe
// directly.
const ListenerRoutineKey = "anotherme_proactive_listener"

const (
	listenerPollSeconds = 600
	listenerInstruction = "New activity is first judged by proactive reminders (against your Tracking Items); only what is worth saying wakes you."
	maxRoutineNameRunes = 120
)

type listenerApp struct {
	name string
	spec reminder.ListenerSpec
}

// listenerApps maps each listenable provider to the listener AnotherMe gets on
// a connection of it.
var listenerApps = map[string]listenerApp{
	// Inbox only: mail the Human sends is not news to them.
	"gmail": {"Gmail inbox watch", reminder.ListenerSpec{Type: reminder.ListenerGmail, Match: &reminder.ListenerMatch{LabelID: "INBOX"}}},
	// The Outlook poller reads the inbox only.
	"outlook":         {"Outlook inbox watch", reminder.ListenerSpec{Type: reminder.ListenerOutlook}},
	"google_calendar": {"Google Calendar watch", reminder.ListenerSpec{Type: reminder.ListenerGCal, Events: []string{"created", "updated", "cancelled"}}},
	"slack":           {"Slack mention watch", reminder.ListenerSpec{Type: reminder.ListenerSlack, Channel: "*", Match: &reminder.ListenerMatch{Kind: "mention"}}},
}

// ListenerProviders lists the providers whose connections get a listener.
func ListenerProviders() []string {
	return slices.Sorted(maps.Keys(listenerApps))
}

// IsListenerProvider reports whether connections of provider get a listener.
func IsListenerProvider(provider string) bool {
	_, ok := listenerApps[provider]
	return ok
}

// SyncConnectionListenersTx applies a connection's auto reminders switch in
// the caller's transaction: off deletes its listener Routines, on installs the
// missing ones for every AnotherMe granted the connection.
func SyncConnectionListenersTx(ctx context.Context, tx pgx.Tx, queries *store.Queries, connectionID string, enabled bool) error {
	if !enabled {
		return reminder.DeleteTemplateRoutinesTx(ctx, queries, ListenerRoutineKey+":"+connectionID)
	}
	missing, err := queries.ListAnotherMeConnectionsWithoutListener(ctx, store.ListAnotherMeConnectionsWithoutListenerParams{
		Providers: ListenerProviders(), ConnectionID: pgtype.Text{String: connectionID, Valid: true},
		RoutineKeyPrefix: ListenerRoutineKey + ":",
	})
	if err != nil {
		return err
	}
	for _, row := range missing {
		if err := InstallListenerTx(ctx, tx, queries, row.TenantID, row.RoomID, row.RepresentedHumanActorID, row.AgentActorID, row.ConnectionID, row.Provider, row.IdentityLabel.String); err != nil {
			return err
		}
	}
	return nil
}

// SweepInstallListener installs the listener a sweep found missing, in its own
// transaction. Under the connection lock it skips a connection whose auto
// reminders were turned off since the sweep's read, and a listener the switch
// installed meanwhile counts as installed.
func SweepInstallListener(ctx context.Context, pool *pgxpool.Pool, row store.ListAnotherMeConnectionsWithoutListenerRow) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	queries := store.New(tx)
	enabled, err := queries.LockConnectionAutoReminders(ctx, row.ConnectionID)
	if errors.Is(err, pgx.ErrNoRows) || err == nil && !enabled {
		return nil
	}
	if err != nil {
		return err
	}
	err = InstallListenerTx(ctx, tx, queries, row.TenantID, row.RoomID, row.RepresentedHumanActorID, row.AgentActorID, row.ConnectionID, row.Provider, row.IdentityLabel.String)
	if err == nil {
		err = tx.Commit(ctx)
	}
	if isListenerAlreadyInstalled(err) {
		return nil
	}
	return err
}

// isListenerAlreadyInstalled reports a conflict on the Routine template origin:
// another transaction installed the same listener first.
func isListenerAlreadyInstalled(err error) bool {
	var postgresError *pgconn.PgError
	return errors.As(err, &postgresError) && postgresError.Code == "23505" && postgresError.ConstraintName == "room_reminders_template_origin_unique"
}

// InstallListenerTx installs the listener Routine of one connection the Human
// granted to their AnotherMe. In a Room at its Routine limit nothing is
// installed.
func InstallListenerTx(ctx context.Context, tx pgx.Tx, queries *store.Queries, tenantID, roomID, humanID, agentID, connectionID, provider, identityLabel string) error {
	app, ok := listenerApps[provider]
	if !ok {
		return nil
	}
	spec := app.spec
	spec.Account, spec.PollIntervalSeconds = connectionID, listenerPollSeconds
	trigger, err := json.Marshal([]reminder.ListenerSpec{spec})
	if err != nil {
		return err
	}
	name := app.name
	if label := strings.TrimSpace(identityLabel); label != "" {
		name += " (" + label + ")"
	}
	if utf8.RuneCountInString(name) > maxRoutineNameRunes {
		name = string([]rune(name)[:maxRoutineNameRunes])
	}
	err = reminder.InstallListenerInTx(ctx, tx, queries, reminder.Authority{
		TenantID: tenantID, RoomID: roomID, ActorID: humanID,
	}, agentID, ListenerRoutineKey+":"+connectionID, name, listenerInstruction, trigger)
	if errors.Is(err, reminder.ErrLimitReached) {
		return nil
	}
	return err
}

// RouteListenerEvents turns an app listener's new events into proactive events
// for the AnotherMe's own Human, in the poll transaction.
func RouteListenerEvents(ctx context.Context, tx pgx.Tx, record store.RoomReminder, events []reminder.ListenerEvent) error {
	humanID, err := store.New(tx).GetAnotherMeHuman(ctx, store.GetAnotherMeHumanParams{
		AgentActorID: record.MentionActorID.String, TenantID: record.TenantID,
	})
	if err != nil {
		return err
	}
	for _, listened := range events {
		if listened.Grant == nil {
			return errors.New("listener event missing grant")
		}
		event, ok := EventFromListener(listened)
		if !ok {
			continue
		}
		event.TenantID, event.OwnerActorID = record.TenantID, humanID
		if err := EnqueueEventTx(ctx, tx, event); err != nil {
			return err
		}
	}
	return nil
}

// EventFromListener names the matter a listened event is about. A mail thread, a
// calendar event, or a Slack thread is one matter; each new message or change
// in it is a new state. OccursAt is when the matter happens; a receive time is
// not one.
func EventFromListener(listened reminder.ListenerEvent) (Event, bool) {
	event := Event{Source: listened.Source, Grant: listened.Grant}
	switch listened.Source {
	case reminder.ListenerGmail, reminder.ListenerOutlook:
		event.Kind = "new_mail"
		event.ExternalID = firstNonEmpty(listened.ThreadID, listened.MessageID, listened.EventID)
		event.State = firstNonEmpty(listened.MessageID, listened.EventID)
		event.Summary = summaryLines([2]string{"From", listened.From}, [2]string{"To", listened.To}, [2]string{"Subject", listened.Subject}, [2]string{"Body", listened.Snippet})
	case reminder.ListenerGCal:
		event.Kind = "calendar_" + listened.EventKind
		event.ExternalID = firstNonEmpty(listened.MessageID, listened.EventID)
		event.Summary = summaryLines([2]string{"Event ID", listened.MessageID}, [2]string{"Status", listened.EventKind}, [2]string{"Event", listened.Summary}, [2]string{"Start", listened.Start}, [2]string{"End", listened.End}, [2]string{"Location", listened.Location}, [2]string{"Organizer", listened.Organizer}, [2]string{"Description", listened.Description})
		// Dedup the evidence, not only the start time or a provider timestamp:
		// place/instruction changes matter, an otherwise identical revision does not.
		digest := sha256.Sum256([]byte(event.Summary))
		event.State = hex.EncodeToString(digest[:])
		event.OccursAt = calendarTime(listened.Start)
	case reminder.ListenerSlack:
		event.Kind = "mention"
		event.ExternalID = listened.ChannelID + ":" + firstNonEmpty(listened.ThreadID, listened.MessageID)
		event.State = firstNonEmpty(listened.MessageID, listened.EventID)
		channel := ""
		if listened.Channel != "" {
			channel = "#" + listened.Channel
		}
		event.Summary = summaryLines([2]string{"Channel", channel}, [2]string{"Sender", listened.Sender}, [2]string{"Content", listened.Text})
	default:
		return Event{}, false
	}
	return event, event.ExternalID != "" && event.Summary != ""
}

// calendarTime reads a Google Calendar start: a time, or an all-day date in
// local time.
func calendarTime(value string) *time.Time {
	if at, err := time.Parse(time.RFC3339, value); err == nil {
		return &at
	}
	if at, err := time.ParseInLocation(time.DateOnly, value, time.Local); err == nil {
		return &at
	}
	return nil
}

func summaryLines(parts ...[2]string) string {
	var lines []string
	for _, part := range parts {
		if value := strings.TrimSpace(part[1]); value != "" {
			lines = append(lines, part[0]+": "+value)
		}
	}
	summary := strings.Join(lines, "\n")
	if utf8.RuneCountInString(summary) > maxEventSummaryRunes {
		const marker = "\n[Event truncated]"
		summary = string([]rune(summary)[:maxEventSummaryRunes-len(marker)]) + marker
	}
	return summary
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}
