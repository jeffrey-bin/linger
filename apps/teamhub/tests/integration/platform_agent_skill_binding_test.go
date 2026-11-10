package integration_test

import (
	"bytes"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestPlatformExplicitSkillSupportsPublicAgentBindingsButDefaultOnlyDoesNot(t *testing.T) {
	allowParallelIntegrationTest(t)
	agentManagement := &recordingAgentManagement{}
	env, alice := newAgentRegistrationEnv(t, agentManagement)
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	skillID := "platform_explicit_" + suffix
	skillName := "platform-explicit-" + suffix
	seedPlatformExplicitSkill(t, env, skillID, skillName)
	status, _, body := env.request(alice, http.MethodPost, "/v0/tenants/"+acmeTenant+"/agents", map[string]any{
		"name":         "Invalid Readonly Skill Description " + suffix,
		"instructions": "The response-only description must not be accepted as input.",
		"runtime":      fixtureRuntime("gpt-5"),
		"skill_bindings": []map[string]any{{
			"name": skillName, "skill_id": skillID, "manifest_version": "1.0.0",
			"description": "caller-controlled",
		}},
	}, "platform-readonly-description-"+suffix)
	if status != http.StatusCreated || bytes.Contains(body, []byte("caller-controlled")) ||
		!bytes.Contains(body, []byte("Platform explicit binding fixture")) {
		t.Fatalf("response-only Skill description influenced by request status=%d body=%s", status, body)
	}

	status, _, body = env.request(alice, http.MethodPost, "/v0/tenants/"+acmeTenant+"/agents", map[string]any{
		"name":         "Platform Bound Agent " + suffix,
		"instructions": "Use the explicitly selected Platform Skill.",
		"runtime":      fixtureRuntime("gpt-5"),
		"skill_bindings": []map[string]any{{
			"name": skillName, "skill_id": skillID, "manifest_version": "1.0.0",
		}},
	}, "platform-explicit-create-"+suffix)
	if status != http.StatusCreated {
		t.Fatalf("create Agent with Platform explicit Skill status=%d body=%s", status, body)
	}
	var registered struct {
		Actor struct {
			ID string `json:"id"`
		} `json:"actor"`
		SkillBindings []agentSkillRegistrationResponse `json:"skill_bindings"`
	}
	decode(t, body, &registered)
	registeredSkills := agentSkillRegistrationsByID(registered.SkillBindings)
	if registered.Actor.ID == "" || len(registered.SkillBindings) != 13 || !hasOfficeDefaultSkillRegistrations(registeredSkills) || !lacksLev8SearchSkillRegistration(registeredSkills) || registeredSkills["simplexai_collaborate"].Name != "collaborate" || registeredSkills["simplexai_collaborate"].ManifestVersion != "1.0.0" || registeredSkills[skillID].Name != skillName || registeredSkills[skillID].ManifestVersion != "1.0.0" || registeredSkills[skillID].Description != "Platform explicit binding fixture" || registeredSkills["simplexai_teamhub_files"].Name != "teamhub-files" || registeredSkills["simplexai_teamhub_files"].ManifestVersion != "1.0.3" {
		t.Fatalf("unexpected Platform explicit registration: %+v", registered)
	}

	createdBindingPath := "/v0/tenants/" + acmeTenant + "/agents/" + registered.Actor.ID + "/skill-bindings/" + skillID
	status, _, body = env.request(alice, http.MethodGet, createdBindingPath, nil, "")
	if status != http.StatusOK || !bytes.Contains(body, []byte(skillID)) {
		t.Fatalf("get created Platform Skill binding status=%d body=%s", status, body)
	}
	status, _, body = env.request(alice, http.MethodGet,
		"/v0/tenants/"+acmeTenant+"/agents/"+registered.Actor.ID+"/skill-bindings", nil, "")
	if status != http.StatusOK || !bytes.Contains(body, []byte(skillID)) {
		t.Fatalf("list created Platform Skill bindings status=%d body=%s", status, body)
	}

	officialBindingPath := "/v0/tenants/" + acmeTenant + "/agents/actor_acme_official/skill-bindings/" + skillID
	status, _, body = env.request(alice, http.MethodPut, officialBindingPath, map[string]any{
		"expected_binding_version": 1, "manifest_version": "1.0.0",
		"enabled": true, "config": map[string]any{},
	}, "platform-explicit-put-"+suffix)
	if status != http.StatusOK {
		t.Fatalf("put Platform explicit Skill binding status=%d body=%s", status, body)
	}
	status, _, body = env.request(alice, http.MethodGet, officialBindingPath, nil, "")
	if status != http.StatusOK || !bytes.Contains(body, []byte(skillID)) {
		t.Fatalf("get Platform explicit Skill binding status=%d body=%s", status, body)
	}
	status, _, body = env.request(alice, http.MethodGet,
		"/v0/tenants/"+acmeTenant+"/agents/actor_acme_official/skill-bindings", nil, "")
	if status != http.StatusOK || !bytes.Contains(body, []byte(skillID)) {
		t.Fatalf("list Platform explicit Skill bindings status=%d body=%s", status, body)
	}
	status, _, body = env.request(alice, http.MethodPut, officialBindingPath, map[string]any{
		"expected_binding_version": 2, "manifest_version": "1.0.0",
		"enabled": true, "config": map[string]any{},
	}, "platform-explicit-noop-put-"+suffix)
	if status != http.StatusOK {
		t.Fatalf("repeat Platform explicit Skill binding status=%d body=%s", status, body)
	}
	var bindingVersion int64
	if err := env.pool.QueryRow(t.Context(), `
		SELECT binding_version FROM agent_skill_bindings
		WHERE agent_actor_id='actor_acme_official' AND skill_id=$1
	`, skillID).Scan(&bindingVersion); err != nil {
		t.Fatal(err)
	}
	if bindingVersion != 3 {
		t.Fatalf("repeat PUT binding version=%d, want 3", bindingVersion)
	}

	status, _, body = env.request(alice, http.MethodDelete, officialBindingPath+"?expected_binding_version=3", nil, "platform-explicit-delete-"+suffix)
	if status != http.StatusNoContent {
		t.Fatalf("delete Platform explicit Skill binding status=%d body=%s", status, body)
	}
	status, _, body = env.request(alice, http.MethodGet, officialBindingPath, nil, "")
	if status != http.StatusNotFound {
		t.Fatalf("get tombstoned Platform Skill binding status=%d body=%s", status, body)
	}
	var enabled, hasDeletedAt bool
	var changedBy string
	if err := env.pool.QueryRow(t.Context(), `
		SELECT enabled,deleted_at IS NOT NULL,updated_by_actor_id
		FROM agent_skill_bindings
		WHERE agent_actor_id='actor_acme_official' AND skill_id=$1
	`, skillID).Scan(&enabled, &hasDeletedAt, &changedBy); err != nil {
		t.Fatal(err)
	}
	if enabled || !hasDeletedAt || changedBy != "actor_acme_alice" {
		t.Fatalf("removed binding enabled=%t deleted_at=%t actor=%q", enabled, hasDeletedAt, changedBy)
	}

	status, _, body = env.request(alice, http.MethodPut, officialBindingPath, map[string]any{
		"expected_binding_version": 4, "manifest_version": "1.0.0",
		"enabled": true, "config": map[string]any{},
	}, "platform-explicit-revive-"+suffix)
	if status != http.StatusOK {
		t.Fatalf("revive Platform explicit Skill binding status=%d body=%s", status, body)
	}
	status, _, body = env.request(alice, http.MethodGet, officialBindingPath, nil, "")
	if status != http.StatusOK || !bytes.Contains(body, []byte(skillID)) {
		t.Fatalf("get revived Platform Skill binding status=%d body=%s", status, body)
	}

	defaultOnly := map[string]any{
		"name": "docx", "skill_id": "simplexai_builtin_docx", "manifest_version": "1.0.0",
	}
	status, _, body = env.request(alice, http.MethodPost, "/v0/tenants/"+acmeTenant+"/agents", map[string]any{
		"name":         "Default Only Reject " + suffix,
		"instructions": "A default-only Platform Skill cannot be selected explicitly.",
		"runtime":      fixtureRuntime("gpt-5"),
		"skill_bindings": []map[string]any{
			defaultOnly,
		},
	}, "platform-default-only-create-"+suffix)
	if status != http.StatusNotFound || !bytes.Contains(body, []byte("REGISTRATION_MANIFEST_NOT_FOUND")) {
		t.Fatalf("create Agent with default-only Skill status=%d body=%s", status, body)
	}
	defaultOnlyPath := "/v0/tenants/" + acmeTenant + "/agents/actor_acme_official/skill-bindings/simplexai_builtin_docx"
	status, _, body = env.request(alice, http.MethodPut, defaultOnlyPath, map[string]any{
		"expected_binding_version": 5, "manifest_version": "1.0.0",
		"enabled": true, "config": map[string]any{},
	}, "platform-default-only-put-"+suffix)
	if status != http.StatusNotFound || !bytes.Contains(body, []byte("NOT_FOUND")) {
		t.Fatalf("put default-only Platform Skill status=%d body=%s", status, body)
	}
	if got := countRows(t, env, `
		SELECT count(*) FROM agent_skill_bindings
		WHERE skill_id='simplexai_builtin_docx'
	`); got != 0 {
		t.Fatalf("default-only Platform Skill explicit binding rows=%d want=0", got)
	}
}

func TestDisabledSkillBindingHistoryDoesNotConsumeEffectiveSetCapacity(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newAgentRegistrationEnv(t, &recordingAgentManagement{})
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	idPrefix := "capacity_" + suffix
	namePrefix := "capacity-" + suffix
	seedPlatformSkillCapacityFixtures(t, env, idPrefix, namePrefix)

	candidateSkillID := fmt.Sprintf("%s_%03d", idPrefix, 101)
	bindingPath := "/v0/tenants/" + acmeTenant + "/agents/actor_acme_official/skill-bindings/" + candidateSkillID
	request := map[string]any{"expected_binding_version": 1, "manifest_version": "1.0.0", "enabled": true, "config": map[string]any{}}
	status, _, body := env.request(alice, http.MethodPut, bindingPath, request, "capacity-after-disabled-"+suffix)
	if status != http.StatusOK {
		t.Fatalf("bind after 100 disabled histories status=%d body=%s", status, body)
	}
	status, _, body = env.request(alice, http.MethodPut, bindingPath, map[string]any{
		"expected_binding_version": 2, "manifest_version": "1.0.0", "enabled": false, "config": map[string]any{},
	}, "capacity-disable-candidate-"+suffix)
	if status != http.StatusOK {
		t.Fatalf("disable capacity candidate status=%d body=%s", status, body)
	}
	bindingTransaction, err := env.pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer bindingTransaction.Rollback(t.Context())
	if _, err := bindingTransaction.Exec(t.Context(), `
		UPDATE agent_skill_bindings
		SET enabled=true,config='{}',binding_version=4,
		    updated_by_actor_id='actor_acme_alice',updated_at=now()
		WHERE agent_actor_id='actor_acme_official'
		  AND skill_id LIKE $1
		  AND skill_id<>$2
	`, idPrefix+"_%", candidateSkillID); err != nil {
		t.Fatal(err)
	}
	if err := bindingTransaction.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}

	request["expected_binding_version"] = 4
	status, _, body = env.request(alice, http.MethodPut, bindingPath, request, "capacity-overflow-"+suffix)
	if status != http.StatusConflict || !bytes.Contains(body, []byte("SKILL_SET_CONFLICT")) {
		t.Fatalf("bind 101st enabled Skill status=%d body=%s", status, body)
	}
	var enabled bool
	if err := env.pool.QueryRow(t.Context(), `
		SELECT enabled FROM agent_skill_bindings
		WHERE agent_actor_id='actor_acme_official' AND skill_id=$1
	`, candidateSkillID).Scan(&enabled); err != nil {
		t.Fatal(err)
	}
	if enabled {
		t.Fatal("failed 101st enabled Skill write was not rolled back")
	}
}

