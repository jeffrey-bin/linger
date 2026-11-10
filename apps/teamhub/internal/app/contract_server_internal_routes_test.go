package app

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/config"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voicemedia"
)

// The internal contract is registered once; each caller still gets its own
// credential check and parameter error body.
func TestInternalContractRoutesKeepEachCallersCheck(t *testing.T) {
	gin.SetMode(gin.TestMode)
	a := &App{
		cfg: config.ForTest(func(c *config.Config) {
			c.Voice.RuntimeToken = "voice-token"
			c.TeamHubInternalToken = "teamhub-internal-token"
		}),
		// Voice Runtime callbacks answer only with voice media on.
		voiceMedia: voicemedia.New(nil, nil, nil),
	}
	engine := gin.New()
	engine.Use(func(c *gin.Context) { c.Set("request_id", "request-contract-test") })
	a.registerContractRoutes(engine)

	for _, test := range []struct {
		name, method, path string
		header             http.Header
		status             int
		body               string
	}{
		{
			name: "voice runtime", method: http.MethodPost, path: "/internal/v1/voice/observations",
			header: http.Header{"Authorization": {"Bearer teamhub-internal-token"}},
			status: http.StatusUnauthorized, body: `{"code":"UNAUTHENTICATED","message":"Voice Runtime authentication is invalid"}`,
		},
		{
			name: "agent service rejects the voice credential", method: http.MethodGet, path: "/v0/agent-runtime/config?agent_id=agent_1",
			header: http.Header{"Authorization": {"Bearer voice-token"}},
			status: http.StatusUnauthorized, body: `"code":"UNAUTHENTICATED"`,
		},
		{
			name: "voice runtime parameters", method: http.MethodPut, path: "/internal/v1/voice/media-objects",
			status: http.StatusBadRequest, body: `{"code":"INVALID_REQUEST","message":"Voice Runtime request is invalid"}`,
		},
		{
			name: "mcp context", method: http.MethodPost, path: "/internal/agents/agent_1/mcp-context/actions/resolve",
			header: http.Header{"X-Teamhub-Context-Kind": {"room"}},
			status: http.StatusBadRequest, body: `"message":"Specify one business context kind and identifier"`,
		},
		{
			name: "agent service", method: http.MethodPost, path: "/v0/agent-runtime/contexts/recently-used",
			header: http.Header{"X-Teamhub-Context-Kind": {"room"}},
			status: http.StatusBadRequest, body: `"message":"Specify one business context kind and identifier"`,
		},
		{
			name: "agent CLI file parameters", method: http.MethodGet, path: "/api/agent/v1/files?limit=many",
			status: http.StatusBadRequest, body: `"code":"INVALID_REQUEST"`,
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(test.method, test.path, strings.NewReader("{}"))
			for name, values := range test.header {
				request.Header[name] = values
			}
			response := httptest.NewRecorder()
			engine.ServeHTTP(response, request)
			if response.Code != test.status || !strings.Contains(response.Body.String(), test.body) {
				t.Fatalf("status=%d body=%s want %d with %s", response.Code, response.Body.String(), test.status, test.body)
			}
		})
	}
}
