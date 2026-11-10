package composio

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestSlackProxyListsAndRendersDailyThreads(t *testing.T) {
	var mu sync.Mutex
	calls := []string{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request proxyRequest
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Fatal(err)
		}
		mu.Lock()
		calls = append(calls, request.Endpoint)
		mu.Unlock()
		data := "{}"
		switch request.Endpoint {
		case "/auth.test":
			data = `{"ok":true,"team_id":"T1","team":"Test Team","url":"https://test.slack.com/","user_id":"U0"}`
		case "/conversations.list":
			data = `{"ok":true,"channels":[{"id":"C0","name":"not-joined"},{"id":"C1","name":"public","is_member":true},{"id":"G1","name":"private","is_private":true,"is_member":true},{"id":"D1","is_im":true},{"id":"M1","is_mpim":true}],"response_metadata":{"next_cursor":"next"}}`
		case "/conversations.history":
			data = `{"ok":true,"messages":[{"type":"message","user":"U1","text":"hello <!channel>","ts":"1785916800.000100","reply_count":1,"edited":{"ts":"1785916900.0"},"files":[{"name":"spec.pdf","mimetype":"application/pdf","filetype":"pdf","permalink":"https://slack.test/file"}]},{"type":"message","subtype":"bot_message","bot_id":"B1","text":"","blocks":[{"type":"section","text":{"type":"mrkdwn","text":"block fallback"}}],"ts":"1785916900.000100"}]}`
		case "/conversations.replies":
			data = `{"ok":true,"messages":[{"user":"U1","text":"root","ts":"1785916800.000100"},{"user":"U2","text":"reply","ts":"1785916810.000100","thread_ts":"1785916800.000100"}]}`
		case "/users.info":
			data = `{"ok":false,"error":"temporarily_unavailable"}`
		default:
			t.Fatalf("unexpected endpoint %s", request.Endpoint)
		}
		encoded, _ := json.Marshal(data)
		_ = json.NewEncoder(w).Encode(proxyResponse{Status: 200, Data: encoded, Headers: map[string]string{}})
	}))
	defer server.Close()
	client, err := newTestClient(Config{BaseURL: server.URL, APIKey: "key", HTTPClient: server.Client(), RetryLimit: -1, MaxThreadBytes: 1 << 20, MaxBatchBytes: 2 << 20})
	if err != nil {
		t.Fatal(err)
	}
	identity, err := client.IdentifySlack(context.Background(), "ca")
	if err != nil {
		t.Fatal(err)
	}
	page, err := client.ListSlackConversations(context.Background(), "ca", "", 100)
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Conversations) != 2 || page.NextCursor != "next" || page.Conversations[1].Kind != "private_channel" {
		t.Fatalf("unexpected page: %+v", page)
	}
	var rateLimitedMethods []string
	documents, used, err := client.FetchSlackDocuments(context.Background(), "ca", identity, []SlackConversation{page.Conversations[0]}, SlackImportOptions{Days: 7, MaxMessagesPerConversation: 15, IncludeThreadReplies: true, MaxProviderCalls: 20, BeforeProviderCall: func(_ context.Context, method string) error {
		rateLimitedMethods = append(rateLimitedMethods, method)
		return nil
	}})
	if err != nil {
		t.Fatal(err)
	}
	if len(documents) != 1 || used != 4 {
		t.Fatalf("documents=%d calls=%d", len(documents), used)
	}
	if strings.Join(rateLimitedMethods, ",") != "conversations.history,conversations.replies,users.info,users.info" {
		t.Fatalf("rate limited methods=%v", rateLimitedMethods)
	}
	if documents[0].RemoteID != "slack:T1:C1:2026-08-05" {
		t.Fatalf("remote=%s", documents[0].RemoteID)
	}
	markdown := string(documents[0].Markdown)
	for _, value := range []string{"hello @channel", "reply", "block fallback", "Edited: true", "spec.pdf", "application/pdf", "https://slack.test/file", "Participant: U1", "Participant: U2"} {
		if !strings.Contains(markdown, value) {
			t.Fatalf("missing %q in %s", value, markdown)
		}
	}
	if strings.Contains(markdown, "download") {
		t.Fatalf("unexpected attachment download marker: %s", markdown)
	}
}

