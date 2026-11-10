package app

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentauth"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentcreationapproval"
)

type fakeAgentCreationApprovalService struct {
	submit        func(context.Context, string, agentcreationapproval.Input) (agentcreationapproval.Result, error)
	listAvailable func(context.Context, string, string, int) (agentcreationapproval.AvailableAgentPage, error)
}

func (f *fakeAgentCreationApprovalService) Submit(ctx context.Context, token string, input agentcreationapproval.Input) (agentcreationapproval.Result, error) {
	return f.submit(ctx, token, input)
}

func (f *fakeAgentCreationApprovalService) ListAvailableAgents(ctx context.Context, token string, cursor string, limit int) (agentcreationapproval.AvailableAgentPage, error) {
	if f.listAvailable == nil {
		return agentcreationapproval.AvailableAgentPage{}, nil
	}
	return f.listAvailable(ctx, token, cursor, limit)
}

func TestListAvailableAgentsProjectsSponsorAuthorizedPage(t *testing.T) {
	token := "th_agent_" + strings.Repeat("A", 43)
	called := false
	a := &App{agentCreationApprovals: &fakeAgentCreationApprovalService{
		listAvailable: func(_ context.Context, gotToken string, cursor string, limit int) (agentcreationapproval.AvailableAgentPage, error) {
			called = true
			if gotToken != token || cursor != "actor_previous" || limit != 25 {
				t.Fatalf("request mismatch token=%q cursor=%q limit=%d", gotToken, cursor, limit)
			}
			return agentcreationapproval.AvailableAgentPage{
				Agents:     []agentcreationapproval.AvailableAgent{{ActorID: "actor_researcher", Name: "Researcher", Description: "Researches evidence"}},
				NextCursor: "actor_researcher"}, nil
		},
	}}
	body := `{"cursor":"actor_previous","limit":25}`
	request := httptest.NewRequest(http.MethodPost, "/api/agent/v1/available-agents", strings.NewReader(body))
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	newAgentAPIContractTestEngine(a).ServeHTTP(response, request)
	if response.Code != http.StatusOK || !called || !strings.Contains(response.Body.String(), `"actor_id":"actor_researcher"`) || !strings.Contains(response.Body.String(), `"next_cursor":"actor_researcher"`) {
		t.Fatalf("status=%d called=%t body=%s", response.Code, called, response.Body.String())
	}
}

func TestListAvailableAgentsExplainsIneligibleCallerForCLI(t *testing.T) {
	token := "th_agent_" + strings.Repeat("A", 43)
	const message = "Only an Agent in its Meta Context can list available Agents"
	for _, cause := range []error{agentauth.ErrForbidden, agentcreationapproval.ErrForbidden} {
		a := &App{agentCreationApprovals: &fakeAgentCreationApprovalService{
			listAvailable: func(context.Context, string, string, int) (agentcreationapproval.AvailableAgentPage, error) {
				return agentcreationapproval.AvailableAgentPage{}, cause
			},
		}}
		request := httptest.NewRequest(http.MethodPost, "/api/agent/v1/available-agents", strings.NewReader(`{}`))
		request.Header.Set("Authorization", "Bearer "+token)
		request.Header.Set("Content-Type", "application/json")
		response := httptest.NewRecorder()
		newAgentAPIContractTestEngine(a).ServeHTTP(response, request)
		if response.Code != http.StatusForbidden || !strings.Contains(response.Body.String(), `"code":"forbidden"`) ||
			!strings.Contains(response.Body.String(), message) || strings.Contains(response.Body.String(), "operation_forbidden") {
			t.Fatalf("cause=%v status=%d body=%s", cause, response.Code, response.Body.String())
		}
	}
}

// Task creation no longer needs Human approval; the approval
// endpoint accepts only Room Creation requests.
func TestSubmitAgentCreationApprovalRejectsTaskCreation(t *testing.T) {
	token := "th_agent_" + strings.Repeat("A", 43)
	a := &App{agentCreationApprovals: &fakeAgentCreationApprovalService{
		submit: func(context.Context, string, agentcreationapproval.Input) (agentcreationapproval.Result, error) {
			t.Fatal("Task creation reached the approval service")
			return agentcreationapproval.Result{}, nil
		},
	}}
	body := `{
		"request_kind":"task_creation",
		"invocation_id":"agent-invocation-sha256:` + strings.Repeat("b", 64) + `",
		"caller_input":{"title":"Task","member_ids":["actor_1"],"initial_message_segments":[{"type":"text","content":"Do it"}]},
		"effective_payload":{"title":"Task","priority":"medium","member_ids":["actor_1"],"work_room_name":"Task","initial_message_segments":[{"type":"text","content":"Do it"}]}
	}`
	request := httptest.NewRequest(http.MethodPost, "/api/agent/v1/creation-approval-requests", strings.NewReader(body))
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	newAgentAPIContractTestEngine(a).ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("status=%d want=%d body=%s", response.Code, http.StatusBadRequest, response.Body.String())
	}
}

func TestSubmitAgentRoomCreationApprovalPreservesOrderedArtifacts(t *testing.T) {
	token := "th_agent_" + strings.Repeat("A", 43)
	called := false
	a := &App{agentCreationApprovals: &fakeAgentCreationApprovalService{
		submit: func(_ context.Context, gotToken string, input agentcreationapproval.Input) (agentcreationapproval.Result, error) {
			called = true
			wantArtifacts := []string{"document_brief", "document_evidence"}
			if gotToken != token ||
				input.RequestKind != "room_creation" || input.RoomCaller == nil || input.RoomEffective == nil ||
				!sameTestStrings(input.RoomCaller.Artifacts, wantArtifacts) ||
				!sameTestStrings(input.RoomEffective.Artifacts, wantArtifacts) {
				t.Fatalf("token/input mismatch token=%q input=%+v", gotToken, input)
			}
			if !strings.Contains(string(input.CallerInputJSON), `"artifacts":["document_brief","document_evidence"]`) ||
				!strings.Contains(string(input.EffectivePayloadJSON), `"artifacts":["document_brief","document_evidence"]`) {
				t.Fatalf("Room artifact wire order was lost caller=%s effective=%s", input.CallerInputJSON, input.EffectivePayloadJSON)
			}
			return agentcreationapproval.Result{
				CreationApprovalRequestID: "creation_approval_request_1", MessageID: "message_1",
			}, nil
		},
	}}
	body := `{
		"request_kind":"room_creation",
		"invocation_id":"agent-invocation-sha256:` + strings.Repeat("b", 64) + `",
		"caller_input":{"name":"Room","member_ids":["actor_1"],"artifacts":["document_brief","document_evidence"],"initial_message_segments":[{"type":"text","content":"Start"}]},
		"effective_payload":{"name":"Room","member_ids":["actor_1"],"artifacts":["document_brief","document_evidence"],"initial_message_segments":[{"type":"text","content":"Start"}]}
	}`
	request := httptest.NewRequest(http.MethodPost, "/api/agent/v1/creation-approval-requests", strings.NewReader(body))
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	newAgentAPIContractTestEngine(a).ServeHTTP(response, request)
	if response.Code != http.StatusOK || !called {
		t.Fatalf("status=%d called=%t body=%s", response.Code, called, response.Body.String())
	}
}

func sameTestStrings(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}
