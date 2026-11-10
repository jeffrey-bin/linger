package integration_test

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/skill"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

func TestSkillContextResolverReadsCurrentPolicyUnderItsLock(t *testing.T) {
	allowParallelIntegrationTest(t)
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, newIntegrationDatabaseWithoutSkills(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	seedSkillContextGenerationStore(t, ctx, pool)
	identity := skill.Identity{
		AgentID: "agent_management_skill_context", AgentActorID: "actor_skill_context_agent",
		TenantID: "tenant_skill_context", AgentType: "general",
	}
	resolve := func() []skill.Item {
		t.Helper()
		tx, err := pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(ctx)
		if err := store.New(tx).AcquireUnifiedSkillPolicySharedLock(ctx); err != nil {
			t.Fatal(err)
		}
		items, _, err := skill.ResolveEffectiveInTx(ctx, tx, identity)
		if err != nil {
			t.Fatal(err)
		}
		if err := tx.Commit(ctx); err != nil {
			t.Fatal(err)
		}
		return items
	}
	items := resolve()
	if len(items) != 2 || items[0].SkillID != "linger_default_query" ||
		items[0].Source != "default" || items[1].SkillID != "tenant_explicit_query" ||
		items[1].Source != "explicit" || items[1].Config["mode"] != "query" {
		t.Fatalf("resolved Skills=%+v", items)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO agent_skill_bindings(
			id,tenant_id,agent_actor_id,skill_id,manifest_version,enabled,config,binding_version,updated_by_actor_id
		) VALUES('binding_cross_tenant_query','tenant_skill_context','actor_skill_context_agent',
				 'tenant_foreign_query','3.0.0',true,'{}',1,'actor_skill_context_human')
	`); err == nil || !strings.Contains(err.Error(), "different Tenant") {
		t.Fatalf("cross-Tenant binding error=%v want Tenant authority rejection", err)
	}

	lockTransaction, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.New(lockTransaction).AcquireUnifiedSkillPolicySharedLock(ctx); err != nil {
		_ = lockTransaction.Rollback(ctx)
		t.Fatal(err)
	}
	writeStarted := make(chan struct{})
	writeDone := make(chan error, 1)
	go func() {
		close(writeStarted)
		_, writeErr := pool.Exec(ctx, `
			UPDATE agent_skill_bindings
			SET config='{"mode":"updated"}',binding_version=2,updated_at=clock_timestamp()
			WHERE id='binding_explicit_query'
		`)
		writeDone <- writeErr
	}()
	<-writeStarted
	select {
	case writeErr := <-writeDone:
		_ = lockTransaction.Rollback(ctx)
		t.Fatalf("binding write bypassed shared Skill Policy lock: %v", writeErr)
	case <-time.After(150 * time.Millisecond):
	}
	if err := lockTransaction.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case writeErr := <-writeDone:
		if writeErr != nil {
			t.Fatalf("binding write after Skill Policy lock release: %v", writeErr)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("binding write remained blocked after Skill Policy lock release")
	}
	if items := resolve(); items[1].Config["mode"] != "updated" {
		t.Fatalf("resolver did not read the current binding: %+v", items)
	}
}

func seedSkillContextGenerationStore(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	t.Helper()
	transaction, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = transaction.Rollback(ctx) }()
	statements := []string{
		`INSERT INTO accounts(id,email,password_hash)
		 VALUES('account_skill_context','skill-context@example.com','x')`,
		`INSERT INTO actors(id,tenant_id,kind,display_name,account_id,handle) VALUES
		 ('actor_skill_context_human','tenant_skill_context','human','Human','account_skill_context',NULL),
		 ('actor_skill_context_agent','tenant_skill_context','agent','Agent',NULL,'skill-context-agent')`,
		`INSERT INTO agent_registrations(
			actor_id,tenant_id,agent_management_id,status,instructions,runtime_model,
			created_by_actor_id,agent_type
		 ,computer_id,local_runtime_type,workspace_grant_id) VALUES(
			'actor_skill_context_agent','tenant_skill_context','agent_management_skill_context',
			'active','Run Skill context query tests.','test-model',
			'actor_skill_context_human','general'
		 ,'computer_fixture','codex','grant_files')`,
		`INSERT INTO skills(
			skill_id,owner_kind,name,default_agent_types
		 ) VALUES(
			'linger_default_query','platform','default-query',ARRAY['general']::text[]
		 )`,
		`INSERT INTO skill_manifests(
			manifest_id,skill_id,manifest_version,description,config_schema,
			content_hash,file_count,size_bytes
		 ) VALUES(
			'manifest_default_query','linger_default_query','1.0.0',
			'Default query Skill.','{}',
			sha256(convert_to('teamhub.skill-package.v1','UTF8') || decode('00','hex') ||
				   int8send(8::bigint) || convert_to('SKILL.md','UTF8') ||
				   int8send(10::bigint) || decode(repeat('aa',32),'hex')),
			1,10
		 )`,
		`UPDATE skill_manifests SET files=jsonb_build_array(jsonb_build_object(
			'path','SKILL.md','media_type','text/markdown','size_bytes',10,
			'sha256',repeat('aa',32),'object_key','object_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
		 )) WHERE manifest_id='manifest_default_query'`,
		`UPDATE skill_manifests SET package_state='sealed',sealed_at=clock_timestamp()
		 WHERE manifest_id='manifest_default_query'`,
		`UPDATE skills SET latest_manifest_id='manifest_default_query'
		 WHERE skill_id='linger_default_query'`,
		`INSERT INTO skills(
			skill_id,owner_kind,tenant_id,name,default_agent_types,created_by_actor_id
		 ) VALUES(
			'tenant_explicit_query','tenant','tenant_skill_context','explicit-query',
			ARRAY[]::text[],'actor_skill_context_human'
		 )`,
		`INSERT INTO skill_manifests(
			manifest_id,skill_id,manifest_version,description,config_schema,
			content_hash,file_count,size_bytes,created_by_actor_id
		 ) VALUES(
			'manifest_explicit_query','tenant_explicit_query','2.1.0',
			'Explicit query Skill.','{"type":"object"}',
			sha256(convert_to('teamhub.skill-package.v1','UTF8') || decode('00','hex') ||
				   int8send(8::bigint) || convert_to('SKILL.md','UTF8') ||
				   int8send(12::bigint) || decode(repeat('bb',32),'hex')),
			1,12,'actor_skill_context_human'
		 )`,
		`UPDATE skill_manifests SET files=jsonb_build_array(jsonb_build_object(
			'path','SKILL.md','media_type','text/markdown','size_bytes',12,
			'sha256',repeat('bb',32),'object_key','object_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
		 )) WHERE manifest_id='manifest_explicit_query'`,
		`UPDATE skill_manifests SET package_state='sealed',sealed_at=clock_timestamp()
		 WHERE manifest_id='manifest_explicit_query'`,
		`INSERT INTO agent_skill_bindings(
			id,tenant_id,agent_actor_id,skill_id,manifest_version,enabled,config,
			binding_version,updated_by_actor_id
		 ) VALUES(
			'binding_explicit_query','tenant_skill_context','actor_skill_context_agent',
			'tenant_explicit_query','2.1.0',true,'{"mode":"query"}',1,
			'actor_skill_context_human'
		 )`,
		`INSERT INTO skills(
			skill_id,owner_kind,tenant_id,name,default_agent_types
		 ) VALUES(
			'tenant_foreign_query','tenant','tenant_skill_context_foreign',
			'foreign-query',ARRAY[]::text[]
		 )`,
		`INSERT INTO skill_manifests(
			manifest_id,skill_id,manifest_version,description,config_schema,
			content_hash,file_count,size_bytes
		 ) VALUES(
			'manifest_foreign_query','tenant_foreign_query','3.0.0',
			'Foreign query Skill.','{}',
			sha256(convert_to('teamhub.skill-package.v1','UTF8') || decode('00','hex') ||
				   int8send(8::bigint) || convert_to('SKILL.md','UTF8') ||
				   int8send(13::bigint) || decode(repeat('cc',32),'hex')),
			1,13
		 )`,
		`UPDATE skill_manifests SET files=jsonb_build_array(jsonb_build_object(
			'path','SKILL.md','media_type','text/markdown','size_bytes',13,
			'sha256',repeat('cc',32),'object_key','object_cccccccccccccccccccccccccccccccc'
		 )) WHERE manifest_id='manifest_foreign_query'`,
		`UPDATE skill_manifests SET package_state='sealed',sealed_at=clock_timestamp()
		 WHERE manifest_id='manifest_foreign_query'`,
	}
	for _, statement := range statements {
		if _, err := transaction.Exec(ctx, statement); err != nil {
			t.Fatalf("seed Skill context generation query: %v\n%s", err, statement)
		}
	}
	if err := transaction.Commit(ctx); err != nil {
		t.Fatalf("commit Skill context generation query fixture: %v", err)
	}
}
