package agentconnectedapps

import (
	"context"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/composio"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/externalsource"
)

type BindToolsInput struct {
	ConnectionID string   `json:"connection_id"`
	Version      string   `json:"tool_version"`
	Slugs        []string `json:"tool_slugs"`
}

// BindTools resolves exact, versioned tools. Structured commands do not use
// semantic discovery, and every result belongs to the same delegated account.
func (s *Service) BindTools(ctx context.Context, token string, input BindToolsInput) ([]AppTool, error) {
	if !connectionIDPattern.MatchString(input.ConnectionID) || !toolVersionPattern.MatchString(input.Version) || len(input.Slugs) < 1 || len(input.Slugs) > 24 {
		return nil, ErrInvalid
	}
	seen := map[string]bool{}
	for _, slug := range input.Slugs {
		if !toolSlugPattern.MatchString(slug) || seen[slug] {
			return nil, ErrInvalid
		}
		seen[slug] = true
	}
	if s == nil || s.pool == nil || s.provider == nil || s.contexts == nil || s.connections == nil {
		return nil, unavailableError(nil)
	}
	connection, err := s.authorizeExecution(ctx, token, input.ConnectionID)
	if err != nil {
		return nil, err
	}
	status, err := s.provider.GetConnectionStatusForToolkit(ctx, connection.UpstreamConnectionID, connection.ToolkitSlug)
	if err != nil {
		return nil, mapToolError(&providerOperationError{phase: "connection_status", err: err}, "search")
	}
	if status != composio.ConnectionActive {
		return nil, mapToolError(externalsource.ErrNotActive, "search")
	}
	result := make([]AppTool, 0, len(input.Slugs))
	for _, slug := range input.Slugs {
		tool, err := s.pinnedTool(ctx, connection, slug, input.Version, "search")
		if err != nil {
			return nil, err
		}
		if tool.InputParameters == nil {
			return nil, mapToolError(errToolNotFound, "search")
		}
		result = append(result, AppTool{ToolSlug: tool.Slug, ToolVersion: tool.Version, Name: tool.Name, Description: tool.Description, AppKey: connection.AppKey, InputSchema: tool.InputParameters})
	}
	current, err := s.authorizeExecution(ctx, token, input.ConnectionID)
	if err != nil {
		return nil, err
	}
	if current != connection {
		return nil, mapToolError(externalsource.ErrNotActive, "search")
	}
	return result, nil
}
