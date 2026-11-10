package agentconnectedapps

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/composio"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/externalsource"
)

func TestSearchToolsInterleavesToolkitsAndProjectsDelegatedConnections(t *testing.T) {
	provider := &fakeToolProvider{toolsByToolkit: map[string][]composio.Tool{
		"gmail": {tool("GMAIL_ONE", "gmail"), tool("GMAIL_TWO", "gmail")},
		"slack": {tool("SLACK_ONE", "slack"), tool("SLACK_TWO", "slack")},
	}}
	service := &Service{provider: provider}
	connections := []externalsource.AgentToolConnection{
		{ID: "connection-slack", AccountID: "owner", UserID: "co_workspace:test:account:owner", UpstreamConnectionID: "ca-slack", AppKey: "slack", DisplayName: "Slack", ToolkitSlug: "slack"},
		{ID: "connection-gmail", AccountID: "owner", UserID: "co_workspace:test:account:owner", UpstreamConnectionID: "ca-gmail", AppKey: "gmail", DisplayName: "Gmail", ToolkitSlug: "gmail"},
	}

	tools, err := service.searchTools(context.Background(), connections, "send", 3)
	if err != nil {
		t.Fatal(err)
	}
	if len(provider.searches) != 2 || provider.searches[0].UserID != "co_workspace:test:account:owner" || provider.searches[0].ConnectedAccountID != "ca-gmail" || provider.searches[1].ConnectedAccountID != "ca-slack" {
		t.Fatalf("search must use the server-resolved owner and granted connection: %+v", provider.searches)
	}
	if len(tools) != 3 || tools[0].ToolSlug != "GMAIL_ONE" || tools[1].ToolSlug != "SLACK_ONE" || tools[2].ToolSlug != "GMAIL_TWO" {
		t.Fatalf("unexpected fair search result: %+v", tools)
	}
	if len(tools[0].AvailableConnections) != 1 || tools[0].AvailableConnections[0].ConnectionID != "connection-gmail" {
		t.Fatalf("unexpected delegated connection projection: %+v", tools[0].AvailableConnections)
	}
}

func TestSearchToolsDoesNotProjectUnrelatedToolkitsOrUnpinnedVersions(t *testing.T) {
	unversioned := tool("NOTION_READ", "notion")
	unversioned.Version = "latest"
	provider := &fakeToolProvider{toolsByToolkit: map[string][]composio.Tool{
		"notion": {tool("GMAIL_SEND_EMAIL", "gmail"), unversioned, tool("NOTION_GET_PAGE", "notion")},
	}}
	service := &Service{provider: provider}
	tools, err := service.searchTools(t.Context(), []externalsource.AgentToolConnection{{ID: "granted", AppKey: "notion", ToolkitSlug: "notion", AccountID: "owner", UpstreamConnectionID: "ca_granted"}}, "read Notion", 5)
	if err != nil || len(tools) != 1 || tools[0].ToolSlug != "NOTION_GET_PAGE" {
		t.Fatalf("tools=%+v err=%v", tools, err)
	}
	if tools[0].InputSchema["type"] != "object" {
		t.Fatal("discovery must retain complete inputs")
	}
	mapped := mapToolError(composio.ErrToolDiscovery, "search")
	if mapped.Code != "provider_unavailable" || !mapped.Retryable {
		t.Fatalf("discovery failure must not be mistaken for no capability: %+v", mapped)
	}
}

func TestSearchToolsKeepsAppsThatShareAToolkitApart(t *testing.T) {
	provider := &fakeToolProvider{toolsByToolkit: map[string][]composio.Tool{
		"outlook": {tool("OUTLOOK_SEND_EMAIL", "outlook"), tool("OUTLOOK_LIST_EVENTS", "outlook")},
	}}
	service := &Service{provider: provider}
	connections := []externalsource.AgentToolConnection{
		{ID: "connection-mail", AppKey: "outlook", ToolkitSlug: "outlook", UpstreamConnectionID: "ca-mail"},
		{ID: "connection-calendar", AppKey: "outlook_calendar", ToolkitSlug: "outlook", UpstreamConnectionID: "ca-calendar"},
	}
	tools, err := service.searchTools(t.Context(), connections, "events", 5)
	if err != nil {
		t.Fatal(err)
	}
	if len(provider.searches) != 2 || provider.searches[1].ConnectedAccountID != "ca-calendar" || provider.searches[1].Limit != maxSearchLimit {
		t.Fatalf("each app must search with its own connection: %+v", provider.searches)
	}
	var calendar []string
	for _, found := range tools {
		if len(found.AvailableConnections) != 1 || found.AvailableConnections[0].AppKey != found.AppKey {
			t.Fatalf("a tool must list only its own app's connections: %+v", found)
		}
		if found.AppKey == "outlook_calendar" {
			calendar = append(calendar, found.ToolSlug)
		}
	}
	if len(tools) != 3 || !reflect.DeepEqual(calendar, []string{"OUTLOOK_LIST_EVENTS"}) {
		t.Fatalf("Outlook Calendar must offer only calendar tools: %+v", tools)
	}
}

