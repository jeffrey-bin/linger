package integration_test

import (
	"crypto/rand"
	"testing"
)

// A Yjs state vector keeps an entry for every client that ever edited the
// Document. Random client IDs and clocks do not compress, so the body row
// stores a state vector from hundreds of clients.
func TestDocumentBodyStoresAStateVectorFromHundredsOfClients(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newRoomDocumentRealtimeEnv(t)
	fixture := newMutationLinearizationFixture(t, env, alice, alice, "large-state-vector")
	vector := make([]byte, 500*8)
	if _, err := rand.Read(vector); err != nil {
		t.Fatal(err)
	}
	save := collaborationLockOrderSave(fixture, 0, 0)
	save.StateVector = vector
	seq, saved, err := saveDocumentBody(t.Context(), env.pool, save)
	if err != nil || !saved || seq != 1 {
		t.Fatalf("save seq=%d saved=%t error=%v", seq, saved, err)
	}
	if loaded, _ := loadRuntimeDocumentBody(t, env, fixture.document.ID); len(loaded.StateVector) != len(vector) {
		t.Fatalf("stored state vector has %d bytes", len(loaded.StateVector))
	}
}

// A save on a stale base updates nothing, so the Runtime can tell it from a
// committed save.
func TestDocumentBodySaveOnAStaleBaseChangesNothing(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newRoomDocumentRealtimeEnv(t)
	fixture := newMutationLinearizationFixture(t, env, alice, alice, "stale-body-save")
	if _, saved, err := saveDocumentBody(t.Context(), env.pool, collaborationLockOrderSave(fixture, 0, 0)); err != nil || !saved {
		t.Fatalf("first save saved=%t error=%v", saved, err)
	}
	if _, saved, err := saveDocumentBody(t.Context(), env.pool, collaborationLockOrderSave(fixture, 1, 0)); err != nil || saved {
		t.Fatalf("stale save saved=%t error=%v", saved, err)
	}
	loaded, _ := loadRuntimeDocumentBody(t, env, fixture.document.ID)
	if loaded.Seq != 1 || string(loaded.State) != string(collaborationLockOrderSave(fixture, 0, 0).State) {
		t.Fatalf("stale save changed the body seq=%d state=%q", loaded.Seq, loaded.State)
	}
}
