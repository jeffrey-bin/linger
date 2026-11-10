package reminder

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/composio"
)

func pollTestProvider(t *testing.T, respond func(string, map[string]string) (int, any)) *composio.Client {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request struct {
			Endpoint   string                         `json:"endpoint"`
			Parameters []struct{ Name, Value string } `json:"parameters"`
		}
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Error(err)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		params := map[string]string{}
		for _, p := range request.Parameters {
			params[p.Name] = p.Value
		}
		status, data := respond(request.Endpoint, params)
		payload, err := json.Marshal(map[string]any{"status": status, "data": data, "headers": map[string]string{"retry-after": "125"}})
		if err != nil {
			t.Error(err)
			return
		}
		_, _ = w.Write(payload) // Bounded readers intentionally close oversized responses early.
	}))
	t.Cleanup(server.Close)
	client, err := composio.New(composio.Config{BaseURL: server.URL, APIKey: "synthetic", EnvironmentKey: "test", HTTPClient: server.Client()})
	if err != nil {
		t.Fatal(err)
	}
	client.SetConnectionAuthority(func(context.Context, string) (composio.ConnectionBinding, error) {
		return composio.ConnectionBinding{UserID: client.UserIDForAccount("account_test"), ToolkitSlug: "gmail", AuthConfigID: "ac_test"}, nil
	})
	return client
}

func persistedPollCursor(t *testing.T, cursor pollCursor) pollCursor {
	t.Helper()
	raw, err := cursor.encode()
	if err != nil {
		t.Fatal(err)
	}
	return decodePollCursor(raw)
}

func TestGmailPollResumesSixPagesAndSkipsMissingMessage(t *testing.T) {
	historyCalls := 0
	provider := pollTestProvider(t, func(endpoint string, p map[string]string) (int, any) {
		if endpoint == "/gmail/v1/users/me/history" {
			historyCalls++
			page := 1
			if p["pageToken"] != "" {
				page, _ = strconv.Atoi(p["pageToken"])
			}
			if p["startHistoryId"] != "100" || page != historyCalls {
				t.Errorf("history request %v call %d", p, historyCalls)
			}
			next := ""
			if page < 6 {
				next = strconv.Itoa(page + 1)
			}
			return 200, map[string]any{"historyId": "200", "nextPageToken": next, "history": []any{map[string]any{"messagesAdded": []any{
				map[string]any{"message": map[string]string{"id": fmt.Sprint(page)}},
				map[string]any{"message": map[string]string{"id": "deleted"}},
			}}}}
		}
		if endpoint == "/gmail/v1/users/me/messages/deleted" {
			return 404, map[string]any{}
		}
		return 200, map[string]any{"id": fmt.Sprint(historyCalls), "threadId": "thread", "labelIds": []string{"INBOX"}}
	})
	cursor := pollCursor{V: "100"}
	for i := 1; i <= 6; i++ {
		read, err := fetchGmail(context.Background(), provider, "ca", ListenerSpec{}, cursor)
		if err != nil || len(read.events) != 1 || read.events[0].MessageID != fmt.Sprint(i) {
			t.Fatalf("page %d: %+v %v", i, read, err)
		}
		cursor = persistedPollCursor(t, read.cursor)
		if i < 6 && (cursor.V != "100" || cursor.PageToken != fmt.Sprint(i+1) || read.nextPoll != time.Minute) {
			t.Fatalf("advanced before last page: %+v", read)
		}
	}
	if cursor.V != "200" || cursor.PageToken != "" || historyCalls != 6 {
		t.Fatalf("final cursor %+v, calls %d", cursor, historyCalls)
	}
}

