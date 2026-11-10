package agentregistry

import (
	"context"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/account"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

// createTenantDirectoryDeliveries tells the Tenant's browsers that its
// directory changed; the HTTP directory remains authoritative.
func createTenantDirectoryDeliveries(ctx context.Context, queries *store.Queries, tenantID string) error {
	return account.PublishTenantChange(ctx, queries, tenantID, "tenant.directory.changed")
}

// createTenantAnotherMeDeliveries tells the Tenant's browsers that an Another
// Me was created.
func createTenantAnotherMeDeliveries(ctx context.Context, queries *store.Queries, tenantID string) error {
	return account.PublishTenantChange(ctx, queries, tenantID, "tenant.another-me.changed")
}

func createTenantAgentDirectoryDeliveries(ctx context.Context, queries *store.Queries, tenantID string) error {
	if err := createTenantDirectoryDeliveries(ctx, queries, tenantID); err != nil {
		return err
	}
	return account.PublishTenantChange(ctx, queries, tenantID, "tenant.agent-availability.changed")
}
