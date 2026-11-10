package app

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentauth"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/messagecreation"
)

// newAgentAPITargetRouter mirrors the production request_id middleware that
// App.writeError relies on.
func newAgentAPITargetRouter() *gin.Engine {
	router := gin.New()
	router.Use(func(c *gin.Context) {
		c.Set("request_id", "request_test")
		c.Next()
	})
	return router
}

func decodeAgentAPIError(t *testing.T, response *httptest.ResponseRecorder) (code, requestID string) {
	t.Helper()
	var body struct {
		Error struct {
			Code      string `json:"code"`
			RequestID string `json:"request_id"`
		} `json:"error"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode error body %q: %v", response.Body.String(), err)
	}
	return body.Error.Code, body.Error.RequestID
}

func TestAgentAPIDoesNotAcceptCallerExecutionAuthority(t *testing.T) {
	for _, body := range []string{`{"execution_run_ref":"someone-elses-run"}`, `{"context_session_id":"session"}`, `{"expected_manifest_digest":"digest"}`, `{"source_inbox_ids":["room:unrelated"]}`} {
		router := newAgentAPITargetRouter()
		router.POST("/api/agent/v1/messages", (&App{}).agentAPITarget, func(c *gin.Context) { c.Status(http.StatusNoContent) })
		req := httptest.NewRequest(http.MethodPost, "/api/agent/v1/messages", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer th_agent_"+strings.Repeat("a", 43))
		response := httptest.NewRecorder()
		router.ServeHTTP(response, req)
		if response.Code != http.StatusBadRequest {
			t.Errorf("accepted execution claim %s: %d", body, response.Code)
		}
		if code, requestID := decodeAgentAPIError(t, response); code != "INVALID_REQUEST" || requestID != "request_test" {
			t.Errorf("execution claim error code=%q request_id=%q", code, requestID)
		}
	}
}

// The CLI names the Run it serves in a header. The message core checks the
// claim before keeping it; a malformed or repeated header is rejected.
func TestAgentAPIRunHeader(t *testing.T) {
	for _, test := range []struct {
		runIDs     []string
		wantStatus int
		wantClaim  string
	}{
		{wantStatus: http.StatusNoContent},
		{runIDs: []string{"run_1"}, wantStatus: http.StatusNoContent, wantClaim: "run_1"},
		{runIDs: []string{"bad run"}, wantStatus: http.StatusBadRequest},
		{runIDs: []string{""}, wantStatus: http.StatusBadRequest},
		{runIDs: []string{"run_1", "run_2"}, wantStatus: http.StatusBadRequest},
	} {
		router := newAgentAPITargetRouter()
		router.POST("/api/agent/v1/messages", (&App{}).agentAPITarget, func(c *gin.Context) {
			if claim := messagecreation.RunClaim(c.Request.Context()); claim != test.wantClaim {
				t.Errorf("Run header %q claim=%q want %q", test.runIDs, claim, test.wantClaim)
			}
			c.Status(http.StatusNoContent)
		})
		req := httptest.NewRequest(http.MethodPost, "/api/agent/v1/messages", strings.NewReader(`{}`))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer th_agent_"+strings.Repeat("a", 43))
		for _, runID := range test.runIDs {
			req.Header.Add("X-TeamHub-Run-Id", runID)
		}
		response := httptest.NewRecorder()
		router.ServeHTTP(response, req)
		if response.Code != test.wantStatus {
			t.Errorf("Run header %q status=%d want %d", test.runIDs, response.Code, test.wantStatus)
		}
		if test.wantStatus == http.StatusBadRequest {
			if code, _ := decodeAgentAPIError(t, response); code != "INVALID_REQUEST" {
				t.Errorf("Run header %q error code=%q", test.runIDs, code)
			}
		}
	}
}

func TestAgentAPIPreservesBusinessInput(t *testing.T) {
	for _, test := range []struct{ route, token, body string }{
		{"/api/agent/v1/messages", "th_agent_" + strings.Repeat("a", 43), `{"text":"hello","invocation_id":"operation"}`},
		{"/api/agent/v1/files/file/body", "th_agent_" + strings.Repeat("a", 43), `[{"type":"paragraph","content":"execution_run_ref"}]`},
	} {
		router := newAgentAPITargetRouter()
		router.POST(test.route, (&App{}).agentAPITarget, func(c *gin.Context) {
			body, err := io.ReadAll(c.Request.Body)
			if err != nil || string(body) != test.body {
				t.Errorf("business input changed: %q, %v", body, err)
			}
			c.Status(http.StatusNoContent)
		})
		req := httptest.NewRequest(http.MethodPost, test.route, strings.NewReader(test.body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+test.token)
		response := httptest.NewRecorder()
		router.ServeHTTP(response, req)
		if response.Code != http.StatusNoContent {
			t.Errorf("valid input rejected at %s: %d", test.route, response.Code)
		}
	}
}

func TestAgentAPIRejectsRuntimeAndServiceCredentials(t *testing.T) {
	for _, token := range []string{"mcp_ctx_" + strings.Repeat("a", 43), "agent-service-token", ""} {
		router := newAgentAPITargetRouter()
		router.POST("/api/agent/v1/messages", (&App{}).agentAPITarget, func(c *gin.Context) {
			t.Error("business handler accepted a non-Agent credential")
			c.Status(http.StatusNoContent)
		})
		req := httptest.NewRequest(http.MethodPost, "/api/agent/v1/messages", strings.NewReader(`{}`))
		req.Header.Set("Authorization", "Bearer "+token)
		response := httptest.NewRecorder()
		router.ServeHTTP(response, req)
		if response.Code != http.StatusUnauthorized {
			t.Errorf("credential family accepted: %d", response.Code)
		}
		if code, requestID := decodeAgentAPIError(t, response); code != "UNAUTHENTICATED" || requestID != "request_test" {
			t.Errorf("credential error code=%q request_id=%q", code, requestID)
		}
	}
}

// The CLI sends its configured Context. There is no Agent-wide Context: a
// request either names a business resource or sends no Context at all.
func TestAgentAPIContextKinds(t *testing.T) {
	for _, test := range []struct {
		kind, id   string
		wantStatus int
		wantTarget agentauth.Target
	}{
		{wantStatus: http.StatusNoContent},
		{kind: "room", id: "room_1", wantStatus: http.StatusNoContent, wantTarget: agentauth.Target{Kind: "room", ID: "room_1"}},
		{kind: "task", id: "task_1", wantStatus: http.StatusNoContent, wantTarget: agentauth.Target{Kind: "task", ID: "task_1"}},
		{kind: "document", id: "document_1", wantStatus: http.StatusNoContent, wantTarget: agentauth.Target{Kind: "document", ID: "document_1"}},
		{kind: "thread", id: "thread_1", wantStatus: http.StatusNoContent, wantTarget: agentauth.Target{Kind: "thread", ID: "thread_1"}},
		{kind: "agent", id: "agent_1", wantStatus: http.StatusBadRequest},
		{kind: "meta", id: "room_1", wantStatus: http.StatusBadRequest},
	} {
		router := newAgentAPITargetRouter()
		router.POST("/api/agent/v1/messages", (&App{}).agentAPITarget, func(c *gin.Context) {
			if target := agentauth.TargetFromContext(c.Request.Context()); target != test.wantTarget {
				t.Errorf("Context %s=%q target=%+v want %+v", test.kind, test.id, target, test.wantTarget)
			}
			c.Status(http.StatusNoContent)
		})
		req := httptest.NewRequest(http.MethodPost, "/api/agent/v1/messages", strings.NewReader(`{}`))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer th_agent_"+strings.Repeat("a", 43))
		if test.kind != "" {
			req.Header.Set("X-TeamHub-Context-Kind", test.kind)
			req.Header.Set("X-TeamHub-Context-Id", test.id)
		}
		response := httptest.NewRecorder()
		router.ServeHTTP(response, req)
		if response.Code != test.wantStatus {
			t.Errorf("Context %s=%q status=%d want %d", test.kind, test.id, response.Code, test.wantStatus)
		}
		if test.wantStatus == http.StatusBadRequest {
			if code, _ := decodeAgentAPIError(t, response); code != "INVALID_REQUEST" {
				t.Errorf("Context %s=%q error code=%q", test.kind, test.id, code)
			}
		}
	}
}
