package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentauth"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/config"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/mcpcontext"
	"github.com/simplexai-labs/linger/contracts-go/teamhubinternal"
)

type fakeMcpContextService struct {
	resolve   func(context.Context, string, mcpcontext.ContextRef) (mcpcontext.ResolveResult, error)
	authorize func(context.Context, string, string) (agentauth.Authorization, error)
}

func TestMcpContextResolveProjectionCarriesNoSessionOrGeneration(t *testing.T) {
	for _, ref := range []mcpcontext.ContextRef{{Kind: "alter_ego", TaskID: "task_demo"}, {Kind: "meta", RoomID: "room_demo"}} {
		response, err := mcpContextResolveResponseToContract(mcpcontext.ResolveResult{AgentID: "agent_demo", Context: ref})
		if err != nil {
			t.Fatal(err)
		}
		raw, err := json.Marshal(response)
		if err != nil {
			t.Fatal(err)
		}
		for _, retired := range []string{`"context_generation_id"`, `"context_session_id"`, `"context_session_expires_at"`, `"document_pins"`} {
			if strings.Contains(string(raw), retired) {
				t.Fatalf("response=%s carries %s", raw, retired)
			}
		}
	}
}

func (f *fakeMcpContextService) Resolve(ctx context.Context, agentID string, ref mcpcontext.ContextRef) (mcpcontext.ResolveResult, error) {
	return f.resolve(ctx, agentID, ref)
}

func (f *fakeMcpContextService) Authorize(ctx context.Context, token, toolName string) (agentauth.Authorization, error) {
	return f.authorize(ctx, token, toolName)
}

func TestMcpInternalOperationsUseOperationSpecificCredentials(t *testing.T) {
	gin.SetMode(gin.TestMode)
	service := &fakeMcpContextService{
		resolve: func(_ context.Context, agentID string, ref mcpcontext.ContextRef) (mcpcontext.ResolveResult, error) {
			if agentID != "agent_demo" || ref != (mcpcontext.ContextRef{Kind: "meta", RoomID: "room_demo"}) {
				t.Fatalf("unexpected resolve arguments: agent=%q ref=%+v", agentID, ref)
			}
			return mcpcontext.ResolveResult{AgentID: agentID, Context: ref}, nil
		},
	}
	a := &App{
		cfg: config.ForTest(func(c *config.Config) {
			c.TeamHubInternalToken = "agent-service-secret"
		}),
		mcpContexts: service,
		agentAuth:   service,
	}
	engine := newMcpInternalContractTestEngine(a)

	tests := []struct {
		name       string
		method     string
		path       string
		credential string
		body       string
		status     int
	}{
		{
			name: "Agent Service resolves", method: http.MethodPost,
			path: "/internal/agents/agent_demo/mcp-context/actions/resolve", credential: "agent-service-secret",
			body: `{"context":{"kind":"meta","room_id":"room_demo"}}`, status: http.StatusOK,
		},
		{
			name: "MCP Server cannot resolve", method: http.MethodPost,
			path: "/internal/agents/agent_demo/mcp-context/actions/resolve", credential: "mcp-server-secret",
			body: `{"context":{"kind":"meta","room_id":"room_demo"}}`, status: http.StatusUnauthorized,
		},
		{
			name: "retired generation field is rejected", method: http.MethodPost,
			path: "/internal/agents/agent_demo/mcp-context/actions/resolve", credential: "agent-service-secret",
			body: `{"context":{"kind":"meta","room_id":"room_demo"},"context_generation":7}`, status: http.StatusBadRequest,
		},
		{
			name: "revoke is retired", method: http.MethodPost,
			path: "/internal/agents/agent_demo/mcp-context/actions/revoke", credential: "agent-service-secret",
			body: `{"context_session_id":"mcp_context_session_0123456789abcdef0123456789abcdef"}`, status: http.StatusNotFound,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(test.method, test.path, strings.NewReader(test.body))
			request.Header.Set("Authorization", "Bearer "+test.credential)
			response := httptest.NewRecorder()
			engine.ServeHTTP(response, request)
			if response.Code != test.status {
				t.Fatalf("status=%d want=%d body=%s", response.Code, test.status, response.Body)
			}
			if response.Code == http.StatusUnauthorized {
				assertMcpContextError(t, response, teamhubinternal.McpContextErrorCodeUnauthenticated)
			}
		})
	}
}

