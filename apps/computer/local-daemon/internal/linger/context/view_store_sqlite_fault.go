package lingercontext

import (
	"bufio"
	"context"
	"database/sql/driver"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"modernc.org/sqlite"
)

// SQLite primary result codes that a fresh connection can clear: a broken
// wal-index (-shm) mapping, a failed read or write, or a lost file handle.
// Other codes, such as corruption or a full disk, keep the connection.
var reopenableSQLiteCodes = map[int]bool{10: true, 14: true, 15: true}

func sqliteResultCode(err error) (int, bool) {
	var sqliteErr *sqlite.Error
	if !errors.As(err, &sqliteErr) {
		return 0, false
	}
	return sqliteErr.Code(), true
}

// storageFault keeps evidence of a SQLite failure before the Worker is
// reclaimed, and drops the pooled connection when a fresh one can clear the
// fault. It reports whether the caller may retry a read once.
func (s *ViewStore) storageFault(ctx context.Context, operation string, err error) bool {
	code, ok := sqliteResultCode(err)
	if !ok {
		return false
	}
	reopen := reopenableSQLiteCodes[code&0xff]
	attrs := []any{
		"operation", operation, "sqlite_code", code, "reopen", reopen, "error", err,
		"connection_age_ms", s.now().Sub(s.connectedAt()).Milliseconds(), "pid", os.Getpid(),
	}
	attrs = append(attrs, sqliteFileEvidence(s.path)...)
	if reopen {
		// The fault must not block forever behind a connection another call holds.
		discardCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		if discardErr := s.discardConnection(discardCtx); discardErr != nil {
			attrs = append(attrs, "reopen_error", discardErr)
			reopen = false
		}
	}
	s.logger.Warn("runner.context_view.sqlite_failed", attrs...)
	return reopen
}

// discardConnection closes the single pooled connection; the next statement
// opens a new one with fresh file handles and a new wal-index mapping.
func (s *ViewStore) discardConnection(ctx context.Context) error {
	conn, err := s.db.Conn(ctx)
	if err != nil {
		// Opening failed, so no connection is pooled; the next statement opens
		// one anyway. Only a wait that ran out leaves the old connection in use.
		return ctx.Err()
	}
	defer conn.Close()
	if err := conn.Raw(func(any) error { return driver.ErrBadConn }); !errors.Is(err, driver.ErrBadConn) {
		return err
	}
	s.connectedMu.Lock()
	s.connected = s.now()
	s.connectedMu.Unlock()
	return nil
}

func (s *ViewStore) connectedAt() time.Time {
	s.connectedMu.Lock()
	defer s.connectedMu.Unlock()
	return s.connected
}

// observedStorageError marks a SQLite failure whose evidence is already logged.
type observedStorageError struct{ error }

func (e observedStorageError) Unwrap() error { return e.error }

// observeStorage records a SQLite failure at a public entry point. It never
// retries: a failed write is not replayed.
func (s *ViewStore) observeStorage(ctx context.Context, operation string, err error) error {
	var observed observedStorageError
	if err != nil && !errors.As(err, &observed) {
		s.storageFault(context.WithoutCancel(ctx), operation, err)
	}
	return err
}

// sqliteFileEvidence describes the database and its WAL files without reading
// their contents.
func sqliteFileEvidence(path string) []any {
	var attrs []any
	for _, file := range []struct{ key, path string }{
		{"db", path}, {"wal", path + "-wal"}, {"shm", path + "-shm"},
	} {
		identity, err := projectionIdentity(file.path)
		if err != nil {
			attrs = append(attrs, file.key+"_exists", false)
			continue
		}
		attrs = append(attrs,
			file.key+"_exists", true, file.key+"_size", identity.Size,
			file.key+"_mode", os.FileMode(identity.Mode).String(),
			file.key+"_device", identity.Device, file.key+"_inode", identity.Inode,
			file.key+"_modified", time.Unix(0, identity.ModifiedNsec).UTC().Format(time.RFC3339Nano),
		)
	}
	if mount := mountOf(filepath.Dir(path)); mount != "" {
		attrs = append(attrs, "mount", mount)
	}
	return attrs
}

// mountOf returns the Linux mount that holds directory: its mount point,
// filesystem type, source and options.
func mountOf(directory string) string {
	if runtime.GOOS != "linux" {
		return ""
	}
	file, err := os.Open("/proc/self/mountinfo")
	if err != nil {
		return ""
	}
	defer file.Close()
	best, bestPoint := "", ""
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		// id parent major:minor root mount-point options ... - type source super-options
		before, after, ok := strings.Cut(scanner.Text(), " - ")
		fields, tail := strings.Fields(before), strings.Fields(after)
		if !ok || len(fields) < 6 || len(tail) < 3 {
			continue
		}
		point := fields[4]
		if (directory == point || strings.HasPrefix(directory, strings.TrimSuffix(point, "/")+"/")) && len(point) > len(bestPoint) {
			bestPoint = point
			best = strings.Join([]string{point, tail[0], tail[1], fields[5], tail[2]}, " ")
		}
	}
	return best
}
