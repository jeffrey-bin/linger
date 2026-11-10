package sqlitedb

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"testing"
)

func TestOpenAppliesSettingsToEveryConnection(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state", "store.sqlite")
	db, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	ctx := context.Background()
	// Hold two connections at once so the pool has to open a second one.
	first, err := db.Conn(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	second, err := db.Conn(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	for index, connection := range []*sql.Conn{first, second} {
		for pragma, want := range map[string]string{
			"foreign_keys": "1", "journal_mode": "wal", "synchronous": "2",
			"secure_delete": "1", "busy_timeout": "5000",
		} {
			var got string
			if err := connection.QueryRowContext(ctx, "PRAGMA "+pragma).Scan(&got); err != nil || got != want {
				t.Fatalf("connection %d %s=%q err=%v, want %q", index, pragma, got, err, want)
			}
		}
	}
	if runtime.GOOS == "windows" {
		return
	}
	for target, want := range map[string]os.FileMode{path: 0o600, filepath.Dir(path): 0o700} {
		if info, err := os.Stat(target); err != nil || info.Mode().Perm() != want {
			t.Fatalf("%s mode=%v err=%v, want %v", target, info.Mode().Perm(), err, want)
		}
	}
}

func TestOpenWritersOnOneFileWaitInsteadOfFailingBusy(t *testing.T) {
	path := filepath.Join(t.TempDir(), "store.sqlite")
	var handles []*sql.DB
	for range 2 {
		db, err := Open(path)
		if err != nil {
			t.Fatal(err)
		}
		defer db.Close()
		handles = append(handles, db)
	}
	if _, err := handles[0].Exec(`CREATE TABLE counter (value INTEGER NOT NULL); INSERT INTO counter VALUES (0)`); err != nil {
		t.Fatal(err)
	}
	// Each transaction reads before it writes. A deferred transaction would
	// fail with SQLITE_BUSY when the other handle commits in between.
	const rounds = 100
	errs := make(chan error, len(handles))
	var group sync.WaitGroup
	for _, db := range handles {
		group.Go(func() {
			for range rounds {
				if err := increment(db); err != nil {
					errs <- err
					return
				}
			}
		})
	}
	group.Wait()
	close(errs)
	for err := range errs {
		t.Fatal(err)
	}
	var value int
	if err := handles[1].QueryRow(`SELECT value FROM counter`).Scan(&value); err != nil || value != 2*rounds {
		t.Fatalf("counter=%d err=%v, want %d", value, err, 2*rounds)
	}
}

func increment(db *sql.DB) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var value int
	if err := tx.QueryRow(`SELECT value FROM counter`).Scan(&value); err != nil {
		return err
	}
	if _, err := tx.Exec(`UPDATE counter SET value=?`, value+1); err != nil {
		return err
	}
	return tx.Commit()
}

func TestOpenRejectsRelativePathsAndPathsTheDriverWouldCut(t *testing.T) {
	for _, path := range []string{":memory:", "store.sqlite", filepath.Join(t.TempDir(), "store?.sqlite")} {
		if _, err := Open(path); err == nil {
			t.Fatalf("Open accepted %q", path)
		}
	}
}
