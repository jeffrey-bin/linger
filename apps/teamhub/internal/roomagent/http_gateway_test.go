package roomagent

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestHTTPGatewayReadsRuntimeHistoryWithoutReinterpretingIt(t *testing.T) {
	contextKey := `["meta","agent-management-1","room","room_1"]`
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.Header.Get("Authorization") != "Bearer service-secret" {
			t.Fatalf("request=%s %s authorization=%q", r.Method, r.URL.Path, r.Header.Get("Authorization"))
		}
		var target struct {
			TenantID   string `json:"tenant_id"`
			ContextKey string `json:"context_key"`
			Cursor     string `json:"cursor"`
			Limit      int    `json:"limit"`
			Ref        struct {
				Kind    string `json:"kind"`
				AgentID string `json:"agent_id"`
				RoomID  string `json:"room_id"`
			} `json:"ref"`
		}
		if err := json.NewDecoder(r.Body).Decode(&target); err != nil {
			t.Fatal(err)
		}
		if target.TenantID != "tenant_1" || target.ContextKey != contextKey || target.Ref.Kind != "meta" ||
			target.Ref.AgentID != "agent-management-1" || target.Ref.RoomID != "room_1" {
			t.Fatalf("target=%+v", target)
		}
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path != "/v1/agent-debug/history:read" {
			t.Fatalf("unexpected AgentManagement route %q", r.URL.Path)
		}
		if target.Cursor != "cursor-current" || target.Limit != 75 {
			t.Fatalf("history page options=%+v", target)
		}
		_, _ = w.Write([]byte(`{"status":"available","provider_kind":"codex","source":"codex_rollout","snapshot":{"id":"snapshot-1","thread_id":"thread-1","captured_at":"2026-08-24T12:00:00Z","record_count":1,"tail_state":"clean"},"instructions":{"status":"available","source":"codex_rollout","blocks":[]},"records":[{"ordinal":0,"category":"tool_call","native_type":"response_item.function_call","tool_call_id":"call-1","native_record":{"type":"response_item"},"redacted_fields":[]}],"previous_cursor":"cursor-prev"}`))
	}))
	t.Cleanup(server.Close)
	gateway, err := NewHTTPGateway(server.URL, "service-secret", server.Client())
	if err != nil {
		t.Fatal(err)
	}
	target := RuntimeContextTarget{
		TenantID: "tenant_1", ContextKey: contextKey,
		Ref: RuntimeContextRef{Kind: "meta", AgentID: "agent-management-1", RoomID: "room_1"},
	}

	cursor, limit := "cursor-current", 75
	history, err := gateway.ReadRuntimeHistory(context.Background(), target, RuntimeHistoryReadOptions{Cursor: &cursor, Limit: &limit})
	if err != nil || history.ProviderKind != "codex" ||
		len(history.Records) != 1 || history.Records[0].ToolCallID != "call-1" || history.PreviousCursor != "cursor-prev" {
		t.Fatalf("history=%+v err=%v", history, err)
	}
}

func TestHTTPGatewayRejectsInvalidRuntimeQueriesBeforeCallingAgentManagement(t *testing.T) {
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		requests++
	}))
	t.Cleanup(server.Close)
	gateway, err := NewHTTPGateway(server.URL, "service-secret", server.Client())
	if err != nil {
		t.Fatal(err)
	}
	target := RuntimeContextTarget{
		TenantID: "tenant_1", ContextKey: `["meta","agent-management-1","room","room_1"]`,
		Ref: RuntimeContextRef{Kind: "meta", AgentID: "agent-management-1", RoomID: "room_1"},
	}

	invalid := target
	invalid.Ref.TaskID = "task_1"
	if _, err := gateway.ReadRuntimeHistory(context.Background(), invalid, RuntimeHistoryReadOptions{}); err == nil {
		t.Fatal("meta Context with a task identity was accepted")
	}
	roomless := target
	roomless.ContextKey, roomless.Ref.RoomID = `["meta","agent-management-1"]`, ""
	if _, err := gateway.ReadRuntimeHistory(context.Background(), roomless, RuntimeHistoryReadOptions{}); err == nil {
		t.Fatal("meta Context without a Room was accepted")
	}
	if _, err := gateway.CancelRun(context.Background(), RunCancelCommand{
		RequestID: "request_1", RunID: "run_1", AgentID: "agent-management-1",
	}); err == nil {
		t.Fatal("Run cancel for a meta Context without a Room was accepted")
	}
	if requests != 0 {
		t.Fatalf("invalid requests reached AgentManagement: %d", requests)
	}
}

func TestRuntimeContextRefEncodesAlterEgoTaskIdentity(t *testing.T) {
	ref, err := runtimeContextRef(RuntimeContextTarget{
		TenantID: "tenant_1", ContextKey: `["alter_ego","agent-management-1","task_1"]`,
		Ref: RuntimeContextRef{Kind: "alter_ego", AgentID: "agent-management-1", TaskID: "task_1"},
	})
	if err != nil {
		t.Fatal(err)
	}
	variant, err := ref.AsAgentRuntimeContextRef1()
	if err != nil || variant.Kind != "alter_ego" || variant.AgentId != "agent-management-1" || variant.TaskId != "task_1" {
		t.Fatalf("variant=%+v err=%v", variant, err)
	}
}

