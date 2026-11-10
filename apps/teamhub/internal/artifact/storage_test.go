package artifact

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

func TestLocalStoreWritesImmutableOpaqueObjects(t *testing.T) {
	root := t.TempDir()
	store, err := NewLocalStore(root, 1024)
	if err != nil {
		t.Fatal(err)
	}

	content := []byte("artifact content")
	object, err := store.Put(context.Background(), bytes.NewReader(content))
	if err != nil {
		t.Fatal(err)
	}
	if object.Key == "" || filepath.Base(object.Key) != object.Key {
		t.Fatalf("object key must be opaque and flat: %q", object.Key)
	}
	if object.Size != int64(len(content)) || object.SHA256 != sha256.Sum256(content) {
		t.Fatalf("unexpected object metadata: %+v", object)
	}

	reader, err := store.Open(t.Context(), object.Key)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	got, err := io.ReadAll(reader)
	if err != nil || !bytes.Equal(got, content) {
		t.Fatalf("read=%q err=%v", got, err)
	}
	rangeReader, err := store.OpenRange(t.Context(), object.Key, 2, 8)
	if err != nil {
		t.Fatal(err)
	}
	rangeContent, rangeErr := io.ReadAll(rangeReader)
	closeRangeErr := rangeReader.Close()
	if rangeErr != nil || closeRangeErr != nil || !bytes.Equal(rangeContent, content[2:10]) {
		t.Fatalf("range=%q readErr=%v closeErr=%v", rangeContent, rangeErr, closeRangeErr)
	}
	if err := store.Delete(t.Context(), object.Key); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Open(t.Context(), object.Key); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("open deleted object err=%v", err)
	}
}

func TestLocalStoreRejectsOversizeAndUnsafeKeys(t *testing.T) {
	root := t.TempDir()
	store, err := NewLocalStore(root, 4)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Put(context.Background(), bytes.NewReader([]byte("12345"))); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("oversize err=%v", err)
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("oversize upload left files: %v", entries)
	}
	for _, key := range []string{"../secret", "nested/object", ".hidden", "", "not-an-object"} {
		if _, err := store.Open(t.Context(), key); !errors.Is(err, ErrInvalidObjectKey) {
			t.Fatalf("Open(%q) err=%v", key, err)
		}
		if err := store.Delete(t.Context(), key); !errors.Is(err, ErrInvalidObjectKey) {
			t.Fatalf("Delete(%q) err=%v", key, err)
		}
	}
	if _, err := store.OpenRange(t.Context(), "object_0123456789abcdef0123456789abcdef", -1, 1); !errors.Is(err, ErrInvalidRange) {
		t.Fatalf("invalid range err=%v", err)
	}
}

func TestLocalStoreReportsFilesystemAvailableBytes(t *testing.T) {
	store, err := NewLocalStore(t.TempDir(), 1024)
	if err != nil {
		t.Fatal(err)
	}
	available, err := store.AvailableBytes()
	if err != nil {
		t.Fatal(err)
	}
	if available <= 0 {
		t.Fatalf("available bytes=%d, want positive filesystem capacity", available)
	}
}

func TestLocalStoreDeleteCleansStableUploadStagingForObjectKey(t *testing.T) {
	root := t.TempDir()
	store, err := NewLocalStore(root, 1024)
	if err != nil {
		t.Fatal(err)
	}
	key := "object_0123456789abcdef0123456789abcdef"
	stagingPath := filepath.Join(root, ".stable-upload-"+key+"-crash")
	if err := os.WriteFile(stagingPath, []byte("interrupted upload"), 0o600); err != nil {
		t.Fatal(err)
	}

	if err := store.Delete(t.Context(), key); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(stagingPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("stable upload staging remains after delete: %v", err)
	}
}

func TestLocalStoreDoesNotPublishStableObjectAfterContextCancellation(t *testing.T) {
	root := t.TempDir()
	store, err := NewLocalStore(root, 1024)
	if err != nil {
		t.Fatal(err)
	}
	key := "object_0123456789abcdef0123456789abcdef"
	content := []byte("lease-expired-content")
	ctx, cancel := context.WithCancel(context.Background())
	reader := &cancelOnRead{contents: content, cancel: cancel}

	if _, _, err := store.PutIfAbsent(
		ctx, key, reader, int64(len(content)), sha256.Sum256(content),
	); !errors.Is(err, context.Canceled) {
		t.Fatalf("PutIfAbsent cancellation err=%v", err)
	}
	if _, err := store.Open(t.Context(), key); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("cancelled stable object was published: %v", err)
	}
}

func TestLocalStorePutIfAbsentReplayDoesNotWriteOrSync(t *testing.T) {
	root := t.TempDir()
	store, err := NewLocalStore(root, 1024)
	if err != nil {
		t.Fatal(err)
	}
	key := "object_0123456789abcdef0123456789abcdef"
	content := []byte("skill bundle content")
	first, replayed, err := store.PutIfAbsent(t.Context(), key, bytes.NewReader(content), int64(len(content)), sha256.Sum256(content))
	if err != nil || replayed {
		t.Fatalf("first PutIfAbsent replayed=%v err=%v", replayed, err)
	}

	if os.Geteuid() == 0 {
		t.Skip("root ignores directory write permissions")
	}
	if err := os.Chmod(root, 0o555); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(root, 0o755) })

	replay, replayed, err := store.PutIfAbsent(t.Context(), key, bytes.NewReader(content), int64(len(content)), sha256.Sum256(content))
	if err != nil || !replayed {
		t.Fatalf("replay PutIfAbsent replayed=%v err=%v", replayed, err)
	}
	if replay != first {
		t.Fatalf("replay object=%+v, want %+v", replay, first)
	}
}

