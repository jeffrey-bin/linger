package integration_test

import (
	"bytes"
	"crypto/sha256"
	"io"
	"os"
	"path/filepath"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	artifactstore "github.com/simplexai-labs/linger/apps/teamhub/internal/artifact"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/platform/agenttemplates"
)

// copyTemplateSkillObjects pairs a database clone with its own writable object
// root. Copy only catalog objects named by that clone, never other tests' files;
// verify the same size/digest evidence as installation without reinstalling the
// catalog. Copies are ordinary files, not links into shared mutable storage.
func copyTemplateSkillObjects(t *testing.T, pool *pgxpool.Pool) string {
	t.Helper()
	root := t.TempDir()
	source, err := artifactstore.NewLocalStore(integrationSkillArtifactRoot(), integrationSkillObjectMaxBytes)
	if err != nil {
		t.Fatal(err)
	}
	rows, err := pool.Query(t.Context(), `SELECT DISTINCT file.object_key,file.size_bytes,decode(file.sha256,'hex')
	 FROM skill_manifests manifest
	 CROSS JOIN LATERAL jsonb_to_recordset(manifest.files)
	   AS file(path text,media_type text,size_bytes bigint,sha256 text,object_key text)
	 JOIN skills skill ON skill.skill_id=manifest.skill_id
	 WHERE skill.owner_kind='platform'`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	count := 0
	for rows.Next() {
		var key string
		var size int64
		var digest []byte
		if err := rows.Scan(&key, &size, &digest); err != nil {
			t.Fatal(err)
		}
		if size < 0 || size > integrationSkillObjectMaxBytes {
			t.Fatalf("invalid template object size: %s=%d", key, size)
		}
		file, err := source.Open(t.Context(), key)
		if err != nil {
			t.Fatal(err)
		}
		content, readErr := io.ReadAll(io.LimitReader(file, size+1))
		closeErr := file.Close()
		if readErr != nil {
			t.Fatal(readErr)
		}
		if closeErr != nil {
			t.Fatal(closeErr)
		}
		actual := sha256.Sum256(content)
		if int64(len(content)) != size || !bytes.Equal(actual[:], digest) {
			t.Fatalf("template object evidence differs: %s", key)
		}
		if err := os.WriteFile(filepath.Join(root, key), content, 0o600); err != nil {
			t.Fatal(err)
		}
		count++
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if count == 0 {
		t.Fatal("Skill-seeded database has no catalog objects")
	}
	return root
}

// prepareTemplateAppCatalog preserves normal startup catalog state while keeping
// each application's writable objects private. Only the repeated Skill install
// is skipped by callers; application audits and workers keep their own defaults.
func prepareTemplateAppCatalog(t *testing.T, pool *pgxpool.Pool) string {
	t.Helper()
	root := copyTemplateSkillObjects(t, pool)
	if err := agenttemplates.Ensure(t.Context(), pool); err != nil {
		t.Fatal(err)
	}
	return root
}
