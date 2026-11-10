package skill

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"io"
	"path"
	"strings"
	"testing"
	"testing/fstest"

	artifactstore "github.com/simplexai-labs/linger/apps/teamhub/internal/artifact"
)

// countingObjectStore records calls that reach the ObjectStore boundary so tests
// can prove when the installer skips a write.
type countingObjectStore struct {
	artifactstore.ObjectStore
	heads    int
	puts     int
	headErr  error
	received []byte
}

func (s *countingObjectStore) Head(ctx context.Context, key string) (artifactstore.Object, error) {
	s.heads++
	if s.headErr != nil {
		return artifactstore.Object{}, s.headErr
	}
	return s.ObjectStore.Head(ctx, key)
}

func (s *countingObjectStore) PutIfAbsent(
	ctx context.Context,
	key string,
	source io.Reader,
	expectedSize int64,
	expectedSHA256 [sha256.Size]byte,
) (artifactstore.Object, bool, error) {
	s.puts++
	// Record the bytes the installer streams so tests can assert the exact upload content.
	var received bytes.Buffer
	object, replay, err := s.ObjectStore.PutIfAbsent(ctx, key, io.TeeReader(source, &received), expectedSize, expectedSHA256)
	s.received = received.Bytes()
	return object, replay, err
}

const objectCasePackagePath = "builtin/object-case/1.0.0"

// newObjectCaseFile returns a package file and a source FS that serves its bytes
// at the case manifest's package path, as the production installer reads them.
func newObjectCaseFile(content string) (PackageFile, fstest.MapFS) {
	file := PackageFile{
		Path:      "SKILL.md",
		MediaType: "text/markdown; charset=utf-8",
		SizeBytes: int64(len(content)),
		SHA256:    sha256.Sum256([]byte(content)),
	}
	source := fstest.MapFS{
		path.Join(objectCasePackagePath, file.Path): &fstest.MapFile{Data: []byte(content)},
	}
	return file, source
}

func newObjectCaseManifest() (builtinSkill, builtinManifest) {
	skill := builtinSkill{SkillID: "object-case-skill", Name: "Object Case"}
	manifest := builtinManifest{ManifestID: "object-case-manifest", Version: "1.0.0", PackagePath: objectCasePackagePath}
	return skill, manifest
}

