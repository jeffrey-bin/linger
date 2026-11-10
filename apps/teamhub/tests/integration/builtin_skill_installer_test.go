package integration_test

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"io/fs"
	"slices"
	"sync"
	"testing"
	"testing/fstest"

	"github.com/jackc/pgx/v5/pgxpool"
	artifactstore "github.com/simplexai-labs/linger/apps/teamhub/internal/artifact"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/skill"
	builtinskills "github.com/simplexai-labs/linger/skills"
)

const (
	builtinFixtureSkillID    = "fixture_builtin_skill"
	builtinFixtureManifest   = "fixture_builtin_skill_1_0_1"
	builtinCatalogSkillCount = 15
)

func TestBuiltinSkillInstallerImportsCatalog(t *testing.T) {
	allowParallelIntegrationTest(t)
	ctx := t.Context()
	pool, err := pgxpool.New(ctx, newIntegrationDatabaseWithoutSkills(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	delegate, err := artifactstore.NewLocalStore(t.TempDir(), 32<<20)
	if err != nil {
		t.Fatal(err)
	}

	if err := skill.EnsureFromFSForTest(ctx, pool, delegate, builtinInstallerFixtureFS()); err != nil {
		t.Fatalf("Ensure built-in Skill catalog: %v", err)
	}

	for query, want := range map[string]int{
		`SELECT count(*) FROM skills
		 WHERE skill_id='fixture_builtin_skill' AND owner_kind='platform'
		   AND name='fixture-builtin-skill' AND default_agent_types=ARRAY['general']::text[]`: 1,
		`SELECT count(*) FROM skill_manifests
		 WHERE skill_id='fixture_builtin_skill'
		   AND package_state='sealed' AND file_count=1`: 2,
		`SELECT COALESCE(sum(jsonb_array_length(files)),0)::integer FROM skill_manifests
		 WHERE skill_id='fixture_builtin_skill'`: 2,
		`SELECT count(*) FROM skill_manifests
		 WHERE skill_id='fixture_builtin_skill' AND state='active'`: 2,
		`SELECT count(*) FROM skills
		 WHERE skill_id='fixture_builtin_skill'
		   AND latest_manifest_id='fixture_builtin_skill_1_0_1'`: 1,
		`SELECT count(*) FROM agent_skill_bindings
		 WHERE skill_id='fixture_builtin_skill'`: 0,
	} {
		var got int
		if err := pool.QueryRow(ctx, query).Scan(&got); err != nil {
			t.Fatal(err)
		}
		if got != want {
			t.Fatalf("query %q count=%d want=%d", query, got, want)
		}
	}
}

func builtinInstallerFixtureFS() fstest.MapFS {
	return fstest.MapFS{
		"builtin/catalog.yaml": {Data: []byte(`schema_version: 1
skills:
  - skill_id: fixture_builtin_skill
    bootstrap_manifest_id: fixture_builtin_skill_1_0_1
    default_agent_types: [general]
    manifests:
      - manifest_id: fixture_builtin_skill_1_0_0
        version: 1.0.0
        package_path: builtin/fixture-builtin-skill/1.0.0
      - manifest_id: fixture_builtin_skill_1_0_1
        version: 1.0.1
        package_path: builtin/fixture-builtin-skill/1.0.1
`)},
		"builtin/fixture-builtin-skill/1.0.0/SKILL.md": {Data: []byte("---\nname: fixture-builtin-skill\ndescription: Fixture built-in Skill v1.\n---\n\n# Fixture v1\n")},
		"builtin/fixture-builtin-skill/1.0.1/SKILL.md": {Data: []byte("---\nname: fixture-builtin-skill\ndescription: Fixture built-in Skill v2.\n---\n\n# Fixture v2\n")},
	}
}

func TestBuiltinSkillInstallerRejectsPersistedIdentityConflict(t *testing.T) {
	allowParallelIntegrationTest(t)
	ctx := t.Context()
	pool, err := pgxpool.New(ctx, newIntegrationDatabaseWithoutSkills(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
		INSERT INTO skills(skill_id,owner_kind,name)
		VALUES($1,'platform','different-skill')
	`, builtinFixtureSkillID); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	objects, err := artifactstore.NewLocalStore(t.TempDir(), 32<<20)
	if err != nil {
		t.Fatal(err)
	}
	if err := skill.EnsureFromFSForTest(ctx, pool, objects, builtinInstallerFixtureFS()); !errors.Is(err, skill.ErrBuiltinSkillConflict) {
		t.Fatalf("Ensure error=%v, want ErrBuiltinSkillConflict", err)
	}
	var name string
	if err := pool.QueryRow(ctx, `SELECT name FROM skills WHERE skill_id=$1`, builtinFixtureSkillID).Scan(&name); err != nil {
		t.Fatal(err)
	}
	if name != "different-skill" {
		t.Fatalf("conflicting identity changed to %q", name)
	}
}

func TestBuiltinSkillInstallerValidatesRepairedFinalBaseline(t *testing.T) {
	allowParallelIntegrationTest(t)
	ctx := t.Context()
	pool, err := pgxpool.New(ctx, newIntegrationDatabaseWithoutSkills(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	objects, err := artifactstore.NewLocalStore(t.TempDir(), 32<<20)
	if err != nil {
		t.Fatal(err)
	}
	if err := skill.EnsureFromFSForTest(ctx, pool, objects, builtinInstallerFixtureFS()); err != nil {
		t.Fatalf("seed built-in Skill fixture: %v", err)
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
		UPDATE skills SET latest_manifest_id=NULL WHERE skill_id=$1
	`, builtinFixtureSkillID); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	seedGeneralDefaultSkills(t, ctx, pool, 100, "repair-default")

	if err := skill.EnsureFromFSForTest(ctx, pool, objects, builtinInstallerFixtureFS()); !errors.Is(err, skill.ErrBuiltinSkillConflict) {
		t.Fatalf("repairing Ensure error=%v, want ErrBuiltinSkillConflict", err)
	}
	if got := countRows(t, &testEnv{pool: pool}, `
		SELECT count(*) FROM skills WHERE skill_id=$1 AND latest_manifest_id IS NOT NULL
	`, builtinFixtureSkillID); got != 0 {
		t.Fatalf("failed repair committed latest=%d", got)
	}
}

func seedGeneralDefaultSkills(
	t *testing.T,
	ctx context.Context,
	pool *pgxpool.Pool,
	count int,
	namePrefix string,
) {
	t.Helper()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	content := []byte("---\nname: fixture\ndescription: fixture\n---\n")
	fileDigest := sha256.Sum256(content)
	packageDigest := skill.CanonicalPackageDigest([]skill.PackageFile{{
		Path: "SKILL.md", MediaType: "text/markdown", SizeBytes: int64(len(content)), SHA256: fileDigest,
	}})
	statements := []struct {
		query string
		args  []any
	}{
		{`INSERT INTO skills(skill_id,owner_kind,name,default_agent_types)
		 SELECT 'general_default_' || lpad(item::text,3,'0'),'platform',
		        $2 || '-' || lpad(item::text,3,'0'),ARRAY['general']::text[]
		 FROM generate_series(1,$1) item`, []any{count, namePrefix}},
		{`INSERT INTO skill_manifests(
			manifest_id,skill_id,manifest_version,description,config_schema,
			content_hash,file_count,size_bytes
		 ) SELECT 'general_manifest_' || lpad(item::text,3,'0'),
		          'general_default_' || lpad(item::text,3,'0'),'1.0.0',
		          'General default fixture.','{}',$2,1,$3
		 FROM generate_series(1,$1) item`,
			[]any{count, packageDigest[:], len(content)}},
		{`UPDATE skill_manifests SET files=jsonb_build_array(jsonb_build_object(
		   'path','SKILL.md','media_type','text/markdown','size_bytes',$1::bigint,
		   'sha256',encode($2::bytea,'hex'),'object_key','object_' || manifest_id
		 )) WHERE skill_id LIKE 'general_default_%'`, []any{len(content), fileDigest[:]}},
		{`UPDATE skill_manifests SET package_state='sealed',sealed_at=clock_timestamp()
		 WHERE skill_id LIKE 'general_default_%'`, nil},
		{`UPDATE skills SET latest_manifest_id='general_manifest_' || substr(skill_id,17)
		 WHERE skill_id LIKE 'general_default_%'`, nil},
	}
	for _, statement := range statements {
		if _, err := tx.Exec(ctx, statement.query, statement.args...); err != nil {
			t.Fatalf("seed general default Skills: %v\n%s", err, statement.query)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
}

// builtinOpenRecorder records package file opens made through the installer's
// fs.FS boundary. Directory metadata calls delegate without Open, so only file
// reads are counted, and the catalog document that every run reads is excluded.
type builtinOpenRecorder struct {
	fs.FS
	mu    sync.Mutex
	files []string
}

func (source *builtinOpenRecorder) Open(name string) (fs.File, error) {
	if name != "builtin/catalog.yaml" {
		source.mu.Lock()
		source.files = append(source.files, name)
		source.mu.Unlock()
	}
	return source.FS.Open(name)
}

func (source *builtinOpenRecorder) Stat(name string) (fs.FileInfo, error) {
	return fs.Stat(source.FS, name)
}

func (source *builtinOpenRecorder) ReadDir(name string) ([]fs.DirEntry, error) {
	return fs.ReadDir(source.FS, name)
}

// builtinObjectCallRecorder counts the object store calls the installer makes.
type builtinObjectCallRecorder struct {
	artifactstore.ObjectStore
	calls map[string]int
}

func (store *builtinObjectCallRecorder) Head(ctx context.Context, key string) (artifactstore.Object, error) {
	store.calls["Head"]++
	return store.ObjectStore.Head(ctx, key)
}

func (store *builtinObjectCallRecorder) PutIfAbsent(
	ctx context.Context,
	key string,
	source io.Reader,
	expectedSize int64,
	expectedSHA256 [sha256.Size]byte,
) (artifactstore.Object, bool, error) {
	store.calls["PutIfAbsent"]++
	return store.ObjectStore.PutIfAbsent(ctx, key, source, expectedSize, expectedSHA256)
}

func (store *builtinObjectCallRecorder) Open(ctx context.Context, key string) (io.ReadCloser, error) {
	store.calls["Open"]++
	return store.ObjectStore.Open(ctx, key)
}

// execWithManifestGuardDisabled applies a state the product trigger rejects, such
// as an uploading Manifest after its seal, to simulate a crash or drift in a fixture.
func execWithManifestGuardDisabled(t *testing.T, ctx context.Context, pool *pgxpool.Pool, statements ...string) {
	t.Helper()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `ALTER TABLE skill_manifests DISABLE TRIGGER unified_skill_manifest_guard`); err != nil {
		t.Fatal(err)
	}
	for _, statement := range statements {
		if _, err := tx.Exec(ctx, statement); err != nil {
			t.Fatalf("fixture statement %q: %v", statement, err)
		}
	}
	if _, err := tx.Exec(ctx, `ALTER TABLE skill_manifests ENABLE TRIGGER unified_skill_manifest_guard`); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
}

func builtinInstallerFixtureWithNewVersion() fstest.MapFS {
	source := builtinInstallerFixtureFS()
	source["builtin/catalog.yaml"] = &fstest.MapFile{Data: []byte(`schema_version: 1
skills:
  - skill_id: fixture_builtin_skill
    bootstrap_manifest_id: fixture_builtin_skill_1_0_1
    default_agent_types: [general]
    manifests:
      - manifest_id: fixture_builtin_skill_1_0_0
        version: 1.0.0
        package_path: builtin/fixture-builtin-skill/1.0.0
      - manifest_id: fixture_builtin_skill_1_0_1
        version: 1.0.1
        package_path: builtin/fixture-builtin-skill/1.0.1
      - manifest_id: fixture_builtin_skill_1_0_2
        version: 1.0.2
        package_path: builtin/fixture-builtin-skill/1.0.2
`)}
	source["builtin/fixture-builtin-skill/1.0.2/SKILL.md"] = &fstest.MapFile{Data: []byte("---\nname: fixture-builtin-skill\ndescription: Fixture built-in Skill v3.\n---\n\n# Fixture v3\n")}
	return source
}

func newBuiltinInstallerObjects(t *testing.T) *artifactstore.LocalStore {
	t.Helper()
	objects, err := artifactstore.NewLocalStore(t.TempDir(), 32<<20)
	if err != nil {
		t.Fatal(err)
	}
	return objects
}

func TestBuiltinSkillInstallerRepeatStartupSkipsSealedPackages(t *testing.T) {
	allowParallelIntegrationTest(t)
	ctx := t.Context()
	pool, err := pgxpool.New(ctx, newIntegrationDatabaseWithoutSkills(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	delegate := newBuiltinInstallerObjects(t)
	if err := skill.EnsureFromFSForTest(ctx, pool, delegate, builtinInstallerFixtureFS()); err != nil {
		t.Fatalf("install built-in Skill catalog: %v", err)
	}

	source := &builtinOpenRecorder{FS: builtinInstallerFixtureFS()}
	objects := &builtinObjectCallRecorder{ObjectStore: delegate, calls: map[string]int{}}
	if err := skill.EnsureFromFSForTest(ctx, pool, objects, source); err != nil {
		t.Fatalf("repeat startup: %v", err)
	}
	if len(objects.calls) != 0 {
		t.Fatalf("repeat startup object store calls=%v, want none", objects.calls)
	}
	if len(source.files) != 0 {
		t.Fatalf("repeat startup opened package files=%v, want none", source.files)
	}

	// The verified installer must reach both the files and the object store, or the zero counts above prove nothing.
	verifiedSource := &builtinOpenRecorder{FS: builtinInstallerFixtureFS()}
	verifiedObjects := &builtinObjectCallRecorder{ObjectStore: delegate, calls: map[string]int{}}
	if err := skill.EnsureVerifiedFromFSForTest(ctx, pool, verifiedObjects, verifiedSource); err != nil {
		t.Fatalf("verified repeat install: %v", err)
	}
	if len(verifiedSource.files) == 0 || verifiedObjects.calls["Head"] == 0 {
		t.Fatalf("verified install files=%v objects=%v, want both reads", verifiedSource.files, verifiedObjects.calls)
	}
}

func TestBuiltinSkillInstallerNewVersionTouchesOnlyNewManifest(t *testing.T) {
	allowParallelIntegrationTest(t)
	ctx := t.Context()
	pool, err := pgxpool.New(ctx, newIntegrationDatabaseWithoutSkills(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	delegate := newBuiltinInstallerObjects(t)
	if err := skill.EnsureFromFSForTest(ctx, pool, delegate, builtinInstallerFixtureFS()); err != nil {
		t.Fatalf("install built-in Skill catalog: %v", err)
	}

	source := &builtinOpenRecorder{FS: builtinInstallerFixtureWithNewVersion()}
	objects := &builtinObjectCallRecorder{ObjectStore: delegate, calls: map[string]int{}}
	if err := skill.EnsureFromFSForTest(ctx, pool, objects, source); err != nil {
		t.Fatalf("install new built-in version: %v", err)
	}
	// The new file is read once to hash it and once to upload it; no other Package is opened.
	opened := slices.Compact(slices.Sorted(slices.Values(source.files)))
	if want := []string{"builtin/fixture-builtin-skill/1.0.2/SKILL.md"}; !slices.Equal(opened, want) {
		t.Fatalf("opened package files=%v, want %v", opened, want)
	}
	if objects.calls["PutIfAbsent"] != 1 || len(objects.calls) != 1 {
		t.Fatalf("object store calls=%v, want exactly one PutIfAbsent", objects.calls)
	}
	var sealedCount int
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FROM skill_manifests
		WHERE skill_id=$1 AND package_state='sealed'`, builtinFixtureSkillID).Scan(&sealedCount); err != nil {
		t.Fatal(err)
	}
	if sealedCount != 3 {
		t.Fatalf("sealed Manifests=%d, want 3", sealedCount)
	}
	var sealed, latestManifest string
	var activeCount int
	if err := pool.QueryRow(ctx, `
		SELECT latest_manifest_id FROM skills WHERE skill_id=$1`, builtinFixtureSkillID).Scan(&latestManifest); err != nil {
		t.Fatal(err)
	}
	if latestManifest != builtinFixtureManifest {
		t.Fatalf("latest Manifest=%s, want bootstrap %s", latestManifest, builtinFixtureManifest)
	}
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FROM skill_manifests
		WHERE manifest_id='fixture_builtin_skill_1_0_2' AND state='active'`).Scan(&activeCount); err != nil {
		t.Fatal(err)
	}
	if activeCount != 1 {
		t.Fatalf("new Manifest active=%d, want 1", activeCount)
	}
	if err := pool.QueryRow(ctx, `
		SELECT package_state FROM skill_manifests WHERE manifest_id='fixture_builtin_skill_1_0_2'`).Scan(&sealed); err != nil {
		t.Fatal(err)
	}
	if sealed != "sealed" {
		t.Fatalf("new Manifest state=%s, want sealed", sealed)
	}
}

func TestBuiltinSkillInstallerFastPathSealsUploadingManifest(t *testing.T) {
	allowParallelIntegrationTest(t)
	ctx := t.Context()
	pool, err := pgxpool.New(ctx, newIntegrationDatabaseWithoutSkills(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	delegate := newBuiltinInstallerObjects(t)
	if err := skill.EnsureFromFSForTest(ctx, pool, delegate, builtinInstallerFixtureFS()); err != nil {
		t.Fatalf("install built-in Skill catalog: %v", err)
	}
	// A crash after persisting files but before sealing leaves this Manifest uploading.
	execWithManifestGuardDisabled(t, ctx, pool,
		`UPDATE skill_manifests SET package_state='uploading',sealed_at=NULL WHERE manifest_id='fixture_builtin_skill_1_0_0'`)

	source := &builtinOpenRecorder{FS: builtinInstallerFixtureFS()}
	objects := &builtinObjectCallRecorder{ObjectStore: delegate, calls: map[string]int{}}
	if err := skill.EnsureFromFSForTest(ctx, pool, objects, source); err != nil {
		t.Fatalf("resume uploading Manifest: %v", err)
	}
	if !slices.Contains(source.files, "builtin/fixture-builtin-skill/1.0.0/SKILL.md") || objects.calls["Head"] == 0 {
		t.Fatalf("uploading Manifest files=%v objects=%v, want full verification", source.files, objects.calls)
	}
	var state string
	var sealedAt bool
	if err := pool.QueryRow(ctx, `
		SELECT package_state,sealed_at IS NOT NULL FROM skill_manifests
		WHERE manifest_id='fixture_builtin_skill_1_0_0'`).Scan(&state, &sealedAt); err != nil {
		t.Fatal(err)
	}
	if state != "sealed" || !sealedAt {
		t.Fatalf("resumed Manifest state=%s sealed_at set=%v, want sealed", state, sealedAt)
	}
}

func TestBuiltinSkillInstallerFastPathRejectsSealedEmbeddedDrift(t *testing.T) {
	allowParallelIntegrationTest(t)
	cases := map[string]func(fstest.MapFS){
		"file count": func(source fstest.MapFS) {
			source["builtin/fixture-builtin-skill/1.0.0/extra.md"] = &fstest.MapFile{Data: []byte("extra")}
		},
		"total size": func(source fstest.MapFS) {
			source["builtin/fixture-builtin-skill/1.0.0/SKILL.md"] = &fstest.MapFile{Data: []byte("---\nname: fixture-builtin-skill\ndescription: Fixture built-in Skill v1 drifted.\n---\n\n# Fixture v1\n")}
		},
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			ctx := t.Context()
			pool, err := pgxpool.New(ctx, newIntegrationDatabaseWithoutSkills(t))
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(pool.Close)
			delegate := newBuiltinInstallerObjects(t)
			if err := skill.EnsureFromFSForTest(ctx, pool, delegate, builtinInstallerFixtureFS()); err != nil {
				t.Fatalf("install built-in Skill catalog: %v", err)
			}
			drifted := builtinInstallerFixtureFS()
			mutate(drifted)
			if err := skill.EnsureFromFSForTest(ctx, pool, delegate, drifted); !errors.Is(err, skill.ErrBuiltinSkillConflict) {
				t.Fatalf("drifted sealed Manifest error=%v, want ErrBuiltinSkillConflict", err)
			}
		})
	}
}

func TestBuiltinSkillInstallerFastPathLeavesMissingSealedObjectForVerifiedRepair(t *testing.T) {
	allowParallelIntegrationTest(t)
	// The first install registers canonical rows, so this Manifest is trusted by count and size afterwards.
	ctx := t.Context()
	pool, err := pgxpool.New(ctx, newIntegrationDatabaseWithoutSkills(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	delegate := newBuiltinInstallerObjects(t)
	if err := skill.EnsureFromFSForTest(ctx, pool, delegate, builtinInstallerFixtureFS()); err != nil {
		t.Fatalf("install built-in Skill catalog: %v", err)
	}
	var objectKey string
	if err := pool.QueryRow(ctx, `
		SELECT file.object_key FROM skill_manifests manifest
		CROSS JOIN LATERAL jsonb_to_recordset(manifest.files)
		  AS file(path text,media_type text,size_bytes bigint,sha256 text,object_key text)
		WHERE manifest.manifest_id=$1 AND file.path='SKILL.md'`, builtinFixtureManifest).Scan(&objectKey); err != nil {
		t.Fatal(err)
	}
	if err := delegate.Delete(ctx, objectKey); err != nil {
		t.Fatalf("remove built-in object: %v", err)
	}

	if err := skill.EnsureFromFSForTest(ctx, pool, delegate, builtinInstallerFixtureFS()); err != nil {
		t.Fatalf("fast startup over marked sealed Manifests: %v", err)
	}
	if _, err := delegate.Head(ctx, objectKey); err == nil {
		t.Fatal("fast startup repaired an object of a marked sealed Manifest; repair belongs to the verified installer")
	}
	if err := skill.EnsureVerifiedFromFSForTest(ctx, pool, delegate, builtinInstallerFixtureFS()); err != nil {
		t.Fatalf("verified repair: %v", err)
	}
	if _, err := delegate.Head(ctx, objectKey); err != nil {
		t.Fatalf("verified installer did not repair object %s: %v", objectKey, err)
	}
}

func TestBuiltinSkillInstallerSealedRowWithDifferentVersionTakesFullPath(t *testing.T) {
	allowParallelIntegrationTest(t)
	ctx := t.Context()
	pool, err := pgxpool.New(ctx, newIntegrationDatabaseWithoutSkills(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	delegate := newBuiltinInstallerObjects(t)
	if err := skill.EnsureFromFSForTest(ctx, pool, delegate, builtinInstallerFixtureFS()); err != nil {
		t.Fatalf("install built-in Skill catalog: %v", err)
	}
	// The fixed Manifest ID now names another version, so the fast path must not skip it.
	execWithManifestGuardDisabled(t, ctx, pool,
		`UPDATE skill_manifests SET manifest_version='9.9.9' WHERE manifest_id='fixture_builtin_skill_1_0_0'`)
	if err := skill.EnsureFromFSForTest(ctx, pool, delegate, builtinInstallerFixtureFS()); !errors.Is(err, skill.ErrBuiltinSkillConflict) {
		t.Fatalf("Manifest with a different persisted version error=%v, want ErrBuiltinSkillConflict", err)
	}
}

func TestBuiltinSkillInstallerConcurrentFastPathInstallsOnce(t *testing.T) {
	allowParallelIntegrationTest(t)
	ctx := t.Context()
	pool, err := pgxpool.New(ctx, newIntegrationDatabaseWithoutSkills(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	objects := newBuiltinInstallerObjects(t)

	const installers = 2
	errs := make(chan error, installers)
	var wg sync.WaitGroup
	for range installers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			errs <- skill.EnsureFromFSForTest(ctx, pool, objects, builtinInstallerFixtureFS())
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatalf("concurrent installer: %v", err)
		}
	}
	for query, want := range map[string]int{
		`SELECT count(*) FROM skill_manifests WHERE skill_id='fixture_builtin_skill'`: 2,
		`SELECT count(*) FROM skills WHERE skill_id='fixture_builtin_skill'
		 AND latest_manifest_id IS NOT NULL AND default_agent_types=ARRAY['general']::text[]`: 1,
	} {
		var got int
		if err := pool.QueryRow(ctx, query).Scan(&got); err != nil {
			t.Fatal(err)
		}
		if got != want {
			t.Fatalf("query %q count=%d want=%d", query, got, want)
		}
	}
}

// failingPutObjectStore fails one PutIfAbsent call so tests can interrupt an installation mid-run.
type failingPutObjectStore struct {
	artifactstore.ObjectStore
	failOn int
	puts   int
}

func (store *failingPutObjectStore) PutIfAbsent(
	ctx context.Context,
	key string,
	source io.Reader,
	expectedSize int64,
	expectedSHA256 [sha256.Size]byte,
) (artifactstore.Object, bool, error) {
	store.puts++
	if store.puts == store.failOn {
		return artifactstore.Object{}, false, errors.New("injected object store failure")
	}
	return store.ObjectStore.PutIfAbsent(ctx, key, source, expectedSize, expectedSHA256)
}

// builtinCanonicalObjectKey mirrors the installer's content-addressed object key.
func builtinCanonicalObjectKey(digest []byte) string {
	hash := sha256.New()
	_, _ = hash.Write([]byte("teamhub.builtin-skill-object.v1\x00"))
	_, _ = hash.Write(digest)
	return "object_" + hex.EncodeToString(hash.Sum(nil)[:16])
}

func TestBuiltinSkillInstallerRepeatStartupTouchesNoPackage(t *testing.T) {
	allowParallelIntegrationTest(t)
	ctx := t.Context()
	pool, err := pgxpool.New(ctx, newIntegrationDatabaseWithoutSkills(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	delegate := newBuiltinInstallerObjects(t)
	if err := skill.Ensure(ctx, pool, delegate); err != nil {
		t.Fatalf("plain startup on fresh database: %v", err)
	}
	if _, err := skill.AuditPackagesWithOptions(ctx, pool, delegate, skill.AuditOptions{}); err != nil {
		t.Fatalf("every sealed built-in object must exist after startup: %v", err)
	}
	if _, err := skill.ProbePackageStorage(ctx, pool, delegate); err != nil {
		t.Fatalf("storage probe after startup: %v", err)
	}
	// The first startup seals every built-in, and every file uses its
	// content-addressed key.
	rows, err := pool.Query(ctx, `
		SELECT manifest.manifest_id,manifest.package_state,decode(file.sha256,'hex'),file.object_key
		FROM skill_manifests manifest
		CROSS JOIN LATERAL jsonb_to_recordset(manifest.files)
		  AS file(path text,media_type text,size_bytes bigint,sha256 text,object_key text)
		JOIN skills skill ON skill.skill_id=manifest.skill_id
		WHERE skill.owner_kind='platform'`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	for rows.Next() {
		var manifestID, state, key string
		var digest []byte
		if err := rows.Scan(&manifestID, &state, &digest, &key); err != nil {
			t.Fatal(err)
		}
		if state != "sealed" || key != builtinCanonicalObjectKey(digest) {
			t.Fatalf("built-in %s file state=%s key=%s, want sealed content-addressed", manifestID, state, key)
		}
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}

	source := &builtinOpenRecorder{FS: builtinskills.FS}
	objects := &builtinObjectCallRecorder{ObjectStore: delegate, calls: map[string]int{}}
	if err := skill.EnsureFromFSForTest(ctx, pool, objects, source); err != nil {
		t.Fatalf("repeat startup: %v", err)
	}
	if len(source.files) != 0 || len(objects.calls) != 0 {
		t.Fatalf("repeat startup opened %v and called the object store %v, want neither", source.files, objects.calls)
	}
}

func TestBuiltinSkillInstallerFailedInstallLeavesNoSealedRowsAndRetries(t *testing.T) {
	allowParallelIntegrationTest(t)
	ctx := t.Context()
	pool, err := pgxpool.New(ctx, newIntegrationDatabaseWithoutSkills(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	delegate := newBuiltinInstallerObjects(t)
	// The first Manifest registers canonical rows before the second upload fails.
	failing := &failingPutObjectStore{ObjectStore: delegate, failOn: 2}
	if err := skill.EnsureFromFSForTest(ctx, pool, failing, builtinInstallerFixtureFS()); err == nil {
		t.Fatal("interrupted installation succeeded")
	}
	// The fast path trusts canonical sealed rows, so a partial run must not commit any of them.
	var manifests, files int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM skill_manifests WHERE skill_id=$1`, builtinFixtureSkillID).Scan(&manifests); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `
		SELECT COALESCE(sum(jsonb_array_length(files)),0)::integer FROM skill_manifests
		WHERE skill_id=$1`, builtinFixtureSkillID).Scan(&files); err != nil {
		t.Fatal(err)
	}
	if manifests != 0 || files != 0 {
		t.Fatalf("rolled-back installation left manifests=%d files=%d", manifests, files)
	}

	if err := skill.EnsureFromFSForTest(ctx, pool, delegate, builtinInstallerFixtureFS()); err != nil {
		t.Fatalf("retry after interrupted installation: %v", err)
	}
	// Check only the fixture's objects; the bare database's migration rows belong to the real catalog.
	rows, err := pool.Query(ctx, `
		SELECT file.object_key FROM skill_manifests manifest
		CROSS JOIN LATERAL jsonb_to_recordset(manifest.files)
		  AS file(path text,media_type text,size_bytes bigint,sha256 text,object_key text)
		WHERE manifest.skill_id=$1`, builtinFixtureSkillID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var objectCount int
	for rows.Next() {
		var key string
		if err := rows.Scan(&key); err != nil {
			t.Fatal(err)
		}
		if _, err := delegate.Head(ctx, key); err != nil {
			t.Fatalf("retried installation object %s: %v", key, err)
		}
		objectCount++
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if objectCount != 2 {
		t.Fatalf("retried installation file objects=%d, want 2", objectCount)
	}
}
