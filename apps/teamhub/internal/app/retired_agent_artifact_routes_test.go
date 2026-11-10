package app

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/config"
)

func TestRetiredAgentArtifactRoutesAreAbsent(t *testing.T) {
	gin.SetMode(gin.TestMode)
	a := &App{cfg: config.ForTest(func(c *config.Config) {
		c.TeamHubInternalToken = "service-token"
	})}
	engine := gin.New()
	// A mistakenly mounted live handler has no services/DB to use: recovery would
	// produce 500, not the required router 404. Do not replace this with an empty router.
	engine.Use(gin.Recovery())
	a.registerContractRoutes(engine)
	for _, endpoint := range []struct{ method, path, body string }{
		{http.MethodPost, "/v0/agents/agent_existing/invocations", `{"request_id":"legacy","room_id":"room_existing","message_ids":["message_existing"],"initial_artifact_version_ids":["version_existing"]}`},
		{http.MethodGet, "/v0/agent-runs/run_missing/artifacts/version_missing/content", ""},
		{http.MethodPost, "/v0/agent-runs/run_missing/artifacts/version_missing/reads", `{}`},
		{http.MethodPost, "/v0/agent-runs/run_missing/outputs", `{"legacy":true}`},
		{http.MethodPost, "/v0/agent-runs/run_missing/steers", `{"message_ids":["message_existing"],"outcome":"pending"}`},
		{http.MethodPost, "/v0/agent-runs/run_missing/reconcile", `{"outcome":"pending"}`},
		{http.MethodPut, "/v0/agent-run-transfers/historical-token", "legacy"},
		{http.MethodPost, "/v0/rooms/room_existing/agents/agent_existing/artifacts", `{"relative_path":"reports/result.txt"}`},
		{http.MethodPost, "/v0/rooms/room_existing/agents/agent_existing/artifacts/artifact_existing/versions", `{"relative_path":"reports/result.txt"}`},
	} {
		assertRetiredAgentRoute(t, engine, endpoint.method, endpoint.path, endpoint.body, "service-token")
	}
	for _, runID := range []string{"run_existing", "run_missing"} {
		for _, token := range []string{"valid-run-token", "invalid-run-token"} {
			for _, body := range []string{
				`{"kind":"output_upload","metadata":{"upload_key":"legacy","filename":"result.txt","media_type":"text/plain","size_bytes":12,"sha256":"` + strings.Repeat("a", 64) + `","publication":{"kind":"create_new","relative_path":"outputs/result.txt","expected_absent":true}}}`,
				`{"kind":"unknown_transfer"}`,
				`{"kind":"document_revision_download","input_id":"legacy-input"}`,
				`{"kind":"document_revision_asset_download","input_id":"legacy-input","asset_id":"legacy-asset"}`,
			} {
				assertRetiredAgentRoute(t, engine, http.MethodPost, "/v0/agent-runs/"+runID+"/transfer-capabilities", body, token)
			}
		}
	}
}

func assertRetiredAgentRoute(t *testing.T, engine *gin.Engine, method, requestPath, body, token string) {
	t.Helper()
	request := httptest.NewRequest(method, requestPath, strings.NewReader(body))
	request.Header.Set("Authorization", "Bearer "+token)
	if method == http.MethodPut {
		request.Header.Set("Content-Type", "application/octet-stream")
	} else {
		request.Header.Set("Content-Type", "application/json")
	}
	response := httptest.NewRecorder()
	engine.ServeHTTP(response, request)
	if response.Code != http.StatusNotFound {
		t.Fatalf("%s %s status=%d body=%s", method, requestPath, response.Code, response.Body)
	}
}
