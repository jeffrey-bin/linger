package composio

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestMailImportCalendarMonths(t *testing.T) {
	for _, test := range []struct{ end, start string }{
		{"2026-10-29", "2026-04-29"},
		{"2026-08-31", "2026-02-28"},
		{"2024-08-31", "2024-02-29"},
		{"2026-01-31", "2025-07-31"},
	} {
		end, _ := time.Parse("2006-01-02", test.end)
		if got := MailImportStart(end).Format("2006-01-02"); got != test.start {
			t.Fatalf("start(%s)=%s, want %s", test.end, got, test.start)
		}
	}
}

func mailImportClient(t *testing.T, handler func(proxyRequest) any) *Client {
	t.Helper()
	var mu sync.Mutex
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		var request proxyRequest
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Error(err)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"status": 200, "data": handler(request)})
	}))
	t.Cleanup(server.Close)
	client, err := New(Config{APIKey: "test", EnvironmentKey: "test", BaseURL: server.URL, HTTPClient: server.Client()})
	if err != nil {
		t.Fatal(err)
	}
	client.SetConnectionAuthority(func(context.Context, string) (ConnectionBinding, error) {
		return ConnectionBinding{}, nil
	})
	return client
}

func TestGmailMailImportCountsMessagesAndKeepsWindowAcrossPages(t *testing.T) {
	end := time.Date(2026, 10, 29, 12, 0, 0, 0, time.UTC)
	start := MailImportStart(end)
	lists, bodies := 0, 0
	client := mailImportClient(t, func(request proxyRequest) any {
		params := map[string]string{}
		for _, p := range request.Parameters {
			params[p.Name] = fmt.Sprint(p.Value)
		}
		if request.Endpoint == "/gmail/v1/users/me/messages" {
			lists++
			want := fmt.Sprintf("after:%d before:%d -in:spam -in:trash -in:drafts {category:primary in:sent}", start.Unix(), end.Unix())
			if params["q"] != want || params["maxResults"] != "2" {
				t.Errorf("parameters=%v", params)
			}
			if lists == 1 {
				return map[string]any{"messages": []any{map[string]string{"id": "m1"}, map[string]string{"id": "m2"}}, "nextPageToken": "next"}
			}
			if params["pageToken"] != "next" {
				t.Errorf("cursor=%q", params["pageToken"])
			}
			return map[string]any{"messages": []any{map[string]string{"id": "old"}}}
		}
		bodies++
		id := strings.TrimPrefix(request.Endpoint, "/gmail/v1/users/me/messages/")
		date := end.Add(-time.Hour)
		if id == "old" {
			date = start.Add(-time.Second)
		}
		return map[string]any{"id": id, "threadId": "same-thread", "internalDate": strconv.FormatInt(date.UnixMilli(), 10), "labelIds": []string{"SENT"}, "payload": map[string]any{"mimeType": "text/plain", "body": map[string]string{"data": base64.RawURLEncoding.EncodeToString([]byte("A real authored message."))}}}
	})
	options := MailImportPageOptions{Start: start, End: end, Limit: 2}
	first, err := client.FetchMailImportPage(context.Background(), "account", "gmail", options)
	if err != nil {
		t.Fatal(err)
	}
	if first.Read != 2 || len(first.Documents) != 2 || first.Documents[0].RemoteID == first.Documents[1].RemoteID {
		t.Fatalf("page=%+v", first)
	}
	options.Cursor = first.NextCursor
	second, err := client.FetchMailImportPage(context.Background(), "account", "gmail", options)
	if err != nil {
		t.Fatal(err)
	}
	if second.Read != 1 || len(second.Documents) != 0 || second.NextCursor != "" || bodies != 3 {
		t.Fatalf("page=%+v bodies=%d", second, bodies)
	}
}

