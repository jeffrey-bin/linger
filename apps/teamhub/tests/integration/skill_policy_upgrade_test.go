package integration_test

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/jackc/pgx/v5/pgxpool"
	artifactstore "github.com/simplexai-labs/linger/apps/teamhub/internal/artifact"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/skill"
)

func TestSkillCatalogAdvanceKeepsAgentEffectiveAndMovesLatest(t *testing.T) {
	allowParallelIntegrationTest(t)
	ctx := t.Context()
	pool, err := pgxpool.New(ctx, newIntegrationDatabase(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	objects, err := artifactstore.NewLocalStore(t.TempDir(), 32<<20)
	if err != nil {
		t.Fatal(err)
	}
	if err := skill.EnsureFromFSForTest(ctx, pool, objects, skillPolicyCatalog("1.0.0", "[]")); err != nil {
		t.Fatal(err)
	}
	seedSkillPolicyAgent(t, ctx, pool, "{}")
	if err := skill.EnsureFromFSForTest(ctx, pool, objects, skillPolicyCatalog("1.0.1", "[general]")); err != nil {
		t.Fatal(err)
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := skill.ValidateEffectiveInTx(ctx, tx, skillPolicyIdentity()); err != nil {
		t.Fatalf("catalog advance broke existing Agent: %v", err)
	}
	var latest string
	if err := tx.QueryRow(ctx, `SELECT latest_manifest_id FROM skills WHERE skill_id='fixture_policy'`).Scan(&latest); err != nil {
		t.Fatal(err)
	}
	if latest != "fixture_policy_1_0_1" {
		t.Fatalf("catalog advance did not move latest: %s", latest)
	}
}

func skillPolicyIdentity() skill.Identity {
	return skill.Identity{AgentID: "agent_policy", AgentActorID: "actor_policy_agent", TenantID: "tenant_policy", AgentType: "general"}
}

func seedSkillPolicyAgent(t *testing.T, ctx context.Context, pool *pgxpool.Pool, config string) {
	t.Helper()
	_, err := pool.Exec(ctx, `
 INSERT INTO actors(id,tenant_id,kind,display_name,handle) VALUES
 ('actor_policy_human','tenant_policy','human','Sponsor',NULL),
 ('actor_policy_agent','tenant_policy','agent','Agent','policy-agent');
 INSERT INTO agent_registrations(actor_id,tenant_id,agent_management_id,status,instructions,runtime_model,created_by_actor_id,agent_type,computer_id,local_runtime_type,workspace_grant_id)
 VALUES('actor_policy_agent','tenant_policy','agent_policy','active','Test','test-model','actor_policy_human','general','computer_fixture','codex','grant_files');`)
	if err != nil {
		t.Fatal(err)
	}
	_, err = pool.Exec(ctx, `INSERT INTO agent_skill_bindings(id,tenant_id,agent_actor_id,skill_id,manifest_version,enabled,config,binding_version,updated_by_actor_id)
 VALUES('binding_policy','tenant_policy','actor_policy_agent','fixture_policy','1.0.0',true,$1::jsonb,1,'actor_policy_human')`, config)
	if err != nil {
		t.Fatal(err)
	}
}

func skillPolicyCatalog(version, defaults string) fstest.MapFS {
	files := fstest.MapFS{}
	catalog := fmt.Sprintf("schema_version: 1\nskills:\n  - skill_id: fixture_policy\n    bootstrap_manifest_id: fixture_policy_%s\n    default_agent_types: %s\n    manifests:\n", strings.ReplaceAll(version, ".", "_"), defaults)
	for _, v := range []string{"1.0.0", "1.0.1"} {
		catalog += fmt.Sprintf("      - manifest_id: fixture_policy_%s\n        version: %s\n        package_path: builtin/fixture-policy/%s\n", strings.ReplaceAll(v, ".", "_"), v, v)
		files["builtin/fixture-policy/"+v+"/SKILL.md"] = &fstest.MapFile{Data: []byte("---\nname: fixture-policy\ndescription: Skill policy fixture " + v + "\n---\nInstructions.\n")}
	}
	files["builtin/catalog.yaml"] = &fstest.MapFile{Data: []byte(catalog)}
	return files
}

func newSkillPolicyFixture(t *testing.T, config string) (context.Context, *pgxpool.Pool, artifactstore.ObjectStore) {
	t.Helper()
	ctx := t.Context()
	pool, err := pgxpool.New(ctx, newIntegrationDatabase(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	objects, err := artifactstore.NewLocalStore(t.TempDir(), 32<<20)
	if err != nil {
		t.Fatal(err)
	}
	if err := skill.EnsureFromFSForTest(ctx, pool, objects, skillPolicyCatalog("1.0.0", "[]")); err != nil {
		t.Fatal(err)
	}
	seedSkillPolicyAgent(t, ctx, pool, config)
	return ctx, pool, objects
}

// assertPolicyBinding checks whether startup removed the seeded binding and
// which Agent binding version it carries.
func assertPolicyBinding(t *testing.T, ctx context.Context, pool *pgxpool.Pool, deleted bool, version int64) {
	t.Helper()
	var gotDeleted, system bool
	var gotVersion int64
	err := pool.QueryRow(ctx, `SELECT deleted_at IS NOT NULL AND NOT enabled,binding_version,updated_by_actor_id IS NULL
 FROM agent_skill_bindings WHERE id='binding_policy'`).Scan(&gotDeleted, &gotVersion, &system)
	if err != nil {
		t.Fatal(err)
	}
	if gotDeleted != deleted || gotVersion != version || system != deleted {
		t.Fatalf("binding deleted=%v version=%d startup-written=%v", gotDeleted, gotVersion, system)
	}
}

func TestEnsureRetiresRevokedExplicitDefaultSkillBinding(t *testing.T) {
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
	catalog := skillPolicyCatalog("1.0.1", "[general]")
	addStartupSkill(catalog, "fixture_optional", "[]")
	if err := skill.EnsureFromFSForTest(ctx, pool, objects, catalog); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
 INSERT INTO actors(id,tenant_id,kind,display_name,handle) VALUES
 ('actor_retire_human','tenant_retire','human','Sponsor',NULL),
 ('actor_retire_revoked','tenant_retire','agent','PPT','retire-revoked'),
 ('actor_retire_anotherme','tenant_retire','agent','AnotherMe','retire-anotherme');
 INSERT INTO agent_registrations(actor_id,tenant_id,agent_management_id,status,instructions,runtime_model,created_by_actor_id,agent_type,represented_human_actor_id,computer_id,local_runtime_type,workspace_grant_id)
 VALUES
 ('actor_retire_revoked','tenant_retire','agent_retire_revoked','revoked','Test','test-model','actor_retire_human','general',NULL,'computer_fixture','codex','grant_files'),
 ('actor_retire_anotherme','tenant_retire','agent_retire_anotherme','active','Test','test-model','actor_retire_human','anotherme','actor_retire_human','computer_fixture','codex','grant_files');
 INSERT INTO agent_skill_bindings(id,tenant_id,agent_actor_id,skill_id,manifest_version,enabled,config,binding_version,updated_by_actor_id)
 VALUES
 ('binding_retire_default','tenant_retire','actor_retire_revoked','fixture_policy','1.0.0',true,'{"mode":"custom"}',1,'actor_retire_human'),
 ('binding_retire_optional','tenant_retire','actor_retire_revoked','fixture_optional','1.0.0',true,'{}',1,'actor_retire_human'),
 ('binding_retire_anotherme','tenant_retire','actor_retire_anotherme','fixture_policy','1.0.0',true,'{}',1,'actor_retire_human')`); err != nil {
		t.Fatal(err)
	}
	// A revoked Agent may keep a binding to a since-disabled Manifest; it must not block startup.
	if _, err := pool.Exec(ctx, `UPDATE skill_manifests SET state='disabled' WHERE manifest_id='fixture_optional_1_0_0'`); err != nil {
		t.Fatal(err)
	}
	addStartupSkill(catalog, "fixture_trigger", "[general]")
	if err := skill.EnsureFromFSForTest(ctx, pool, objects, catalog); err != nil {
		t.Fatalf("Ensure: %v", err)
	}
	assertStartupRetirement(t, ctx, pool)
	if err := skill.EnsureFromFSForTest(ctx, pool, objects, catalog); err != nil {
		t.Fatalf("replay Ensure: %v", err)
	}
	assertStartupRetirement(t, ctx, pool)
}

func addStartupSkill(files fstest.MapFS, skillID, defaults string) {
	name := strings.ReplaceAll(skillID, "_", "-")
	manifestID := skillID + "_1_0_0"
	files["builtin/catalog.yaml"].Data = append(files["builtin/catalog.yaml"].Data, []byte(fmt.Sprintf(
		"  - skill_id: %s\n    bootstrap_manifest_id: %s\n    default_agent_types: %s\n    manifests:\n      - manifest_id: %s\n        version: 1.0.0\n        package_path: builtin/%s/1.0.0\n",
		skillID, manifestID, defaults, manifestID, name,
	))...)
	files["builtin/"+name+"/1.0.0/SKILL.md"] = &fstest.MapFile{Data: []byte("---\nname: " + name + "\ndescription: Startup retirement fixture.\n---\nInstructions.\n")}
}

func assertStartupRetirement(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	t.Helper()
	var enabled, deleted, configKept, system bool
	var manifestVersion string
	var version int64
	err := pool.QueryRow(ctx, `SELECT enabled,deleted_at IS NOT NULL,binding_version,manifest_version,
 config='{"mode":"custom"}'::jsonb,updated_by_actor_id IS NULL
 FROM agent_skill_bindings WHERE id='binding_retire_default'`).Scan(
		&enabled, &deleted, &version, &manifestVersion, &configKept, &system)
	if err != nil {
		t.Fatal(err)
	}
	if enabled || !deleted || version != 2 || manifestVersion != "1.0.0" || !configKept || !system {
		t.Fatalf("retired binding enabled=%v deleted=%v version=%d manifest=%s configKept=%v system=%v", enabled, deleted, version, manifestVersion, configKept, system)
	}
	for _, bindingID := range []string{"binding_retire_optional", "binding_retire_anotherme"} {
		var stillEnabled bool
		var stillVersion int64
		if err := pool.QueryRow(ctx, `SELECT enabled AND deleted_at IS NULL,binding_version FROM agent_skill_bindings WHERE id=$1`, bindingID).Scan(&stillEnabled, &stillVersion); err != nil {
			t.Fatal(err)
		}
		if !stillEnabled || stillVersion != 1 {
			t.Fatalf("%s enabled=%v version=%d", bindingID, stillEnabled, stillVersion)
		}
	}
}

func TestSkillCatalogAdvanceRepointsExplicitBindingWithoutChangingConfig(t *testing.T) {
	allowParallelIntegrationTest(t)
	ctx, pool, objects := newSkillPolicyFixture(t, `{"mode":"custom"}`)
	if err := skill.EnsureFromFSForTest(ctx, pool, objects, skillPolicyCatalog("1.0.1", "[]")); err != nil {
		t.Fatal(err)
	}
	assertSkillPolicy(t, ctx, pool, "fixture_policy_1_0_1", "{}")
	assertRepointedBinding(t, ctx, pool, "1.0.1", 2)
	assertBindingConfig(t, ctx, pool, `{"mode":"custom"}`)
	if err := skill.EnsureFromFSForTest(ctx, pool, objects, skillPolicyCatalog("1.0.1", "[]")); err != nil {
		t.Fatalf("replay Ensure: %v", err)
	}
	assertSkillPolicy(t, ctx, pool, "fixture_policy_1_0_1", "{}")
	assertRepointedBinding(t, ctx, pool, "1.0.1", 2)
	// An older catalog image during a rolling deploy must not move latest back.
	if err := skill.EnsureFromFSForTest(ctx, pool, objects, skillPolicyCatalog("1.0.0", "[general]")); err != nil {
		t.Fatalf("older catalog Ensure: %v", err)
	}
	assertSkillPolicy(t, ctx, pool, "fixture_policy_1_0_1", "{}")
	assertRepointedBinding(t, ctx, pool, "1.0.1", 2)
}

func TestSkillCatalogAdvanceMovesDefaultsAndRetiresCoveredBinding(t *testing.T) {
	allowParallelIntegrationTest(t)
	ctx, pool, objects := newSkillPolicyFixture(t, "{}")
	if err := skill.EnsureFromFSForTest(ctx, pool, objects, skillPolicyCatalog("1.0.1", "[general]")); err != nil {
		t.Fatal(err)
	}
	assertSkillPolicy(t, ctx, pool, "fixture_policy_1_0_1", "{general}")
	// The binding is re-pointed to the new latest, then retired because the Agent Type is now a default.
	assertPolicyBinding(t, ctx, pool, true, 3)
	assertBindingManifestVersion(t, ctx, pool, "1.0.1")
}

func TestSkillCatalogEqualVersionUpdatesChangedDefaultsOnly(t *testing.T) {
	allowParallelIntegrationTest(t)
	ctx, pool, objects := newSkillPolicyFixture(t, "{}")
	if err := skill.EnsureFromFSForTest(ctx, pool, objects, skillPolicyCatalog("1.0.0", "[general]")); err != nil {
		t.Fatal(err)
	}
	assertSkillPolicy(t, ctx, pool, "fixture_policy_1_0_0", "{general}")
	assertPolicyBinding(t, ctx, pool, true, 2)
	if err := skill.EnsureFromFSForTest(ctx, pool, objects, skillPolicyCatalog("1.0.0", "[general]")); err != nil {
		t.Fatalf("replay Ensure: %v", err)
	}
	assertSkillPolicy(t, ctx, pool, "fixture_policy_1_0_0", "{general}")
	assertPolicyBinding(t, ctx, pool, true, 2)
}

func assertSkillPolicy(t *testing.T, ctx context.Context, pool *pgxpool.Pool, latestManifestID, defaults string) {
	t.Helper()
	var gotLatest, gotDefaults string
	if err := pool.QueryRow(ctx, `SELECT latest_manifest_id,default_agent_types::text FROM skills WHERE skill_id='fixture_policy'`).Scan(&gotLatest, &gotDefaults); err != nil {
		t.Fatal(err)
	}
	if gotLatest != latestManifestID || gotDefaults != defaults {
		t.Fatalf("latest=%s defaults=%s, want latest=%s defaults=%s", gotLatest, gotDefaults, latestManifestID, defaults)
	}
}

func assertRepointedBinding(t *testing.T, ctx context.Context, pool *pgxpool.Pool, manifestVersion string, version int64) {
	t.Helper()
	assertBindingManifestVersion(t, ctx, pool, manifestVersion)
	var enabled, system bool
	var gotVersion int64
	if err := pool.QueryRow(ctx, `SELECT enabled AND deleted_at IS NULL,binding_version,updated_by_actor_id IS NULL
 FROM agent_skill_bindings WHERE id='binding_policy'`).Scan(&enabled, &gotVersion, &system); err != nil {
		t.Fatal(err)
	}
	if !enabled || gotVersion != version || !system {
		t.Fatalf("re-pointed binding enabled=%v version=%d startup-written=%v", enabled, gotVersion, system)
	}
}

func assertBindingManifestVersion(t *testing.T, ctx context.Context, pool *pgxpool.Pool, manifestVersion string) {
	t.Helper()
	var got string
	if err := pool.QueryRow(ctx, `SELECT manifest_version FROM agent_skill_bindings WHERE id='binding_policy'`).Scan(&got); err != nil {
		t.Fatal(err)
	}
	if got != manifestVersion {
		t.Fatalf("binding manifest version=%s want %s", got, manifestVersion)
	}
}

func assertBindingConfig(t *testing.T, ctx context.Context, pool *pgxpool.Pool, config string) {
	t.Helper()
	var matches bool
	if err := pool.QueryRow(ctx, `SELECT config=$1::jsonb FROM agent_skill_bindings WHERE id='binding_policy'`, config).Scan(&matches); err != nil {
		t.Fatal(err)
	}
	if !matches {
		t.Fatalf("binding config changed; want %s", config)
	}
}
