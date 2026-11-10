package lingercontext

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"
	"testing"
)

// A failed SQLite read must keep its cause instead of posing as a conflict,
// which callers treat as a permanent refusal.
func TestViewReadsKeepStorageFailuresDistinctFromConflicts(t *testing.T) {
	store, err := OpenViewStore(filepath.Join(t.TempDir(), "state.sqlite"), filepath.Join(t.TempDir(), "views"), nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	ctx := context.Background()
	ref, _ := json.Marshal(ViewRef{ViewDigest: strings.Repeat("d", 64)})

	if _, err := store.CurrentView(ctx, "missing", ""); !errors.Is(err, ErrContextConflict) {
		t.Fatalf("missing View = %v, want conflict", err)
	}
	if err := store.db.Close(); err != nil {
		t.Fatal(err)
	}
	_, current := store.CurrentView(ctx, "key", "")
	_, workspace := store.ValidatedWorkspace(ctx, "key", ref)
	for name, err := range map[string]error{"CurrentView": current, "ValidatedWorkspace": workspace} {
		if !errors.Is(err, ErrContextStorage) || errors.Is(err, ErrContextConflict) || err.Error() == ErrContextStorage.Error() {
			t.Fatalf("%s = %v, want a storage failure with its cause", name, err)
		}
	}
}
