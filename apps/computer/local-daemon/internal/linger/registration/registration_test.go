package registration

import (
	"context"
	"errors"
	"testing"
)

func TestStoreUpsertPreservesOwnerScopedIdentity(t *testing.T) {
	store := openTestStore(t)
	first := Observation{RegistrationID: "reg-a", Key: Key{DaemonID: "daemon-1", TenantID: "tenant-a", OwnerActorID: "owner-a", ProviderType: "codex"}, Status: StatusOnline, Revision: 2}
	if _, err := store.Apply(context.Background(), first); err != nil {
		t.Fatal(err)
	}
	second := first
	second.RegistrationID = "reg-b"
	second.Key.TenantID = "tenant-b"
	if _, err := store.Apply(context.Background(), second); err != nil {
		t.Fatal(err)
	}
	items, err := store.List(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 2 {
		t.Fatalf("registrations = %d, want 2", len(items))
	}
}

func TestStoreRejectsRegistrationIdentityCollision(t *testing.T) {
	store := openTestStore(t)
	observation := Observation{RegistrationID: "reg-a", Key: Key{DaemonID: "daemon-1", TenantID: "tenant-a", OwnerActorID: "owner-a", ProviderType: "codex"}, Status: StatusOnline, Revision: 1}
	if _, err := store.Apply(context.Background(), observation); err != nil {
		t.Fatal(err)
	}
	observation.RegistrationID = "reg-b"
	if _, err := store.Apply(context.Background(), observation); !errors.Is(err, ErrIdentityCollision) {
		t.Fatalf("collision error = %v", err)
	}
}

func TestStoreReplacesRegistrationIdentityAtHigherRevision(t *testing.T) {
	store := openTestStore(t)
	observation := Observation{RegistrationID: "reg-a", Key: Key{DaemonID: "daemon-1", TenantID: "tenant-a", OwnerActorID: "owner-a", ProviderType: "codex"}, Status: StatusOnline, Revision: 1}
	if _, err := store.Apply(context.Background(), observation); err != nil {
		t.Fatal(err)
	}
	replacement := observation
	replacement.RegistrationID = "reg-b"
	replacement.Revision = 2
	if _, err := store.Apply(context.Background(), replacement); err != nil {
		t.Fatal(err)
	}
	items, err := store.List(context.Background())
	if err != nil || len(items) != 1 || !equalObservation(items[0], replacement) {
		t.Fatalf("replacement Registrations=%+v err=%v", items, err)
	}
}

func TestStoreIgnoresStaleObservation(t *testing.T) {
	store := openTestStore(t)
	observation := Observation{RegistrationID: "reg-a", Key: Key{DaemonID: "daemon-1", TenantID: "tenant-a", OwnerActorID: "owner-a", ProviderType: "codex"}, Status: StatusOnline, Revision: 2}
	if _, err := store.Apply(context.Background(), observation); err != nil {
		t.Fatal(err)
	}
	stale := observation
	stale.Revision = 1
	stale.Status = StatusOffline
	got, err := store.Apply(context.Background(), stale)
	if err != nil {
		t.Fatal(err)
	}
	if got.Revision != 2 || got.Status != StatusOnline {
		t.Fatalf("stale observation overwrote state: %+v", got)
	}
}

func TestStoreRejectsSameRevisionDrift(t *testing.T) {
	store := openTestStore(t)
	observation := Observation{RegistrationID: "reg-a", Key: Key{DaemonID: "daemon-1", TenantID: "tenant-a", OwnerActorID: "owner-a", ProviderType: "codex"}, Status: StatusOnline, Revision: 1}
	if _, err := store.Apply(context.Background(), observation); err != nil {
		t.Fatal(err)
	}
	observation.Status = StatusOffline
	if _, err := store.Apply(context.Background(), observation); !errors.Is(err, ErrRevisionConflict) {
		t.Fatalf("same revision drift error = %v", err)
	}
}

func openTestStore(t *testing.T) *MemoryStore {
	t.Helper()
	return NewMemoryStore()
}
