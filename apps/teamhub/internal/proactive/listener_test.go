package proactive

import (
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/reminder"
)

func TestListenerAppsHearOnlyWhatIsNewsToTheHuman(t *testing.T) {
	for _, check := range []struct {
		provider string
		event    reminder.ListenerEvent
		want     bool
	}{
		{"gmail", reminder.ListenerEvent{Source: "gmail", LabelIDs: []string{"INBOX", "UNREAD"}}, true},
		{"gmail", reminder.ListenerEvent{Source: "gmail", LabelIDs: []string{"SENT"}}, false},
		{"outlook", reminder.ListenerEvent{Source: "outlook"}, true},
		{"google_calendar", reminder.ListenerEvent{Source: "gcal", EventKind: "cancelled"}, true},
		{"slack", reminder.ListenerEvent{Source: "slack", EventKind: "message", IsMention: true}, true},
		{"slack", reminder.ListenerEvent{Source: "slack", EventKind: "message"}, false},
	} {
		if got := reminder.MatchEvent(listenerApps[check.provider].spec, check.event); got != check.want {
			t.Errorf("%s listener heard %+v: %v, want %v", check.provider, check.event, got, check.want)
		}
	}
}

func TestListenerEventNamesOneMatterPerThreadOrCalendarEvent(t *testing.T) {
	mail, ok := EventFromListener(reminder.ListenerEvent{Source: "gmail", EventID: "m2", MessageID: "m2", ThreadID: "t1", From: "lisa@example.com", To: "owner@example.com", Subject: "Quote confirmation"})
	if !ok || mail.ExternalID != "t1" || mail.State != "m2" || mail.Kind != "new_mail" || mail.Summary != "From: lisa@example.com\nTo: owner@example.com\nSubject: Quote confirmation" {
		t.Fatalf("mail=%+v ok=%v", mail, ok)
	}
	outlook, ok := EventFromListener(reminder.ListenerEvent{Source: "outlook", EventID: "o1", MessageID: "o1", From: "Director Wang <wang@partner.cn>", Subject: "Contract", Snippet: "Confirm by Thursday"})
	if !ok || outlook.ExternalID != "o1" || outlook.Source != "outlook" || outlook.Summary != "From: Director Wang <wang@partner.cn>\nSubject: Contract\nBody: Confirm by Thursday" {
		t.Fatalf("outlook=%+v ok=%v", outlook, ok)
	}

	moved := reminder.ListenerEvent{Source: "gcal", EventID: "e1:2026-10-22T01:00:00Z", MessageID: "e1", EventKind: "updated", Summary: "Review meeting", Start: "2026-10-23T10:00:00+08:00", End: "2026-10-23T11:00:00+08:00"}
	event, ok := EventFromListener(moved)
	if !ok || event.ExternalID != "e1" || event.Kind != "calendar_updated" || event.OccursAt == nil || !event.OccursAt.Equal(time.Date(2026, 10, 23, 2, 0, 0, 0, time.UTC)) {
		t.Fatalf("calendar=%+v ok=%v", event, ok)
	}
	// A location or description edit at the same time must be judged again.
	edited := moved
	edited.EventID = "e1:2026-10-22T02:00:00Z"
	if again, _ := EventFromListener(edited); again.State != event.State {
		t.Fatal("unchanged content must not be new news just because its revision changed")
	}
	edited.Location = "New room"
	edited.Description = "Bring the revised contract"
	if again, _ := EventFromListener(edited); again.State == event.State || !strings.Contains(again.Summary, "New room") || !strings.Contains(again.Summary, "Bring the revised contract") {
		t.Fatalf("an important edit at the same start time was lost: %q -> %q", event.State, again.State)
	}
	cancelled := moved
	cancelled.EventKind = "cancelled"
	if gone, _ := EventFromListener(cancelled); gone.State == event.State {
		t.Fatal("a cancellation must be judged again")
	}
	allDay, _ := EventFromListener(reminder.ListenerEvent{Source: "gcal", MessageID: "e2", EventKind: "created", Summary: "Team offsite", Start: "2026-10-24"})
	if allDay.OccursAt == nil || !allDay.OccursAt.Equal(time.Date(2026, 10, 23, 16, 0, 0, 0, time.UTC)) {
		t.Fatalf("all-day start=%v, want Beijing midnight", allDay.OccursAt)
	}

	reply, ok := EventFromListener(reminder.ListenerEvent{Source: "slack", EventID: "C1:2.0", ChannelID: "C1", Channel: "sales", MessageID: "2.0", ThreadID: "1.0", Sender: "U2", Text: "<@U1> can the quote go out today?"})
	if !ok || reply.ExternalID != "C1:1.0" || reply.State != "2.0" || !strings.Contains(reply.Summary, "Channel: #sales") {
		t.Fatalf("slack=%+v ok=%v", reply, ok)
	}

	if _, ok := EventFromListener(reminder.ListenerEvent{Source: "gmail", MessageID: "m3"}); ok {
		t.Fatal("a mail with nothing to say must be dropped")
	}
	if _, ok := EventFromListener(reminder.ListenerEvent{Source: "teams", MessageID: "x", Text: "hi"}); ok {
		t.Fatal("a source without a listener app must be dropped")
	}
}

func TestMailEventRetainsFactsBeyondProviderPreviewAndOldSummaryLimit(t *testing.T) {
	body := strings.Repeat("Background", 400) + "Please update the payment method today, or the service will stop."
	event, ok := EventFromListener(reminder.ListenerEvent{Source: "gmail", MessageID: "m1", Subject: "Account update", Snippet: body})
	if !ok || !strings.HasSuffix(event.Summary, "Please update the payment method today, or the service will stop.") || !strings.Contains(event.Summary, "Body: ") {
		t.Fatal("mail body was cut before the action and deadline")
	}
	event, ok = EventFromListener(reminder.ListenerEvent{Source: "gmail", MessageID: "m2", Subject: strings.Repeat("€", maxEventSummaryRunes), Snippet: "body"})
	if !ok || !strings.HasSuffix(event.Summary, "[Event truncated]") || len([]rune(event.Summary)) > maxEventSummaryRunes {
		t.Fatal("oversized event must remain bounded and explicit")
	}
}

func TestSparseCalendarCancellationStillHasJudgeEvidence(t *testing.T) {
	event, ok := EventFromListener(reminder.ListenerEvent{Source: "gcal", EventID: "cancelled:cancelled", MessageID: "cancelled", EventKind: "cancelled"})
	if !ok || !strings.Contains(event.Summary, "Status: cancelled") || !strings.Contains(event.Summary, "Event ID: cancelled") {
		t.Fatal("sparse cancellation lost before judgment")
	}
}

func TestOnlyATemplateOriginConflictMeansTheListenerIsInstalled(t *testing.T) {
	for _, check := range []struct {
		err  error
		want bool
	}{
		{fmt.Errorf("install: %w", &pgconn.PgError{Code: "23505", ConstraintName: "room_reminders_template_origin_unique"}), true},
		{&pgconn.PgError{Code: "23505", ConstraintName: "room_reminders_pkey"}, false},
		{&pgconn.PgError{Code: "40P01"}, false},
		{errors.New("boom"), false},
		{nil, false},
	} {
		if got := isListenerAlreadyInstalled(check.err); got != check.want {
			t.Errorf("isListenerAlreadyInstalled(%v)=%v, want %v", check.err, got, check.want)
		}
	}
}
