package lingercontext

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"testing"
)

// faultLog records SQLite fault events and runs onFault after each one, so a
// test can repair the database between the failed read and its retry.
type faultLog struct {
	attrs   []map[string]any
	onFault func()
}

func (h *faultLog) Enabled(context.Context, slog.Level) bool { return true }
func (h *faultLog) WithAttrs([]slog.Attr) slog.Handler       { return h }
func (h *faultLog) WithGroup(string) slog.Handler            { return h }
func (h *faultLog) Handle(_ context.Context, record slog.Record) error {
	if record.Message != "runner.context_view.sqlite_failed" {
		return nil
	}
	attrs := map[string]any{}
	record.Attrs(func(attr slog.Attr) bool {
		attrs[attr.Key] = attr.Value.Any()
		return true
	})
	h.attrs = append(h.attrs, attrs)
	if h.onFault != nil {
		h.onFault()
	}
	return nil
}

// A path that cannot be opened gives real SQLite errors on a new connection,
// for root as well. The store must log evidence, open a fresh connection and
// retry the read once.
func TestViewReadRecoversFromAReopenableSQLiteFailure(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.sqlite")
	store, err := OpenViewStore(path, filepath.Join(t.TempDir(), "views"), nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	ctx := context.Background()
	log := &faultLog{}
	store.logger = slog.New(log)

	breakDatabase := func() {
		if err := store.discardConnection(ctx); err != nil {
			t.Fatal(err)
		}
		if err := os.Rename(path, path+".moved"); err != nil {
			t.Fatal(err)
		}
		if err := os.Mkdir(path, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	repair := func() {
		if err := os.Remove(path); err != nil {
			t.Fatal(err)
		}
		if err := os.Rename(path+".moved", path); err != nil {
			t.Fatal(err)
		}
	}

	breakDatabase()
	log.onFault = func() { repair(); log.onFault = nil }
	if _, err := store.CurrentView(ctx, "missing", ""); !errors.Is(err, ErrContextConflict) {
		t.Fatalf("read after a fresh connection = %v, want the missing View conflict", err)
	}
	if len(log.attrs) != 1 || log.attrs[0]["operation"] != "read" || log.attrs[0]["reopen"] != true ||
		log.attrs[0]["sqlite_code"].(int64)&0xff != 14 || log.attrs[0]["db_exists"] != false {
		t.Fatalf("fault evidence = %#v", log.attrs)
	}
	var synchronous int
	if err := store.db.QueryRow("PRAGMA synchronous").Scan(&synchronous); err != nil || synchronous != 2 {
		t.Fatalf("fresh connection synchronous = %d, %v; want FULL", synchronous, err)
	}

	// Without a repair the single retry fails too, and the caller sees a
	// storage failure with its cause, not a conflict.
	log.attrs = nil
	breakDatabase()
	t.Cleanup(repair)
	_, err = store.CurrentView(ctx, "missing", "")
	if !errors.Is(err, ErrContextStorage) || errors.Is(err, ErrContextConflict) {
		t.Fatalf("unrepaired read = %v, want a storage failure", err)
	}
	if len(log.attrs) != 2 || log.attrs[0]["operation"] != "read" || log.attrs[1]["operation"] != "read_retry" {
		t.Fatalf("unrepaired fault evidence = %#v", log.attrs)
	}
}