func TestRetiredInternalBusinessAndPublisherEndpointsAreAbsent(t *testing.T) {
	gin.SetMode(gin.TestMode)
	a := &App{cfg: config.ForTest(func(c *config.Config) {
		c.TeamHubInternalToken = "agent-service-secret"
	})}
	engine := newMcpInternalContractTestEngine(a)

	tests := []struct {
		method string
		path   string
		body   string
	}{
		{method: http.MethodPost, path: "/internal/mcp-context/actions/authorize", body: `{}`},
		{method: http.MethodPost, path: "/internal/v1/platform-mcp-manifests/actions/preflight", body: `{}`},
		{method: http.MethodPost, path: "/internal/v1/platform-mcp-manifests/actions/publish", body: `{}`},
		{method: http.MethodPost, path: "/internal/v1/platform-mcp-manifests/actions/activate", body: `{}`},
		{method: http.MethodGet, path: "/internal/v1/platform-mcp-manifests/linger_teamhub/active"},
		{method: http.MethodGet, path: "/internal/v1/platform-mcp-manifests/linger_teamhub/versions/1.0.0"},
	}
	for _, test := range tests {
		request := httptest.NewRequest(test.method, test.path, strings.NewReader(test.body))
		request.Header.Set("Authorization", "Bearer th_agent_"+strings.Repeat("A", 43))
		response := httptest.NewRecorder()
		engine.ServeHTTP(response, request)
		if response.Code != http.StatusNotFound {
			t.Fatalf("%s %s status=%d want=%d body=%s", test.method, test.path, response.Code, http.StatusNotFound, response.Body)
		}
	}
}

func TestMcpInternalOperationsRejectDuplicateAuthorizationHeaders(t *testing.T) {
	gin.SetMode(gin.TestMode)
	service := &fakeMcpContextService{
		resolve: func(context.Context, string, mcpcontext.ContextRef) (mcpcontext.ResolveResult, error) {
			t.Fatal("resolve was invoked after duplicate Authorization headers")
			return mcpcontext.ResolveResult{}, nil
		},
		authorize: func(context.Context, string, string) (agentauth.Authorization, error) {
			t.Fatal("authorize was invoked after duplicate Authorization headers")
			return agentauth.Authorization{}, nil
		},
	}
	a := &App{
		cfg: config.ForTest(func(c *config.Config) {
			c.TeamHubInternalToken = "agent-service-secret"
		}),
		mcpContexts: service,
		agentAuth:   service,
	}
	engine := newMcpInternalContractTestEngine(a)

	tests := []struct {
		name  string
		path  string
		token string
		body  string
	}{
		{name: "resolve", path: "/internal/agents/agent_demo/mcp-context/actions/resolve", token: "agent-service-secret", body: `{"context":{"kind":"meta","room_id":"room_demo"}}`},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodPost, test.path, strings.NewReader(test.body))
			request.Header.Add("Authorization", "Bearer "+test.token)
			request.Header.Add("Authorization", "Bearer "+test.token)
			response := httptest.NewRecorder()
			engine.ServeHTTP(response, request)
			if response.Code != http.StatusUnauthorized {
				t.Fatalf("status=%d want=%d body=%s", response.Code, http.StatusUnauthorized, response.Body)
			}
			assertMcpContextError(t, response, teamhubinternal.McpContextErrorCodeUnauthenticated)
		})
	}
}

func TestMcpContextResolveProjectionIncludesContextDiscriminator(t *testing.T) {
	tests := []struct {
		name    string
		context mcpcontext.ContextRef
		want    string
	}{
		{name: "meta", context: mcpcontext.ContextRef{Kind: "meta", RoomID: "room_demo"}, want: `"context":{"kind":"meta","room_id":"room_demo"}`},
		{name: "alterEgo", context: mcpcontext.ContextRef{Kind: "alter_ego", TaskID: "task_demo"}, want: `"context":{"kind":"alter_ego","task_id":"task_demo"}`},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			response, err := mcpContextResolveResponseToContract(mcpcontext.ResolveResult{
				AgentID: "agent_demo", Context: test.context,
			})
			if err != nil {
				t.Fatalf("project response: %v", err)
			}
			raw, err := json.Marshal(response)
			if err != nil {
				t.Fatalf("marshal response: %v", err)
			}
			if !strings.Contains(string(raw), test.want) {
				t.Fatalf("response=%s missing %s", raw, test.want)
			}
			if strings.Contains(string(raw), "skill") {
				t.Fatalf("response=%s carries Skill state", raw)
			}
		})
	}
}

