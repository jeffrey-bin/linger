package integration_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"io"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/jackc/pgx/v5/pgxpool"
	artifactstore "github.com/simplexai-labs/linger/apps/teamhub/internal/artifact"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/skill"
)

type interruptedSkillStore struct {
	artifactstore.ObjectStore
	writes int
}

func (s *interruptedSkillStore) PutIfAbsent(ctx context.Context, key string, source io.Reader, size int64, digest [sha256.Size]byte) (artifactstore.Object, bool, error) {
	s.writes++
	if s.writes == 2 {
		return artifactstore.Object{}, false, errors.New("storage interrupted")
	}
	return s.ObjectStore.PutIfAbsent(ctx, key, source, size, digest)
}

func TestSkillPackagePublicationRecoversAfterStorageFailure(t *testing.T) {
	allowParallelIntegrationTest(t)
	ctx := t.Context()
	pool, err := pgxpool.New(ctx, newIntegrationDatabase(t))
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	shared, err := artifactstore.NewLocalStore(t.TempDir(), 32<<20)
	if err != nil {
		t.Fatal(err)
	}
	interrupted := &interruptedSkillStore{ObjectStore: shared}
	if err := skill.EnsureFromFSForTest(ctx, pool, interrupted, skillPolicyCatalog("1.0.0", "[]")); err == nil {
		t.Fatal("partial upload published a package")
	}
	var count int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM skill_manifests WHERE skill_id='fixture_policy'`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatal("failed package upload committed metadata")
	}
	for range 2 {
		if err := skill.EnsureFromFSForTest(ctx, pool, shared, skillPolicyCatalog("1.0.0", "[]")); err != nil {
			t.Fatal(err)
		}
	}
	rows, err := pool.Query(ctx, `SELECT file.object_key,decode(file.sha256,'hex') FROM skill_manifests manifest CROSS JOIN LATERAL jsonb_to_recordset(manifest.files) AS file(path text,media_type text,size_bytes bigint,sha256 text,object_key text) WHERE manifest.skill_id='fixture_policy' AND manifest.package_state='sealed'`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	count = 0
	for rows.Next() {
		var key string
		var expected []byte
		if err := rows.Scan(&key, &expected); err != nil {
			t.Fatal(err)
		}
		reader, err := shared.Open(ctx, key)
		if err != nil {
			t.Fatal(err)
		}
		content, err := io.ReadAll(reader)
		_ = reader.Close()
		if err != nil {
			t.Fatal(err)
		}
		digest := sha256.Sum256(content)
		if !bytes.Equal(digest[:], expected) {
			t.Fatal("published bytes differ")
		}
		count++
	}
	if rows.Err() != nil || count != 2 {
		t.Fatalf("recovered package files=%d error=%v", count, rows.Err())
	}
}

func TestSkillCatalogStartupChecksCombinedAgentCapacity(t *testing.T) {
	allowParallelIntegrationTest(t)
	ctx, pool, shared := newSkillPolicyFixture(t, "{}")
	if _, err := pool.Exec(ctx, `UPDATE agent_registrations SET agent_type='general' WHERE actor_id='actor_policy_agent'`); err != nil {
		t.Fatal(err)
	}
	var existing int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM skills WHERE 'general'=ANY(default_agent_types)`).Scan(&existing); err != nil {
		t.Fatal(err)
	}
	seedGeneralDefaultSkills(t, ctx, pool, 99-existing, "capacity")
	identity := skillPolicyIdentity()
	identity.AgentType = "general"
	validate := func() {
		tx, err := pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(ctx)
		if err := skill.ValidateEffectiveInTx(ctx, tx, identity); err != nil {
			t.Fatalf("original effective set: %v", err)
		}
	}
	validate()
	catalog := skillPolicyCatalog("1.0.0", "[general]")
	for _, file := range catalog {
		file.Data = []byte(strings.ReplaceAll(strings.ReplaceAll(string(file.Data), "fixture_policy", "fixture_extra"), "fixture-policy", "fixture-extra"))
	}
	// Package paths in the fixture filesystem need to match the renamed catalog.
	renamed := fstest.MapFS{}
	for name, file := range catalog {
		renamed[strings.ReplaceAll(name, "fixture-policy", "fixture-extra")] = file
	}
	if err := skill.EnsureFromFSForTest(ctx, pool, shared, renamed); err == nil || !strings.Contains(err.Error(), "101 exceeds 100") {
		t.Fatalf("combined capacity error=%v", err)
	}
	validate()
}
