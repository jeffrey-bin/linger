package skill

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	artifactstore "github.com/simplexai-labs/linger/apps/teamhub/internal/artifact"
)

type packageAuditCountingStore struct {
	*packageAuditMemoryStore
	mu        sync.Mutex
	heads     int
	opens     int
	active    int
	maxActive int
	delay     time.Duration
}

func (s *packageAuditCountingStore) Head(ctx context.Context, key string) (artifactstore.Object, error) {
	s.begin()
	defer s.end()
	if s.delay > 0 {
		time.Sleep(s.delay)
	}
	s.mu.Lock()
	s.heads++
	s.mu.Unlock()
	content, ok := s.objects[key]
	if !ok {
		return artifactstore.Object{}, os.ErrNotExist
	}
	digest := sha256.Sum256(content)
	return artifactstore.Object{Key: key, Size: int64(len(content)), SHA256: digest}, nil
}

func (s *packageAuditCountingStore) Open(ctx context.Context, key string) (io.ReadCloser, error) {
	s.begin()
	defer s.end()
	if s.delay > 0 {
		time.Sleep(s.delay)
	}
	s.mu.Lock()
	s.opens++
	s.mu.Unlock()
	return s.packageAuditMemoryStore.Open(ctx, key)
}

func (s *packageAuditCountingStore) begin() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.active++
	if s.active > s.maxActive {
		s.maxActive = s.active
	}
}

func (s *packageAuditCountingStore) end() {
	s.mu.Lock()
	s.active--
	s.mu.Unlock()
}

type packageAuditMemoryStore struct {
	artifactstore.ObjectStore
	objects map[string][]byte
	reads   map[string]int
}

func (s *packageAuditMemoryStore) Open(ctx context.Context, key string) (io.ReadCloser, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	content, ok := s.objects[key]
	if !ok {
		return nil, os.ErrNotExist
	}
	return &packageAuditTrackingReader{store: s, key: key, reader: bytes.NewReader(content)}, nil
}

type packageAuditTrackingReader struct {
	store  *packageAuditMemoryStore
	key    string
	reader *bytes.Reader
}

func (r *packageAuditTrackingReader) Read(buffer []byte) (int, error) {
	count, err := r.reader.Read(buffer)
	r.store.reads[r.key] += count
	return count, err
}

func (*packageAuditTrackingReader) Close() error { return nil }

