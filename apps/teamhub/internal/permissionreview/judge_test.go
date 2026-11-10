package permissionreview

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/roomagent"
)

// fakeModelCall stands in for the Agent Service model call. A 200 answers with
// output as the judged object; any other status answers with an error body.
func fakeModelCall(t *testing.T, status int, output string, inspect func([]byte)) Client {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/model-calls" || r.Header.Get("Authorization") != "Bearer key" {
			http.Error(w, "unexpected request", http.StatusBadRequest)
			return
		}
		body, err := io.ReadAll(r.Body)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if inspect != nil {
			inspect(body)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		if status != http.StatusOK {
			_, _ = w.Write([]byte(`{"error":{"code":"MODEL_UNAVAILABLE","message":"no candidate answered","request_id":"r"}}`))
			return
		}
		_, _ = w.Write([]byte(`{"model":"judge-model","output":` + output + `}`))
	}))
	t.Cleanup(server.Close)
	models, err := roomagent.NewModelCallClient(server.URL, "key")
	if err != nil {
		t.Fatal(err)
	}
	return Client{Models: models, Timeout: 45 * time.Second}
}

// lowAllow is a complete, valid model answer allowing a low-risk read.
const lowAllow = `{"risk_level":"low","user_authorization":"unknown","decision":"allow","rationale":"read"}`

func TestJudgeSendsTheOwnerAndStrictSchemaAndValidates(t *testing.T) {
	t.Parallel()
	var sent []byte
	client := fakeModelCall(t, http.StatusOK, `{"risk_level":"high","user_authorization":"high","decision":"allow","rationale":"sponsor asked"}`, func(body []byte) { sent = body })
	request := sampleRequest()
	request.Owner = roomagent.ModelCallOwner{TenantID: "tenant_1", OwnerActorID: "actor_sponsor"}
	request.ContextKey = "agent_1:room_1"
	request.RunOperationID = "operation_1"
	verdict, err := client.Judge(context.Background(), request)
	if err != nil {
		t.Fatalf("Judge: %v", err)
	}
	if verdict.Decision != DecisionAllow || verdict.RiskLevel != RiskHigh || verdict.Rationale != "sponsor asked" {
		t.Fatalf("unexpected verdict %+v", verdict)
	}
	var payload struct {
		Route  json.RawMessage `json:"route"`
		Effort *string         `json:"effort"`
		Owner  struct {
			TenantID     string `json:"tenantId"`
			OwnerActorID string `json:"ownerActorId"`
		} `json:"owner"`
		Instructions string `json:"instructions"`
		Input        string `json:"input"`
		Output       struct {
			Name   string          `json:"name"`
			Schema json.RawMessage `json:"schema"`
		} `json:"output"`
		TimeoutMS      int    `json:"timeoutMs"`
		SessionKey     string `json:"sessionKey"`
		RunOperationID string `json:"runOperationId"`
	}
	if err := json.Unmarshal(sent, &payload); err != nil {
		t.Fatal(err)
	}
	if payload.SessionKey != sessionKey("agent_1:room_1") || !strings.HasPrefix(payload.SessionKey, "permission-review:") ||
		strings.Contains(payload.SessionKey, "room_1") || len(payload.SessionKey) > 200 || sessionKey("agent_1:room_2") == payload.SessionKey {
		t.Fatalf("session key %q", payload.SessionKey)
	}
	if payload.Route != nil || payload.Effort != nil ||
		payload.Owner.TenantID != "tenant_1" || payload.Owner.OwnerActorID != "actor_sponsor" || payload.TimeoutMS != 45000 ||
		payload.RunOperationID != "operation_1" {
		t.Fatalf("unexpected request %s", sent)
	}
	if payload.Instructions != SystemPrompt() || !strings.HasPrefix(payload.Input, "<review_request>") || strings.Contains(payload.Input, "actor_sponsor") {
		t.Fatalf("the prompt is not the rendered request")
	}
	schema := string(payload.Output.Schema)
	if payload.Output.Name != "permission_review" || strings.Index(schema, `"risk_level":{`) > strings.Index(schema, `"decision":{`) {
		t.Fatalf("the schema must keep risk before the decision: %s", schema)
	}
}

func TestJudgeMakesOneCallAndKeepsAValidAnswer(t *testing.T) {
	t.Parallel()
	calls := 0
	client := fakeModelCall(t, http.StatusOK, strings.Replace(lowAllow, `"decision":"allow"`, `"decision":"needs_approval"`, 1), func([]byte) { calls++ })
	verdict, err := client.Judge(context.Background(), sampleRequest())
	if err != nil || verdict.Decision != DecisionNeedsApproval || calls != 1 {
		t.Fatalf("a valid needs_approval must be final: calls=%d verdict=%+v err=%v", calls, verdict, err)
	}
	calls = 0
	failing := fakeModelCall(t, http.StatusBadGateway, "", func([]byte) { calls++ })
	if _, err := failing.Judge(context.Background(), sampleRequest()); !errors.Is(err, ErrUnavailable) || calls != 1 {
		t.Fatalf("the Agent Service owns failover; the judge must not retry: calls=%d err=%v", calls, err)
	}
}

func TestJudgeIgnoresExtraFieldsButRequiresKnownOnes(t *testing.T) {
	t.Parallel()
	extra := strings.Replace(lowAllow, `"rationale":"read"`, `"rationale":"read","authorized_targets":["self"]`, 1)
	verdict, err := fakeModelCall(t, http.StatusOK, extra, nil).Judge(context.Background(), sampleRequest())
	if err != nil || verdict.Decision != DecisionAllow {
		t.Fatalf("an extra field must be ignored: verdict=%+v err=%v", verdict, err)
	}

	renamed := strings.Replace(lowAllow, `"user_authorization":"unknown"`, `"authorization":"high"`, 1)
	if _, err := fakeModelCall(t, http.StatusOK, renamed, nil).Judge(context.Background(), sampleRequest()); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("a missing required field must not read as empty: %v", err)
	}
}

func TestJudgeFailuresAreUnavailable(t *testing.T) {
	t.Parallel()
	cases := map[string]struct {
		status int
		output string
	}{
		"every candidate failed":  {http.StatusBadGateway, ""},
		"gateway not configured":  {http.StatusServiceUnavailable, ""},
		"no output":               {http.StatusOK, `null`},
		"missing required field":  {http.StatusOK, `{"risk_level":"low","user_authorization":"unknown","decision":"allow"}`},
		"bad enum":                {http.StatusOK, strings.Replace(lowAllow, `"decision":"allow"`, `"decision":"ask"`, 1)},
		"unauthorized model call": {http.StatusUnauthorized, ""},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			if _, err := fakeModelCall(t, tc.status, tc.output, nil).Judge(context.Background(), sampleRequest()); !errors.Is(err, ErrUnavailable) {
				t.Fatalf("got %v, want ErrUnavailable", err)
			}
		})
	}
}