func TestRuntimeContextRefEncodesDocumentIdentity(t *testing.T) {
	ref, err := runtimeContextRef(RuntimeContextTarget{
		TenantID: "tenant_1", ContextKey: `["document","agent-management-1","document_1"]`,
		Ref: RuntimeContextRef{Kind: "document", AgentID: "agent-management-1", DocumentID: "document_1"},
	})
	if err != nil {
		t.Fatal(err)
	}
	variant, err := ref.AsAgentRuntimeContextRef2()
	if err != nil || variant.Kind != "document" || variant.AgentId != "agent-management-1" || variant.DocumentId != "document_1" {
		t.Fatalf("variant=%+v err=%v", variant, err)
	}
}

func TestHTTPGatewayScansOwnedLocalComputerSkills(t *testing.T) {
	expiresAt := time.Date(2026, time.August, 17, 10, 0, 0, 0, time.UTC)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/v1/tenants/tenant_1/owners/actor_owner/local-computers/computer_1/skill-scans" {
			t.Fatalf("request=%s %s", r.Method, r.URL.Path)
		}
		if r.Header.Get("Authorization") != "Bearer service-secret" {
			t.Fatalf("authorization=%q", r.Header.Get("Authorization"))
		}
		var body struct {
			RequestID   string    `json:"request_id"`
			ScanID      string    `json:"scan_id"`
			RuntimeType string    `json:"runtime_type"`
			ExpiresAt   time.Time `json:"expires_at"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if body.RequestID != "command_scan_1" || body.ScanID != "scan_1" || body.RuntimeType != "codex" || !body.ExpiresAt.Equal(expiresAt) {
			t.Fatalf("body=%+v", body)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"scan_id":"scan_1","computer_id":"computer_1","runtime_type":"codex","expires_at":"2026-08-17T10:00:00Z","items":[{"candidate_ref":"candidate_1","name":"review-skill","description":"Review changes","package_sha256":"` + strings.Repeat("a", 64) + `","file_count":2,"size_bytes":128,"normalizations":[],"risk_flags":["contains_scripts"],"importability":"ready"},{"candidate_ref":"candidate_unsupported","name":"legacy-skill","description":"This local Skill cannot be imported safely.","package_sha256":"` + strings.Repeat("0", 64) + `","file_count":1,"size_bytes":1,"normalizations":[],"risk_flags":[],"importability":"unsupported","error_code":"LOCAL_SKILL_FRONTMATTER_UNSUPPORTED","error_detail":"SKILL.md contains unsupported frontmatter fields","manifest_excerpt":"---\\nname: legacy-skill\\nversion: 1.0.0\\n---\\n"}]}`))
	}))
	t.Cleanup(server.Close)
	gateway, err := NewHTTPGateway(server.URL, "service-secret", server.Client())
	if err != nil {
		t.Fatal(err)
	}

	result, err := gateway.ScanLocalSkills(context.Background(), LocalSkillScanCommand{
		TenantID: "tenant_1", OwnerActorID: "actor_owner", ComputerID: "computer_1",
		CommandID: "command_scan_1", ScanID: "scan_1", RuntimeType: "codex", ExpiresAt: expiresAt,
	})
	if err != nil || len(result.Items) != 2 || result.Items[0].CandidateRef != "candidate_1" ||
		result.Items[0].Importability != "ready" || strings.Join(result.Items[0].RiskFlags, ",") != "contains_scripts" {
		t.Fatalf("result=%+v err=%v", result, err)
	}
	if result.Items[1].ErrorDetail != "SKILL.md contains unsupported frontmatter fields" ||
		!strings.Contains(result.Items[1].ManifestExcerpt, "version: 1.0.0") {
		t.Fatalf("unsupported candidate=%+v", result.Items[1])
	}
}

func TestHTTPGatewayNotifiesAgentRegistrationChange(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/v1/agents/agent-local/registration-changes" {
			t.Fatalf("request=%s %s", r.Method, r.URL.Path)
		}
		if r.Header.Get("Authorization") != "Bearer service-secret" {
			t.Fatalf("authorization=%q", r.Header.Get("Authorization"))
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	t.Cleanup(server.Close)
	gateway, err := NewHTTPGateway(server.URL, "service-secret", server.Client())
	if err != nil {
		t.Fatal(err)
	}
	if err := gateway.NotifyAgentRegistrationChanged(context.Background(), "agent-local"); err != nil {
		t.Fatal(err)
	}
	if err := gateway.NotifyAgentRegistrationChanged(context.Background(), "not a valid id"); err == nil {
		t.Fatal("an invalid Agent ID was sent")
	}
}
