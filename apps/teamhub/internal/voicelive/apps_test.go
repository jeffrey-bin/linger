package voicelive

import (
	"encoding/base64"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestGmailQueryIsTheConnectorCommandsSearch(t *testing.T) {
	for _, check := range []struct {
		query, folder string
		unread        bool
		want          string
	}{
		{"from:wang@acme.com", "", false, "(from:wang@acme.com) in:inbox"},
		{"", "sent", true, "in:sent is:unread"},
		{" quote ", "all", false, "(quote)"},
	} {
		if got := GmailQuery(check.query, check.folder, check.unread); got != check.want {
			t.Fatalf("%+v: %q", check, got)
		}
	}
}

func TestMailIsTrimmedToWhatIsSaid(t *testing.T) {
	gmail := map[string]any{
		"messageId": "m1", "threadId": "t1", "sender": "Director Wang <wang@acme.com>", "subject": "Quote",
		"messageTimestamp": "1793700000000", "labelIds": []any{"INBOX", "UNREAD"}, "preview": map[string]any{"body": "Get it to me by next Monday"},
		"payload": map[string]any{"headers": []any{map[string]any{"name": "To", "value": "me@acme.com"}}, "parts": []any{
			map[string]any{"mimeType": "text/html", "body": map[string]any{"data": base64.RawURLEncoding.EncodeToString([]byte("<p>See the <b>attachment</b></p>"))}},
			map[string]any{"mimeType": "text/plain", "body": map[string]any{"data": base64.RawURLEncoding.EncodeToString([]byte("See the attachment, reply by next Monday."))}},
		}},
	}
	summary := MailSummary("gmail", gmail)
	if summary["from"] != "Director Wang <wang@acme.com>" || summary["subject"] != "Quote" || summary["unread"] != true ||
		summary["snippet"] != "Get it to me by next Monday" || summary["received_at"] != time.UnixMilli(1793700000000).Local().Format("2006-01-02 15:04") {
		t.Fatalf("gmail summary=%v", summary)
	}
	message := MailMessage("gmail", gmail)
	if message["text"] != "See the attachment, reply by next Monday." || message["to"] != "me@acme.com" || message["snippet"] != nil {
		t.Fatalf("gmail message=%v", message)
	}
	// Only an HTML part is read as text.
	gmail["payload"] = map[string]any{"mimeType": "text/html", "body": map[string]any{"data": base64.RawURLEncoding.EncodeToString([]byte("<p>See the <b>attachment</b></p><p>Thanks &amp; best</p>"))}}
	if text := MailMessage("gmail", gmail)["text"]; text != "See the attachment\nThanks & best" {
		t.Fatalf("html text=%q", text)
	}
	outlook := map[string]any{
		"id": "o1", "conversationId": "c1", "subject": "Lunch", "receivedDateTime": "2026-11-03T09:00:00Z", "isRead": true,
		"from": map[string]any{"emailAddress": map[string]any{"name": "Lisa", "address": "lisa@acme.com"}}, "bodyPreview": "Friday?",
		"body":         map[string]any{"contentType": "html", "content": "<div>Friday at noon?</div>"},
		"toRecipients": []any{map[string]any{"emailAddress": map[string]any{"address": "me@acme.com"}}},
	}
	if got := MailMessage("outlook", outlook); got["from"] != "Lisa <lisa@acme.com>" || got["unread"] != false || got["text"] != "Friday at noon?" || got["to"] != "me@acme.com" {
		t.Fatalf("outlook message=%v", got)
	}
}

func TestSlackAndCalendarAreTrimmed(t *testing.T) {
	slack := SlackMessage(map[string]any{
		"ts": "1793700000.000100", "thread_ts": "1793699000.000100", "username": "lisa", "text": "Can the quote be ready today?",
		"channel": map[string]any{"id": "C1", "name": "sales"},
	}, "")
	if slack["channel_id"] != "C1" || slack["channel"] != "sales" || slack["author"] != "lisa" || slack["thread_ts"] != "1793699000.000100" {
		t.Fatalf("slack=%v", slack)
	}
	event := CalendarEvent(map[string]any{
		"id": "e1", "summary": "Weekly sync", "start": map[string]any{"dateTime": "2026-11-04T10:00:00+08:00"}, "end": map[string]any{"date": "2026-11-05"},
		"attendees": []any{map[string]any{"email": "me@acme.com", "self": true}, map[string]any{"displayName": "Ray Zhao"}},
	})
	want := time.Date(2026, 11, 4, 2, 0, 0, 0, time.UTC).Local().Format("2006-01-02 15:04")
	if event["title"] != "Weekly sync" || event["start"] != want || event["end"] != "2026-11-05" || event["attendees"] != "Ray Zhao" {
		t.Fatalf("event=%v", event)
	}
}

func TestFreeSlotsAreTheGapsBetweenBusyTimes(t *testing.T) {
	now := time.Date(2026, 11, 3, 20, 0, 0, 0, time.UTC)
	from, to, ok := AppTimeRange("2026-11-04T09:00:00Z", "2026-11-04T18:00:00Z", now)
	if !ok {
		t.Fatal("range rejected")
	}
	raw := map[string]any{"calendars": map[string]any{"primary": map[string]any{"busy": []any{
		map[string]any{"start": "2026-11-04T12:00:00Z", "end": "2026-11-04T13:00:00Z"},
		map[string]any{"start": "2026-11-04T09:00:00Z", "end": "2026-11-04T10:00:00Z"},
		map[string]any{"start": "2026-11-04T13:10:00Z", "end": "2026-11-04T17:40:00Z"},
	}}}}
	local := func(hour, minute int) string {
		return time.Date(2026, 11, 4, hour, minute, 0, 0, time.UTC).Local().Format("2006-01-02 15:04")
	}
	want := []map[string]string{{"from": local(10, 0), "to": local(12, 0)}}
	if got := FreeSlots(raw, "primary", from, to, 30); !reflect.DeepEqual(got, want) {
		t.Fatalf("free=%v", got)
	}
	// One local date means that whole day; reversed or overlong ranges are refused.
	day, next, ok := AppTimeRange("2026-11-04", "2026-11-04", now)
	if !ok || next.Sub(day) != 24*time.Hour {
		t.Fatalf("day=%v %v", day, next)
	}
	if _, _, ok := AppTimeRange("2026-11-05", "2026-11-04", now); ok {
		t.Fatal("reversed range accepted")
	}
	if _, _, ok := AppTimeRange("2026-01-01", "2026-06-01", now); ok {
		t.Fatal("overlong range accepted")
	}
}

func TestAppToolsAreReadsOrConfirmedWrites(t *testing.T) {
	for _, tool := range AppTools {
		if strings.TrimSpace(tool.Description) == "" {
			t.Fatalf("%s has no description", tool.Name)
		}
	}
	// Only the sends ask to be confirmed; they are the writes that leave.
	for _, tool := range AppTools {
		_, confirmable := tool.Parameters["properties"].(map[string]any)["confirmed"]
		if confirmable != (tool.Name == ToolSendEmailCanvas || tool.Name == ToolSendSlack) {
			t.Fatalf("%s confirmed=%v", tool.Name, confirmable)
		}
	}
}

func TestSlackInboxMergesDirectMessagesAndMentions(t *testing.T) {
	message := func(channel, ts, user, body string) map[string]any {
		return map[string]any{"channel": map[string]any{"id": channel, "name": channel}, "ts": ts, "user": user, "username": user, "text": body}
	}
	directs := []map[string]any{
		message("D1", "1700000100.000100", "U2", "You there?"),
		message("D1", "1700000300.000100", "U1", "my own reply"),
	}
	mentions := []map[string]any{
		message("C1", "1700000200.000100", "U3", "<@U1> take a look"),
		message("D1", "1700000100.000100", "U2", "You there?"),
	}
	got := SlackInbox(directs, mentions, "U1")
	if len(got) != 2 || got[0]["channel_id"] != "C1" || got[0]["kind"] != "mention" || got[1]["kind"] != "dm" || got[1]["author_id"] != "U2" {
		t.Fatalf("inbox=%v", got)
	}
}

func TestSlackSearchSinceIncludesTheDay(t *testing.T) {
	now := time.Date(2026, 11, 4, 15, 0, 0, 0, time.Local)
	if after, ok := SlackSearchSince("", now); !ok || after != "2026-11-02" {
		t.Fatalf("default after=%q", after)
	}
	if after, ok := SlackSearchSince("2026-11-01", now); !ok || after != "2026-10-31" {
		t.Fatalf("after=%q", after)
	}
	for _, since := range []string{"yesterday", "2026-11-05"} {
		if _, ok := SlackSearchSince(since, now); ok {
			t.Fatalf("%q accepted", since)
		}
	}
}
