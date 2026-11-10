package integration_test

import (
	"context"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

func TestSkillIdentifierLimits(t *testing.T) {
	allowParallelIntegrationTest(t)
	databaseURL := newIntegrationDatabase(t)
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	skillID := "s" + strings.Repeat("x", 511)
	manifestID := "m" + strings.Repeat("y", 511)
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
		INSERT INTO skills(skill_id,owner_kind,name,default_agent_types)
		VALUES($1,'platform','identifier-boundary',ARRAY[]::text[])
	`, skillID); err != nil {
		t.Fatalf("insert 512-character Skill ID: %v", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO skill_manifests(
			manifest_id,skill_id,manifest_version,description,config_schema,
			content_hash,file_count,size_bytes,package_state
		) VALUES($1,$2,'1.0.0','Boundary Manifest','{}',decode(repeat('00',32),'hex'),1,1,'uploading')
	`, manifestID, skillID); err != nil {
		t.Fatalf("insert 512-character Manifest ID: %v", err)
	}
	path := "assets/" + strings.Repeat("a", 1017)
	if _, err := tx.Exec(ctx, `
		UPDATE skill_manifests SET files=jsonb_build_array(jsonb_build_object(
			'path',$2::text,'media_type','application/octet-stream','size_bytes',0,
			'sha256',repeat('00',32),'object_key','object_boundary'
		)) WHERE manifest_id=$1
	`, manifestID, path); err != nil {
		t.Fatalf("index maximum Skill Manifest and package path: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit maximum Skill identifiers: %v", err)
	}

	if _, err := pool.Exec(ctx, `
		INSERT INTO skills(skill_id,owner_kind,name,default_agent_types)
		VALUES($1,'platform','oversized-skill',ARRAY[]::text[])
	`, "s"+strings.Repeat("x", 512)); err == nil {
		t.Fatal("513-character Skill ID was accepted")
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO skill_manifests(
			manifest_id,skill_id,manifest_version,description,config_schema,
			content_hash,file_count,size_bytes,package_state
		) VALUES($1,$2,'2.0.0','Oversized Manifest','{}',decode(repeat('00',32),'hex'),1,1,'uploading')
	`, "m"+strings.Repeat("y", 512), skillID); err == nil {
		t.Fatal("513-character Manifest ID was accepted")
	}
}
