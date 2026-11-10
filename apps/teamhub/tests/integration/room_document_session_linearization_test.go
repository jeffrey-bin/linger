package integration_test

import (
	"net/http"
	"testing"
)

// A permission change or a trash commits before its response, so a body load
// that follows it sees a permission count the old token does not carry, or no
// active Document at all.
func TestOpenSessionLinearizesWithRevocationAndArchive(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newRoomDocumentRealtimeEnv(t)
	bob := seedPeerHuman(t, env)

	t.Run("membership revocation makes the earlier token stale", func(t *testing.T) {
		fixture := newMutationLinearizationFixture(t, env, alice, bob, "open-before-revoke")
		requireOpenedPermissionCount(t, env, fixture, fixture.credential.claims(t).PermissionCount)
		removal := deleteLinearizationResource(alice, env.server.URL+"/v0/rooms/"+fixture.roomID+"/members/actor_acme_bob", "")
		requireLinearizationStatus(t, removal, http.StatusNoContent, "membership revocation")
		if count := openedPermissionCount(t, env, fixture); count == fixture.credential.claims(t).PermissionCount {
			t.Fatalf("membership revocation left the permission count at the token's %d", count)
		}
	})

	t.Run("document archive refuses a later state load", func(t *testing.T) {
		fixture := newMutationLinearizationFixture(t, env, alice, alice, "archive-before-open")
		trash := deleteLinearizationResource(alice, env.server.URL+"/v0/documents/"+fixture.document.ID, "linearization-trash-"+fixture.suffix)
		requireLinearizationStatus(t, trash, http.StatusNoContent, "Document trash")
		if _, ok := loadRuntimeDocumentBody(t, env, fixture.document.ID); ok {
			t.Fatal("the Runtime loaded a trashed Document")
		}
	})
}

func requireOpenedPermissionCount(t *testing.T, env *testEnv, fixture mutationLinearizationFixture, want int64) {
	t.Helper()
	if got := openedPermissionCount(t, env, fixture); got != want {
		t.Fatalf("opened permission count=%d want=%d", got, want)
	}
}

func openedPermissionCount(t *testing.T, env *testEnv, fixture mutationLinearizationFixture) int64 {
	t.Helper()
	loaded, ok := loadRuntimeDocumentBody(t, env, fixture.credential.DocumentID)
	if !ok {
		t.Fatal("the Runtime found no active body")
	}
	return loaded.PermissionCount
}
