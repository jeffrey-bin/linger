package account

import (
	"testing"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/realtime"
)

func TestTenantChangesMapToTenantHints(t *testing.T) {
	for eventType, resource := range tenantInvalidations {
		if !realtime.ValidInvalidationResource(resource) || resource == realtime.InvalidateRoom || resource == realtime.InvalidateDocument ||
			resource == realtime.InvalidateDocumentAccess {
			t.Fatalf("%s maps to %q, not a Tenant collection hint", eventType, resource)
		}
	}
}