func TestLocalStorePutIfAbsentReplayRejectsCallerContentMismatch(t *testing.T) {
	store, err := NewLocalStore(t.TempDir(), 1024)
	if err != nil {
		t.Fatal(err)
	}
	key := "object_0123456789abcdef0123456789abcdef"
	stored := []byte("stored content")
	if _, _, err := store.PutIfAbsent(t.Context(), key, bytes.NewReader(stored), int64(len(stored)), sha256.Sum256(stored)); err != nil {
		t.Fatal(err)
	}

	caller := []byte("caller content")
	if _, _, err := store.PutIfAbsent(t.Context(), key, bytes.NewReader(caller), int64(len(stored)), sha256.Sum256(stored)); !errors.Is(err, ErrContentMismatch) {
		t.Fatalf("mismatched replay err=%v, want ErrContentMismatch", err)
	}
	object, err := store.Head(t.Context(), key)
	if err != nil {
		t.Fatal(err)
	}
	if object.Size != int64(len(stored)) || object.SHA256 != sha256.Sum256(stored) {
		t.Fatalf("stored object changed: %+v", object)
	}
}

func TestLocalStorePutIfAbsentRejectsExistingObjectWithDifferentContent(t *testing.T) {
	store, err := NewLocalStore(t.TempDir(), 1024)
	if err != nil {
		t.Fatal(err)
	}
	key := "object_0123456789abcdef0123456789abcdef"
	stored := []byte("content A")
	if _, _, err := store.PutIfAbsent(t.Context(), key, bytes.NewReader(stored), int64(len(stored)), sha256.Sum256(stored)); err != nil {
		t.Fatal(err)
	}

	other := []byte("content B")
	if _, _, err := store.PutIfAbsent(t.Context(), key, bytes.NewReader(other), int64(len(other)), sha256.Sum256(other)); !errors.Is(err, ErrObjectConflict) {
		t.Fatalf("conflicting PutIfAbsent err=%v, want ErrObjectConflict", err)
	}
	reader, err := store.Open(t.Context(), key)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	got, err := io.ReadAll(reader)
	if err != nil || !bytes.Equal(got, stored) {
		t.Fatalf("stored content=%q err=%v, want %q", got, err, stored)
	}
}

func TestLocalStorePutIfAbsentConcurrentFirstWritersPublishOnce(t *testing.T) {
	store, err := NewLocalStore(t.TempDir(), 1024)
	if err != nil {
		t.Fatal(err)
	}
	key := "object_0123456789abcdef0123456789abcdef"
	content := []byte("concurrent skill content")
	const writers = 8
	type result struct {
		object   Object
		replayed bool
		err      error
	}
	results := make([]result, writers)
	var wg sync.WaitGroup
	for i := range writers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			object, replayed, err := store.PutIfAbsent(t.Context(), key, bytes.NewReader(content), int64(len(content)), sha256.Sum256(content))
			results[i] = result{object: object, replayed: replayed, err: err}
		}()
	}
	wg.Wait()

	created := 0
	for _, r := range results {
		if r.err != nil {
			t.Fatalf("concurrent PutIfAbsent err=%v", r.err)
		}
		if r.object.Key != key || r.object.Size != int64(len(content)) || r.object.SHA256 != sha256.Sum256(content) {
			t.Fatalf("concurrent PutIfAbsent object=%+v", r.object)
		}
		if !r.replayed {
			created++
		}
	}
	if created != 1 {
		t.Fatalf("created=%d, want exactly one first writer", created)
	}
	object, err := store.Head(t.Context(), key)
	if err != nil {
		t.Fatal(err)
	}
	if object.Size != int64(len(content)) || object.SHA256 != sha256.Sum256(content) {
		t.Fatalf("stored object=%+v", object)
	}
}

func TestLocalStorePutIfAbsentReplayStopsOnCancellation(t *testing.T) {
	store, err := NewLocalStore(t.TempDir(), 1024)
	if err != nil {
		t.Fatal(err)
	}
	key := "object_0123456789abcdef0123456789abcdef"
	content := []byte("existing content")
	if _, _, err := store.PutIfAbsent(t.Context(), key, bytes.NewReader(content), int64(len(content)), sha256.Sum256(content)); err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	reader := &cancelOnRead{contents: content, cancel: cancel}
	if _, _, err := store.PutIfAbsent(ctx, key, reader, int64(len(content)), sha256.Sum256(content)); !errors.Is(err, context.Canceled) {
		t.Fatalf("replay cancellation err=%v, want context.Canceled", err)
	}
}

type cancelOnRead struct {
	contents []byte
	cancel   context.CancelFunc
	read     bool
}

func (reader *cancelOnRead) Read(buffer []byte) (int, error) {
	if reader.read {
		return 0, io.EOF
	}
	reader.read = true
	read := copy(buffer, reader.contents)
	reader.cancel()
	return read, io.EOF
}

type blockingDeleteStore struct{ ObjectStore }

func (blockingDeleteStore) Delete(ctx context.Context, _ string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	<-ctx.Done()
	return ctx.Err()
}

func TestDeleteDetachedIgnoresParentCancellationAndIsBounded(t *testing.T) {
	parent, cancel := context.WithCancel(context.Background())
	cancel()
	started := time.Now()
	err := DeleteDetachedWithTimeout(parent, blockingDeleteStore{}, "object_key", 5*time.Millisecond)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("DeleteDetached error=%v, want deadline exceeded", err)
	}
	if elapsed := time.Since(started); elapsed > time.Second {
		t.Fatalf("detached delete exceeded bound: %s", elapsed)
	}
}