func TestMcpContextResolveProjectionRejectsMetaWithoutRoom(t *testing.T) {
	if _, err := mcpContextRefToContract(mcpcontext.ContextRef{Kind: "meta"}); err == nil {
		t.Fatal("meta MCP Context without a Room was projected")
	}
}

func TestMcpContextReferenceParsingIsStrict(t *testing.T) {
	tests := []struct {
		name string
		raw  string
		want mcpcontext.ContextRef
		ok   bool
	}{
		{name: "meta", raw: `{"kind":"meta","room_id":"room_1"}`, want: mcpcontext.ContextRef{Kind: "meta", RoomID: "room_1"}, ok: true},
		{name: "meta without Room", raw: `{"kind":"meta"}`},
		{name: "meta with empty Room", raw: `{"kind":"meta","room_id":""}`},
		{name: "alterEgo", raw: `{"kind":"alter_ego","task_id":"task_1"}`, want: mcpcontext.ContextRef{Kind: "alter_ego", TaskID: "task_1"}, ok: true},
		{name: "meta with Task", raw: `{"kind":"meta","room_id":"room_1","task_id":"task_1"}`},
		{name: "alterEgo missing Task", raw: `{"kind":"alter_ego"}`},
		{name: "unknown kind", raw: `{"kind":"other"}`},
		{name: "unknown field", raw: `{"kind":"meta","room_id":"room_1","other":true}`},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			var reference teamhubinternal.McpContextReference
			if err := json.Unmarshal([]byte(test.raw), &reference); err != nil {
				t.Fatalf("decode union: %v", err)
			}
			got, err := mcpContextRefFromContract(reference)
			if (err == nil) != test.ok {
				t.Fatalf("error=%v want success=%v", err, test.ok)
			}
			if err == nil && got != test.want {
				t.Fatalf("reference=%+v want=%+v", got, test.want)
			}
		})
	}
}

func TestMcpContextServiceErrorMappingDoesNotLeakCredential(t *testing.T) {
	tests := []struct {
		name   string
		err    error
		status int
		code   teamhubinternal.McpContextErrorCode
	}{
		{name: "invalid request", err: mcpcontext.ErrInvalid, status: http.StatusBadRequest, code: teamhubinternal.McpContextErrorCodeInvalidRequest},
		{name: "invalid identity", err: mcpcontext.ErrIdentityInvalid, status: http.StatusForbidden, code: teamhubinternal.McpContextErrorCodeContextIdentityInvalid},
		{name: "dependency", err: mcpcontext.ErrDependencyFailed, status: http.StatusServiceUnavailable, code: teamhubinternal.McpContextErrorCodeDependencyUnavailable},
		{name: "unknown", err: errors.New("database rejected mcp_ctx_NEVER_LOG_THIS"), status: http.StatusInternalServerError, code: teamhubinternal.McpContextErrorCodeInternalError},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			var logs bytes.Buffer
			a := &App{logger: slog.New(slog.NewTextHandler(&logs, nil))}
			response := httptest.NewRecorder()
			context, _ := gin.CreateTestContext(response)
			context.Set("request_id", "request-error-test")
			if !a.writeMcpContextServiceError(context, "test MCP Context error", test.err) {
				t.Fatal("error was not handled")
			}
			if response.Code != test.status {
				t.Fatalf("status=%d want=%d", response.Code, test.status)
			}
			assertMcpContextError(t, response, test.code)
			if strings.Contains(response.Body.String(), "NEVER_LOG_THIS") || strings.Contains(logs.String(), "NEVER_LOG_THIS") {
				t.Fatal("MCP Context credential material leaked")
			}
		})
	}
}

func newMcpInternalContractTestEngine(a *App) *gin.Engine {
	engine := gin.New()
	engine.Use(func(c *gin.Context) { c.Set("request_id", "request-contract-test") })
	mountRouteGroup(engine, routeGroup{
		paramError: func(c *gin.Context, _ reflect.Type, _ error) {
			a.writeMcpContextError(c, http.StatusBadRequest, teamhubinternal.McpContextErrorCodeInvalidRequest, "MCP internal request parameters are invalid")
		},
		routes: a.mcpContextRoutes(),
	})
	return engine
}

func (f *fakeMcpContextService) AuthorizeInTx(ctx context.Context, tx pgx.Tx, token, toolName string) (agentauth.Authorization, error) {
	return f.Authorize(ctx, token, toolName)
}
