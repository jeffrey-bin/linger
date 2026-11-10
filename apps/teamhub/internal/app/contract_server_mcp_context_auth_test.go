package app

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/config"
	"github.com/simplexai-labs/linger/contracts-go/teamhubinternal"
)

func TestAuthenticateMcpAgentServiceUsesDedicatedStrictBearer(t *testing.T) {
	gin.SetMode(gin.TestMode)
	a := &App{cfg: config.ForTest(func(c *config.Config) {
		c.TeamHubInternalToken = "agent-service-secret"
	})}
	engine := gin.New()
	engine.Use(func(c *gin.Context) { c.Set("request_id", "request-agent-auth-test") })
	engine.GET("/protected", func(c *gin.Context) {
		if a.authenticateMcpAgentService(c) {
			c.Status(http.StatusNoContent)
		}
	})

	tests := []struct {
		name    string
		headers []string
		status  int
	}{
		{name: "valid", headers: []string{"Bearer agent-service-secret"}, status: http.StatusNoContent},
		{name: "missing", status: http.StatusUnauthorized},
		{name: "wrong scheme", headers: []string{"bearer agent-service-secret"}, status: http.StatusUnauthorized},
		{name: "MCP Server credential", headers: []string{"Bearer mcp-publisher-secret"}, status: http.StatusUnauthorized},
		{name: "duplicate", headers: []string{"Bearer agent-service-secret", "Bearer agent-service-secret"}, status: http.StatusUnauthorized},
		{name: "combined values", headers: []string{"Bearer agent-service-secret, Bearer agent-service-secret"}, status: http.StatusUnauthorized},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodGet, "/protected", nil)
			for _, header := range test.headers {
				request.Header.Add("Authorization", header)
			}
			response := httptest.NewRecorder()
			engine.ServeHTTP(response, request)
			if response.Code != test.status {
				t.Fatalf("status=%d want=%d body=%s", response.Code, test.status, response.Body)
			}
			if response.Code == http.StatusUnauthorized {
				assertMcpContextError(t, response, teamhubinternal.McpContextErrorCodeUnauthenticated)
				if strings.Contains(response.Body.String(), "secret") {
					t.Fatal("authentication error leaked a credential")
				}
			}
		})
	}
}

func TestAuthenticateMcpAgentServiceFailsClosedWhenUnconfigured(t *testing.T) {
	gin.SetMode(gin.TestMode)
	a := &App{}
	engine := gin.New()
	engine.Use(func(c *gin.Context) { c.Set("request_id", "request-agent-unconfigured") })
	engine.GET("/protected", func(c *gin.Context) {
		if a.authenticateMcpAgentService(c) {
			c.Status(http.StatusNoContent)
		}
	})

	request := httptest.NewRequest(http.MethodGet, "/protected", nil)
	request.Header.Set("Authorization", "Bearer any-token")
	response := httptest.NewRecorder()
	engine.ServeHTTP(response, request)

	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("status=%d want=%d", response.Code, http.StatusServiceUnavailable)
	}
	assertMcpContextError(t, response, teamhubinternal.McpContextErrorCodeDependencyUnavailable)
}

func assertMcpContextError(
	t *testing.T,
	response *httptest.ResponseRecorder,
	want teamhubinternal.McpContextErrorCode,
) {
	t.Helper()
	var envelope teamhubinternal.McpContextErrorEnvelope
	if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil {
		t.Fatalf("decode error envelope: %v", err)
	}
	if envelope.Error.Code != want {
		t.Fatalf("code=%q want=%q", envelope.Error.Code, want)
	}
	if envelope.Error.RequestId == "" {
		t.Fatal("error envelope omitted request_id")
	}
}
