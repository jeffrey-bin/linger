package composio

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"strconv"
)

type AuthConfig struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	AuthScheme string `json:"auth_scheme"`
	Managed    bool   `json:"is_composio_managed"`
	Status     string `json:"status"`
	Toolkit    struct {
		Slug string `json:"slug"`
	} `json:"toolkit"`
}

// ValidateAPIKey makes the cheapest authenticated call, so a rejected key
// surfaces as an IsUnauthorized error.
func (c *Client) ValidateAPIKey(ctx context.Context) error {
	var page struct {
		Items []AuthConfig `json:"items"`
	}
	return c.requestJSON(ctx, http.MethodGet, "/api/v3.1/auth_configs?limit=1", nil, &page, "validate API key")
}

// FindAuthConfig finds the enabled auth config of toolkit named name with the
// given scheme, either Composio-managed or custom as managed says.
func (c *Client) FindAuthConfig(ctx context.Context, toolkit, name, scheme string, managed bool) (AuthConfig, bool, error) {
	cursor := ""
	seen := map[string]bool{}
	var selected AuthConfig
	for {
		query := url.Values{"toolkit_slug": {toolkit}, "is_composio_managed": {strconv.FormatBool(managed)}, "show_disabled": {"false"}, "limit": {"50"}, "search": {name}}
		if cursor != "" {
			query.Set("cursor", cursor)
		}
		var page struct {
			Items      []AuthConfig `json:"items"`
			NextCursor string       `json:"next_cursor"`
		}
		if err := c.requestJSON(ctx, http.MethodGet, "/api/v3.1/auth_configs?"+query.Encode(), nil, &page, "find application auth configuration"); err != nil {
			return AuthConfig{}, false, err
		}
		if page.Items == nil {
			return AuthConfig{}, false, errors.New("invalid auth configuration list")
		}
		for _, item := range page.Items {
			if item.ID != "" && item.Name == name && item.Managed == managed && item.AuthScheme == scheme && item.Toolkit.Slug == toolkit && item.Status == "ENABLED" {
				if selected.ID == "" || item.ID < selected.ID {
					selected = item
				}
			}
		}
		cursor = page.NextCursor
		if cursor == "" {
			break
		}
		if seen[cursor] {
			return AuthConfig{}, false, errors.New("repeated auth configuration cursor")
		}
		seen[cursor] = true
	}
	// Older deployments may have duplicate remote configs. Select consistently
	// across all pages without retaining them or deleting any remote credentials.
	return selected, selected.ID != "", nil
}

// CreateAuthConfig creates a Composio-managed auth config, or a custom one
// without credentials, whose connect link collects everything the scheme needs.
func (c *Client) CreateAuthConfig(ctx context.Context, toolkit, name, scheme string, managed bool) (AuthConfig, error) {
	authConfig := map[string]any{"type": "use_composio_managed_auth", "name": name, "auth_scheme": scheme}
	if !managed {
		authConfig = map[string]any{"type": "use_custom_auth", "name": name, "authScheme": scheme, "credentials": map[string]any{}}
	}
	request := map[string]any{"toolkit": map[string]string{"slug": toolkit}, "auth_config": authConfig}
	var response struct {
		Toolkit struct {
			Slug string `json:"slug"`
		} `json:"toolkit"`
		AuthConfig AuthConfig `json:"auth_config"`
	}
	// A timed-out write may have succeeded. Its caller reconciles by the stable
	// environment-specific name instead of retrying this POST.
	if err := c.requestJSONOnce(ctx, http.MethodPost, "/api/v3.1/auth_configs", request, &response, "create auth configuration"); err != nil {
		return AuthConfig{}, err
	}
	item := response.AuthConfig
	if item.ID == "" || item.Managed != managed || item.AuthScheme != scheme || response.Toolkit.Slug != toolkit {
		return AuthConfig{}, errors.New("invalid auth configuration response")
	}
	item.Toolkit.Slug = toolkit
	item.Name = name
	item.Status = "ENABLED"
	return item, nil
}
