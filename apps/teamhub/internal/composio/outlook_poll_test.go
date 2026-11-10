package composio

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestOutlookDeltaReadsHeadersAndKeepsProviderCursor(t *testing.T) {
	var selects []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request struct {
			Endpoint   string `json:"endpoint"`
			Parameters []struct {
				Name  string `json:"name"`
				Value string `json:"value"`
			} `json:"parameters"`
		}
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Fatal(err)
		}
		selected := ""
		for _, parameter := range request.Parameters {
			if parameter.Name == "$select" {
				selected = parameter.Value
			}
		}
		selects = append(selects, selected)
		_, _ = w.Write([]byte(`{"status":200,"headers":{},"data":{"value":[
			{"id":"o1","subject":"Your payment failed","bodyPreview":"Update your card within 3 days or your account will be suspended.",
			 "from":{"emailAddress":{"name":"AWS Billing","address":"no-reply@aws.amazon.com"}},
			 "toRecipients":[{"emailAddress":{"name":"Tony","address":"tony@example.com"}},{"emailAddress":{"name":"","address":"ops@example.com"}}],
			 "createdDateTime":"2026-10-26T08:00:00Z","receivedDateTime":"2026-10-26T08:00:00Z"},
			{"id":"o2","subject":"hi","from":{"emailAddress":{"name":"bob@example.com","address":"bob@example.com"}}}
		],"@odata.deltaLink":"https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=t1"}}`))
	}))
	defer server.Close()
	client, err := New(Config{BaseURL: server.URL, APIKey: "restricted-key", EnvironmentKey: "test", HTTPClient: server.Client()})
	if err != nil {
		t.Fatal(err)
	}
	client.SetConnectionAuthority(func(context.Context, string) (ConnectionBinding, error) {
		return ConnectionBinding{UserID: client.UserIDForAccount("account_1"), ToolkitSlug: "outlook", AuthConfigID: "ac_1"}, nil
	})
	messages, _, deltaLink, err := client.ListOutlookMessageDelta(context.Background(), "ca_1", "")
	if err != nil || deltaLink == "" || len(messages) != 2 {
		t.Fatalf("messages=%+v deltaLink=%q err=%v", messages, deltaLink, err)
	}
	mail := messages[0]
	if mail.From != "AWS Billing <no-reply@aws.amazon.com>" || mail.To != "Tony <tony@example.com>, ops@example.com" ||
		mail.Subject != "Your payment failed" {
		t.Fatalf("mail=%+v", mail)
	}
	if messages[1].From != "bob@example.com" {
		t.Fatalf("a sender named by its address must not repeat it: %+v", messages[1])
	}
	// The chain continues from the deltaLink, which carries the selection itself.
	if _, _, _, err := client.ListOutlookMessageDelta(context.Background(), "ca_1", deltaLink); err != nil {
		t.Fatal(err)
	}
	if len(selects) != 2 || selects[0] != outlookDeltaFields || selects[1] != "" {
		t.Fatalf("$select per request=%q", selects)
	}
}

func TestGraphPollContinuationKeepsOpaqueValuesAndRejectsOtherHosts(t *testing.T) {
	request, err := graphPollRequest("ca", "https://graph.microsoft.com/v1.0/teams/T/channels/C%2FD/messages?$skiptoken=a%2Bb%2Fc")
	if err != nil || request.Endpoint != "/v1.0/teams/T/channels/C%2FD/messages" || len(request.Parameters) != 1 || request.Parameters[0].Value != "a+b/c" {
		t.Fatalf("request=%+v error=%v", request, err)
	}
	if _, err := graphPollRequest("ca", "https://unrelated.example/v1.0/messages"); err == nil {
		t.Fatal("foreign continuation host accepted")
	}
}