func TestOutlookMailImportReadsBodiesAndContinues(t *testing.T) {
	end := time.Date(2026, 10, 29, 12, 0, 0, 0, time.UTC)
	listCalls := 0
	client := mailImportClient(t, func(request proxyRequest) any {
		switch request.Endpoint {
		case "https://graph.microsoft.com/v1.0/me":
			return map[string]string{"id": "alice", "mail": "alice@example.test"}
		case "/v1.0/me/mailFolders/junkemail":
			return map[string]string{"id": "junk"}
		case "/v1.0/me/mailFolders/deleteditems":
			return map[string]string{"id": "trash"}
		case "/v1.0/me/messages":
			listCalls++
			params := map[string]string{}
			for _, p := range request.Parameters {
				params[p.Name] = fmt.Sprint(p.Value)
			}
			if listCalls == 1 && (!strings.Contains(params["$filter"], "2026-04-29T12:00:00Z") || params["$orderby"] != "receivedDateTime desc") {
				t.Errorf("params=%v", params)
			}
			if listCalls == 2 && params["$skip"] != "1" {
				t.Errorf("continuation=%v", params)
			}
			response := map[string]any{"value": []any{map[string]any{"id": fmt.Sprintf("m%d", listCalls), "conversationId": "conversation", "subject": "Meeting", "receivedDateTime": end.Add(-time.Hour).Format(time.RFC3339), "parentFolderId": "sent", "from": map[string]any{"emailAddress": map[string]string{"address": "alice@example.test"}}, "body": map[string]string{"contentType": "html", "content": "<style>.hidden{display:none}</style><p>Project update.</p>"}}}}
			if listCalls == 1 {
				response["@odata.nextLink"] = "https://graph.microsoft.com/v1.0/me/messages?$skip=1&$top=1"
			}
			return response
		default:
			t.Errorf("unexpected endpoint %s", request.Endpoint)
			return nil
		}
	})
	options := MailImportPageOptions{Start: MailImportStart(end), End: end, Limit: 1}
	for i := 0; i < 2; i++ {
		page, err := client.FetchMailImportPage(context.Background(), "account", "outlook", options)
		if err != nil {
			t.Fatal(err)
		}
		if page.Read != 1 || len(page.Documents) != 1 {
			t.Fatalf("page=%+v", page)
		}
		body := string(page.Documents[0].Markdown)
		if !strings.Contains(body, "Project update.") || !strings.Contains(body, "outlook") || strings.Contains(body, "display:none") || strings.Contains(body, "Gmail") {
			t.Fatalf("body=%s", body)
		}
		if len(page.Documents[0].ProfileMarkdown) == 0 {
			t.Fatal("sent mail lost Profile evidence")
		}
		options.Cursor = page.NextCursor
	}
	if options.Cursor != "" {
		t.Fatal("last page still has a cursor")
	}
}

func TestMailImportRejectsInvalidWindowsAndPageSizes(t *testing.T) {
	client := &Client{}
	end := time.Now()
	for _, options := range []MailImportPageOptions{{Start: end, End: end, Limit: 1}, {Start: end.Add(-time.Hour), End: end, Limit: 101}, {Start: end.Add(-time.Hour), End: end, Limit: 0}} {
		if _, err := client.FetchMailImportPage(context.Background(), "account", "gmail", options); err == nil {
			t.Fatal("invalid page was accepted")
		}
	}
}

func importMessage(id string, labels []string, headers map[string]string, body string) gmailMessage {
	message := gmailMessage{ID: id, ThreadID: "thread-" + id, InternalDate: "1790000000000", LabelIDs: labels}
	message.Payload.MimeType = "text/plain"
	message.Payload.Body.Data = base64.RawURLEncoding.EncodeToString([]byte(body))
	for name, value := range headers {
		message.Payload.Headers = append(message.Payload.Headers, struct {
			Name  string `json:"name"`
			Value string `json:"value"`
		}{name, value})
	}
	return message
}

