package agentruntimestate

import (
	"context"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

// Read-only observation of recent Runs, never an execution lease.
const (
	recentlyUsedWindowSeconds = 24 * 60 * 60
	recentlyUsedRowLimit      = 200
)

// ListRecentlyUsedContexts returns Context keys of active Agents with a Local
// Run in the window, most recent first.
func (s *Service) ListRecentlyUsedContexts(ctx context.Context) ([]string, error) {
	if s == nil || s.pool == nil {
		return nil, ErrInvalid
	}
	return store.New(s.pool).ListRecentlyUsedAgentExecutionContexts(ctx, store.ListRecentlyUsedAgentExecutionContextsParams{
		WindowSeconds: recentlyUsedWindowSeconds, RowLimit: recentlyUsedRowLimit,
	})
}
