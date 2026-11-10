package app

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentauth"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentdirectmessage"
	teamhubagentapi "github.com/simplexai-labs/linger/contracts-go/teamhubagentapi"
)

type fakeAgentDirectMessageService struct {
	send func(context.Context, string, agentdirectmessage.Input) (agentdirectmessage.Result, error)
}

func (f *fakeAgentDirectMessageService) Send(
	ctx context.Context,
	token string,
	input agentdirectmessage.Input,
) (agentdirectmessage.Result, error) {
	return f.send(ctx, token, input)
}

func TestSendAgentDirectMessageUsesAgentBearer(t *testing.T) {
	contextToken := "th_agent_" + strings.Repeat("A", 43)
	invocationID := "agent-invocation-sha256:" + strings.Repeat("b", 64)

	a := &App{
		agentDirectMessages: &fakeAgentDirectMessageService{send: func(
			_ context.Context,
			token string,
			input agentdirectmessage.Input,
		) (agentdirectmessage.Result, error) {
			if token != contextToken {
				t.Fatalf("authorization arguments token length=%d", len(token))
			}
			if input.InvocationID != invocationID || len(input.Messages) != 2 || input.Messages[0] != "first" || input.Messages[1] != "second" {
				t.Fatalf("input=%+v", input)
			}
			return agentdirectmessage.Result{
				Accepted: true, InboxID: "room:room_direct",
				MessageIDs: []string{"message_one", "message_two"}, RoomCreated: true,
			}, nil
		}},
	}
	request := httptest.NewRequest(
		http.MethodPost,
		"/api/agent/v1/direct-messages",
		strings.NewReader(`{"invocation_id":"`+invocationID+`","messages":["first","second"]}`),
	)
	request.Header.Set("Authorization", "Bearer "+contextToken)
	response := httptest.NewRecorder()
	newAgentAPIContractTestEngine(a).ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body)
	}
	want := `{"accepted":true,"duplicate_request":false,"inbox_id":"room:room_direct","message_ids":["message_one","message_two"],"room_created":true}`
	assertAgentTaskJSONEqual(t, response.Body.Bytes(), []byte(want))
}

func TestSendAgentDirectMessageRejectsInvalidCredentialAndBody(t *testing.T) {
	valid := validAgentDirectMessageRequest()
	validBody := validAgentDirectMessageBody()
	tests := []struct {
		name    string
		headers []string
		body    string
		status  int
		code    teamhubagentapi.AgentApiErrorCode
	}{
		{name: "missing Bearer", body: `{}`, status: http.StatusUnauthorized, code: teamhubagentapi.AgentApiErrorCodeAgentCredentialInvalid},
		{name: "duplicate Bearer", headers: []string{"Bearer first", "Bearer second"}, body: `{}`, status: http.StatusUnauthorized, code: teamhubagentapi.AgentApiErrorCodeAgentCredentialInvalid},
		{name: "unknown identity", headers: []string{valid.Header.Get("Authorization")}, body: `{"agent_id":"agent_attacker"}`, status: http.StatusBadRequest, code: teamhubagentapi.AgentApiErrorCodeInvalidRequest},
		{name: "trailing object", headers: []string{valid.Header.Get("Authorization")}, body: validBody + `{}`, status: http.StatusBadRequest, code: teamhubagentapi.AgentApiErrorCodeInvalidRequest},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			called := false
			a := &App{agentDirectMessages: &fakeAgentDirectMessageService{send: func(context.Context, string, agentdirectmessage.Input) (agentdirectmessage.Result, error) {
				called = true
				return agentdirectmessage.Result{}, nil
			}}}
			request := httptest.NewRequest(http.MethodPost, "/api/agent/v1/direct-messages", strings.NewReader(test.body))
			for _, header := range test.headers {
				request.Header.Add("Authorization", header)
			}
			response := httptest.NewRecorder()
			newAgentAPIContractTestEngine(a).ServeHTTP(response, request)
			if response.Code != test.status || called {
				t.Fatalf("status=%d body=%s called=%v", response.Code, response.Body, called)
			}
			assertAgentDirectMessageErrorCode(t, response.Body.Bytes(), test.code)
		})
	}
}

func TestSendAgentDirectMessageErrorMapping(t *testing.T) {
	tests := []struct {
		err    error
		status int
		code   teamhubagentapi.AgentApiErrorCode
	}{
		{err: agentdirectmessage.ErrInvalid, status: http.StatusBadRequest, code: teamhubagentapi.AgentApiErrorCodeInvalidRequest},
		{err: agentauth.ErrCredentialInvalid, status: http.StatusUnauthorized, code: teamhubagentapi.AgentApiErrorCodeAgentCredentialInvalid},
		{err: agentdirectmessage.ErrForbidden, status: http.StatusForbidden, code: teamhubagentapi.AgentApiErrorCodeOperationForbidden},
		{err: agentdirectmessage.ErrSponsorUnavailable, status: http.StatusForbidden, code: teamhubagentapi.AgentApiErrorCodeForbidden},
		{err: agentdirectmessage.ErrIdempotencyConflict, status: http.StatusConflict, code: teamhubagentapi.AgentApiErrorCodeIdempotencyConflict},
		{err: agentdirectmessage.ErrUnavailable, status: http.StatusServiceUnavailable, code: teamhubagentapi.AgentApiErrorCodeDependencyUnavailable},
		{err: errors.New("database failed"), status: http.StatusInternalServerError, code: teamhubagentapi.AgentApiErrorCodeInternalError},
	}
	for _, test := range tests {
		t.Run(string(test.code), func(t *testing.T) {
			a := &App{agentDirectMessages: &fakeAgentDirectMessageService{send: func(context.Context, string, agentdirectmessage.Input) (agentdirectmessage.Result, error) {
				return agentdirectmessage.Result{}, test.err
			}}}
			response := httptest.NewRecorder()
			newAgentAPIContractTestEngine(a).ServeHTTP(response, validAgentDirectMessageRequest())
			if response.Code != test.status {
				t.Fatalf("status=%d body=%s", response.Code, response.Body)
			}
			assertAgentDirectMessageErrorCode(t, response.Body.Bytes(), test.code)
		})
	}
}

func validAgentDirectMessageRequest() *http.Request {
	request := httptest.NewRequest(
		http.MethodPost,
		"/api/agent/v1/direct-messages",
		strings.NewReader(validAgentDirectMessageBody()),
	)
	request.Header.Set("Authorization", "Bearer th_agent_"+strings.Repeat("A", 43))
	return request
}

func validAgentDirectMessageBody() string {
	invocationID := "agent-invocation-sha256:" + strings.Repeat("b", 64)
	return `{"invocation_id":"` + invocationID + `","messages":["message"]}`
}

func assertAgentDirectMessageErrorCode(t *testing.T, body []byte, code teamhubagentapi.AgentApiErrorCode) {
	t.Helper()
	var envelope teamhubagentapi.AgentApiErrorEnvelope
	if err := json.Unmarshal(body, &envelope); err != nil || envelope.Error.Code != code {
		t.Fatalf("error body=%s code=%q want=%q error=%v", body, envelope.Error.Code, code, err)
	}
}
