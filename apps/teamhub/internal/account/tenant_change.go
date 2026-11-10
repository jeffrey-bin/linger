package account

import (
	"context"
	"fmt"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/realtime"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

// tenantInvalidations maps each Tenant-level change to the browser hint it
// publishes.
var tenantInvalidations = map[string]string{
	"tenant.directory.changed":            realtime.InvalidateDirectory,
	"tenant.agent-availability.changed":   realtime.InvalidateAgents,
	"tenant.another-me.changed":           realtime.InvalidateAnotherMe,
	"tenant.local-computers.changed":      realtime.InvalidateComputers,
	"tenant.external-connections.changed": realtime.InvalidateConnections,
	"tenant.work-items.changed":           realtime.InvalidateWorkItems,
}

// PublishTenantChange tells the Tenant's browsers, after commit, that the
// resource behind a Tenant-level change must be refetched. PostgreSQL sends
// identical hints of one transaction once.
func PublishTenantChange(ctx context.Context, queries *store.Queries, tenantID, change string) error {
	resource, found := tenantInvalidations[change]
	if !found {
		return fmt.Errorf("unknown Tenant change %q", change)
	}
	return realtime.Invalidate(ctx, queries, realtime.Invalidation{TenantID: tenantID, Resource: resource, ID: tenantID})
}

// FanoutTenantAccountDeliveries is PublishTenantChange for the Work Item
// writer; the payload fields are not sent.
func FanoutTenantAccountDeliveries(
	ctx context.Context,
	queries *store.Queries,
	tenantID, change string,
	_ map[string]string,
) error {
	return PublishTenantChange(ctx, queries, tenantID, change)
}
