// Package sqlitedb opens the Daemon's local state databases.
package sqlitedb

import (
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"strings"

	_ "modernc.org/sqlite"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/platform/privatefs"
)

// The driver applies these on every connection it opens, so a second pooled
// connection keeps foreign keys and the same durability. A writer waits for
// the lock instead of failing with SQLITE_BUSY, and takes it when its
// transaction begins: upgrading a read to a write cannot wait for the lock.
const connectionSettings = "?_pragma=foreign_keys(1)&_pragma=journal_mode(WAL)&_pragma=synchronous(FULL)&_pragma=secure_delete(1)&_busy_timeout=5000&_txlock=immediate"

// Open opens the database at path as an owner-only file in an owner-only
// directory. Each store keeps its own file, tables and transactions.
func Open(path string) (*sql.DB, error) {
	// The driver ends the file name at the first '?', which would open
	// another file.
	if !filepath.IsAbs(path) || strings.Contains(path, "?") {
		return nil, errors.New("database path must be absolute and contain no '?'")
	}
	if err := privatefs.EnsureDir(filepath.Dir(path)); err != nil {
		return nil, err
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err == nil {
		err = file.Close()
	} else if errors.Is(err, os.ErrExist) {
		err = os.Chmod(path, 0o600)
	}
	if err != nil {
		return nil, err
	}
	db, err := sql.Open("sqlite", path+connectionSettings)
	if err != nil {
		return nil, err
	}
	if err := db.Ping(); err != nil {
		_ = db.Close()
		return nil, err
	}
	return db, nil
}
