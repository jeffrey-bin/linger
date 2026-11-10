package app

import (
	"github.com/simplexai-labs/linger/apps/teamhub/internal/config"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/permissionreview"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/roomagent"
)

// registerPermissionReview builds the Runtime permission review. Its route
// always answers and allows every call without a judge, but the Agent Service
// asks it only when TeamHub reports one. Only a judge creates permission
// cards; they are decisions, decided, expired and handed off by the decision
// jobs.
func (a *App) registerPermissionReview(cfg config.PermissionReviewConfig, models *roomagent.ModelCallClient, injected permissionreview.Judge) {
	a.permissionReviews = &permissionreview.Service{Pool: a.pool, Cards: a.typedCards, Timeout: permissionReviewTimeout}
	switch {
	case injected != nil:
		a.permissionReviews.Judge = injected
	case cfg.Enabled && models != nil:
		a.permissionReviews.Judge = permissionreview.Client{Models: models, Timeout: permissionReviewTimeout}
	}
}

// permissionReviewEnabled reports whether this process has a Runtime
// permission judge. Without one the Agent Service declares no review, so no
// Runtime permission prompt makes the round trip to TeamHub.
func (a *App) permissionReviewEnabled() bool {
	return a.permissionReviews != nil && a.permissionReviews.Judge != nil
}
