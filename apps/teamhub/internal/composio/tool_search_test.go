package composio

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
)

func TestToolSearchUsesRouterForNaturalLanguageAndResolvesExecutableMetadata(t *testing.T) {
	const query = "Notion API search pages get page retrieve blocks content read page update page"
	var calls []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls = append(calls, r.Method+" "+r.URL.Path)
		switch r.URL.Path {
		case "/api/v3/tool_router/session":
			var body map[string]any
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Error(err)
			}
			if body["user_id"] != "linger:test:account:owner" || !reflect.DeepEqual(body["connected_accounts"], map[string]any{"notion": "ca_authorized"}) || !reflect.DeepEqual(body["toolkits"], map[string]any{"enable": []any{"notion"}}) ||
				!reflect.DeepEqual(body["manage_connections"], map[string]any{"enable": false}) ||
				!reflect.DeepEqual(body["workbench"], map[string]any{"enable": false}) {
				t.Errorf("search session must be restricted: %#v", body)
			}
			_, _ = w.Write([]byte(`{"session_id":"router_1"}`))
		case "/api/v3/tool_router/session/router_1/execute_meta":
			var body struct {
				Slug      string `json:"slug"`
				Arguments struct {
					Queries []struct {
						UseCase string `json:"use_case"`
					} `json:"queries"`
				} `json:"arguments"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Error(err)
			}
			if body.Slug != "COMPOSIO_SEARCH_TOOLS" || len(body.Arguments.Queries) != 1 || body.Arguments.Queries[0].UseCase != query {
				t.Errorf("unexpected discovery request: %+v", body)
			}
			_, _ = w.Write([]byte(`{"data":{"results":[{"primary_tool_slugs":["NOTION_GET_PAGE_MARKDOWN","NOTION_GET_PAGE_MARKDOWN"],"related_tool_slugs":["GMAIL_SEND_EMAIL","NOTION_OLD","NOTION_INVALID_VERSION","NOTION_MISMATCH","NOTION_NO_SCHEMA","NOTION_MISSING"]}],"tool_schemas":{"NOTION_GET_PAGE_MARKDOWN":{"input_schema":{"untrusted":true}}},"success":true},"error":null}`))
		case "/api/v3/tools/NOTION_GET_PAGE_MARKDOWN":
			if r.URL.Query().Get("version") != "latest" {
				t.Error("must resolve current concrete version")
			}
			_, _ = w.Write([]byte(`{"slug":"NOTION_GET_PAGE_MARKDOWN","name":"Read page","version":"20260911_00","toolkit":{"slug":"notion"},"input_parameters":{"type":"object","required":["page_id"]},"output_parameters":{"type":"object"}}`))
		case "/api/v3/tools/GMAIL_SEND_EMAIL":
			_, _ = w.Write([]byte(`{"slug":"GMAIL_SEND_EMAIL","version":"20260911_00","toolkit":{"slug":"gmail"}}`))
		case "/api/v3/tools/NOTION_INVALID_VERSION":
			_, _ = w.Write([]byte(`{"slug":"NOTION_INVALID_VERSION","version":"latest","toolkit":{"slug":"notion"},"input_parameters":{}}`))
		case "/api/v3/tools/NOTION_MISMATCH":
			_, _ = w.Write([]byte(`{"slug":"NOTION_OTHER","version":"20260911_00","toolkit":{"slug":"notion"},"input_parameters":{}}`))
		case "/api/v3/tools/NOTION_NO_SCHEMA":
			_, _ = w.Write([]byte(`{"slug":"NOTION_NO_SCHEMA","version":"20260911_00","toolkit":{"slug":"notion"}}`))
		case "/api/v3/tools/NOTION_MISSING":
			w.WriteHeader(http.StatusNotFound)
		case "/api/v3/tools/NOTION_OLD":
			_, _ = w.Write([]byte(`{"slug":"NOTION_OLD","version":"20260911_00","toolkit":{"slug":"notion"},"is_deprecated":true}`))
		default:
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(server.Close)
	client, err := newTestClient(Config{BaseURL: server.URL, APIKey: "test-key", HTTPClient: server.Client(), RetryLimit: -1})
	if err != nil {
		t.Fatal(err)
	}
	tools, err := client.SearchTools(t.Context(), ToolSearchRequest{UserID: "linger:test:account:owner", ConnectedAccountID: "ca_authorized", ToolkitSlug: "notion", Query: query, Limit: 5})
	if err != nil {
		t.Fatal(err)
	}
	if len(tools) != 1 || tools[0].Slug != "NOTION_GET_PAGE_MARKDOWN" || tools[0].Version != "20260911_00" || tools[0].InputParameters["type"] != "object" {
		t.Fatalf("search must return only executable, verified Notion metadata: %+v", tools)
	}
	if len(calls) != 9 {
		t.Fatalf("duplicate candidates must not be fetched twice: %v", calls)
	}
}

func TestToolSearchRetriesEmptyPlansOnceAndDoesNotHideProviderFailures(t *testing.T) {
	tests := []struct {
		name, response string
		wantError      bool
		wantSearches   int
	}{
		{"empty", `{"data":{"success":true,"results":[],"tool_schemas":{}}}`, false, 2},
		{"provider failure", `{"data":{"success":false,"error":"private upstream details"}}`, true, 1},
		{"envelope failure", `{"error":"private upstream details"}`, true, 1},
		{"malformed success", `{}`, true, 1},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			var strategies []string
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/api/v3/tool_router/session" {
					_, _ = w.Write([]byte(`{"session_id":"s1"}`))
					return
				}
				if r.URL.Path != "/api/v3/tool_router/session/s1/execute_meta" {
					t.Errorf("unexpected %s", r.URL.Path)
				}
				var body struct {
					Arguments struct {
						Strategy string `json:"search_strategy"`
					} `json:"arguments"`
				}
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					t.Error(err)
				}
				strategies = append(strategies, body.Arguments.Strategy)
				_, _ = w.Write([]byte(test.response))
			}))
			t.Cleanup(server.Close)
			client, err := newTestClient(Config{BaseURL: server.URL, APIKey: "key", HTTPClient: server.Client(), RetryLimit: -1})
			if err != nil {
				t.Fatal(err)
			}
			tools, err := client.SearchTools(t.Context(), ToolSearchRequest{UserID: "owner", ConnectedAccountID: "ca_1", ToolkitSlug: "notion", Query: "read a Notion page", Limit: 5})
			if (err != nil) != test.wantError || len(tools) != 0 {
				t.Fatalf("tools=%+v err=%v", tools, err)
			}
			if err != nil && strings.Contains(err.Error(), "private") {
				t.Fatalf("provider failure leaked: %v", err)
			}
			if len(strategies) != test.wantSearches || strategies[0] != "auto" || len(strategies) == 2 && strategies[1] != "tool_search" {
				t.Fatalf("strategies=%v", strategies)
			}
		})
	}
}

func TestToolSearchFreshSessionUsesCurrentConnectionAndSchemaOnlyCandidates(t *testing.T) {
	var connectedAccounts []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v3/tool_router/session":
			var body struct {
				ConnectedAccounts map[string]string `json:"connected_accounts"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Error(err)
			}
			connectedAccounts = append(connectedAccounts, body.ConnectedAccounts["notion"])
			_, _ = w.Write([]byte(`{"session_id":"s1"}`))
		case "/api/v3/tool_router/session/s1/execute_meta":
			_, _ = w.Write([]byte(`{"data":{"success":true,"tool_schemas":{"NOTION_READ":{"schemaRef":"opaque-ref"},"../escape":{}}}}`))
		case "/api/v3/tools/NOTION_READ":
			_, _ = w.Write([]byte(`{"slug":"NOTION_READ","name":"Read","version":"20260911_00","toolkit":{"slug":"notion"},"input_parameters":{"type":"object"}}`))
		default:
			t.Errorf("unexpected %s", r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(server.Close)
	client, err := newTestClient(Config{BaseURL: server.URL, APIKey: "key", HTTPClient: server.Client(), RetryLimit: -1})
	if err != nil {
		t.Fatal(err)
	}
	for _, connection := range []string{"ca_before", "ca_after"} {
		tools, err := client.SearchTools(t.Context(), ToolSearchRequest{UserID: "owner", ConnectedAccountID: connection, ToolkitSlug: "notion", Query: "read a Notion page", Limit: 1})
		if err != nil || len(tools) != 1 {
			t.Fatalf("tools=%+v err=%v", tools, err)
		}
	}
	if !reflect.DeepEqual(connectedAccounts, []string{"ca_before", "ca_after"}) {
		t.Fatalf("stale session routing: %v", connectedAccounts)
	}
}