func TestGmailPollKeepsHistoryOnFailedReadAndInvalidPage(t *testing.T) {
	for _, status := range []int{401, 403, 500, 400} {
		t.Run(strconv.Itoa(status), func(t *testing.T) {
			provider := pollTestProvider(t, func(_ string, _ map[string]string) (int, any) { return status, map[string]any{} })
			cursor := pollCursor{V: "100", PageToken: "page2"}
			read, err := fetchGmail(context.Background(), provider, "ca", ListenerSpec{}, cursor)
			if status == 400 {
				if err != nil || read.cursor.V != "100" || read.cursor.PageToken != "" {
					t.Fatalf("invalid continuation should replay committed history: %+v %v", read, err)
				}
			} else if err == nil {
				t.Fatal("failed provider read was accepted")
			}
			if cursor.V != "100" || cursor.PageToken != "page2" {
				t.Fatal("input cursor mutated on error")
			}
		})
	}
}

func TestSlackPollCommitsPagesAndRotatesChannelsAcrossRateLimit(t *testing.T) {
	historyCalls := 0
	provider := pollTestProvider(t, func(endpoint string, p map[string]string) (int, any) {
		switch endpoint {
		case "/auth.test":
			return 200, map[string]any{"ok": true, "team_id": "T", "user_id": "U"}
		case "/conversations.list":
			if p["cursor"] == "" {
				return 200, map[string]any{"ok": true, "channels": []any{map[string]string{"id": "A", "name": "first"}}, "response_metadata": map[string]string{"next_cursor": "second"}}
			}
			return 200, map[string]any{"ok": true, "channels": []any{map[string]string{"id": "B", "name": "second"}}}
		case "/conversations.history":
			historyCalls++
			if p["limit"] != "15" {
				t.Errorf("unexpected limit %v", p)
			}
			switch historyCalls {
			case 1:
				if p["channel"] != "A" || p["oldest"] != "10" || p["cursor"] != "" {
					t.Errorf("first page %v", p)
				}
				return 200, map[string]any{"ok": true, "messages": []any{map[string]string{"ts": "12", "user": "other", "text": "<@U> first"}}, "has_more": true, "response_metadata": map[string]string{"next_cursor": "A2"}}
			case 2:
				return 429, map[string]any{}
			case 3:
				if p["channel"] != "A" || p["oldest"] != "10" || p["cursor"] != "A2" {
					t.Errorf("resume page %v", p)
				}
				return 200, map[string]any{"ok": true, "messages": []any{map[string]string{"ts": "11", "user": "other", "text": "<@U> second"}}}
			case 4:
				if p["channel"] != "B" || p["oldest"] != "20" || p["cursor"] != "" {
					t.Errorf("next channel %v", p)
				}
				return 200, map[string]any{"ok": true, "messages": []any{map[string]string{"ts": "21", "user": "other", "text": "<@U> third"}}}
			}
		}
		t.Errorf("unexpected request %s %v", endpoint, p)
		return 500, map[string]any{}
	})
	spec := ListenerSpec{Channel: "*", PollIntervalSeconds: 600, Match: &ListenerMatch{Kind: "mention"}}
	cursor := pollCursor{Channels: map[string]string{"A": "10", "B": "20"}}
	first, err := fetchSlack(context.Background(), provider, "ca", spec, cursor)
	if err != nil || len(first.events) != 1 || !first.events[0].IsMention {
		t.Fatalf("first page %+v %v", first, err)
	}
	cursor = persistedPollCursor(t, first.cursor)
	if cursor.Channels["A"] != "10" || cursor.Slack.PageToken != "A2" {
		t.Fatalf("premature channel advance: %+v", cursor)
	}
	if _, err = fetchSlack(context.Background(), provider, "ca", spec, cursor); err == nil {
		t.Fatal("missing rate limit")
	} else {
		var limited *composio.RateLimitError
		if !errors.As(err, &limited) || pollFailureDelay(10*time.Minute, err) != 125*time.Second {
			t.Fatalf("retry lost provider delay: %v", err)
		}
	}
	cursor = persistedPollCursor(t, cursor)
	second, err := fetchSlack(context.Background(), provider, "ca", spec, cursor)
	if err != nil || len(second.events) != 1 || second.events[0].MessageID != "11" {
		t.Fatalf("second page %+v %v", second, err)
	}
	cursor = persistedPollCursor(t, second.cursor)
	if cursor.Channels["A"] != "12" || cursor.Slack.ChannelID != "B" || cursor.Slack.PageToken != "" {
		t.Fatalf("completed A %+v", cursor)
	}
	third, err := fetchSlack(context.Background(), provider, "ca", spec, cursor)
	if err != nil || len(third.events) != 1 || third.events[0].MessageID != "21" || third.cursor.Slack.ChannelID != "A" || historyCalls != 4 {
		t.Fatalf("next channel %+v calls=%d err=%v", third, historyCalls, err)
	}
}

