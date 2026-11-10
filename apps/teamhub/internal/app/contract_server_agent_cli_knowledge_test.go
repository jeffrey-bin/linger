package app

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentauth"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentcredential"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/memoryclient"
)

func TestAgentKnowledgeDirectRequestUsesCurrentServerSourceAndAuthorizesOnce(t *testing.T) {
	calls := 0
	upstreamCalls := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamCalls++
		if r.Header.Get("Authorization") != "Bearer private-memory-token" {
			t.Error("wrong internal credential")
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		if body["tenant_id"] != "tenant" || body["agent_id"] != "knowledge-agent" || body["user_artifact_owner_actor_id"] != "sponsor" {
			t.Errorf("untrusted knowledge subject: %v", body)
		}
		if _, ok := body["execution_run_ref"]; ok {
			t.Error("knowledge request retained Run dependency")
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"items":[],"query":"release"}`))
	}))
	defer upstream.Close()
	svc := &fakeMcpContextService{authorize: func(_ context.Context, token, tool string) (agentauth.Authorization, error) {
		calls++
		if token != "th_agent_test" || tool != "search_knowledge" {
			t.Error("wrong principal authorization input")
		}
		return agentauth.Authorization{Principal: &agentcredential.Principal{CredentialID: "cred", TenantID: "tenant", AgentActorID: "caller", UserArtifactOwnerActorID: "sponsor"}, PersonalKnowledgeAgentID: "knowledge-agent"}, nil
	}}
	memory, err := memoryclient.New(upstream.URL, "private-memory-token")
	if err != nil {
		t.Fatal(err)
	}
	server := &App{memory: memory, agentAuth: svc, logger: slog.Default()}
	response := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(response)
	c.Request = httptest.NewRequest(http.MethodPost, "/api/agent/v1/knowledge/search", strings.NewReader(`{"query":"release"}`))
	c.Request.Header.Set("Authorization", "Bearer th_agent_test")
	server.searchAgentKnowledge(c)
	if response.Code != http.StatusOK || calls != 1 || upstreamCalls != 1 {
		t.Fatalf("status=%d auth=%d query=%d body=%s", response.Code, calls, upstreamCalls, response.Body.String())
	}
}

func TestAgentKnowledgeReadRejectsForgedEvidence(t *testing.T) {
	identity := agentauth.Authorization{Principal: &agentcredential.Principal{TenantID: "t", UserArtifactOwnerActorID: "s"}, PersonalKnowledgeAgentID: "a"}
	type section = struct {
		SectionID string `json:"sectionId"`
		Offset    *int   `json:"offset,omitempty"`
	}
	if _, err := agentKnowledgeRequest("read_knowledge", agentKnowledgeInput{EvidenceID: "owc_forged", SectionRequests: []section{{SectionID: "a"}}}, identity); err == nil {
		t.Fatal("invalid evidence id accepted")
	}
	if _, err := agentKnowledgeRequest("read_knowledge", agentKnowledgeInput{EvidenceID: "raw_0123456789abcdef_0123456789abcdef"}, identity); err == nil {
		t.Fatal("read without sections accepted")
	}
}

func TestAgentKnowledgeSearchForwardsEventRangeSeparatelyFromSourceDates(t *testing.T) {
	identity := agentauth.Authorization{Principal: &agentcredential.Principal{TenantID: "t", UserArtifactOwnerActorID: "s"}, PersonalKnowledgeAgentID: "a"}
	from, to := "2026-04-01", "2026-04-30"
	request, err := agentKnowledgeRequest("search_knowledge", agentKnowledgeInput{Query: "shoes", EventFrom: &from, EventTo: &to}, identity)
	if err != nil {
		t.Fatal(err)
	}
	if request["event_from"] != from || request["event_to"] != to || request["date_from"] != nil {
		t.Fatalf("event range was not forwarded on its own: %#v", request)
	}
	if _, err := agentKnowledgeRequest("search_knowledge", agentKnowledgeInput{Query: "shoes", EventFrom: &to, EventTo: &from}, identity); err == nil {
		t.Fatal("reversed event range accepted")
	}
}

func TestAgentKnowledgeSourceDatesBecomeASoftWindow(t *testing.T) {
	identity := agentauth.Authorization{Principal: &agentcredential.Principal{TenantID: "t", UserArtifactOwnerActorID: "s"}, PersonalKnowledgeAgentID: "a"}
	today, monthStart, april := "2026-05-30", "2026-05-01", "2026-04-01"
	request, err := agentKnowledgeRequest("search_knowledge", agentKnowledgeInput{Query: "video", DateFrom: &today, DateTo: &today}, identity)
	if err != nil {
		t.Fatal(err)
	}
	if request["date_from"] != nil || request["date_to"] != nil || request["event_from"] != today || request["event_to"] != today {
		t.Fatalf("source dates must rank, not filter: %#v", request)
	}
	request, err = agentKnowledgeRequest("search_knowledge", agentKnowledgeInput{Query: "shoes", DateFrom: &monthStart, EventFrom: &april}, identity)
	if err != nil {
		t.Fatal(err)
	}
	if request["event_from"] != april || request["event_to"] != nil || request["date_from"] != nil {
		t.Fatalf("event bounds must take precedence: %#v", request)
	}
	bad := "2026-13-01"
	if _, err := agentKnowledgeRequest("search_knowledge", agentKnowledgeInput{Query: "x", DateFrom: &bad}, identity); err == nil {
		t.Fatal("invalid source date accepted")
	}
}

func TestAgentKnowledgeSearchForwardsBoundedAlternates(t *testing.T) {
	identity := agentauth.Authorization{Principal: &agentcredential.Principal{TenantID: "t", UserArtifactOwnerActorID: "s"}, PersonalKnowledgeAgentID: "a"}
	body, err := agentKnowledgeRequest("search_knowledge", agentKnowledgeInput{Query: "budget", Alternates: []string{"presupuesto", "cost"}}, identity)
	if err != nil {
		t.Fatal(err)
	}
	if got, _ := json.Marshal(body["alternates"]); string(got) != `["presupuesto","cost"]` {
		t.Fatalf("alternates = %s", got)
	}
	for _, alternates := range [][]string{{"a", "b", "c", "d", "e", "f", "g"}, {" "}, {strings.Repeat("€", 201)}} {
		if _, err := agentKnowledgeRequest("search_knowledge", agentKnowledgeInput{Query: "budget", Alternates: alternates}, identity); err == nil {
			t.Fatalf("accepted alternates %q", alternates)
		}
	}
	if _, err := agentKnowledgeRequest("read_knowledge", agentKnowledgeInput{EvidenceID: "raw_0123456789abcdef_0123456789abcdef", Alternates: []string{"presupuesto"}}, identity); err == nil {
		t.Fatal("read accepted alternates")
	}
}