func TestRenderImportedMailProfileViewMarksQuotesAndAutomatedMail(t *testing.T) {
	client := &Client{maxBodyBytes: 64 << 10, maxThreadBytes: 256 << 10}
	human := map[string]string{"Subject": "Budget review", "From": "Bob <bob@example.test>", "To": "alice@example.test"}
	document, err := client.renderImportedMail("gmail", importMessage("m1", []string{"INBOX"}, human, "Please send the numbers by Friday.\n\nOn Mon, Bob wrote:\n> Quoted history line"))
	if err != nil {
		t.Fatal(err)
	}
	profile, full := string(document.ProfileMarkdown), string(document.Markdown)
	for _, want := range []string{"# Budget review", "- From: Bob <bob@example.test>", "- To: alice@example.test", "Please send the numbers by Friday."} {
		if !strings.Contains(profile, want) {
			t.Fatalf("profile missing %q:\n%s", want, profile)
		}
	}
	authored := authoredProfileSections(profile)
	if !strings.Contains(profile, "## Written by the sender of this message") || strings.Contains(authored, "Quoted history line") ||
		!strings.Contains(profile, "Quoted history line") || !strings.Contains(full, "Quoted history line") || document.Automated {
		t.Fatalf("profile=%s\nmarkdown=%s", profile, full)
	}
	promotions := map[string]string{"Subject": "Sale", "From": "Shop <shop@example.test>"}
	listed := map[string]string{"Subject": "Weekly", "From": "News <news@example.test>", "List-Unsubscribe": "<mailto:u@example.test>"}
	for name, test := range map[string]struct {
		message gmailMessage
		body    string
	}{
		"promotions":       {importMessage("m2", []string{"INBOX", "CATEGORY_PROMOTIONS"}, promotions, "Buy now."), "Buy now."},
		"list-unsubscribe": {importMessage("m3", []string{"INBOX"}, listed, "This week."), "This week."},
	} {
		document, err := client.renderImportedMail("gmail", test.message)
		if err != nil {
			t.Fatal(err)
		}
		profile := string(document.ProfileMarkdown)
		if !document.Automated || !strings.Contains(profile, "- Kind: automated (marketing)") || authoredProfileSections(profile) != "" ||
			!strings.Contains(profile, test.body) || len(document.Markdown) == 0 {
			t.Fatalf("%s: profile=%q markdown=%q", name, document.ProfileMarkdown, document.Markdown)
		}
	}
	sent, err := client.renderImportedMail("gmail", importMessage("m4", []string{"SENT"}, map[string]string{"Subject": "Plan", "From": "Alice <alice@example.test>"}, "Here is my plan."))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(sent.ProfileMarkdown), "## Written by the subject in this message\n\nHere is my plan.") {
		t.Fatalf("sent profile=%s", sent.ProfileMarkdown)
	}
}

func gmailSkipTestClient(t *testing.T, end time.Time, ids []string, message func(id string, w http.ResponseWriter) bool) *Client {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request proxyRequest
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Error(err)
			return
		}
		if request.Endpoint == "/gmail/v1/users/me/messages" {
			messages := []any{}
			for _, id := range ids {
				messages = append(messages, map[string]string{"id": id})
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"status": 200, "data": map[string]any{"messages": messages}})
			return
		}
		id := strings.TrimPrefix(request.Endpoint, "/gmail/v1/users/me/messages/")
		if message(id, w) {
			return
		}
		data := map[string]any{"id": id, "threadId": id, "internalDate": strconv.FormatInt(end.Add(-time.Hour).UnixMilli(), 10), "labelIds": []string{"SENT"}, "payload": map[string]any{"mimeType": "text/plain", "body": map[string]string{"data": base64.RawURLEncoding.EncodeToString([]byte("Authored text."))}}}
		_ = json.NewEncoder(w).Encode(map[string]any{"status": 200, "data": data})
	}))
	t.Cleanup(server.Close)
	client, err := New(Config{APIKey: "test", EnvironmentKey: "test", BaseURL: server.URL, HTTPClient: server.Client()})
	if err != nil {
		t.Fatal(err)
	}
	client.SetConnectionAuthority(func(context.Context, string) (ConnectionBinding, error) {
		return ConnectionBinding{}, nil
	})
	return client
}

