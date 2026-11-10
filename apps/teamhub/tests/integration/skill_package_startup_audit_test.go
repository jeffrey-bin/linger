package integration_test

import (
	"context"
	"crypto/sha256"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/app"
	artifactstore "github.com/simplexai-labs/linger/apps/teamhub/internal/artifact"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/config"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/skill"
)

func TestTeamHubStartupAuditsSealedSkillPackageObjects(t *testing.T) {
	allowParallelIntegrationTest(t)
	databaseURL := newIntegrationDatabase(t)
	artifactRoot := t.TempDir()
	cfg := config.ForTest(func(c *config.Config) {
		c.DatabaseURL = databaseURL
		c.SessionTTL = time.Hour
		c.CookieName = "teamhub_session"
		c.ArtifactStorageRoot = artifactRoot
		c.ArtifactMaxBytes = 1 << 20
	})

	// The database is seeded with built-ins, but this artifact root is empty. Startup skips
	// sealed built-ins, so the bounded probe must detect the missing objects.
	first, err := newTestApp(t.Context(), cfg, withConfig(func(cfg *config.Config) { cfg.Jobs.SkillPackageProbeRetry = 20 * time.Millisecond }))
	if err != nil {
		t.Fatalf("initial startup: %v", err)
	}
	waitForStartupAuditReadyz(t, first, http.StatusServiceUnavailable, "SKILL_PACKAGE_AUDIT_FAILED")
	// Independent readers (including old binaries) must not need this image's embedded files.
	shared, err := artifactstore.NewLocalStore(artifactRoot, 32<<20)
	if err != nil {
		t.Fatal(err)
	}
	auditPool, err := pgxpool.New(t.Context(), databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer auditPool.Close()
	// The ops repair path (teamhub-skill-package-audit -repair-builtin) publishes the missing objects.
	if err := skill.EnsureVerified(t.Context(), auditPool, shared); err != nil {
		t.Fatalf("verified built-in repair: %v", err)
	}
	if _, err := skill.AuditPackagesWithOptions(t.Context(), auditPool, shared, skill.AuditOptions{}); err != nil {
		t.Fatalf("shared package publication: %v", err)
	}
	// The retrying probe restores readiness without a restart once the objects are back.
	waitForStartupAuditReadyz(t, first, http.StatusOK, "")
	first.Close()

	pool, err := pgxpool.New(t.Context(), databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	seedMissingStartupAuditPackage(t, pool)

	failed, err := newTestApp(t.Context(), cfg)
	if err != nil {
		t.Fatalf("startup should return an App while the background audit fails: %v", err)
	}
	defer failed.Close()
	waitForStartupAuditReadyz(t, failed, http.StatusServiceUnavailable, "SKILL_PACKAGE_AUDIT_FAILED")
}

// waitForStartupAuditReadyz polls /readyz until the background storage probe
// reaches the expected status and, when set, the expected error code.
func waitForStartupAuditReadyz(t *testing.T, application *app.App, wantStatus int, wantCode string) {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for {
		recorder := httptest.NewRecorder()
		application.Handler().ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/readyz", nil))
		if recorder.Code == wantStatus && (wantCode == "" || strings.Contains(recorder.Body.String(), wantCode)) {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("readyz status=%d body=%s, want status=%d code=%q", recorder.Code, recorder.Body.String(), wantStatus, wantCode)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func seedMissingStartupAuditPackage(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	content := []byte("---\nname: startup-audit\ndescription: Startup audit fixture.\n---\n\n# Audit\n")
	fileDigest := sha256.Sum256(content)
	packageDigest := skill.CanonicalPackageDigest([]skill.PackageFile{{
		Path: "SKILL.md", MediaType: "text/markdown; charset=utf-8",
		SizeBytes: int64(len(content)), SHA256: fileDigest,
	}})
	tx, err := pool.Begin(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	if _, err := tx.Exec(t.Context(), `
		INSERT INTO skills(skill_id,owner_kind,tenant_id,name)
		VALUES('skill_startup_audit_missing','tenant',$1,'startup-audit')
	`, acmeTenant); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(t.Context(), `
		INSERT INTO skill_manifests(
			manifest_id,skill_id,manifest_version,description,config_schema,
			content_hash,file_count,size_bytes
		) VALUES(
			'skill_manifest_startup_audit_missing','skill_startup_audit_missing','1.0.0',
			'Startup audit fixture.','{}',$1,1,$2
		)
	`, packageDigest[:], len(content)); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(t.Context(), `
		UPDATE skill_manifests SET files=jsonb_build_array(jsonb_build_object(
			'path','SKILL.md','media_type','text/markdown; charset=utf-8','size_bytes',$1::bigint,
			'sha256',encode($2::bytea,'hex'),'object_key',$3::text
		)) WHERE manifest_id='skill_manifest_startup_audit_missing'
	`, len(content), fileDigest[:], "object_"+strings.Repeat("9", 32)); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(t.Context(), `
		UPDATE skill_manifests
		SET package_state='sealed',sealed_at=clock_timestamp()
		WHERE manifest_id='skill_manifest_startup_audit_missing'
	`); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
}
