package integration_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	artifactstore "github.com/simplexai-labs/linger/apps/teamhub/internal/artifact"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/skill"
)

// probeCountingStore records object opens made by the startup storage probe.
type probeCountingStore struct {
	artifactstore.ObjectStore
	mu    sync.Mutex
	opens int
}

func (s *probeCountingStore) Open(ctx context.Context, key string) (io.ReadCloser, error) {
	s.mu.Lock()
	s.opens++
	s.mu.Unlock()
	return s.ObjectStore.Open(ctx, key)
}

func TestSkillPackageStorageProbeReadsBoundedSample(t *testing.T) {
	allowParallelIntegrationTest(t)
	databaseURL := newIntegrationDatabaseWithoutSkills(t)
	pool, err := pgxpool.New(t.Context(), databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	// The bare database holds no Skill Packages; add only the packages needed by
	// the probe scenario to this test's private store.
	store, err := artifactstore.NewLocalStore(t.TempDir(), 32<<20)
	if err != nil {
		t.Fatal(err)
	}
	// Ten single-file packages exceed the eight-object bound without installing
	// the unrelated embedded catalog.
	for index := range 10 {
		content := []byte(fmt.Sprintf("---\nname: probe-skill-%02d\ndescription: Probe fixture.\n---\n\n# Probe %d\n", index, index))
		object, err := store.Put(t.Context(), bytes.NewReader(content))
		if err != nil {
			t.Fatal(err)
		}
		seedProbeSkillPackage(t, pool, index, object.Key, object.Size, object.SHA256, object.Size)
	}
	var sealed int
	if err := pool.QueryRow(t.Context(), `SELECT count(*) FROM skill_manifests WHERE package_state='sealed'`).Scan(&sealed); err != nil {
		t.Fatal(err)
	}
	if sealed <= 8 {
		t.Fatalf("fixture must exceed the probe bound, sealed Manifests=%d", sealed)
	}

	counting := &probeCountingStore{ObjectStore: store}
	stats, err := skill.ProbePackageStorage(t.Context(), pool, counting)
	if err != nil {
		t.Fatalf("probe sealed Skill Package storage: %v", err)
	}
	if counting.opens > 8 || stats.ObjectCount != counting.opens || stats.ObjectCount != 8 {
		t.Fatalf("probe opened %d objects, reported %d, want exactly 8 within the bound", counting.opens, stats.ObjectCount)
	}
	if stats.BytesVerified <= 0 {
		t.Fatalf("probe verified %d bytes, want positive", stats.BytesVerified)
	}
}

func TestSkillPackageStorageProbeDetectsObjectFailures(t *testing.T) {
	allowParallelIntegrationTest(t)
	content := []byte("---\nname: probe-skill-00\ndescription: Probe fixture.\n---\n\n# Probe\n")
	otherContent := []byte("---\nname: probe-skill-00\ndescription: Probe fixture.\n---\n\n# Other\n")
	if len(content) != len(otherContent) {
		t.Fatal("fixture contents must share a size")
	}
	cases := []struct {
		name string
		// stored is written to the object store; seeded metadata is written to PostgreSQL.
		stored     []byte
		storeKey   bool
		sizeBytes  int64
		digest     [sha256.Size]byte
		wantDetail string
	}{
		{name: "missing object", storeKey: false, sizeBytes: int64(len(content)), digest: sha256.Sum256(content), wantDetail: "object"},
		{name: "size mismatch", stored: content, storeKey: true, sizeBytes: int64(len(content)) + 1, digest: sha256.Sum256(content), wantDetail: "size"},
		{name: "digest mismatch", stored: content, storeKey: true, sizeBytes: int64(len(content)), digest: sha256.Sum256(otherContent), wantDetail: "sha256"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			databaseURL := newIntegrationDatabaseWithoutSkills(t)
			pool, err := pgxpool.New(t.Context(), databaseURL)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(pool.Close)
			store, err := artifactstore.NewLocalStore(t.TempDir(), 32<<20)
			if err != nil {
				t.Fatal(err)
			}
			objectKey := "object_" + strings.Repeat("8", 32)
			if tc.storeKey {
				object, err := store.Put(t.Context(), bytes.NewReader(tc.stored))
				if err != nil {
					t.Fatal(err)
				}
				objectKey = object.Key
			}
			seedProbeSkillPackage(t, pool, 0, objectKey, tc.sizeBytes, tc.digest, tc.sizeBytes)

			_, err = skill.ProbePackageStorage(t.Context(), pool, store)
			if !errors.Is(err, skill.ErrPackageAudit) {
				t.Fatalf("probe error=%v, want ErrPackageAudit", err)
			}
			for _, want := range []string{"skill_manifest_probe_00", "SKILL.md", objectKey, tc.wantDetail} {
				if !strings.Contains(err.Error(), want) {
					t.Fatalf("probe error %q does not contain %q", err, want)
				}
			}
		})
	}
}

