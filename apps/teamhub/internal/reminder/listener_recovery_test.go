package reminder

import (
	"encoding/base64"
	"fmt"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestGmailPollHydratesExternalTextButNotFileAttachments(t *testing.T) {
	for _, status := range []int{200, 404, 500} {
		t.Run(strconv.Itoa(status), func(t *testing.T) {
			bodyCalls := 0
			provider := pollTestProvider(t, func(endpoint string, p map[string]string) (int, any) {
				switch endpoint {
				case "/gmail/v1/users/me/history":
					return 200, map[string]any{"historyId": "200", "history": []any{map[string]any{"messagesAdded": []any{map[string]any{"message": map[string]string{"id": "m1"}}}}}}
				case "/gmail/v1/users/me/messages/m1":
					return 200, map[string]any{"id": "m1", "payload": map[string]any{"mimeType": "multipart/mixed", "parts": []any{
						map[string]any{"mimeType": "text/plain", "body": map[string]string{"attachmentId": "body"}},
						map[string]any{"mimeType": "text/plain", "filename": "private.txt", "body": map[string]string{"attachmentId": "file"}},
					}}}
				case "/gmail/v1/users/me/messages/m1/attachments/body":
					bodyCalls++
					return status, map[string]string{"data": base64.RawURLEncoding.EncodeToString([]byte("Please sign today."))}
				default:
					t.Errorf("unexpected attachment read %s", endpoint)
					return 500, nil
				}
			})
			read, err := fetchGmail(t.Context(), provider, "ca", ListenerSpec{}, pollCursor{V: "100"})
			if bodyCalls != 1 {
				t.Fatal("missing external text read")
			}
			if status == 500 {
				if err == nil || read.cursor.V != "" {
					t.Fatal("temporary failure advanced cursor")
				}
				return
			}
			if err != nil || read.cursor.V != "200" {
				t.Fatalf("read=%+v error=%v", read, err)
			}
			if status == 200 && (len(read.events) != 1 || read.events[0].Snippet != "Please sign today.") {
				t.Fatal("external body lost")
			}
			if status == 404 && (len(read.events) != 1 || !strings.Contains(read.events[0].Snippet, "body unavailable")) {
				t.Fatal("missing body part discarded the message")
			}
		})
	}
}

func TestOutlookBootstrapPersistsMoreThanTenPagesAndNewMail(t *testing.T) {
	calls, bodyCalls := 0, 0
	created := time.Now().Add(time.Minute).UTC().Format(time.RFC3339Nano)
	provider := pollTestProvider(t, func(endpoint string, p map[string]string) (int, any) {
		if endpoint == "/v1.0/me/messages/new" {
			bodyCalls++
			return 200, map[string]any{"body": map[string]string{"contentType": "text", "content": "Reply today"}}
		}
		calls++
		page := 1
		if p["$skiptoken"] != "" {
			page, _ = strconv.Atoi(p["$skiptoken"])
		}
		if page != calls || endpoint != "/v1.0/me/mailFolders/inbox/messages/delta" {
			t.Errorf("page %d call %d endpoint %s", page, calls, endpoint)
		}
		items := []any{map[string]string{"id": "old", "createdDateTime": "2000-01-01T00:00:00Z"}}
		if page == 6 {
			items = append(items, map[string]string{"id": "new", "createdDateTime": created})
		}
		wire := map[string]any{"value": items}
		if page < 12 {
			wire["@odata.nextLink"] = fmt.Sprintf("https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$skiptoken=%d", page+1)
		} else {
			wire["@odata.deltaLink"] = "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=done"
		}
		return 200, wire
	})
	first, err := fetchOutlook(t.Context(), provider, "ca", ListenerSpec{}, pollCursor{})
	if err != nil || calls != 0 {
		t.Fatal("observation boundary was not saved before remote reads")
	}
	cursor := persistedPollCursor(t, first.cursor)
	boundary := cursor.Channels["since"]
	for page := 1; page <= 12; page++ {
		read, err := fetchOutlook(t.Context(), provider, "ca", ListenerSpec{}, cursor)
		if err != nil {
			t.Fatal(err)
		}
		cursor = persistedPollCursor(t, read.cursor)
		if boundary == "" {
			boundary = cursor.Channels["since"]
		}
		if cursor.Channels["since"] != boundary {
			t.Fatal("bootstrap boundary moved")
		}
		if page < 12 && (cursor.V != "" || cursor.PageToken == "" || read.nextPoll != time.Minute) {
			t.Fatal("bootstrap lost continuation")
		}
		if page == 6 && (len(read.events) != 1 || read.events[0].Snippet != "Reply today") {
			t.Fatal("mail arriving during bootstrap lost")
		}
	}
	if calls != 12 || bodyCalls != 1 || cursor.PageToken != "" || !strings.Contains(cursor.V, "done") {
		t.Fatalf("cursor %+v calls %d body %d", cursor, calls, bodyCalls)
	}
}

func TestOutlookExpiredContinuationReplaysCheckpointThenResyncs(t *testing.T) {
	calls := 0
	provider := pollTestProvider(t, func(_ string, p map[string]string) (int, any) {
		calls++
		if calls <= 2 {
			return 410, map[string]any{}
		}
		if p["$select"] == "" {
			t.Fatal("expired delta did not restart initial sync")
		}
		return 200, map[string]any{"@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=new"}
	})
	cursor := pollCursor{V: "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=old", PageToken: "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$skiptoken=expired", Channels: map[string]string{"since": "2026-10-28T00:00:00Z"}}
	for round := 1; round <= 3; round++ {
		read, err := fetchOutlook(t.Context(), provider, "ca", ListenerSpec{}, cursor)
		if err != nil {
			t.Fatal(err)
		}
		cursor = persistedPollCursor(t, read.cursor)
		if cursor.Channels["since"] != "2026-10-28T00:00:00Z" {
			t.Fatal("resync lost original observation boundary")
		}
		if round == 1 && (cursor.V == "" || cursor.PageToken != "") {
			t.Fatal("checkpoint discarded with page")
		}
		if round == 2 && (cursor.V != "" || cursor.PageToken != "") {
			t.Fatal("expired checkpoint not reset")
		}
	}
	if !strings.Contains(cursor.V, "new") {
		t.Fatal("resync did not finish")
	}
}

func TestCalendarPollCommitsEveryPageWithoutSkippingUnorderedChanges(t *testing.T) {
	calls := 0
	provider := pollTestProvider(t, func(_ string, p map[string]string) (int, any) {
		calls++
		page := 1
		if p["pageToken"] != "" {
			page, _ = strconv.Atoi(p["pageToken"])
		}
		if p["updatedMin"] != "2026-10-28T00:00:00Z" || page != calls {
			t.Fatalf("checkpoint advanced early %v", p)
		}
		wire := map[string]any{"items": []any{map[string]any{"id": fmt.Sprint(page), "updated": fmt.Sprintf("2026-10-28T%02d:00:00Z", 10-page), "created": "2026-10-01T00:00:00Z", "summary": "Meeting", "description": "<style>noise</style><p>Bring the contract.</p>", "location": "Room 2", "organizer": map[string]string{"email": "host@example.com"}}}}
		if page < 6 {
			wire["nextPageToken"] = fmt.Sprint(page + 1)
		}
		return 200, wire
	})
	cursor := pollCursor{V: "2026-10-28T00:00:00Z"}
	for page := 1; page <= 6; page++ {
		read, err := fetchGCal(t.Context(), provider, "ca", ListenerSpec{}, cursor)
		if err != nil || len(read.events) != 1 {
			t.Fatalf("read %+v error %v", read, err)
		}
		if read.events[0].Description != "Bring the contract." || read.events[0].Location != "Room 2" || read.events[0].Organizer != "host@example.com" {
			t.Fatal("calendar evidence lost")
		}
		cursor = persistedPollCursor(t, read.cursor)
		if page < 6 && (cursor.V != "2026-10-28T00:00:00Z" || cursor.PageToken == "" || read.nextPoll != time.Minute) {
			t.Fatal("unfinished round advanced")
		}
	}
	if cursor.V != "2026-10-28T09:00:00Z" || cursor.PageToken != "" || cursor.Newest != "" {
		t.Fatalf("final cursor %+v", cursor)
	}
}

func TestCalendarContinuationFailureDoesNotSkipWindow(t *testing.T) {
	for _, status := range []int{400, 403, 500} {
		t.Run(strconv.Itoa(status), func(t *testing.T) {
			provider := pollTestProvider(t, func(_ string, _ map[string]string) (int, any) { return status, nil })
			cursor := pollCursor{V: "2026-10-28T00:00:00Z", PageToken: "page2", Newest: "2026-10-28T09:00:00Z"}
			read, err := fetchGCal(t.Context(), provider, "ca", ListenerSpec{}, cursor)
			if status == 400 {
				if err != nil || read.cursor.V != cursor.V || read.cursor.PageToken != "" || read.cursor.Newest != "" {
					t.Fatal("expired page lost checkpoint")
				}
			} else if err == nil {
				t.Fatal("provider failure accepted")
			}
		})
	}
}

func TestPendingPollEventsDoNotWaitForProvider(t *testing.T) {
	provider := pollTestProvider(t, func(_ string, _ map[string]string) (int, any) {
		t.Error("provider contacted with saved events pending")
		return 503, nil
	})
	for _, source := range []string{ListenerGmail, ListenerOutlook, ListenerGCal, ListenerSlack} {
		cursor := pollCursor{V: "checkpoint", PageToken: "next", Pending: []ListenerEvent{{Source: source, EventID: "saved"}}}
		read, err := fetchListenerPoll(t.Context(), provider, "ca", ListenerSpec{Type: source}, cursor)
		if err != nil || len(read.cursor.Pending) != 1 || len(read.events) != 0 || read.nextPoll != time.Minute || read.cursor.PageToken != "next" {
			t.Fatalf("pending lost for %s: %+v %v", source, read, err)
		}
	}
}

func TestCalendarMinimalCancellationStillReachesJudgement(t *testing.T) {
	provider := pollTestProvider(t, func(_ string, _ map[string]string) (int, any) {
		return 200, map[string]any{"items": []any{map[string]string{"id": "cancelled", "status": "cancelled"}}}
	})
	read, err := fetchGCal(t.Context(), provider, "ca", ListenerSpec{}, pollCursor{V: "2026-10-28T00:00:00Z"})
	if err != nil || len(read.events) != 1 || read.events[0].EventKind != "cancelled" || read.events[0].EventID != "cancelled:cancelled" {
		t.Fatalf("read %+v error %v", read, err)
	}
}

func TestSlackContentSubtypesReachMentionMatching(t *testing.T) {
	provider := pollTestProvider(t, func(endpoint string, _ map[string]string) (int, any) {
		switch endpoint {
		case "/auth.test":
			return 200, map[string]any{"ok": true, "team_id": "T", "user_id": "U"}
		case "/conversations.list":
			return 200, map[string]any{"ok": true, "channels": []any{map[string]string{"id": "C", "name": "team"}}}
		case "/conversations.history":
			return 200, map[string]any{"ok": true, "messages": []any{
				map[string]string{"ts": "11", "subtype": "file_share", "text": "<@U> Please review this proposal today."},
				map[string]string{"ts": "12", "subtype": "bot_message", "text": "<@U> Your build failed."},
				map[string]string{"ts": "13", "subtype": "channel_join", "text": "<@U> joined"},
			}}
		}
		return 500, nil
	})
	spec := ListenerSpec{Type: ListenerSlack, Channel: "*", Match: &ListenerMatch{Kind: "mention"}}
	read, err := fetchSlack(t.Context(), provider, "ca", spec, pollCursor{Channels: map[string]string{"C": "10"}})
	if err != nil || len(read.events) != 2 || !MatchEvent(spec, read.events[0]) || !MatchEvent(spec, read.events[1]) {
		t.Fatalf("content filtered: %+v %v", read, err)
	}
}

func TestGmailOversizedExternalPlainKeepsReadableHTML(t *testing.T) {
	for _, htmlBody := range []string{"", "<p>Reply by Friday.</p>"} {
		t.Run(fmt.Sprint(htmlBody != ""), func(t *testing.T) {
			provider := pollTestProvider(t, func(endpoint string, _ map[string]string) (int, any) {
				switch endpoint {
				case "/gmail/v1/users/me/history":
					return 200, map[string]any{"historyId": "200", "history": []any{map[string]any{"messagesAdded": []any{map[string]any{"message": map[string]string{"id": "m1"}}}}}}
				case "/gmail/v1/users/me/messages/m1":
					return 200, map[string]any{"id": "m1", "payload": map[string]any{"mimeType": "multipart/alternative", "parts": []any{
						map[string]any{"mimeType": "text/plain", "body": map[string]string{"attachmentId": "body"}},
						map[string]any{"mimeType": "text/html", "body": map[string]string{"data": base64.RawURLEncoding.EncodeToString([]byte(htmlBody))}},
					}}}
				case "/gmail/v1/users/me/messages/m1/attachments/body":
					return 200, map[string]string{"data": strings.Repeat("A", 4<<20)}
				default:
					t.Errorf("unexpected read %s", endpoint)
					return 500, nil
				}
			})
			read, err := fetchGmail(t.Context(), provider, "ca", ListenerSpec{}, pollCursor{V: "100"})
			if err != nil || len(read.events) != 1 || read.cursor.V != "200" {
				t.Fatalf("read %+v error %v", read, err)
			}
			body := read.events[0].Snippet
			if htmlBody == "" {
				if !strings.Contains(body, "body unavailable") {
					t.Fatal("missing body was not disclosed")
				}
			} else if !strings.Contains(body, "Reply by Friday.") || strings.Contains(body, "Only headers are available") {
				t.Fatalf("readable alternative hidden: %s", body)
			}
		})
	}
}
