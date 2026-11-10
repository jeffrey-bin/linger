package app

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestRetiredAgentHumanRequestRouteIsNotFound(t *testing.T) {
	engine := newMcpInternalContractTestEngine(&App{})
	request := httptest.NewRequest(http.MethodPost, "/api/agent/v1/human-interactions", strings.NewReader(`{}`))
	request.Header.Set("Authorization", "Bearer retired-command-token")
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	engine.ServeHTTP(response, request)
	if response.Code != http.StatusNotFound {
		t.Fatalf("retired Human request route status=%d want=404 body=%s", response.Code, response.Body.String())
	}
}