func TestSkillPackageAuditCommandReportsMissingObjectAndRepairsBuiltin(t *testing.T) {
	serialIntegrationTest(t, serialSubprocess)
	requireTestDatabase(t)
	binary := skillPackageAuditBinary(t)
	databaseURL := newIntegrationDatabase(t)
	pool, err := pgxpool.New(t.Context(), databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	artifactRoot := copyTemplateSkillObjects(t, pool)
	store, err := artifactstore.NewLocalStore(artifactRoot, 32<<20)
	if err != nil {
		t.Fatal(err)
	}
	var objectKey string
	if err := pool.QueryRow(t.Context(), `
		SELECT file.object_key
		FROM skill_manifests manifest
		CROSS JOIN LATERAL jsonb_to_recordset(manifest.files)
		  AS file(path text,media_type text,size_bytes bigint,sha256 text,object_key text)
		WHERE manifest.package_state='sealed' AND file.path='SKILL.md'
		ORDER BY manifest.manifest_id
		LIMIT 1
	`).Scan(&objectKey); err != nil {
		t.Fatal(err)
	}

	runAudit := func(phase string, args ...string) (stdout []byte, stderr string, err error) {
		command := exec.CommandContext(t.Context(), binary, args...)
		command.Env = []string{
			"PATH=" + os.Getenv("PATH"),
			"TEAMHUB_DATABASE_URL=" + databaseURL,
			"TEAMHUB_ARTIFACT_STORAGE_ROOT=" + artifactRoot,
		}
		var out, errOut bytes.Buffer
		command.Stdout = &out
		command.Stderr = &errOut
		err = command.Run()
		// A nonzero exit is expected for the missing-object scenario. The caller
		// asserts each outcome; a passing negative check is a completed phase.
		return out.Bytes(), errOut.String(), err
	}

	stdout, stderr, err := runAudit("skill_audit_healthy")
	if err != nil {
		t.Fatalf("healthy audit failed: %v stderr=%s", err, stderr)
	}
	var report map[string]any
	if err := json.Unmarshal(stdout, &report); err != nil {
		t.Fatalf("audit stdout is not one JSON object: %v %s", err, stdout)
	}
	if report["manifest_count"] == nil || report["manifest_count"] == float64(0) {
		t.Fatalf("audit report=%v, want sealed Manifests counted", report)
	}

	if err := store.Delete(t.Context(), objectKey); err != nil {
		t.Fatal(err)
	}
	if _, stderr, err := runAudit("skill_audit_missing"); err == nil || !strings.Contains(stderr, objectKey) {
		t.Fatalf("audit of missing object err=%v stderr=%s, want failure naming %s", err, stderr, objectKey)
	}
	if _, stderr, err := runAudit("skill_audit_repair", "-repair-builtin"); err != nil {
		t.Fatalf("repaired audit failed: %v stderr=%s", err, stderr)
	}
	if _, err := store.Head(t.Context(), objectKey); err != nil {
		t.Fatalf("built-in object was not repaired: %v", err)
	}
}

// skillPackageAuditBinary compiles the audit CLI from this checkout.
func skillPackageAuditBinary(t *testing.T) string {
	t.Helper()
	binary := filepath.Join(t.TempDir(), "skill-package-audit")
	build := exec.CommandContext(t.Context(), "go", "build", "-trimpath", "-o", binary, "./cmd/skill-package-audit")
	build.Dir = repositoryPath("apps", "teamhub")
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build skill-package-audit: %v %s", err, output)
	}
	return binary
}

// seedProbeSkillPackage seals one single-file Manifest. The SKILL.md row carries
// the given metadata, which the probe checks against the stored object. The
// Manifest aggregate size must match that row because the seal trigger verifies it.
func seedProbeSkillPackage(
	t *testing.T,
	pool *pgxpool.Pool,
	index int,
	objectKey string,
	sizeBytes int64,
	digest [sha256.Size]byte,
	manifestSize int64,
) {
	t.Helper()
	packageDigest := skill.CanonicalPackageDigest([]skill.PackageFile{{
		Path: "SKILL.md", MediaType: "text/markdown; charset=utf-8",
		SizeBytes: sizeBytes, SHA256: digest,
	}})
	skillID := fmt.Sprintf("skill_probe_%02d", index)
	manifestID := fmt.Sprintf("skill_manifest_probe_%02d", index)
	tx, err := pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	if _, err := tx.Exec(t.Context(), `
		INSERT INTO skills(skill_id,owner_kind,tenant_id,name)
		VALUES($1,'tenant',$2,$3)
	`, skillID, acmeTenant, fmt.Sprintf("probe-skill-%02d", index)); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(t.Context(), `
		INSERT INTO skill_manifests(
			manifest_id,skill_id,manifest_version,description,config_schema,
			content_hash,file_count,size_bytes
		) VALUES($1,$2,'1.0.0','Probe fixture.','{}',$3,1,$4)
	`, manifestID, skillID, packageDigest[:], manifestSize); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(t.Context(), `
		UPDATE skill_manifests SET files=jsonb_build_array(jsonb_build_object(
			'path','SKILL.md','media_type','text/markdown; charset=utf-8','size_bytes',$2::bigint,
			'sha256',encode($3::bytea,'hex'),'object_key',$4::text
		)) WHERE manifest_id=$1
	`, manifestID, sizeBytes, digest[:], objectKey); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(t.Context(), `
		UPDATE skill_manifests SET package_state='sealed',sealed_at=clock_timestamp()
		WHERE manifest_id=$1
	`, manifestID); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
}