func TestSlackProxyReturnsOuterAndInnerRateLimits(t *testing.T) {
	for _, layer := range []string{"outer", "proxy", "slack"} {
		t.Run(layer, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				if layer == "proxy" {
					_ = json.NewEncoder(w).Encode(proxyResponse{Status: 429, Data: json.RawMessage(`{}`), Headers: map[string]string{"Retry-After": "61"}})
					return
				}
				if layer == "slack" {
					_ = json.NewEncoder(w).Encode(proxyResponse{Status: 200, Data: json.RawMessage(`{"ok":false,"error":"ratelimited"}`), Headers: map[string]string{"Retry-After": "61"}})
					return
				}
				w.Header().Set("Retry-After", "61")
				w.WriteHeader(http.StatusTooManyRequests)
			}))
			defer server.Close()
			client, err := newTestClient(Config{BaseURL: server.URL, APIKey: "key", HTTPClient: server.Client(), RetryLimit: -1, MaxRetryAfter: time.Minute})
			if err != nil {
				t.Fatal(err)
			}
			_, err = client.IdentifySlack(context.Background(), "ca")
			var limited *RateLimitError
			if !errors.As(err, &limited) || limited.Operation != "auth.test" || limited.RetryAfter != 61*time.Second {
				t.Fatalf("error=%v", err)
			}
		})
	}
}

func TestSlackProxyDoesNotSendWhenAttemptReservationFails(t *testing.T) {
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		requests++
	}))
	defer server.Close()
	client, err := newTestClient(Config{BaseURL: server.URL, APIKey: "key", HTTPClient: server.Client()})
	if err != nil {
		t.Fatal(err)
	}
	reservations := 0
	ctx := WithProviderAttemptReservation(context.Background(), func(context.Context) error {
		reservations++
		return ErrProviderCallBudgetExhausted
	})
	_, err = client.IdentifySlack(ctx, "ca")
	if !errors.Is(err, ErrProviderCallBudgetExhausted) {
		t.Fatalf("error=%v", err)
	}
	if reservations != 1 || requests != 0 {
		t.Fatalf("reservations=%d requests=%d", reservations, requests)
	}
}

func TestSlackHistoryPaginationUsesFifteenAndHonorsCancellation(t *testing.T) {
	var historyCalls int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request proxyRequest
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Fatal(err)
		}
		if request.Endpoint != "/conversations.history" {
			t.Fatalf("unexpected endpoint %s", request.Endpoint)
		}
		historyCalls++
		limit, cursor := "", ""
		for _, parameter := range request.Parameters {
			if parameter.Name == "limit" {
				limit = parameter.Value
			}
			if parameter.Name == "cursor" {
				cursor = parameter.Value
			}
		}
		if limit != "15" {
			t.Fatalf("history limit=%s", limit)
		}
		if historyCalls == 1 {
			data := json.RawMessage(`{"ok":true,"messages":[{"user":"U1","text":"first","ts":"1785916800.000100"}],"response_metadata":{"next_cursor":"page-2"}}`)
			_ = json.NewEncoder(w).Encode(proxyResponse{Status: 200, Data: data})
			return
		}
		if cursor != "page-2" {
			t.Fatalf("history cursor=%s", cursor)
		}
		data := json.RawMessage(`{"ok":true,"messages":[{"user":"U1","text":"second","ts":"1785916810.000100"}]}`)
		_ = json.NewEncoder(w).Encode(proxyResponse{Status: 200, Data: data})
	}))
	defer server.Close()
	client, err := newTestClient(Config{BaseURL: server.URL, APIKey: "key", HTTPClient: server.Client()})
	if err != nil {
		t.Fatal(err)
	}
	messages, calls, err := client.fetchSlackHistory(context.Background(), "ca", "C1", SlackImportOptions{Days: 7, MaxMessagesPerConversation: 30}, 2)
	if err != nil || calls != 2 || len(messages) != 2 {
		t.Fatalf("messages=%d calls=%d error=%v", len(messages), calls, err)
	}
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	_, _, err = client.fetchSlackHistory(cancelled, "ca", "C1", SlackImportOptions{Days: 7, MaxMessagesPerConversation: 15}, 1)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("cancel error=%v", err)
	}
}