func TestAuditSealedPackageObjectsVerifiesPersistedObjectsAndIdentity(t *testing.T) {
	tests := []struct {
		name       string
		mutate     func(*packageAuditManifest, *packageAuditMemoryStore)
		wantDetail string
	}{
		{name: "valid"},
		{
			name: "missing object",
			mutate: func(manifest *packageAuditManifest, objects *packageAuditMemoryStore) {
				delete(objects.objects, manifest.files[0].objectKey)
			},
			wantDetail: "file \"SKILL.md\" object",
		},
		{
			name: "corrupt object bytes",
			mutate: func(manifest *packageAuditManifest, objects *packageAuditMemoryStore) {
				content := append([]byte(nil), objects.objects[manifest.files[0].objectKey]...)
				content[len(content)-1] ^= 1
				objects.objects[manifest.files[0].objectKey] = content
			},
			wantDetail: "object evidence differs",
		},
		{
			name: "frontmatter name drift",
			mutate: func(manifest *packageAuditManifest, objects *packageAuditMemoryStore) {
				replacePackageAuditFile(
					manifest,
					objects,
					"SKILL.md",
					[]byte("---\nname: different-skill\ndescription: Audit fixture.\n---\n"),
				)
			},
			wantDetail: "differs from Skill name",
		},
		{
			name: "frontmatter description drift",
			mutate: func(manifest *packageAuditManifest, objects *packageAuditMemoryStore) {
				replacePackageAuditFile(
					manifest,
					objects,
					"SKILL.md",
					[]byte("---\nname: audit-skill\ndescription: Changed fixture.\n---\n"),
				)
			},
			wantDetail: "description differs",
		},
		{
			name: "invalid canonical frontmatter",
			mutate: func(manifest *packageAuditManifest, objects *packageAuditMemoryStore) {
				replacePackageAuditFile(
					manifest,
					objects,
					"SKILL.md",
					[]byte("---\nname: audit-skill\ndescription: Audit fixture.\nlicense: [MIT]\n---\n"),
				)
			},
			wantDetail: "frontmatter is invalid",
		},
		{
			name: "Manifest file count drift",
			mutate: func(manifest *packageAuditManifest, _ *packageAuditMemoryStore) {
				manifest.fileCount++
			},
			wantDetail: "aggregate count",
		},
		{
			name: "Manifest size drift",
			mutate: func(manifest *packageAuditManifest, _ *packageAuditMemoryStore) {
				manifest.sizeBytes++
			},
			wantDetail: "aggregate count",
		},
		{
			name: "Manifest content hash drift",
			mutate: func(manifest *packageAuditManifest, _ *packageAuditMemoryStore) {
				manifest.contentHash = bytes.Repeat([]byte{0xff}, sha256.Size)
			},
			wantDetail: "content hash differs",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			manifest, objects := newPackageAuditFixture()
			if test.mutate != nil {
				test.mutate(manifest, objects)
			}
			_, err := auditSealedPackageObjects(t.Context(), &packageAuditCountingStore{packageAuditMemoryStore: objects}, []*packageAuditManifest{manifest}, AuditOptions{}, AuditStats{})
			if test.wantDetail == "" {
				if err != nil {
					t.Fatal(err)
				}
				return
			}
			if !errors.Is(err, ErrPackageAudit) || !strings.Contains(err.Error(), test.wantDetail) {
				t.Fatalf("audit error=%v, want ErrPackageAudit containing %q", err, test.wantDetail)
			}
		})
	}
}

func TestAuditSealedPackageObjectsBoundsBodyReads(t *testing.T) {
	manifest, objects := newPackageAuditFixture()
	file := &manifest.files[0]
	file.sizeBytes = 1
	digest := sha256.Sum256([]byte("x"))
	file.sha256 = append(file.sha256[:0], digest[:]...)
	objects.objects[file.objectKey] = bytes.Repeat([]byte("x"), 1<<20)

	_, err := auditSealedPackageObjects(t.Context(), &packageAuditCountingStore{packageAuditMemoryStore: objects}, []*packageAuditManifest{manifest}, AuditOptions{}, AuditStats{})
	if !errors.Is(err, ErrPackageAudit) || !strings.Contains(err.Error(), "object evidence differs") {
		t.Fatalf("audit oversized object error=%v", err)
	}
	if got := objects.reads[file.objectKey]; got != 2 {
		t.Fatalf("oversized object read bytes=%d want=2", got)
	}
}

