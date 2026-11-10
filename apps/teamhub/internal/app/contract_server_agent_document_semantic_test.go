package app

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentauth"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentdocument"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
	teamhubagentapi "github.com/simplexai-labs/linger/contracts-go/teamhubagentapi"
)

type fakeAgentDocumentSemanticService struct {
	apply func(context.Context, string, agentdocument.SemanticInput) (agentdocument.SemanticResult, error)
}

func (f fakeAgentDocumentSemanticService) Apply(ctx context.Context, token string, input agentdocument.SemanticInput) (agentdocument.SemanticResult, error) {
	return f.apply(ctx, token, input)
}

func TestAgentDocumentSemanticMutationMapsCanonicalReplay(t *testing.T) {
	service := fakeAgentDocumentSemanticService{apply: func(_ context.Context, token string, input agentdocument.SemanticInput) (agentdocument.SemanticResult, error) {
		if token != "th_agent_"+strings.Repeat("A", 43) ||
			input.DocumentID != "document_private" ||
			input.InvocationID != "agent-invocation-sha256:"+strings.Repeat("b", 64) ||
			input.SchemaVersion != "blocknote-semantic-v1" ||
			string(input.SemanticChange) != `[{"kind":"set_title","title":"Canonical"}]` {
			t.Fatalf("unexpected request token=%q input=%+v", token, input)
		}
		return agentdocument.SemanticResult{
			SemanticMutationResult: document.SemanticMutationResult{
				SemanticMutationID: "mutation_1", Status: document.SemanticMutationApplied,
				RevisionID: "revision_2", HistoryEntryID: "history_2", Replayed: true,
			},
		}, nil
	}}
	response := performAgentDocumentSemanticRequest(t, &App{agentDocumentSemanticMutations: service}, map[string]any{
		"document_id":     "document_private",
		"invocation_id":   "agent-invocation-sha256:" + strings.Repeat("b", 64),
		"schema_version":  "blocknote-semantic-v1",
		"semantic_change": []any{map[string]any{"kind": "set_title", "title": "Canonical"}},
	})
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	var payload teamhubagentapi.AgentDocumentSemanticMutationResponse
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil ||
		payload.SemanticMutationId != "mutation_1" || payload.Status != teamhubagentapi.AgentDocumentSemanticMutationResponseStatusApplied ||
		!payload.Replayed || payload.RevisionId == nil || *payload.RevisionId != "revision_2" ||
		payload.HistoryEntryId == nil || *payload.HistoryEntryId != "history_2" {
		t.Fatalf("payload=%+v error=%v", payload, err)
	}
}

func TestAgentDocumentSemanticMutationRejectsUnknownFieldBeforeService(t *testing.T) {
	called := false
	service := fakeAgentDocumentSemanticService{apply: func(context.Context, string, agentdocument.SemanticInput) (agentdocument.SemanticResult, error) {
		called = true
		return agentdocument.SemanticResult{}, nil
	}}
	body := validAgentDocumentSemanticBody()
	body["agent_id"] = "override"
	response := performAgentDocumentSemanticRequest(t, &App{agentDocumentSemanticMutations: service}, body)
	if response.Code != http.StatusBadRequest || called {
		t.Fatalf("status=%d service_called=%v body=%s", response.Code, called, response.Body.String())
	}
}

func TestAgentDocumentSemanticMutationMapsFailClosedErrors(t *testing.T) {
	for _, test := range []struct {
		name   string
		err    error
		status int
		code   teamhubagentapi.AgentApiErrorCode
	}{
		{name: "revoked session", err: agentauth.ErrCredentialInvalid, status: http.StatusUnauthorized, code: teamhubagentapi.AgentApiErrorCodeAgentCredentialInvalid},
		{name: "tool forbidden", err: agentauth.ErrForbidden, status: http.StatusForbidden, code: teamhubagentapi.AgentApiErrorCodeOperationForbidden},
		{name: "generation override", err: agentdocument.ErrSemanticForbidden, status: http.StatusForbidden, code: teamhubagentapi.AgentApiErrorCodeOperationForbidden},
		{name: "document hidden", err: document.ErrNotFound, status: http.StatusNotFound, code: teamhubagentapi.AgentApiErrorCodeNotFound},
		{name: "invocation conflict", err: document.ErrIdempotencyConflict, status: http.StatusConflict, code: teamhubagentapi.AgentApiErrorCodeIdempotencyConflict},
		{name: "recovery budget", err: document.ErrRecoveryBudgetExceeded, status: http.StatusRequestEntityTooLarge, code: teamhubagentapi.AgentApiErrorCodePayloadTooLarge},
		{name: "runtime unavailable", err: document.ErrRuntimeUnavailable, status: http.StatusServiceUnavailable, code: teamhubagentapi.AgentApiErrorCodeDependencyUnavailable},
		{name: "unknown result", err: agentdocument.ErrSemanticDependency, status: http.StatusServiceUnavailable, code: teamhubagentapi.AgentApiErrorCodeDependencyUnavailable},
	} {
		t.Run(test.name, func(t *testing.T) {
			service := fakeAgentDocumentSemanticService{apply: func(context.Context, string, agentdocument.SemanticInput) (agentdocument.SemanticResult, error) {
				return agentdocument.SemanticResult{}, test.err
			}}
			response := performAgentDocumentSemanticRequest(t, &App{agentDocumentSemanticMutations: service}, validAgentDocumentSemanticBody())
			if response.Code != test.status {
				t.Fatalf("status=%d want=%d body=%s", response.Code, test.status, response.Body.String())
			}
			assertAgentAPIError(t, response, test.code)
		})
	}
}

func validAgentDocumentSemanticBody() map[string]any {
	return map[string]any{
		"document_id":     "document_plan",
		"invocation_id":   "agent-invocation-sha256:" + strings.Repeat("b", 64),
		"schema_version":  "blocknote-semantic-v1",
		"semantic_change": []any{map[string]any{"kind": "set_title", "title": "Canonical"}},
	}
}

func performAgentDocumentSemanticRequest(t *testing.T, app *App, body any) *httptest.ResponseRecorder {
	t.Helper()
	encoded, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost,
		"/api/agent/v1/document-semantic-mutations", bytes.NewReader(encoded))
	request.Header.Set("Authorization", "Bearer th_agent_"+strings.Repeat("A", 43))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	newAgentAPIContractTestEngine(app).ServeHTTP(response, request)
	return response
}