func seedPlatformExplicitSkill(t *testing.T, env *testEnv, skillID, skillName string) {
	t.Helper()
	tx, err := env.pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(t.Context())
	manifestID := "skill_manifest_" + skillID + "_1_0_0"
	if _, err = tx.Exec(t.Context(), `
		INSERT INTO skills(
			skill_id,owner_kind,name,default_agent_types,created_by_actor_id
		) VALUES($1,'platform',$2,ARRAY[]::text[],'actor_acme_alice')
	`, skillID, skillName); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(t.Context(), `
		INSERT INTO skill_manifests(
			manifest_id,skill_id,manifest_version,description,config_schema,
			content_hash,file_count,size_bytes,created_by_actor_id
		) VALUES(
			$1,$2,'1.0.0','Platform explicit binding fixture','{}',
			sha256(convert_to('teamhub.skill-package.v1','UTF8') || decode('00','hex') ||
			       int8send(8::bigint) || convert_to('SKILL.md','UTF8') ||
			       int8send(1::bigint) || decode(repeat('31',32),'hex')),
			1,1,'actor_acme_alice'
		)
	`, manifestID, skillID); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(t.Context(), `
		UPDATE skill_manifests SET files=jsonb_build_array(jsonb_build_object(
			'path','SKILL.md','media_type','text/markdown','size_bytes',1,
			'sha256',repeat('31',32),'object_key',$2::text
		)) WHERE manifest_id=$1
	`, manifestID, "platform-explicit-fixture/"+skillID+"/SKILL.md"); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(t.Context(), `
		UPDATE skill_manifests SET package_state='sealed',sealed_at=now()
		WHERE manifest_id=$1
	`, manifestID); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(t.Context(), `
		UPDATE skills SET latest_manifest_id=$2 WHERE skill_id=$1
	`, skillID, manifestID); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
}