func TestAuditSealedPackageObjectsUsesHeadAndDeduplicatesObjects(t *testing.T) {
	first, fixture := newPackageAuditFixture()
	second := *first
	second.manifestID = "skill_manifest_audit_2"
	second.skillID = "skill_audit_2"
	second.files = append([]packageAuditFile(nil), first.files...)
	store := &packageAuditCountingStore{packageAuditMemoryStore: fixture}

	stats, err := auditSealedPackageObjects(t.Context(), store, []*packageAuditManifest{first, &second}, AuditOptions{MaxConcurrency: 2}, AuditStats{})
	if err != nil {
		t.Fatal(err)
	}
	if stats.FileCount != 4 || stats.UniqueObjectCount != 2 || stats.HeadChecks != 1 || stats.BodyReads != 1 {
		t.Fatalf("unexpected audit stats: %+v", stats)
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	if store.heads != 1 || store.opens != 1 {
		t.Fatalf("object store calls heads=%d opens=%d, want one each", store.heads, store.opens)
	}
}

func TestAuditSealedPackageObjectsRespectsConcurrencyLimit(t *testing.T) {
	first, fixture := newPackageAuditFixture()
	manifests := make([]*packageAuditManifest, 0, 6)
	for index := 0; index < 6; index++ {
		manifest := *first
		manifest.manifestID = fmt.Sprintf("skill_manifest_audit_%d", index+2)
		manifest.skillID = fmt.Sprintf("skill_audit_%d", index+2)
		manifest.files = append([]packageAuditFile(nil), first.files...)
		for fileIndex := range manifest.files {
			manifest.files[fileIndex].sha256 = append([]byte(nil), manifest.files[fileIndex].sha256...)
		}
		manifest.contentHash = append([]byte(nil), first.contentHash...)
		file := &manifest.files[1]
		content := []byte(fmt.Sprintf("details-%d\n", index))
		digest := sha256.Sum256(content)
		file.objectKey = fmt.Sprintf("object_unique_%d", index)
		file.sizeBytes = int64(len(content))
		file.sha256 = append(file.sha256[:0], digest[:]...)
		fixture.objects[file.objectKey] = content
		recomputePackageAuditManifestEvidence(&manifest)
		manifests = append(manifests, &manifest)
	}
	store := &packageAuditCountingStore{packageAuditMemoryStore: fixture, delay: 5 * time.Millisecond}
	manifests = append(manifests, first)
	if _, err := auditSealedPackageObjects(t.Context(), store, manifests, AuditOptions{MaxConcurrency: 2}, AuditStats{}); err != nil {
		t.Fatal(err)
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	if store.maxActive > 2 {
		t.Fatalf("max concurrent object checks=%d, want <=2", store.maxActive)
	}
}

func newPackageAuditFixture() (*packageAuditManifest, *packageAuditMemoryStore) {
	contents := []struct {
		path, mediaType, content string
	}{
		{
			path: "SKILL.md", mediaType: "text/markdown; charset=utf-8",
			content: "---\nname: audit-skill\ndescription: Audit fixture.\n---\n\n# Audit\n",
		},
		{path: "references/details.md", mediaType: "text/markdown; charset=utf-8", content: "details\n"},
	}
	manifest := &packageAuditManifest{
		manifestID: "skill_manifest_audit_1", skillID: "skill_audit",
		manifestVersion: "1.0.0", skillName: "audit-skill", description: "Audit fixture.",
	}
	objects := &packageAuditMemoryStore{objects: map[string][]byte{}, reads: map[string]int{}}
	for index, item := range contents {
		content := []byte(item.content)
		digest := sha256.Sum256(content)
		objectKey := fmt.Sprintf("object_%032x", index+1)
		manifest.files = append(manifest.files, packageAuditFile{
			path: item.path, mediaType: item.mediaType, sizeBytes: int64(len(content)),
			sha256: append([]byte(nil), digest[:]...), objectKey: objectKey,
		})
		objects.objects[objectKey] = content
	}
	recomputePackageAuditManifestEvidence(manifest)
	return manifest, objects
}

func replacePackageAuditFile(
	manifest *packageAuditManifest,
	objects *packageAuditMemoryStore,
	path string,
	content []byte,
) {
	for index := range manifest.files {
		file := &manifest.files[index]
		if file.path != path {
			continue
		}
		digest := sha256.Sum256(content)
		file.sizeBytes = int64(len(content))
		file.sha256 = append(file.sha256[:0], digest[:]...)
		objects.objects[file.objectKey] = append([]byte(nil), content...)
		recomputePackageAuditManifestEvidence(manifest)
		return
	}
	panic("missing fixture file " + path)
}

func recomputePackageAuditManifestEvidence(manifest *packageAuditManifest) {
	files := make([]PackageFile, 0, len(manifest.files))
	manifest.sizeBytes = 0
	for _, file := range manifest.files {
		var digest [sha256.Size]byte
		copy(digest[:], file.sha256)
		files = append(files, PackageFile{
			Path: file.path, MediaType: file.mediaType, SizeBytes: file.sizeBytes, SHA256: digest,
		})
		manifest.sizeBytes += file.sizeBytes
	}
	manifest.fileCount = len(files)
	digest := CanonicalPackageDigest(files)
	manifest.contentHash = append(manifest.contentHash[:0], digest[:]...)
}
