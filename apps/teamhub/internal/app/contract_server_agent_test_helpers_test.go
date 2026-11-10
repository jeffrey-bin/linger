package app

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"

	"github.com/gin-gonic/gin"
	teamhubagentapi "github.com/simplexai-labs/linger/contracts-go/teamhubagentapi"
)

// Kept as the historical helper name while the task-list endpoint is retired;
// all Agent API contract tests use structural JSON comparison.
func assertAgentTaskJSONEqual(t *testing.T, got, want []byte) {
	t.Helper()
	var gotValue any
	var wantValue any
	if err := json.Unmarshal(got, &gotValue); err != nil {
		t.Fatalf("decode response JSON: %v", err)
	}
	if err := json.Unmarshal(want, &wantValue); err != nil {
		t.Fatalf("decode expected JSON: %v", err)
	}
	if !reflect.DeepEqual(gotValue, wantValue) {
		t.Fatalf("response=%s want=%s", got, want)
	}
}

func newAgentAPIContractTestEngine(a *App) *gin.Engine {
	engine := gin.New()
	engine.Use(func(c *gin.Context) { c.Set("request_id", "request-contract-test") })
	mountRouteGroup(engine, routeGroup{
		paramError: func(c *gin.Context, _ reflect.Type, _ error) {
			a.writeAgentAPIError(c, http.StatusBadRequest, teamhubagentapi.AgentApiErrorCodeInvalidRequest, "Agent API request parameters are invalid")
		},
		routes: a.agentAPIRoutes(),
	})
	return engine
}

func assertAgentAPIError(
	t *testing.T,
	response *httptest.ResponseRecorder,
	want teamhubagentapi.AgentApiErrorCode,
) {
	t.Helper()
	var envelope teamhubagentapi.AgentApiErrorEnvelope
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
