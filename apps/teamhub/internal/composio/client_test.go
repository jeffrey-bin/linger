package composio

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/emailevidence"
)

func TestClientCreateLinkSendsFixedCallbackURL(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v3.1/connected_accounts/link", func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if body["callback_url"] != "https://workspace.example.com/oauth/composio-complete" {
			t.Fatalf("unexpected link body: %#v", body)
		}
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"connected_account_id":"ca_1","redirect_url":"https://connect.example/link","expires_at":"2026-08-05T12:00:00Z"}`))
	})
	server := httptest.NewServer(mux)
	defer server.Close()

	client, err := newTestClient(Config{
		BaseURL: server.URL, APIKey: "restricted-key",
		CallbackURL: "https://workspace.example.com/oauth/composio-complete", HTTPClient: server.Client(),
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.CreateConnectionLink(context.Background(), "gmail-auth", "account_1"); err != nil {
		t.Fatal(err)
	}
}

func TestOAuthCallbackURLUsesPublicWebBase(t *testing.T) {
	if got := OAuthCallbackURL("https://workspace.example.com/"); got != "https://workspace.example.com/oauth/composio-complete" {
		t.Fatalf("callback URL=%q", got)
	}
}

func TestClientCreatesManagedAuthLinkAndMapsStatus(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v3.1/connected_accounts/link", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("x-api-key") != "restricted-key" {
			t.Fatalf("missing API key")
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if body["auth_config_id"] != "gmail-auth" || body["user_id"] != "co_workspace:test:account:account_1" {
			t.Fatalf("unexpected link body: %#v", body)
		}
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"connected_account_id":"ca_1","redirect_url":"https://connect.example/link","expires_at":"2026-08-05T12:00:00Z"}`))
	})
	mux.HandleFunc("/api/v3.1/connected_accounts/ca_1", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"id":"ca_1","status":"ACTIVE","toolkit":{"slug":"gmail"}}`))
	})
	server := httptest.NewServer(mux)
	defer server.Close()

	client, err := newTestClient(Config{BaseURL: server.URL, APIKey: "restricted-key", HTTPClient: server.Client()})
	if err != nil {
		t.Fatal(err)
	}
	link, err := client.CreateConnectionLink(context.Background(), "gmail-auth", "account_1")
	if err != nil {
		t.Fatal(err)
	}
	if link.ConnectedAccountID != "ca_1" || link.RedirectURL == "" || link.ExpiresAt.IsZero() {
		t.Fatalf("unexpected link: %+v", link)
	}
	status, err := client.GetConnectionStatus(context.Background(), "ca_1")
	if err != nil {
		t.Fatal(err)
	}
	if status != ConnectionActive {
		t.Fatalf("status=%q", status)
	}
}

func TestClientGetsAndExecutesVersionedToolsWithoutWriteRetry(t *testing.T) {
	var executeCalls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("x-api-key") != "restricted-key" {
			t.Fatal("missing API key")
		}
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/api/v3/tools/GMAIL_GET_PROFILE":
			if r.URL.Query().Get("version") != "20260721_00" {
				t.Fatalf("unexpected tool version: %s", r.URL.RawQuery)
			}
			_, _ = w.Write([]byte(`{"slug":"GMAIL_GET_PROFILE","name":"Get profile","description":"Read Gmail profile","version":"20260721_00","is_deprecated":false,"toolkit":{"slug":"gmail","name":"Gmail"},"input_parameters":{},"output_parameters":{}}`))
		case r.Method == http.MethodPost && r.URL.Path == "/api/v3.1/tools/execute/GMAIL_SEND_EMAIL":
			executeCalls.Add(1)
			var request map[string]any
			if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
				t.Fatal(err)
			}
			if request["connected_account_id"] != "ca_internal" || request["user_id"] != "co_workspace:test:account:account_1" || request["version"] != "20260721_00" {
				t.Fatalf("unexpected execute request: %#v", request)
			}
			w.Header().Set("Retry-After", "0")
			w.WriteHeader(http.StatusTooManyRequests)
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.String())
		}
	}))
	defer server.Close()
	client, err := newTestClient(Config{
		BaseURL: server.URL, APIKey: "restricted-key",
		HTTPClient: server.Client(), RetryLimit: 3,
	})
	if err != nil {
		t.Fatal(err)
	}
	tool, err := client.GetTool(context.Background(), "GMAIL_GET_PROFILE", "20260721_00")
	if err != nil || tool.Toolkit.Slug != "gmail" {
		t.Fatalf("tool=%+v error=%v", tool, err)
	}
	_, err = client.ExecuteTool(context.Background(), "ca_internal", client.UserIDForAccount("account_1"), "GMAIL_SEND_EMAIL", "20260721_00", map[string]any{"recipient_email": "test@example.com"})
	var rateLimit *RateLimitError
	if !errors.As(err, &rateLimit) || executeCalls.Load() != 1 {
		t.Fatalf("execute error=%v calls=%d", err, executeCalls.Load())
	}
}

func TestSyntheticGmailEvidenceFixtureProfileViewMarksAuthoredText(t *testing.T) {
	raw, err := os.ReadFile("testdata/synthetic_gmail_evidence.json")
	if err != nil {
		t.Fatal(err)
	}
	var threads []gmailThreadPayload
	if err = json.Unmarshal(raw, &threads); err != nil {
		t.Fatal(err)
	}
	client := &Client{maxBodyBytes: 64 << 10, maxThreadBytes: 256 << 10}
	var profile strings.Builder
	for _, thread := range threads {
		for _, message := range thread.Messages {
			// The import skips drafts before rendering.
			if gmailMessageDirectionValue(message) == "draft" {
				continue
			}
			document, renderErr := client.renderImportedMail("gmail", message)
			if renderErr != nil {
				t.Fatal(renderErr)
			}
			profile.Write(document.ProfileMarkdown)
		}
	}
	profileText := profile.String()
	for _, required := range []string{"Please review the sample checklist by Friday.", "I am Casey Example, an engineer building sample data tools.", "inbound (received by mailbox owner)", "outbound (sent by mailbox owner)"} {
		if !strings.Contains(profileText, required) {
			t.Fatalf("profile view missing %q: %s", required, profileText)
		}
	}
	if !strings.Contains(profileText, "- Kind: automated (") {
		t.Fatalf("automated mail is not marked: %s", profileText)
	}
	// Automated mail, quotes and signatures stay out of the sections that
	// carry someone's own words.
	authored := authoredProfileSections(profileText)
	for _, forbidden := range []string{"status.example.test", "samples.example.test", "product manager", "Best,", "Reviewer wrote:"} {
		if strings.Contains(authored, forbidden) {
			t.Fatalf("authored sections leaked %q: %s", forbidden, authored)
		}
	}
}

func TestGmailInsightEvidenceKeepsMessageLevelClassificationInputs(t *testing.T) {
	message := func(id, label, from, body string, headers map[string]string) gmailMessage {
		part := gmailPart{MimeType: "text/plain"}
		part.Headers = append(part.Headers, struct {
			Name  string `json:"name"`
			Value string `json:"value"`
		}{Name: "From", Value: from})
		for name, value := range headers {
			part.Headers = append(part.Headers, struct {
				Name  string `json:"name"`
				Value string `json:"value"`
			}{Name: name, Value: value})
		}
		part.Body.Data = base64.RawURLEncoding.EncodeToString([]byte(body))
		return gmailMessage{ID: id, ThreadID: "thread-1", LabelIDs: []string{label}, InternalDate: "1787587200000", Payload: part}
	}
	thread := gmailThreadPayload{ID: "thread-1", Messages: []gmailMessage{
		message("self", "SENT", "Owner <owner@example.test>", "I prefer written proposals.", nil),
		message("peer", "INBOX", "Peer <peer@example.test>", "You ask for concrete examples.", nil),
		message("digest", "INBOX", "Digest <digest@example.test>", "Weekly update", map[string]string{"List-Id": "weekly.example.test"}),
		message("promo", "CATEGORY_PROMOTIONS", "Sales <sales@example.test>", "Buy now", nil),
	}}

	raw, err := renderGmailInsightEvidence(thread, 256<<10, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	var inputs []emailevidence.MessageInput
	if err = json.Unmarshal(raw, &inputs); err != nil {
		t.Fatal(err)
	}
	for index := range inputs {
		inputs[index].DatasetID = "runtime-job-1"
	}
	classified, err := emailevidence.Classify(inputs)
	if err != nil {
		t.Fatal(err)
	}
	got := make([]emailevidence.MessageClass, 0, len(classified))
	for _, item := range classified {
		got = append(got, item.Class)
	}
	want := []emailevidence.MessageClass{
		emailevidence.MessageClassSelfSent,
		emailevidence.MessageClassDirectInbound,
		emailevidence.MessageClassSubscription,
		emailevidence.MessageClassMarketing,
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("classes=%v want=%v", got, want)
	}
	if inputs[1].SenderLocal != "peer" || inputs[0].ThreadID != "thread-1" {
		t.Fatalf("unexpected message evidence: %+v", inputs)
	}
}

func TestClientIdentifiesGmail(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request proxyRequest
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Fatal(err)
		}
		if request.Endpoint != "/gmail/v1/users/me/profile" {
			t.Fatalf("unexpected endpoint %s", request.Endpoint)
		}
		_ = json.NewEncoder(w).Encode(proxyResponse{Status: http.StatusOK, Data: json.RawMessage(`{"emailAddress":" Alice@Example.Test ","historyId":"200"}`)})
	}))
	defer server.Close()
	client, err := newTestClient(Config{BaseURL: server.URL, APIKey: "key", HTTPClient: server.Client()})
	if err != nil {
		t.Fatal(err)
	}
	identity, err := client.IdentifyGmail(context.Background(), "ca")
	if err != nil || identity.EmailAddress != "alice@example.test" || identity.HistoryID != "200" {
		t.Fatalf("identity=%+v error=%v", identity, err)
	}
}

func TestClientErrorsNeverExposeSecretsOrMailBodies(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
		_, _ = w.Write([]byte(`{"error":{"message":"restricted-key secret mail body"}}`))
	}))
	defer server.Close()
	client, err := newTestClient(Config{BaseURL: server.URL, APIKey: "restricted-key", HTTPClient: server.Client(), RetryLimit: 0})
	if err != nil {
		t.Fatal(err)
	}
	_, err = client.GetConnectionStatus(context.Background(), "ca_1")
	if err == nil || containsAll(err.Error(), "restricted-key") || containsAll(err.Error(), "mail body") {
		t.Fatalf("unsafe error: %v", err)
	}
}

func TestClientRevokesConnectedAccount(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodDelete || r.URL.Path != "/api/v3.1/connected_accounts/ca_1" || r.Header.Get("x-api-key") != "restricted-key" {
			t.Fatalf("unexpected revoke request: %s %s", r.Method, r.URL.Path)
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()
	client, err := newTestClient(Config{BaseURL: server.URL, APIKey: "restricted-key", HTTPClient: server.Client()})
	if err != nil {
		t.Fatal(err)
	}
	if err := client.RevokeConnection(context.Background(), "ca_1"); err != nil {
		t.Fatal(err)
	}
}

func TestIsAuthFailureClassifiesPermissionDenials(t *testing.T) {
	if !IsAuthFailure(RemoteStatusError("identify Gmail account", http.StatusForbidden)) {
		t.Fatal("403 should be an auth failure")
	}
	if !IsAuthFailure(RemoteStatusError("identify Gmail account", http.StatusUnauthorized)) {
		t.Fatal("401 should be an auth failure")
	}
	if IsAuthFailure(RemoteStatusError("identify Gmail account", http.StatusBadGateway)) {
		t.Fatal("502 should not be an auth failure")
	}
	if IsAuthFailure(errors.New("temporary identity failure")) {
		t.Fatal("generic errors should not be auth failures")
	}
}

func TestConnectionStatusMapping(t *testing.T) {
	tests := map[string]ConnectionStatus{
		"INITIALIZING": ConnectionPending, "INITIATED": ConnectionPending, "ACTIVE": ConnectionActive,
		"EXPIRED": ConnectionExpired, "FAILED": ConnectionFailed, "REVOKED": ConnectionFailed,
	}
	for input, want := range tests {
		if got := mapConnectionStatus(input, false); got != want {
			t.Fatalf("status %q=%q want=%q", input, got, want)
		}
	}
	if got := mapConnectionStatus("ACTIVE", true); got != ConnectionFailed {
		t.Fatalf("disabled active=%q", got)
	}
}

func TestRetryAfterDate(t *testing.T) {
	now := time.Date(2026, 8, 5, 0, 0, 0, 0, time.UTC)
	if got := parseRetryAfter(now, now.Add(2*time.Second).Format(http.TimeFormat), 10*time.Second); got != 2*time.Second {
		t.Fatalf("retry=%s", got)
	}
	if got := parseRetryAfter(now, "3600", 3*time.Second); got != 3*time.Second {
		t.Fatalf("numeric retry cap=%s", got)
	}
	if got := parseRetryAfter(now, now.Add(time.Hour).Format(http.TimeFormat), 4*time.Second); got != 4*time.Second {
		t.Fatalf("date retry cap=%s", got)
	}
}

func TestRetryWaitHonorsContextDeadline(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Retry-After", "3600")
		w.WriteHeader(http.StatusTooManyRequests)
	}))
	defer server.Close()
	client, err := newTestClient(Config{
		BaseURL: server.URL, APIKey: "restricted-key",
		HTTPClient: server.Client(), RetryLimit: 1, MaxRetryAfter: time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	started := time.Now()
	_, err = client.GetConnectionStatus(ctx, "ca_1")
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("error=%v", err)
	}
	if elapsed := time.Since(started); elapsed > 500*time.Millisecond {
		t.Fatalf("context cancellation took %s", elapsed)
	}
}

func containsAll(value string, needles ...string) bool {
	for _, needle := range needles {
		if !strings.Contains(value, needle) {
			return false
		}
	}
	return true
}

func TestGmailIdentityRetryAfterPreservedForDurableRetry(t *testing.T) {
	for _, envelope := range []bool{false, true} {
		t.Run(fmt.Sprint(envelope), func(t *testing.T) {
			var calls int
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				calls++
				if envelope {
					_, _ = fmt.Fprint(w, `{"status":429,"headers":{"retry-after":"3600"},"data":{}}`)
				} else {
					w.Header().Set("Retry-After", "3600")
					w.WriteHeader(http.StatusTooManyRequests)
				}
			}))
			defer server.Close()
			client, err := newTestClient(Config{BaseURL: server.URL, APIKey: "key", HTTPClient: server.Client()})
			if err != nil {
				t.Fatal(err)
			}
			ctx, _ := WithProviderAttemptBudget(context.Background(), 2)
			_, err = client.IdentifyGmail(ctx, "ca")
			var limited *RateLimitError
			if !errors.As(err, &limited) || limited.RetryAfter != time.Hour || calls != 1 {
				t.Fatalf("calls=%d error=%v limit=%+v", calls, err, limited)
			}
		})
	}
}

func TestRequestAuthorizationRechecksRetriesWithoutDisablingThem(t *testing.T) {
	for _, envelope := range []bool{false, true} {
		for _, revoked := range []bool{false, true} {
			t.Run(fmt.Sprintf("envelope=%t/revoked=%t", envelope, revoked), func(t *testing.T) {
				var calls atomic.Int32
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					if calls.Add(1) == 1 {
						if envelope {
							_, _ = fmt.Fprint(w, `{"status":429,"headers":{"retry-after":"0"},"data":{}}`)
						} else {
							w.Header().Set("Retry-After", "0")
							w.WriteHeader(http.StatusTooManyRequests)
						}
						return
					}
					_, _ = fmt.Fprint(w, `{"status":200,"data":{"emailAddress":"owner@example.com","historyId":"1"}}`)
				}))
				defer server.Close()
				client, err := New(Config{BaseURL: server.URL, APIKey: "test", EnvironmentKey: "test", HTTPClient: server.Client(), RetryLimit: 1, MaxRetryAfter: time.Millisecond})
				if err != nil {
					t.Fatal(err)
				}
				client.SetConnectionAuthority(func(context.Context, string) (ConnectionBinding, error) {
					return ConnectionBinding{UserID: client.UserIDForAccount("account_test"), ToolkitSlug: "gmail", AuthConfigID: "ac_test"}, nil
				})
				denied := errors.New("revoked")
				checks := 0
				ctx := WithRequestAuthorization(t.Context(), func(context.Context) error {
					checks++
					if revoked && calls.Load() > 0 {
						return denied
					}
					return nil
				})
				_, err = client.IdentifyGmail(ctx, "ca")
				if revoked {
					if !errors.Is(err, denied) || calls.Load() != 1 || checks != 2 {
						t.Fatalf("revoked retry calls=%d checks=%d err=%v", calls.Load(), checks, err)
					}
				} else if err != nil || calls.Load() != 2 || checks != 2 {
					t.Fatalf("authorized retry changed calls=%d checks=%d err=%v", calls.Load(), checks, err)
				}
			})
		}
	}
}

// authoredProfileSections returns the text of every "Written by" section of a
// Profile mail view, without the full-text sections.
func authoredProfileSections(profile string) string {
	var out strings.Builder
	keep := false
	for _, line := range strings.Split(profile, "\n") {
		switch {
		case strings.HasPrefix(line, "## Written by "):
			keep = true
		case strings.HasPrefix(line, "## ") || strings.HasPrefix(line, "# "):
			keep = false
		case keep:
			out.WriteString(line + "\n")
		}
	}
	return out.String()
}
