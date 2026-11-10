package workspace

import (
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
)

type OperationTemp struct {
	Path string
	lock *os.File
	once sync.Once
	mu   sync.Mutex
	refs int
	err  error
}

func PruneOperationTemps(base string, logger *slog.Logger) (int, int64, error) {
	if !filepath.IsAbs(base) {
		return 0, 0, fmt.Errorf("Operation temp base must be absolute")
	}
	removed, bytesFreed := PruneTaskTempDirs(base, logger)
	return removed, bytesFreed, nil
}

func PrepareOperationTemp(base string) (*OperationTemp, error) {
	if !filepath.IsAbs(base) {
		return nil, fmt.Errorf("Operation temp base must be absolute")
	}
	if err := os.MkdirAll(base, 0o700); err != nil {
		return nil, fmt.Errorf("create Operation temp base: %w", err)
	}
	if err := os.Chmod(base, 0o700); err != nil { //nolint:gosec // owner-only directory mode; gosec expects a file mode for Chmod
		return nil, fmt.Errorf("protect Operation temp base: %w", err)
	}
	dir, err := os.MkdirTemp(base, TaskTempDirPrefix)
	if err != nil {
		return nil, fmt.Errorf("create Operation temp directory: %w", err)
	}
	if err := os.Chmod(dir, 0o700); err != nil { //nolint:gosec // owner-only directory mode; gosec expects a file mode for Chmod
		_ = os.RemoveAll(dir)
		return nil, fmt.Errorf("protect Operation temp directory: %w", err)
	}
	lock, err := LockTaskTempDir(dir)
	if err != nil {
		_ = os.RemoveAll(dir)
		return nil, err
	}
	return &OperationTemp{Path: dir, lock: lock, refs: 1}, nil
}

// Retain keeps the directory and its sweep lock alive for a native process
// whose lifetime can exceed the Operation. Release only after tree cleanup.
func (t *OperationTemp) Retain() (func() error, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.refs == 0 {
		return nil, fmt.Errorf("Operation temp directory has already been released")
	}
	t.refs++
	var once sync.Once
	var err error
	return func() error {
		once.Do(func() { err = t.release() })
		return err
	}, nil
}

func (t *OperationTemp) Close() error {
	if t == nil {
		return nil
	}
	t.once.Do(func() { _ = t.release() })
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.err
}

func (t *OperationTemp) release() error {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.refs--
	if t.refs == 0 {
		ReleaseTaskTempLock(t.lock)
		t.lock = nil
		t.err = RemoveTaskTempDir(t.Path)
	}
	return t.err
}
