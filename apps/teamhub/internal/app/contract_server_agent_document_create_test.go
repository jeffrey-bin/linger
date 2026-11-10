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

type fakeAgentDocumentCreateService struct {
	create func(context.Context, string, agentdocument.CreateInput) (agentdocument.CreateResult, error)
}

func (f fakeAgentDocumentCreateService) Create(ctx context.Context, token string, input agentdocument.CreateInput) (agentdocument.CreateResult, error) {
	return f.create(ctx, token, input)
}

func TestAgentDocumentCreateMapsCanonicalReplayAndRejectsOverride(t *testing.T) {
	service := fakeAgentDocumentCreateService{create: func(_ context.Context, token string, input agentdocument.CreateInput) (agentdocument.CreateResult, error) {
		if token != "th_agent_"+strings.Repeat("A", 43) ||
			input.InvocationID != "agent-invocation-sha256:"+strings.Repeat("b", 64) ||
			input.Title != "Created" || input.Markdown != "# Body\n" {
			t.Fatalf("request token=%q input=%+v", token, input)
		}
		return agentdocument.CreateResult{
			CreateAgentDocumentResult: document.CreateAgentDocumentResult{
				DocumentID: "document_1", RevisionID: "revision_1", Replayed: true,
			},
		}, nil
	}}
	response := performAgentDocumentCreateRequest(t, &App{agentDocumentCreations: service}, validAgentDocumentCreateBody())
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	var payload teamhubagentapi.AgentDocumentCreateResponse
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil ||
		payload.DocumentId != "document_1" || payload.RevisionId != "revision_1" ||
		payload.Status != "created" || !payload.Replayed {
		t.Fatalf("payload=%+v error=%v", payload, err)
	}
	called := false
	rejecting := fakeAgentDocumentCreateService{create: func(context.Context, string, agentdocument.CreateInput) (agentdocument.CreateResult, error) {
		called = true
		return agentdocument.CreateResult{}, nil
	}}
	body := validAgentDocumentCreateBody()
	body["owner_actor_id"] = "override"
	response = performAgentDocumentCreateRequest(t, &App{agentDocumentCreations: rejecting}, body)
	if response.Code != http.StatusBadRequest || called {
		t.Fatalf("override status=%d called=%v body=%s", response.Code, called, response.Body.String())
	}
}

func TestAgentDocumentCreateMapsFailClosedErrors(t *testing.T) {
	for _, test := range []struct {
		err    error
		status int
		code   teamhubagentapi.AgentApiErrorCode
	}{
		{err: agentauth.ErrCredentialInvalid, status: http.StatusUnauthorized, code: teamhubagentapi.AgentApiErrorCodeAgentCredentialInvalid},
		{err: agentdocument.ErrCreateForbidden, status: http.StatusForbidden, code: teamhubagentapi.AgentApiErrorCodeOperationForbidden},
		{err: document.ErrNotFound, status: http.StatusNotFound, code: teamhubagentapi.AgentApiErrorCodeNotFound},
		{err: document.ErrRecoveryBudgetExceeded, status: http.StatusRequestEntityTooLarge, code: teamhubagentapi.AgentApiErrorCodePayloadTooLarge},
		{err: document.ErrRuntimeUnavailable, status: http.StatusServiceUnavailable, code: teamhubagentapi.AgentApiErrorCodeDependencyUnavailable},
	} {
		service := fakeAgentDocumentCreateService{create: func(context.Context, string, agentdocument.CreateInput) (agentdocument.CreateResult, error) {
			return agentdocument.CreateResult{}, test.err
		}}
		response := performAgentDocumentCreateRequest(t, &App{agentDocumentCreations: service}, validAgentDocumentCreateBody())
		if response.Code != test.status {
			t.Fatalf("error=%v status=%d want=%d body=%s", test.err, response.Code, test.status, response.Body.String())
		}
		assertAgentAPIError(t, response, test.code)
	}
}

func validAgentDocumentCreateBody() map[string]any {
	return map[string]any{
		"invocation_id": "agent-invocation-sha256:" + strings.Repeat("b", 64),
		"title":         "Created",
		"markdown":      "# Body\n",
	}
}

func performAgentDocumentCreateRequest(t *testing.T, app *App, body any) *httptest.ResponseRecorder {
	t.Helper()
	encoded, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost,
		"/api/agent/v1/documents", bytes.NewReader(encoded))
	request.Header.Set("Authorization", "Bearer th_agent_"+strings.Repeat("A", 43))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	newAgentAPIContractTestEngine(app).ServeHTTP(response, request)
	return response
}
