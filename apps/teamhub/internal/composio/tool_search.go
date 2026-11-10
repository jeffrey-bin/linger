package composio

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strings"
)

var (
	ErrToolDiscovery         = errors.New("Composio tool discovery failed")
	searchToolSlugPattern    = regexp.MustCompile(`^[A-Z0-9][A-Z0-9_]{1,199}$`)
	searchToolVersionPattern = regexp.MustCompile(`^[0-9]{8}_[0-9]{2}$`)
)

// ToolSearchRequest contains routing resolved by TeamHub from an active grant.
// None of these provider identity coordinates are accepted from the model.
type ToolSearchRequest struct {
	UserID, ConnectedAccountID, ToolkitSlug, Query string
	Limit                                          int
}

type routerSearchResponse struct {
	Error      json.RawMessage `json:"error"`
	Successful *bool           `json:"successful"`
	Data       struct {
		Success *bool           `json:"success"`
		Error   json.RawMessage `json:"error"`
		Results []struct {
			Primary []string `json:"primary_tool_slugs"`
			Related []string `json:"related_tool_slugs"`
		} `json:"results"`
		ToolSchemas map[string]json.RawMessage `json:"tool_schemas"`
	} `json:"data"`
}

// SearchTools uses task discovery, not the literal tool-catalog query endpoint.
// A fresh discovery-only session avoids stale routing across revocation, account
// changes or process restarts. It is never exposed or reused for execution.
func (c *Client) SearchTools(ctx context.Context, input ToolSearchRequest) ([]Tool, error) {
	binding, err := c.authorizeConnection(ctx, input.ConnectedAccountID)
	if err != nil {
		return nil, err
	}
	if binding.UserID != "" && (binding.UserID != input.UserID || binding.ToolkitSlug != input.ToolkitSlug) {
		return nil, ErrConnectionScope
	}
	if input.UserID == "" || input.ConnectedAccountID == "" || input.ToolkitSlug == "" ||
		strings.TrimSpace(input.Query) == "" || input.Limit < 1 || input.Limit > 50 {
		return nil, errors.New("invalid tool discovery request")
	}
	var session struct {
		ID string `json:"session_id"`
	}
	request := map[string]any{
		"user_id":            input.UserID,
		"connected_accounts": map[string]string{input.ToolkitSlug: input.ConnectedAccountID},
		"toolkits":           map[string]any{"enable": []string{input.ToolkitSlug}},
		"manage_connections": map[string]bool{"enable": false},
		"workbench":          map[string]bool{"enable": false},
	}
	if err := c.requestJSONOnce(ctx, http.MethodPost, "/api/v3/tool_router/session", request, &session, "create tool discovery session"); err != nil {
		return nil, err
	}
	if strings.TrimSpace(session.ID) == "" {
		return nil, ErrToolDiscovery
	}
	// An empty cached plan is not evidence that the application has no tools.
	// Retry discovery once using the provider's direct-search strategy. Neither
	// pass executes an app action; execution retries remain forbidden elsewhere.
	for _, strategy := range []string{"auto", "tool_search"} {
		var response routerSearchResponse
		request := map[string]any{
			"slug": "COMPOSIO_SEARCH_TOOLS",
			"arguments": map[string]any{
				"queries":         []map[string]string{{"use_case": input.Query}},
				"session":         map[string]bool{"generate_id": true},
				"search_strategy": strategy,
			},
		}
		endpoint := "/api/v3/tool_router/session/" + url.PathEscape(session.ID) + "/execute_meta"
		if err := c.requestJSON(ctx, http.MethodPost, endpoint, request, &response, "discover tools"); err != nil {
			return nil, err
		}
		if providerSearchFailed(response) {
			return nil, ErrToolDiscovery
		}
		tools, err := c.resolveSearchTools(ctx, input, response)
		if err != nil || len(tools) > 0 {
			return tools, err
		}
	}
	return []Tool{}, nil
}

func providerSearchFailed(response routerSearchResponse) bool {
	if response.Successful != nil && !*response.Successful || response.Data.Success != nil && !*response.Data.Success {
		return true
	}
	for _, raw := range []json.RawMessage{response.Error, response.Data.Error} {
		value := strings.TrimSpace(string(raw))
		if value != "" && value != "null" && value != `""` {
			return true
		}
	}
	// The API currently supplies data.success; older envelopes use successful.
	// A malformed 200 response must not masquerade as an empty search result.
	return response.Data.Success == nil && response.Successful == nil && response.Data.Results == nil && response.Data.ToolSchemas == nil
}

func (c *Client) resolveSearchTools(ctx context.Context, input ToolSearchRequest, response routerSearchResponse) ([]Tool, error) {
	slugs := make([]string, 0)
	for _, result := range response.Data.Results {
		slugs = append(slugs, result.Primary...)
	}
	for _, result := range response.Data.Results {
		slugs = append(slugs, result.Related...)
	}
	// Include schema-only candidates, deterministically after the ranked results.
	schemaSlugs := make([]string, 0, len(response.Data.ToolSchemas))
	for slug := range response.Data.ToolSchemas {
		schemaSlugs = append(schemaSlugs, slug)
	}
	sort.Strings(schemaSlugs)
	slugs = append(slugs, schemaSlugs...)
	tools := make([]Tool, 0, input.Limit)
	seen := make(map[string]bool)
	for _, slug := range slugs {
		if seen[slug] || !searchToolSlugPattern.MatchString(slug) {
			continue
		}
		seen[slug] = true
		if len(seen) > 100 {
			break
		}
		// Search hints/schemaRefs are not execution metadata. Resolve the current
		// concrete version and full schema, then enforce toolkit provenance.
		tool, err := c.GetTool(ctx, slug, "latest")
		if status, ok := ErrorStatus(err); ok && status == http.StatusNotFound {
			continue
		}
		if err != nil {
			return nil, err
		}
		if tool.Slug != slug || tool.Toolkit.Slug != input.ToolkitSlug || tool.IsDeprecated ||
			!searchToolVersionPattern.MatchString(tool.Version) || tool.InputParameters == nil {
			continue
		}
		tools = append(tools, tool)
		if len(tools) >= input.Limit {
			break
		}
	}
	return tools, nil
}
