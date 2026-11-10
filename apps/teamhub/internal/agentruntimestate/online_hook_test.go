package agentruntimestate

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

// The online hooks see every observation of an online Computer, heartbeats
// included, so a hook that failed once tries again while the Computer stays
// connected. Offline observations do not reach them.
func TestOnlineHooksRunOnEveryOnlineObservation(t *testing.T) {
	computer := func(status, diagnostics string) store.LocalComputer {
		return store.LocalComputer{
			ComputerID: "computer_hook", Status: status, OwnerTenantID: "tenant_hook", OwnerActorID: "actor_hook",
			RuntimeInventory: []byte(`[]`), RuntimeDiagnostics: []byte(diagnostics), WorkspaceGrants: []byte(`[]`),
		}
	}
	const notReady = `[{"type":"codex","status":"not_installed"}]`
	const ready = `[{"type":"codex","status":"ready"}]`
	for _, test := range []struct {
		name              string
		previous, current store.LocalComputer
		want              int
	}{
		{"comes online", computer("offline", notReady), computer("online", notReady), 1},
		{"Runtime becomes ready while online", computer("online", notReady), computer("online", ready), 1},
		{"heartbeat while online", computer("online", ready), computer("online", ready), 1},
		{"goes offline", computer("online", ready), computer("offline", ready), 0},
	} {
		t.Run(test.name, func(t *testing.T) {
			calls := 0
			service := &Service{}
			service.OnLocalComputerOnline(func(_ context.Context, _ pgx.Tx, observed LocalComputer) error {
				if observed.ComputerID != "computer_hook" || observed.Owner.OwnerActorID != "actor_hook" {
					t.Fatalf("hook observed %+v", observed)
				}
				calls++
				return nil
			})
			if err := service.runOnlineHooks(t.Context(), nil, test.current); err != nil {
				t.Fatal(err)
			}
			if calls != test.want {
				t.Fatalf("hook calls=%d want %d", calls, test.want)
			}
		})
	}
}