func TestSlackDiscoveryPreservesMentionsWhileChannelsWait(t *testing.T) {
	historyCalls := 0
	boundary, mentionTS := "", ""
	provider := pollTestProvider(t, func(endpoint string, p map[string]string) (int, any) {
		switch endpoint {
		case "/auth.test":
			return http.StatusOK, map[string]any{"ok": true, "team_id": "T", "user_id": "U"}
		case "/conversations.list":
			return http.StatusOK, map[string]any{"ok": true, "channels": []any{map[string]string{"id": "A"}, map[string]string{"id": "B"}}}
		case "/conversations.history":
			historyCalls++
			if boundary == "" || p["oldest"] != boundary {
				t.Errorf("history must start at the persisted discovery boundary: %v", p)
			}
			messages := []any{}
			// Simulate Slack filtering an old message and the mention arriving in B
			// after discovery, while A still has its turn to poll.
			for _, ts := range []string{"1000000000.000000", mentionTS} {
				if p["channel"] == "B" && ts != "" && ts > p["oldest"] {
					messages = append(messages, map[string]string{"ts": ts, "text": "<@U> please review"})
				}
			}
			return http.StatusOK, map[string]any{"ok": true, "messages": messages}
		default:
			t.Errorf("unexpected request %s", endpoint)
			return http.StatusInternalServerError, nil
		}
	})
	spec := ListenerSpec{Channel: "*", PollIntervalSeconds: 600, Match: &ListenerMatch{Kind: "mention"}}
	read, err := fetchSlack(context.Background(), provider, "ca", spec, pollCursor{})
	if err != nil || historyCalls != 0 || len(read.events) != 0 || read.nextPoll != time.Minute {
		t.Fatalf("discovery must persist before history: %+v calls=%d err=%v", read, historyCalls, err)
	}
	cursor := persistedPollCursor(t, read.cursor)
	boundary = cursor.Channels["A"]
	if boundary == "" || cursor.Channels["B"] != boundary {
		t.Fatalf("channels did not share a discovery boundary: %+v", cursor)
	}
	mentionTS = fmt.Sprintf("%d.000000", time.Now().Unix()+1)
	read, err = fetchSlack(context.Background(), provider, "ca", spec, cursor)
	if err != nil || len(read.events) != 0 || read.cursor.Slack.ChannelID != "B" {
		t.Fatalf("first channel poll: %+v %v", read, err)
	}
	read, err = fetchSlack(context.Background(), provider, "ca", spec, persistedPollCursor(t, read.cursor))
	if err != nil || historyCalls != 2 || len(read.events) != 1 || read.events[0].MessageID != mentionTS || !read.events[0].IsMention {
		t.Fatalf("mention during rotation lost or history replayed: %+v calls=%d err=%v", read, historyCalls, err)
	}
}

func TestSlackDiscoveryKeepsExistingChannelContinuation(t *testing.T) {
	provider := pollTestProvider(t, func(endpoint string, _ map[string]string) (int, any) {
		if endpoint == "/auth.test" {
			return http.StatusOK, map[string]any{"ok": true, "team_id": "T", "user_id": "U"}
		}
		if endpoint == "/conversations.list" {
			return http.StatusOK, map[string]any{"ok": true, "channels": []any{map[string]string{"id": "A"}, map[string]string{"id": "B"}}}
		}
		t.Errorf("history must wait for discovery to persist: %s", endpoint)
		return http.StatusInternalServerError, nil
	})
	cursor := pollCursor{Channels: map[string]string{"A": "10"}, Slack: &slackPollCursor{ChannelID: "A", PageToken: "A2", Newest: "12"}}
	read, err := fetchSlack(context.Background(), provider, "ca", ListenerSpec{}, cursor)
	if err != nil {
		t.Fatal(err)
	}
	cursor = persistedPollCursor(t, read.cursor)
	if cursor.Channels["A"] != "10" || cursor.Channels["B"] == "" || cursor.Slack.ChannelID != "A" || cursor.Slack.PageToken != "A2" || cursor.Slack.Newest != "12" {
		t.Fatalf("discovery reset an existing checkpoint or page: %+v", cursor)
	}
}

