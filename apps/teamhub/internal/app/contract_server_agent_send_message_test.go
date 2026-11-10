package app

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentauth"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentsendmessage"
	teamhubagentapi "github.com/simplexai-labs/linger/contracts-go/teamhubagentapi"
)

func TestAgentSendMessageErrorMapping(t *testing.T) {
	gin.SetMode(gin.TestMode)
	tests := []struct {
		err    error
		status int
		code   teamhubagentapi.AgentApiErrorCode
	}{
		{err: agentsendmessage.ErrInvalid, status: http.StatusBadRequest, code: teamhubagentapi.AgentApiErrorCodeInvalidRequest},
		{err: agentauth.ErrCredentialInvalid, status: http.StatusUnauthorized, code: teamhubagentapi.AgentApiErrorCodeAgentCredentialInvalid},
		{err: agentsendmessage.ErrForbidden, status: http.StatusForbidden, code: teamhubagentapi.AgentApiErrorCodeOperationForbidden},
		{err: agentsendmessage.ErrReplySourceUnavailable, status: http.StatusForbidden, code: teamhubagentapi.AgentApiErrorCodeForbidden},
		{err: agentsendmessage.ErrInboxUnavailable, status: http.StatusForbidden, code: teamhubagentapi.AgentApiErrorCodeForbidden},
		{err: agentsendmessage.ErrIdempotencyConflict, status: http.StatusConflict, code: teamhubagentapi.AgentApiErrorCodeIdempotencyConflict},
		{err: agentsendmessage.ErrUnavailable, status: http.StatusServiceUnavailable, code: teamhubagentapi.AgentApiErrorCodeDependencyUnavailable},
		{err: errors.New("database failed"), status: http.StatusInternalServerError, code: teamhubagentapi.AgentApiErrorCodeInternalError},
	}
	for _, test := range tests {
		t.Run(string(test.code), func(t *testing.T) {
			response := httptest.NewRecorder()
			c, _ := gin.CreateTestContext(response)
			c.Request = httptest.NewRequest(http.MethodPost, "/api/agent/v1/messages/commit", nil)
			if !(&App{}).writeAgentSendMessageError(c, test.err) {
				t.Fatal("error was not written")
			}
			if response.Code != test.status {
				t.Fatalf("status=%d body=%s", response.Code, response.Body)
			}
			assertAgentSendMessageErrorCode(t, response.Body.Bytes(), test.code)
		})
	}
}
func assertAgentSendMessageErrorCode(t *testing.T, body []byte, code teamhubagentapi.AgentApiErrorCode) {
	t.Helper()
	var envelope teamhubagentapi.AgentApiErrorEnvelope
	if err := json.Unmarshal(body, &envelope); err != nil || envelope.Error.Code != code {
		t.Fatalf("error body=%s code=%q want=%q error=%v", body, envelope.Error.Code, code, err)
	}
}