func seedPlatformSkillCapacityFixtures(t *testing.T, env *testEnv, idPrefix, namePrefix string) {
	t.Helper()
	tx, err := env.pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(t.Context())
	if _, err = tx.Exec(t.Context(), `
		INSERT INTO skills(
			skill_id,owner_kind,name,default_agent_types,created_by_actor_id
		)
		SELECT $1 || '_' || lpad(item::text,3,'0'),'platform',
		       $2 || '-' || lpad(item::text,3,'0'),ARRAY[]::text[],'actor_acme_alice'
		FROM generate_series(1,101) item
	`, idPrefix, namePrefix); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(t.Context(), `
		INSERT INTO skill_manifests(
			manifest_id,skill_id,manifest_version,description,config_schema,
			content_hash,file_count,size_bytes,created_by_actor_id
		)
		SELECT 'skill_manifest_' || $1 || '_' || lpad(item::text,3,'0'),
		       $1 || '_' || lpad(item::text,3,'0'),'1.0.0','capacity fixture','{}',
		       sha256(convert_to('teamhub.skill-package.v1','UTF8') || decode('00','hex') ||
		              int8send(8::bigint) || convert_to('SKILL.md','UTF8') ||
		              int8send(1::bigint) || decode(repeat('32',32),'hex')),
		       1,1,'actor_acme_alice'
		FROM generate_series(1,101) item
	`, idPrefix); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(t.Context(), `
		UPDATE skill_manifests SET files=jsonb_build_array(jsonb_build_object(
			'path','SKILL.md','media_type','text/markdown','size_bytes',1,
			'sha256',repeat('32',32),'object_key','capacity-fixture/' || skill_id || '/SKILL.md'
		))
		WHERE skill_id LIKE $1
	`, idPrefix+"_%"); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(t.Context(), `
		UPDATE skill_manifests
		SET package_state='sealed',sealed_at=now()
		WHERE skill_id LIKE $1
	`, idPrefix+"_%"); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(t.Context(), `
		UPDATE skills SET latest_manifest_id='skill_manifest_' || skill_id
		WHERE skill_id LIKE $1
	`, idPrefix+"_%"); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(t.Context(), `
		INSERT INTO agent_skill_bindings(
			id,tenant_id,agent_actor_id,skill_id,manifest_version,enabled,config,
			binding_version,updated_by_actor_id
		)
		SELECT 'agent_skill_binding_' || $1 || '_' || lpad(item::text,3,'0'),
		       $2,'actor_acme_official',$1 || '_' || lpad(item::text,3,'0'),
		       '1.0.0',false,'{}',1,'actor_acme_alice'
		FROM generate_series(1,100) item
	`, idPrefix, acmeTenant); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
}