func TestGmailMailImportSkipsUnreadableMessages(t *testing.T) {
	end := time.Date(2026, 10, 29, 12, 0, 0, 0, time.UTC)
	client := gmailSkipTestClient(t, end, []string{"ok", "huge", "bad-date", "wrong-id"}, func(id string, w http.ResponseWriter) bool {
		switch id {
		case "huge":
			_, _ = w.Write([]byte(`{"status":200,"data":{"id":"huge","payload":{"body":{"data":"` + strings.Repeat("A", 4<<20) + `"}}}}`))
			return true
		case "bad-date":
			_ = json.NewEncoder(w).Encode(map[string]any{"status": 200, "data": map[string]any{"id": id, "internalDate": "not-a-number"}})
			return true
		case "wrong-id":
			_ = json.NewEncoder(w).Encode(map[string]any{"status": 200, "data": map[string]any{"id": "another", "internalDate": strconv.FormatInt(end.Add(-time.Hour).UnixMilli(), 10)}})
			return true
		}
		return false
	})
	client.maxThreadBytes, client.maxBodyBytes = 64<<10, 64<<10
	page, err := client.FetchMailImportPage(context.Background(), "account", "gmail", MailImportPageOptions{Start: MailImportStart(end), End: end, Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if page.Read != 4 || page.Skipped != 3 || len(page.Documents) != 1 || page.Documents[0].RemoteID != "message:ok" {
		t.Fatalf("page=%+v", page)
	}
}

func TestGmailMailImportFailsPageOnServerError(t *testing.T) {
	end := time.Date(2026, 10, 29, 12, 0, 0, 0, time.UTC)
	client := gmailSkipTestClient(t, end, []string{"ok", "broken"}, func(id string, w http.ResponseWriter) bool {
		if id == "broken" {
			_ = json.NewEncoder(w).Encode(map[string]any{"status": 500, "data": map[string]string{}})
			return true
		}
		return false
	})
	_, err := client.FetchMailImportPage(context.Background(), "account", "gmail", MailImportPageOptions{Start: MailImportStart(end), End: end, Limit: 10})
	if status, _ := ErrorStatus(err); status != http.StatusInternalServerError {
		t.Fatalf("a provider 500 was not returned as the page error: %v", err)
	}
}

func TestOutlookMailImportSkipsMalformedItems(t *testing.T) {
	end := time.Date(2026, 10, 29, 12, 0, 0, 0, time.UTC)
	item := func(id, received string) map[string]any {
		return map[string]any{"id": id, "subject": "Hi", "receivedDateTime": received, "parentFolderId": "inbox", "inferenceClassification": "focused", "from": map[string]any{"emailAddress": map[string]string{"address": "bob@example.test"}}, "body": map[string]string{"contentType": "text", "content": "Hello Alice."}}
	}
	client := mailImportClient(t, func(request proxyRequest) any {
		switch request.Endpoint {
		case "https://graph.microsoft.com/v1.0/me":
			return map[string]string{"id": "alice", "mail": "alice@example.test"}
		case "/v1.0/me/mailFolders/junkemail":
			return map[string]string{"id": "junk"}
		case "/v1.0/me/mailFolders/deleteditems":
			return map[string]string{"id": "trash"}
		}
		return map[string]any{"value": []any{item("good", end.Add(-time.Hour).Format(time.RFC3339)), item("bad", "yesterday"), item("", end.Add(-time.Hour).Format(time.RFC3339))}}
	})
	page, err := client.FetchMailImportPage(context.Background(), "account", "outlook", MailImportPageOptions{Start: MailImportStart(end), End: end, Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if page.Read != 3 || page.Skipped != 2 || len(page.Documents) != 1 || page.Documents[0].RemoteID != "message:good" {
		t.Fatalf("page=%+v", page)
	}
}