func TestSlackEmptyChannelBootstrapsWithoutReplayingLaterMessages(t *testing.T) {
	calls := 0
	newTS := ""
	provider := pollTestProvider(t, func(endpoint string, p map[string]string) (int, any) {
		if endpoint == "/auth.test" {
			return http.StatusOK, map[string]any{"ok": true, "team_id": "T", "user_id": "U"}
		}
		if endpoint == "/conversations.list" {
			return http.StatusOK, map[string]any{"ok": true, "channels": []any{map[string]string{"id": "A", "name": "first"}}}
		}
		calls++
		messages := []any{}
		if calls > 1 && newTS > p["oldest"] {
			messages = append(messages, map[string]string{"ts": newTS, "text": "new message"})
		}
		return http.StatusOK, map[string]any{"ok": true, "messages": messages}
	})
	spec := ListenerSpec{Channel: "*", PollIntervalSeconds: 600}
	read, err := fetchSlack(context.Background(), provider, "ca", spec, pollCursor{})
	if err != nil || len(read.events) != 0 || !read.cursor.bootstrapped() || calls != 0 {
		t.Fatalf("bootstrap %+v %v", read, err)
	}
	boundary := read.cursor.Channels["A"]
	newTS = fmt.Sprintf("%d.000000", time.Now().Unix()+1)
	read, err = fetchSlack(context.Background(), provider, "ca", spec, persistedPollCursor(t, read.cursor))
	if err != nil || len(read.events) != 0 || read.cursor.Channels["A"] != boundary {
		t.Fatalf("empty poll lost boundary: %+v %v", read, err)
	}
	read, err = fetchSlack(context.Background(), provider, "ca", spec, persistedPollCursor(t, read.cursor))
	if err != nil || len(read.events) != 1 || read.events[0].MessageID != newTS || calls != 2 {
		t.Fatalf("new message dropped: %+v %v", read, err)
	}
}