func TestPlatformExplicitSkillBindingAcceptsOnlyCurrentLatestVersion(t *testing.T) {
	allowParallelIntegrationTest(t)
	agentManagement := &recordingAgentManagement{}
	env, alice := newAgentRegistrationEnv(t, agentManagement)
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	skillID := "platform_latest_" + suffix
	seedPlatformExplicitSkill(t, env, skillID, "platform-latest-"+suffix)
	seedPlatformNonLatestManifest(t, env, skillID, "1.0.1")
	bindingPath := "/v0/tenants/" + acmeTenant + "/agents/actor_acme_official/skill-bindings/" + skillID
	status, _, body := env.request(alice, http.MethodPut, bindingPath, map[string]any{
		"expected_binding_version": 1, "manifest_version": "1.0.1",
		"enabled": true, "config": map[string]any{},
	}, "platform-latest-reject-"+suffix)
	if status != http.StatusBadRequest || !bytes.Contains(body, []byte("SKILL_MANIFEST_NOT_CURRENT")) {
		t.Fatalf("non-latest Platform Skill version status=%d body=%s", status, body)
	}
	status, _, body = env.request(alice, http.MethodPut, bindingPath, map[string]any{
		"expected_binding_version": 1, "manifest_version": "1.0.0",
		"enabled": true, "config": map[string]any{},
	}, "platform-latest-accept-"+suffix)
	if status != http.StatusOK {
		t.Fatalf("latest Platform Skill version status=%d body=%s", status, body)
	}
}

