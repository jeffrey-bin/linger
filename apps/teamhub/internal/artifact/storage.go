// Package artifact provides immutable content object storage for TeamHub.
package artifact

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"time"
)

var (
	ErrTooLarge         = errors.New("artifact content exceeds configured limit")
	ErrInvalidObjectKey = errors.New("invalid artifact object key")
	ErrObjectConflict   = errors.New("object key already contains different content")
	ErrContentMismatch  = errors.New("content does not match declared evidence")
	ErrInvalidRange     = errors.New("invalid artifact content range")
	objectKeyPattern    = regexp.MustCompile(`^object_[a-f0-9]{32}$`)
)

// Object describes an opaque content object produced by a successful write.
type Object struct {
	Key    string
	Size   int64
	SHA256 [sha256.Size]byte
}

// ObjectStore stores and reads opaque immutable content objects.
type ObjectStore interface {
	Put(ctx context.Context, source io.Reader) (Object, error)
	PutIfAbsent(ctx context.Context, key string, source io.Reader, expectedSize int64, expectedSHA256 [sha256.Size]byte) (Object, bool, error)
	Head(ctx context.Context, key string) (Object, error)
	Open(ctx context.Context, key string) (io.ReadCloser, error)
	Delete(ctx context.Context, key string) error
	MaxBytes() int64
	AvailableBytes() (int64, error)
}

// RangeObjectStore streams a bounded byte interval without reading the
// preceding object bytes. Callers fall back to ObjectStore.Open only for
// adapters that have not implemented this optional capability.
type RangeObjectStore interface {
	OpenRange(ctx context.Context, key string, offset, length int64) (io.ReadCloser, error)
}

const detachedDeleteTimeout = 30 * time.Second

// DeleteDetached performs compensating object cleanup after the database has
// established that an object is not referenced. Request cancellation must not
// strand that cleanup, but it remains bounded during shutdown or a slow store.
func DeleteDetached(parent context.Context, store ObjectStore, key string) error {
	return DeleteDetachedWithTimeout(parent, store, key, detachedDeleteTimeout)
}

func DeleteDetachedWithTimeout(parent context.Context, store ObjectStore, key string, timeout time.Duration) error {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(parent), timeout)
	defer cancel()
	return store.Delete(ctx, key)
}

// LocalStore keeps immutable content objects in a single local directory.
type LocalStore struct {
	root     string
	maxBytes int64
}

var _ ObjectStore = (*LocalStore)(nil)

// NewLocalStore creates a local object store and ensures the root directory exists.
func NewLocalStore(root string, maxBytes int64) (*LocalStore, error) {
	if root == "" {
		return nil, errors.New("artifact storage root is required")
	}
	if maxBytes <= 0 {
		return nil, errors.New("artifact maximum size must be positive")
	}
	abs, err := filepath.Abs(root)
	if err != nil {
		return nil, fmt.Errorf("resolve artifact storage root: %w", err)
	}
	if err := os.MkdirAll(abs, 0o750); err != nil {
		return nil, fmt.Errorf("create artifact storage root: %w", err)
	}
	return &LocalStore{root: abs, maxBytes: maxBytes}, nil
}

// Put writes a new object and returns its opaque key, size, and content digest.
func (s *LocalStore) Put(ctx context.Context, source io.Reader) (Object, error) {
	// The temporary file is in the same directory as the final object; it is published via rename only after the content is flushed and closed.
	// This boundary is not atomic with the PostgreSQL transaction and does not promise cross-platform power-loss durability.
	temporary, err := os.CreateTemp(s.root, ".upload-*")
	if err != nil {
		return Object{}, err
	}
	temporaryName := temporary.Name()
	committed := false
	defer func() {
		_ = temporary.Close()
		if !committed {
			_ = os.Remove(temporaryName)
		}
	}()

	hash := sha256.New()
	// Reading one extra byte distinguishes "exactly at the limit" from "over the limit". contextReader
	// can only observe cancellation before the next underlying Read, and cannot interrupt a source.Read that is already blocked.
	reader := &contextReader{ctx: ctx, reader: io.LimitReader(source, s.maxBytes+1)}
	size, err := io.Copy(io.MultiWriter(temporary, hash), reader)
	if err != nil {
		return Object{}, err
	}
	if size > s.maxBytes {
		return Object{}, ErrTooLarge
	}
	if err := temporary.Sync(); err != nil {
		return Object{}, err
	}
	if err := temporary.Close(); err != nil {
		return Object{}, err
	}
	key, err := newObjectKey()
	if err != nil {
		return Object{}, err
	}
	if err := os.Rename(temporaryName, filepath.Join(s.root, key)); err != nil {
		return Object{}, err
	}
	committed = true
	var digest [sha256.Size]byte
	copy(digest[:], hash.Sum(nil))
	return Object{Key: key, Size: size, SHA256: digest}, nil
}