func TestSlackExpiredPageReplaysTheCommittedChannelCheckpoint(t *testing.T) {
	historyCalls := 0
	provider := pollTestProvider(t, func(endpoint string, p map[string]string) (int, any) {
		switch endpoint {
		case "/auth.test":
			return 200, map[string]any{"ok": true, "team_id": "T", "user_id": "U"}
		case "/conversations.list":
			return 200, map[string]any{"ok": true, "channels": []any{map[string]string{"id": "A", "name": "first"}, map[string]string{"id": "B", "name": "second"}}}
		case "/conversations.history":
			historyCalls++
			if p["channel"] == "B" {
				if p["oldest"] != "20" || p["cursor"] != "" {
					t.Errorf("invalid next channel position: %v", p)
				}
				return 200, map[string]any{"ok": true, "messages": []any{map[string]string{"ts": "21", "text": "next channel"}}}
			}
			if p["oldest"] != "10" {
				t.Errorf("lost committed checkpoint: %v", p)
			}
			if historyCalls == 1 {
				if p["cursor"] != "expired" {
					t.Errorf("expected expired continuation: %v", p)
				}
				return 200, map[string]any{"ok": false, "error": "invalid_cursor"}
			}
			if p["cursor"] != "" {
				t.Errorf("reused expired continuation: %v", p)
			}
			return 200, map[string]any{"ok": true, "messages": []any{
				map[string]string{"ts": "12", "text": "previously delivered"},
				map[string]string{"ts": "11", "text": "not yet delivered"},
			}}
		}
		t.Errorf("unexpected endpoint %s", endpoint)
		return 500, nil
	})
	cursor := pollCursor{Channels: map[string]string{"A": "10", "B": "20"}, Slack: &slackPollCursor{ChannelID: "A", PageToken: "expired", Newest: "12"}}
	spec := ListenerSpec{Channel: "*", PollIntervalSeconds: 600}
	read, err := fetchSlack(context.Background(), provider, "ca", spec, cursor)
	if err != nil || len(read.events) != 0 || read.cursor.Channels["A"] != "10" || read.cursor.Slack.PageToken != "" || read.nextPoll != time.Minute {
		t.Fatalf("expired continuation must retain the committed checkpoint: %+v %v", read, err)
	}
	if cursor.Slack.PageToken != "expired" {
		t.Fatal("input cursor mutated before persistence")
	}
	read, err = fetchSlack(context.Background(), provider, "ca", spec, persistedPollCursor(t, read.cursor))
	if err != nil || len(read.events) != 2 || read.events[0].EventID != "A:12" || read.events[1].EventID != "A:11" || read.cursor.Channels["A"] != "12" || read.cursor.Slack.ChannelID != "B" || historyCalls != 2 {
		t.Fatalf("replay must preserve event identities for receipt deduplication: %+v %v", read, err)
	}
	read, err = fetchSlack(context.Background(), provider, "ca", spec, persistedPollCursor(t, read.cursor))
	if err != nil || len(read.events) != 1 || read.events[0].EventID != "B:21" || read.cursor.Slack.ChannelID != "A" || historyCalls != 3 {
		t.Fatalf("next channel stalled after cursor recovery: %+v %v", read, err)
	}
}

func TestGmailPollReadsBodyInsteadOfPreview(t *testing.T) {
	calls := 0
	body := strings.Repeat("Background information. ", 120) + "Payment failed. Update your card today or service stops."
	provider := pollTestProvider(t, func(endpoint string, p map[string]string) (int, any) {
		calls++
		if endpoint == "/gmail/v1/users/me/history" {
			return 200, map[string]any{"historyId": "200", "history": []any{map[string]any{"messagesAdded": []any{map[string]any{"message": map[string]string{"id": "m1"}}}}}}
		}
		if endpoint != "/gmail/v1/users/me/messages/m1" || p["format"] != "full" {
			t.Errorf("unexpected body request: %s %v", endpoint, p)
		}
		return 200, map[string]any{"id": "m1", "threadId": "t1", "snippet": "Account update", "payload": map[string]any{"mimeType": "text/plain", "body": map[string]string{"data": base64.RawURLEncoding.EncodeToString([]byte(body))}}}
	})
	read, err := fetchGmail(context.Background(), provider, "ca", ListenerSpec{}, pollCursor{V: "100"})
	if err != nil || len(read.events) != 1 || read.events[0].Snippet != body || calls != 2 || read.cursor.V != "200" {
		t.Fatalf("body lost or extra requests: events=%d calls=%d err=%v", len(read.events), calls, err)
	}
}