func TestOutlookCalendarAllowsOnlyCalendarTools(t *testing.T) {
	for slug, want := range map[string]bool{
		"OUTLOOK_LIST_EVENTS": true, "OUTLOOK_CALENDAR_CREATE_EVENT": true, "OUTLOOK_GET_SCHEDULE": true,
		"OUTLOOK_FIND_MEETING_TIMES": true, "OUTLOOK_LIST_REMINDERS": true, "OUTLOOK_GET_SUPPORTED_TIME_ZONES": true,
		"OUTLOOK_SEND_EMAIL": false, "OUTLOOK_LIST_MESSAGES": false, "OUTLOOK_CREATE_CONTACT": false,
		"OUTLOOK_CREATE_TASK": false, "GOOGLECALENDAR_EVENTS_LIST": false,
	} {
		if got := appAllowsTool("outlook_calendar", slug); got != want {
			t.Errorf("appAllowsTool(outlook_calendar, %s) = %t", slug, got)
		}
	}
	if !appAllowsTool("outlook", "OUTLOOK_LIST_EVENTS") || !appAllowsTool("outlook", "OUTLOOK_SEND_EMAIL") {
		t.Error("Outlook Mail keeps every Outlook tool")
	}
}

func TestExecutionErrorsAreNeverRetryableAfterDispatch(t *testing.T) {
	for _, cause := range []error{
		nil, errors.New("private provider error"), &composio.RateLimitError{},
		context.Canceled, context.DeadlineExceeded,
		composioHTTPError(t, http.StatusUnprocessableEntity),
		composioHTTPError(t, http.StatusServiceUnavailable),
	} {
		err := uncertainExecutionError(cause)
		if err.Code != "tool_execution_failed" || err.Retryable || err.Message != uncertainExecutionMessage || !errors.Is(err, cause) && cause != nil {
			t.Fatalf("unexpected execution error: %+v", err)
		}
	}
}

func TestOversizedResponseNamesItsIssue(t *testing.T) {
	oversized := dispatchedError(fmt.Errorf("execute: %w", composio.ErrResponseTooLarge))
	if oversized.Code != "tool_execution_failed" || oversized.Retryable || len(oversized.Issues) != 1 || oversized.Issues[0].Code != "response_too_large" {
		t.Fatalf("oversized response: %+v", oversized)
	}
	if codes := issueCodes(oversized); !reflect.DeepEqual(codes, []any{"issue_codes", []string{"response_too_large"}}) {
		t.Fatalf("call log codes=%v", codes)
	}
	if other := dispatchedError(errors.New("private provider error")); len(other.Issues) != 0 || issueCodes(other) != nil {
		t.Fatalf("other failures name no issue: %+v", other)
	}
}

func TestSanitizeValueRemovesSensitiveFieldsRecursively(t *testing.T) {
	value := map[string]any{
		"email": "alice@example.test", "api_key": "secret",
		"nested": map[string]any{
			"accessToken": "oauth-secret", "connected-account-id": "upstream-secret",
			"items": []any{map[string]any{"client_secret": "secret", "count": float64(3)}},
		},
	}
	want := map[string]any{
		"email":  "alice@example.test",
		"nested": map[string]any{"items": []any{map[string]any{"count": float64(3)}}},
	}
	if got := sanitizeValue(value); !reflect.DeepEqual(got, want) {
		t.Fatalf("sanitized=%#v want=%#v", got, want)
	}
}

func TestMapToolErrorBeforeDispatch(t *testing.T) {
	tests := []struct {
		name, phase, operation, code string
		status                       int
		retryable                    bool
	}{
		{"expired connection", "connection_status", "execute", "provider_auth_failed", http.StatusForbidden, false},
		{"pre-dispatch outage", "get_tool", "execute", "provider_unavailable", http.StatusServiceUnavailable, true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			mapped := mapToolError(&providerOperationError{phase: test.phase, err: composioHTTPError(t, test.status)}, test.operation)
			if mapped.Code != test.code || mapped.Retryable != test.retryable {
				t.Fatalf("mapped=%+v want code=%q retryable=%t", mapped, test.code, test.retryable)
			}
		})
	}
}

