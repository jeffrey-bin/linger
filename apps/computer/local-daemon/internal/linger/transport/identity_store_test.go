package transport

import (
	"context"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/platform/privatefs"
)

func TestFileStorePersistsIdentityAcrossLoads(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state", "daemon-identity.json")
	store := IdentityFileStore{Path: path}
	first, err := store.LoadOrCreate(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	second, err := store.LoadOrCreate(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if second.DaemonID != first.DaemonID {
		t.Fatalf("daemon id changed: %q != %q", second.DaemonID, first.DaemonID)
	}
	if err := privatefs.CheckPath(path, "file", true); err != nil {
		t.Fatal(err)
	}
}

func TestFileStoreConcurrentCreatorsLoadThePublishedIdentity(t *testing.T) {
	store := IdentityFileStore{Path: filepath.Join(t.TempDir(), "state", "daemon-identity.json")}
	const count = 12
	identities := make([]Identity, count)
	errors := make([]error, count)
	var group sync.WaitGroup
	start := make(chan struct{})
	for i := range identities {
		group.Add(1)
		go func() {
			defer group.Done()
			<-start
			identities[i], errors[i] = store.LoadOrCreate(context.Background())
		}()
	}
	close(start)
	group.Wait()
	for i := range identities {
		if errors[i] != nil {
			t.Fatalf("creator %d: %v", i, errors[i])
		}
		if identities[i].DaemonID != identities[0].DaemonID {
			t.Fatalf("creator %d returned an unpublished identity", i)
		}
	}
	if err := privatefs.CheckPath(store.Path, "file", true); err != nil {
		t.Fatal(err)
	}
}

func TestFileStoreFailsClosedForUnsafeIdentityFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "daemon-identity.json")
	if err := os.WriteFile(path, []byte(`{"public_key":"bad","private_key":"bad"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := (IdentityFileStore{Path: path}).LoadOrCreate(context.Background()); err == nil {
		t.Fatal("unsafe identity file was accepted")
	}
}