// seedPlatformNonLatestManifest adds a sealed, active Platform Manifest that is
// not the skill's latest Manifest.
func seedPlatformNonLatestManifest(t *testing.T, env *testEnv, skillID, version string) {
	t.Helper()
	ctx := t.Context()
	manifestID := "skill_manifest_" + skillID + "_" + strings.ReplaceAll(version, ".", "_")
	statements := []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO skill_manifests(
			manifest_id,skill_id,manifest_version,description,config_schema,
			content_hash,file_count,size_bytes,created_by_actor_id
		) VALUES(
			$1,$2,$3,'Platform explicit binding fixture','{}',
			sha256(convert_to('teamhub.skill-package.v1','UTF8') || decode('00','hex') ||
			       int8send(8::bigint) || convert_to('SKILL.md','UTF8') ||
			       int8send(1::bigint) || decode(repeat('32',32),'hex')),
			1,1,'actor_acme_alice'
		)`, []any{manifestID, skillID, version}},
		{`UPDATE skill_manifests SET files=jsonb_build_array(jsonb_build_object(
			'path','SKILL.md','media_type','text/markdown','size_bytes',1,
			'sha256',repeat('32',32),'object_key',$2::text
		)) WHERE manifest_id=$1`,
			[]any{manifestID, "platform-explicit-fixture/" + skillID + "/" + version + "/SKILL.md"}},
		{`UPDATE skill_manifests SET package_state='sealed',sealed_at=now() WHERE manifest_id=$1`, []any{manifestID}},
	}
	for _, statement := range statements {
		if _, err := env.pool.Exec(ctx, statement.sql, statement.args...); err != nil {
			t.Fatal(err)
		}
	}
}