func TestEnsurePackageObjectPersistedWithMatchingObjectSkipsPut(t *testing.T) {
	inner, err := artifactstore.NewLocalStore(t.TempDir(), 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	file, source := newObjectCaseFile("# Skill\n")
	key := packageFileObjectKey(file.SHA256)
	if _, _, err := inner.PutIfAbsent(context.Background(), key, bytes.NewReader([]byte("# Skill\n")), file.SizeBytes, file.SHA256); err != nil {
		t.Fatal(err)
	}
	store := &countingObjectStore{ObjectStore: inner}
	skill, manifest := newObjectCaseManifest()

	if err := ensurePackageObject(context.Background(), store, source, skill, manifest, file, key, true); err != nil {
		t.Fatalf("ensurePackageObject() error = %v", err)
	}
	if store.heads != 1 || store.puts != 0 {
		t.Fatalf("heads=%d puts=%d, want heads=1 puts=0", store.heads, store.puts)
	}
}

func TestEnsurePackageObjectPersistedMissingObjectRepairsWithPut(t *testing.T) {
	inner, err := artifactstore.NewLocalStore(t.TempDir(), 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	store := &countingObjectStore{ObjectStore: inner}
	file, source := newObjectCaseFile("# Repaired\n")
	key := packageFileObjectKey(file.SHA256)
	skill, manifest := newObjectCaseManifest()

	if err := ensurePackageObject(context.Background(), store, source, skill, manifest, file, key, true); err != nil {
		t.Fatalf("ensurePackageObject() error = %v", err)
	}
	if store.puts != 1 {
		t.Fatalf("puts=%d, want 1", store.puts)
	}
	reader, err := inner.Open(context.Background(), key)
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	defer reader.Close()
	got, err := io.ReadAll(reader)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, []byte("# Repaired\n")) {
		t.Fatalf("stored bytes = %q, want %q", got, "# Repaired\n")
	}
	if !bytes.Equal(store.received, []byte("# Repaired\n")) {
		t.Fatalf("PutIfAbsent received %q, want the embedded bytes", store.received)
	}
}

func TestEnsurePackageObjectPersistedHeadFailureFallsBackToPut(t *testing.T) {
	inner, err := artifactstore.NewLocalStore(t.TempDir(), 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	store := &countingObjectStore{ObjectStore: inner, headErr: errors.New("access denied")}
	file, source := newObjectCaseFile("# Denied HEAD\n")
	key := packageFileObjectKey(file.SHA256)
	skill, manifest := newObjectCaseManifest()

	if err := ensurePackageObject(context.Background(), store, source, skill, manifest, file, key, true); err != nil {
		t.Fatalf("ensurePackageObject() error = %v", err)
	}
	if store.heads != 1 || store.puts != 1 {
		t.Fatalf("heads=%d puts=%d, want heads=1 puts=1", store.heads, store.puts)
	}
}

func TestEnsurePackageObjectPersistedDifferentBytesConflicts(t *testing.T) {
	inner, err := artifactstore.NewLocalStore(t.TempDir(), 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	file, source := newObjectCaseFile("# Expected\n")
	other := []byte("# Other\n")
	key := packageFileObjectKey(file.SHA256)
	otherSHA := sha256.Sum256(other)
	if _, _, err := inner.PutIfAbsent(context.Background(), key, bytes.NewReader(other), int64(len(other)), otherSHA); err != nil {
		t.Fatal(err)
	}
	store := &countingObjectStore{ObjectStore: inner}
	skill, manifest := newObjectCaseManifest()

	err = ensurePackageObject(context.Background(), store, source, skill, manifest, file, key, true)
	if !errors.Is(err, ErrBuiltinSkillConflict) {
		t.Fatalf("ensurePackageObject() error = %v, want ErrBuiltinSkillConflict", err)
	}
	if store.puts != 0 {
		t.Fatalf("puts=%d, want 0", store.puts)
	}
}

func TestEnsurePackageObjectNotPersistedSkipsHead(t *testing.T) {
	inner, err := artifactstore.NewLocalStore(t.TempDir(), 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	store := &countingObjectStore{ObjectStore: inner}
	file, source := newObjectCaseFile("# New\n")
	key := packageFileObjectKey(file.SHA256)
	skill, manifest := newObjectCaseManifest()

	if err := ensurePackageObject(context.Background(), store, source, skill, manifest, file, key, false); err != nil {
		t.Fatalf("ensurePackageObject() error = %v", err)
	}
	if store.heads != 0 || store.puts != 1 {
		t.Fatalf("heads=%d puts=%d, want heads=0 puts=1", store.heads, store.puts)
	}
}

func TestEnsurePackageObjectPersistedHeadFailureWithCancelledContextReturnsCancellation(t *testing.T) {
	inner, err := artifactstore.NewLocalStore(t.TempDir(), 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	store := &countingObjectStore{ObjectStore: inner, headErr: errors.New("transient")}
	file, source := newObjectCaseFile("# Cancelled\n")
	key := packageFileObjectKey(file.SHA256)
	skill, manifest := newObjectCaseManifest()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	err = ensurePackageObject(ctx, store, source, skill, manifest, file, key, true)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("ensurePackageObject() error = %v, want context.Canceled", err)
	}
	if store.puts != 0 {
		t.Fatalf("puts=%d, want 0", store.puts)
	}
}

func TestEnsurePackageObjectMissingEmbeddedFileFailsWithPackagePath(t *testing.T) {
	inner, err := artifactstore.NewLocalStore(t.TempDir(), 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	file, _ := newObjectCaseFile("# Missing\n")
	store := &countingObjectStore{ObjectStore: inner}
	skill, manifest := newObjectCaseManifest()

	err = ensurePackageObject(context.Background(), store, fstest.MapFS{}, skill, manifest, file, packageFileObjectKey(file.SHA256), false)
	if err == nil || !strings.Contains(err.Error(), objectCasePackagePath+"/SKILL.md") {
		t.Fatalf("ensurePackageObject() error = %v, want embedded package path", err)
	}
	if store.puts != 0 {
		t.Fatalf("puts=%d, want 0", store.puts)
	}
}