// PutIfAbsent publishes exact bytes at a caller-derived stable key. A matching
// existing object is an idempotent replay that verifies the caller's bytes and
// the existing object without rewriting or syncing; different bytes never
// overwrite it.
func (s *LocalStore) PutIfAbsent(
	ctx context.Context,
	key string,
	source io.Reader,
	expectedSize int64,
	expectedSHA256 [sha256.Size]byte,
) (Object, bool, error) {
	path, err := s.objectPath(key)
	if err != nil {
		return Object{}, false, err
	}
	if expectedSize < 0 || expectedSize > s.maxBytes {
		return Object{}, false, ErrTooLarge
	}
	if _, err := os.Lstat(path); err == nil {
		return s.replayPutIfAbsent(ctx, key, source, expectedSize, expectedSHA256)
	} else if !errors.Is(err, os.ErrNotExist) {
		return Object{}, false, err
	}
	temporary, err := os.CreateTemp(s.root, ".stable-upload-"+key+"-*")
	if err != nil {
		return Object{}, false, err
	}
	temporaryName := temporary.Name()
	defer func() {
		_ = temporary.Close()
		_ = os.Remove(temporaryName)
	}()

	hash := sha256.New()
	reader := &contextReader{ctx: ctx, reader: io.LimitReader(source, s.maxBytes+1)}
	size, err := io.Copy(io.MultiWriter(temporary, hash), reader)
	if err != nil {
		return Object{}, false, err
	}
	if size > s.maxBytes {
		return Object{}, false, ErrTooLarge
	}
	var digest [sha256.Size]byte
	copy(digest[:], hash.Sum(nil))
	if size != expectedSize || digest != expectedSHA256 {
		return Object{}, false, ErrContentMismatch
	}
	if err := ctx.Err(); err != nil {
		return Object{}, false, err
	}
	if err := temporary.Sync(); err != nil {
		return Object{}, false, err
	}
	if err := temporary.Close(); err != nil {
		return Object{}, false, err
	}
	if err := ctx.Err(); err != nil {
		return Object{}, false, err
	}
	if err := os.Link(temporaryName, path); err == nil {
		return Object{Key: key, Size: size, SHA256: digest}, false, nil
	} else if !errors.Is(err, os.ErrExist) {
		return Object{}, false, err
	}
	existing, err := s.Head(ctx, key)
	if err != nil {
		return Object{}, false, err
	}
	if existing.Size != expectedSize || existing.SHA256 != expectedSHA256 {
		return Object{}, false, ErrObjectConflict
	}
	return existing, true, nil
}

// replayPutIfAbsent handles a key that already exists. It hashes the caller's
// bytes in memory and compares them with the existing object, so a replay never
// creates a temporary file, syncs, or rewrites the stable key.
func (s *LocalStore) replayPutIfAbsent(
	ctx context.Context,
	key string,
	source io.Reader,
	expectedSize int64,
	expectedSHA256 [sha256.Size]byte,
) (Object, bool, error) {
	hash := sha256.New()
	reader := &contextReader{ctx: ctx, reader: io.LimitReader(source, s.maxBytes+1)}
	size, err := io.Copy(hash, reader)
	if err != nil {
		return Object{}, false, err
	}
	if size > s.maxBytes {
		return Object{}, false, ErrTooLarge
	}
	var digest [sha256.Size]byte
	copy(digest[:], hash.Sum(nil))
	if size != expectedSize || digest != expectedSHA256 {
		return Object{}, false, ErrContentMismatch
	}
	if err := ctx.Err(); err != nil {
		return Object{}, false, err
	}
	existing, err := s.Head(ctx, key)
	if err != nil {
		return Object{}, false, err
	}
	if existing.Size != expectedSize || existing.SHA256 != expectedSHA256 {
		return Object{}, false, ErrObjectConflict
	}
	return existing, true, nil
}