func composioHTTPError(t *testing.T, statusCode int) error {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.WriteHeader(statusCode)
	}))
	t.Cleanup(server.Close)
	client, err := composio.New(composio.Config{
		BaseURL: server.URL, APIKey: "restricted-key", EnvironmentKey: "test", HTTPClient: server.Client(),
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = client.GetTool(context.Background(), "GMAIL_GET_PROFILE", "20260721_00")
	if err == nil {
		t.Fatal("expected Composio HTTP error")
	}
	return err
}

type fakeToolProvider struct {
	toolsByToolkit map[string][]composio.Tool
	searches       []composio.ToolSearchRequest
}

func (provider *fakeToolProvider) SearchTools(_ context.Context, input composio.ToolSearchRequest) ([]composio.Tool, error) {
	provider.searches = append(provider.searches, input)
	return provider.toolsByToolkit[input.ToolkitSlug], nil
}
func (*fakeToolProvider) GetTool(context.Context, string, string) (composio.Tool, error) {
	return composio.Tool{}, nil
}
func (*fakeToolProvider) ExecuteTool(context.Context, string, string, string, string, map[string]any) (composio.ToolExecution, error) {
	return composio.ToolExecution{}, nil
}
func (*fakeToolProvider) GetConnectionStatusForToolkit(context.Context, string, string) (composio.ConnectionStatus, error) {
	return composio.ConnectionActive, nil
}

func tool(slug, toolkit string) composio.Tool {
	result := composio.Tool{
		Slug: slug, Version: "20260817_01", Name: slug,
		InputParameters: map[string]any{"type": "object"},
	}
	result.Toolkit.Slug = toolkit
	return result
}

func TestPinnedToolNamesAnUnavailableVersion(t *testing.T) {
	connection := externalsource.AgentToolConnection{ToolkitSlug: "gmail"}
	current := tool("GMAIL_SEND_EMAIL", "gmail")
	deprecated, newer := current, current
	deprecated.IsDeprecated = true
	newer.Version = "20261101_00"
	for name, provider := range map[string]*pinnedToolProvider{
		"deprecated":      {tool: deprecated},
		"another version": {tool: newer},
		"missing":         {err: composioHTTPError(t, http.StatusNotFound)},
	} {
		t.Run(name, func(t *testing.T) {
			_, err := (&Service{provider: provider}).pinnedTool(t.Context(), connection, current.Slug, current.Version, "execute")
			var domain *Error
			if !errors.As(err, &domain) || domain.Code != "tool_not_found" || len(domain.Issues) != 1 ||
				domain.Issues[0].Code != "tool_version_unavailable" || domain.Issues[0].Path != "tool_version" ||
				!strings.Contains(domain.Issues[0].Message, current.Slug) || !strings.Contains(domain.Issues[0].Message, current.Version) {
				t.Fatalf("err=%+v", err)
			}
		})
	}
	other := current
	other.Toolkit.Slug = "outlook"
	if _, err := (&Service{provider: &pinnedToolProvider{tool: other}}).pinnedTool(t.Context(), connection, current.Slug, current.Version, "execute"); !errors.Is(err, errToolNotFound) {
		t.Fatalf("a tool of another toolkit: err=%v", err)
	}
	if got, err := (&Service{provider: &pinnedToolProvider{tool: current}}).pinnedTool(t.Context(), connection, current.Slug, current.Version, "execute"); err != nil || got.Slug != current.Slug {
		t.Fatalf("tool=%+v err=%v", got, err)
	}
	calendar := externalsource.AgentToolConnection{AppKey: "outlook_calendar", ToolkitSlug: "outlook"}
	mail := tool("OUTLOOK_SEND_EMAIL", "outlook")
	mail.Version = current.Version
	if _, err := (&Service{provider: &pinnedToolProvider{tool: mail}}).pinnedTool(t.Context(), calendar, mail.Slug, mail.Version, "execute"); !errors.Is(err, errToolNotFound) {
		t.Fatalf("a mail tool on an Outlook Calendar connection: err=%v", err)
	}
}

type pinnedToolProvider struct {
	fakeToolProvider
	tool composio.Tool
	err  error
}

func (provider *pinnedToolProvider) GetTool(context.Context, string, string) (composio.Tool, error) {
	return provider.tool, provider.err
}