func TestOutlookPollHydratesNewMailAndPreservesCursorOnBodyFailure(t *testing.T) {
	for _, status := range []int{200, 404, 403, 500} {
		t.Run(strconv.Itoa(status), func(t *testing.T) {
			calls := 0
			provider := pollTestProvider(t, func(endpoint string, p map[string]string) (int, any) {
				if endpoint == "/v1.0/me/mailFolders/inbox/messages/delta" {
					return 200, map[string]any{"@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=new", "value": []any{
						map[string]string{"id": "old", "createdDateTime": "2026-10-27T00:00:00Z"},
						map[string]string{"id": "m1", "subject": "Account update", "bodyPreview": "unhelpful preview", "createdDateTime": "2026-10-29T01:00:00Z"},
					}}
				}
				calls++
				if endpoint != "/v1.0/me/messages/m1" || p["$select"] != "body" {
					t.Errorf("body requested for wrong mail: %s %v", endpoint, p)
				}
				return status, map[string]any{"body": map[string]string{"contentType": "html", "content": "<style>padding</style><div hidden>preview</div><p>Update your card today.</p>"}}
			})
			cursor := pollCursor{V: "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=old", Channels: map[string]string{"since": "2026-10-28T00:00:00Z"}}
			read, err := fetchOutlook(context.Background(), provider, "ca", ListenerSpec{}, cursor)
			if calls != 1 {
				t.Fatalf("body requests=%d", calls)
			}
			switch status {
			case 200:
				if err != nil || len(read.events) != 1 || read.events[0].Snippet != "Update your card today." || read.cursor.V == cursor.V {
					t.Fatalf("read=%+v err=%v", read, err)
				}
			case 404:
				if err != nil || len(read.events) != 0 || read.cursor.V == cursor.V {
					t.Fatalf("deleted mail was not skipped: %+v %v", read, err)
				}
			default:
				if err == nil || read.cursor.V != "" {
					t.Fatalf("body failure must not commit a new cursor: %+v %v", read, err)
				}
			}
		})
	}
}

func TestOversizedMailDoesNotBlockLaterMessages(t *testing.T) {
	for _, source := range []string{"gmail", "outlook"} {
		t.Run(source, func(t *testing.T) {
			metadataReads := 0
			provider := pollTestProvider(t, func(endpoint string, p map[string]string) (int, any) {
				switch endpoint {
				case "/gmail/v1/users/me/history":
					return 200, map[string]any{"historyId": "200", "history": []any{map[string]any{"messagesAdded": []any{
						map[string]any{"message": map[string]string{"id": "large"}}, map[string]any{"message": map[string]string{"id": "small"}},
					}}}}
				case "/v1.0/me/mailFolders/inbox/messages/delta":
					return 200, map[string]any{"@odata.deltaLink": "next", "value": []any{
						map[string]string{"id": "large", "subject": "Large notice", "createdDateTime": "2026-10-29T01:00:00Z"},
						map[string]string{"id": "small", "subject": "Reply today", "createdDateTime": "2026-10-29T01:00:00Z"},
					}}
				}
				large := strings.HasSuffix(endpoint, "/large")
				body := "Please reply today."
				if large {
					body = strings.Repeat("x", 3<<20)
				}
				if source == "outlook" {
					return 200, map[string]any{"body": map[string]string{"contentType": "html", "content": body}}
				}
				id := "small"
				if large {
					id = "large"
				}
				message := map[string]any{"id": id, "threadId": id, "labelIds": []string{"INBOX"}, "payload": map[string]any{"mimeType": "text/plain", "body": map[string]string{"data": base64.RawURLEncoding.EncodeToString([]byte(body))}}}
				if p["format"] == "metadata" {
					metadataReads++
					message["payload"] = map[string]any{"headers": []map[string]string{{"name": "Subject", "value": "Large notice"}}}
				}
				return 200, message
			})
			var read pollRead
			var err error
			if source == "gmail" {
				read, err = fetchGmail(context.Background(), provider, "ca", ListenerSpec{}, pollCursor{V: "100"})
			} else {
				read, err = fetchOutlook(context.Background(), provider, "ca", ListenerSpec{}, pollCursor{V: "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=old", Channels: map[string]string{"since": "2026-10-28T00:00:00Z"}})
			}
			if err != nil || len(read.events) != 2 {
				t.Fatalf("large mail stalled page: count=%d err=%v", len(read.events), err)
			}
			if !strings.Contains(read.events[0].Snippet, "exceeded the read limit") || read.events[1].Snippet != "Please reply today." {
				t.Fatal("missing body must be explicit while later mail stays readable")
			}
			if source == "gmail" && (metadataReads != 1 || read.cursor.V != "200" || read.events[0].Subject != "Large notice") {
				t.Fatal("Gmail must retain headers and advance history")
			}
			if source == "outlook" && read.cursor.V != "next" {
				t.Fatal("Outlook must advance delta")
			}
		})
	}
}
