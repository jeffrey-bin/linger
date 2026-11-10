package composio

import (
	"context"
	"encoding/base64"
	"fmt"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"
)

// Live polling validation against real Composio connected accounts.
// Skipped unless COMPOSIO_API_KEY plus the per-source connection ids are set
// (the Gmail probe also needs COMPOSIO_LIVE_GMAIL_PROBE_TO, the connected address);
// see .env.local for the authorized test bindings.

func liveClient(t *testing.T) *Client {
	t.Helper()
	key := os.Getenv("COMPOSIO_API_KEY")
	if key == "" {
		t.Skip("COMPOSIO_API_KEY not set")
	}
	client, err := newTestClient(Config{APIKey: key})
	if err != nil {
		t.Fatalf("composio client: %v", err)
	}
	return client
}

func liveConn(t *testing.T, name string) string {
	t.Helper()
	id := os.Getenv(name)
	if id == "" {
		t.Skipf("%s not set", name)
	}
	return id
}

func TestLiveGmailPoll(t *testing.T) {
	client := liveClient(t)
	ca := liveConn(t, "LISTENER_TEST_GMAIL_CONNECTION")
	probeTo := liveConn(t, "COMPOSIO_LIVE_GMAIL_PROBE_TO")
	ctx := context.Background()

	historyID, err := client.BootstrapGmailHistoryID(ctx, ca)
	if err != nil {
		t.Fatalf("bootstrap historyId: %v", err)
	}
	if historyID == "" {
		t.Fatal("empty historyId")
	}
	t.Logf("historyId=%s", historyID)

	// Send a self-addressed probe so the incremental history read has a new
	// messageAdded entry to surface.
	probe := fmt.Sprintf("listener-probe-%d", time.Now().Unix())
	raw := base64.RawURLEncoding.EncodeToString([]byte(
		"To: " + probeTo + "\r\nSubject: " + probe + "\r\n\r\nprobe body"))
	var sent struct {
		ID string `json:"id"`
	}
	err = client.proxy(ctx, proxyRequest{
		ConnectedAccountID: ca, Endpoint: "/gmail/v1/users/me/messages/send",
		Method: http.MethodPost, Body: []byte(`{"raw":"` + raw + `"}`),
	}, &sent, "send gmail probe")
	if err != nil {
		t.Fatalf("send probe: %v", err)
	}
	t.Logf("sent probe %s subject=%q", sent.ID, probe)

	var msgs []GmailNewMessage
	next := historyID
	pageToken := ""
	deadline := time.Now().Add(60 * time.Second)
	for time.Now().Before(deadline) {
		page, histErr := client.ListGmailNewMessagesPage(ctx, ca, next, pageToken)
		msgs = page.Messages
		pageToken = page.NextPageToken
		if pageToken == "" {
			next = page.HistoryID
		}
		if histErr != nil {
			t.Fatalf("history list: %v", histErr)
		}
		for _, m := range msgs {
			if strings.Contains(m.Subject, probe) {
				t.Logf("probe surfaced: id=%s from=%q subject=%q", m.ID, m.From, m.Subject)
				return
			}
		}
		time.Sleep(3 * time.Second)
	}
	t.Fatalf("probe not surfaced in history within 60s (last next=%s, msgs=%d)", next, len(msgs))
}

func TestLiveSlackPoll(t *testing.T) {
	client := liveClient(t)
	ca := liveConn(t, "LISTENER_TEST_SLACK_CONNECTION")
	ctx := context.Background()

	identity, err := client.IdentifySlack(ctx, ca)
	if err != nil {
		t.Fatalf("identify: %v", err)
	}
	t.Logf("self=%s", identity.UserID)

	channels, err := client.ListSlackChannels(ctx, ca)
	if err != nil {
		t.Fatalf("channels: %v", err)
	}
	if len(channels) == 0 {
		t.Fatal("no channels visible")
	}
	target := channels[0]
	for _, ch := range channels {
		if ch.Name != "" { // a direct message has no name
			target = ch
			break
		}
	}
	t.Logf("channel=%s #%s", target.ID, target.Name)

	page, err := client.ListSlackChannelMessagesPage(ctx, ca, target.ID, "", "", 5)
	msgs := page.Messages
	if err != nil {
		t.Fatalf("history: %v", err)
	}
	t.Logf("latest messages=%d", len(msgs))
	if len(msgs) == 0 {
		return
	}
	// Incremental read after the newest ts must return nothing or only newer.
	afterPage, err := client.ListSlackChannelMessagesPage(ctx, ca, target.ID, msgs[0].Ts, "", 5)
	after := afterPage.Messages
	if err != nil {
		t.Fatalf("incremental: %v", err)
	}
	for _, m := range after {
		if m.Ts <= msgs[0].Ts {
			t.Fatalf("cursor regression: %s <= %s", m.Ts, msgs[0].Ts)
		}
	}
	t.Logf("incremental after cursor=%s -> %d messages", msgs[0].Ts, len(after))
}

func TestLiveOutlookPoll(t *testing.T) {
	client := liveClient(t)
	ca := liveConn(t, "LISTENER_TEST_OUTLOOK_CONNECTION")
	ctx := context.Background()

	link := ""
	for {
		_, next, delta, err := client.ListOutlookMessageDelta(ctx, ca, link)
		if err != nil {
			t.Fatalf("delta bootstrap: %v", err)
		}
		if delta != "" {
			link = delta
			break
		}
		link = next
	}

	msgs, nextLink, deltaLink, err := client.ListOutlookMessageDelta(ctx, ca, link)
	if err != nil {
		t.Fatalf("delta: %v", err)
	}
	t.Logf("delta page: messages=%d nextLink=%t deltaLink=%t", len(msgs), nextLink != "", deltaLink != "")
}

func TestLiveGoogleCalendarPoll(t *testing.T) {
	client := liveClient(t)
	ca := liveConn(t, "LISTENER_TEST_GCAL_CONNECTION")
	ctx := context.Background()

	// Create a probe event so the updatedMin read returns a real change.
	start := time.Now().UTC().Add(2 * time.Hour).Truncate(time.Minute)
	end := start.Add(15 * time.Minute)
	var created struct {
		ID      string `json:"id"`
		Updated string `json:"updated"`
	}
	body := `{"summary":"listener-poll-probe","start":{"dateTime":"` + start.Format(time.RFC3339) + `"},"end":{"dateTime":"` + end.Format(time.RFC3339) + `"}}`
	err := client.proxy(ctx, proxyRequest{
		ConnectedAccountID: ca, Endpoint: "/calendars/primary/events",
		Method: http.MethodPost, Body: []byte(body),
	}, &created, "create probe calendar event")
	if err != nil {
		t.Fatalf("create event: %v", err)
	}
	t.Logf("created event %s", created.ID)
	defer func() {
		var drop map[string]any
		_ = client.proxy(ctx, proxyRequest{
			ConnectedAccountID: ca, Endpoint: "/calendars/primary/events/" + created.ID,
			Method: http.MethodDelete,
		}, &drop, "delete probe calendar event")
	}()

	changes, next, err := client.ListGoogleCalendarChanges(ctx, ca, "primary", time.Now().UTC().Add(-time.Hour), "")
	if err != nil {
		t.Fatalf("changes: %v", err)
	}
	var found bool
	for _, ch := range changes {
		if ch.ID == created.ID {
			found = true
			t.Logf("probe change: status=%s updated=%s", ch.Status, ch.Updated)
		}
	}
	if !found {
		t.Fatalf("created event not in changes (n=%d next=%q)", len(changes), next)
	}
}