// Head returns immutable object evidence. The local adapter computes SHA-256
// from bytes because it has no separate object-metadata service.
func (s *LocalStore) Head(ctx context.Context, key string) (Object, error) {
	file, err := s.Open(ctx, key)
	if err != nil {
		return Object{}, err
	}
	defer file.Close()
	hash := sha256.New()
	size, err := io.Copy(hash, file)
	if err != nil {
		return Object{}, err
	}
	var digest [sha256.Size]byte
	copy(digest[:], hash.Sum(nil))
	return Object{Key: key, Size: size, SHA256: digest}, nil
}

func (s *LocalStore) MaxBytes() int64 { return s.maxBytes }

// AvailableBytes reports filesystem capacity available to the service account.
// Callers use it as a high-water admission gate before reserving new objects.
func (s *LocalStore) AvailableBytes() (int64, error) {
	available, err := availableBytes(s.root)
	if err != nil {
		return 0, fmt.Errorf("read artifact storage capacity: %w", err)
	}
	if available > ^uint64(0)>>1 {
		return int64(^uint64(0) >> 1), nil
	}
	return int64(available), nil
}

// Open opens an opaque object key produced by this store.
func (s *LocalStore) Open(ctx context.Context, key string) (io.ReadCloser, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	path, err := s.objectPath(key)
	if err != nil {
		return nil, err
	}
	return os.Open(path)
}

// OpenRange reads a bounded byte interval from a local immutable object.
func (s *LocalStore) OpenRange(ctx context.Context, key string, offset, length int64) (io.ReadCloser, error) {
	if offset < 0 || length <= 0 {
		return nil, ErrInvalidRange
	}
	file, err := s.Open(ctx, key)
	if err != nil {
		return nil, err
	}
	if _, err := file.(*os.File).Seek(offset, io.SeekStart); err != nil {
		_ = file.Close()
		return nil, err
	}
	return &rangeReadCloser{Reader: io.LimitReader(file, length), closer: file}, nil
}

// Delete removes an object; it still succeeds when the object is already gone.
func (s *LocalStore) Delete(ctx context.Context, key string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	path, err := s.objectPath(key)
	if err != nil {
		return err
	}
	var deleteErr error
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		deleteErr = errors.Join(deleteErr, err)
	}
	stagingPaths, err := filepath.Glob(filepath.Join(s.root, ".stable-upload-"+key+"-*"))
	if err != nil {
		return errors.Join(deleteErr, err)
	}
	for _, stagingPath := range stagingPaths {
		if err := os.Remove(stagingPath); err != nil && !errors.Is(err, os.ErrNotExist) {
			deleteErr = errors.Join(deleteErr, err)
		}
	}
	return deleteErr
}

func (s *LocalStore) objectPath(key string) (string, error) {
	// A caller-provided key must not be treated as an arbitrary relative path; the fixed format and single basename together prevent directory escape.
	if err := validateObjectKey(key); err != nil {
		return "", err
	}
	return filepath.Join(s.root, key), nil
}

func validateObjectKey(key string) error {
	if !objectKeyPattern.MatchString(key) || filepath.Base(key) != key {
		return ErrInvalidObjectKey
	}
	return nil
}

func newObjectKey() (string, error) {
	value := make([]byte, 16)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	return "object_" + hex.EncodeToString(value), nil
}

type contextReader struct {
	ctx    context.Context
	reader io.Reader
}

type rangeReadCloser struct {
	io.Reader
	closer io.Closer
}

func (r *rangeReadCloser) Close() error { return r.closer.Close() }

func (r *contextReader) Read(buffer []byte) (int, error) {
	select {
	case <-r.ctx.Done():
		return 0, r.ctx.Err()
	default:
		return r.reader.Read(buffer)
	}
}
