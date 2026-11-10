package integration_test

import (
	"bytes"
	"encoding/hex"
	"io"
	"net/http"
	"testing"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentcredential"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/skill"
)

// agentSkillPackage downloads one Skill package the way the Agent's Computer
// does, with the Agent credential it holds.
func agentSkillPackage(t *testing.T, env *testEnv, token, manifestID string) (int, http.Header, []byte) {
	t.Helper()
	request, err := http.NewRequestWithContext(t.Context(), http.MethodGet, env.server.URL+"/api/agent/v1/skills/packages/"+manifestID, nil)
	if err != nil {
		t.Fatal(err)
	}
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	return response.StatusCode, response.Header, body
}

func TestAgentEffectiveResourcesReadAndExactPackageIsolation(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newAgentRegistrationEnv(t, &recordingAgentManagement{})
	resourcePath := "/v0/agents/" + acmeOfficialAgentManagementID + "/effective-resources"
	read := func(requestPath string, want int) []byte {
		t.Helper()
		httpStatus, _, body := agentWorkItemRequest(t, env, http.MethodGet, requestPath, teamHubInternalToken, "", nil)
		if httpStatus != want {
			t.Fatalf("GET %s: %d want %d %s", requestPath, httpStatus, want, body)
		}
		return body
	}
	if httpStatus, _, _ := agentWorkItemRequest(t, env, http.MethodGet, resourcePath, "", "", nil); httpStatus != 401 {
		t.Fatalf("unauthenticated resources: %d", httpStatus)
	}
	var before map[string]any
	decode(t, read(resourcePath, 200), &before)
	if _, ok := before["skills"].([]any); !ok {
		t.Fatalf("missing Skills: %v", before)
	}
	if _, exists := before["has_external_mcp_servers"]; exists {
		t.Fatalf("retired external MCP inventory is still returned: %v", before)
	}
	countResourceState := func() string {
		t.Helper()
		var result string
		if err := env.pool.QueryRow(t.Context(), `SELECT json_build_array((SELECT count(*) FROM agent_execution_contexts),(SELECT count(*) FROM agent_local_runs))::text`).Scan(&result); err != nil {
			t.Fatal(err)
		}
		return result
	}
	baseline := countResourceState()
	read(resourcePath, 200)
	if got := countResourceState(); got != baseline {
		t.Fatalf("read created Context resources: %s -> %s", baseline, got)
	}
	roomID := createPrivateRoom(t, env, alice, "Resource read active run", "resource-run-room")
	if httpStatus, body := putRoomMember(t, env, alice, roomID, "actor_acme_official", "member"); httpStatus != 200 {
		t.Fatalf("member: %d %s", httpStatus, body)
	}
	seedRunningLocalRun(t, env, acmeOfficialAgentManagementID, roomID, "resource-running")
	manifest := map[string]any{"skill_id": "skill_effective_read", "manifest_version": "1.0.0", "description": "Read effective config", "config_schema": map[string]any{"type": "object"}}
	content := makeIntegrationSkillZIP(t, "effective-read", "Read effective config", false, nil)
	env.seedSkillPackage(acmeTenant, "actor_acme_alice", manifest, content)
	listed, found := findListedSkillManifest(t, env, alice, acmeTenant, "skill_effective_read", "1.0.0")
	if !found {
		t.Fatal("missing published package")
	}
	var manifestID string
	if err := env.pool.QueryRow(t.Context(), `SELECT manifest_id FROM skill_manifests WHERE skill_id=$1 AND manifest_version='1.0.0'`, listed.SkillId).Scan(&manifestID); err != nil {
		t.Fatal(err)
	}
	bindingPath := "/v0/tenants/" + acmeTenant + "/agents/actor_acme_official/skill-bindings/" + listed.SkillId
	if httpStatus, _, body := env.request(alice, http.MethodPut, bindingPath, map[string]any{"expected_binding_version": 1, "manifest_version": "1.0.0", "enabled": true, "config": map[string]any{}}, "effective-bind"); httpStatus != 200 {
		t.Fatalf("bind: %d %s", httpStatus, body)
	}
	var after map[string]any
	decode(t, read(resourcePath, 200), &after)
	if before["effective_sha256"] == after["effective_sha256"] || !bytes.Contains(read(resourcePath, 200), []byte(manifestID)) {
		t.Fatalf("new binding missing: %v", after)
	}
	issued, err := agentcredential.New(env.pool).IssueManaged(t.Context(), acmeOfficialAgentManagementID, "Computer Skill fetch")
	if err != nil {
		t.Fatal(err)
	}
	readPackage := func(id string, want int) []byte {
		t.Helper()
		httpStatus, _, body := agentSkillPackage(t, env, issued.AccessToken, id)
		if httpStatus != want {
			t.Fatalf("GET package %s: %d want %d %s", id, httpStatus, want, body)
		}
		return body
	}
	zipBytes := readPackage(manifestID, 200)
	pkg, err := skill.ParsePackage(bytes.NewReader(zipBytes), int64(len(zipBytes)), skill.DefaultPackageLimits())
	if err != nil || hex.EncodeToString(pkg.SHA256[:]) != listed.PackageSha256 {
		t.Fatalf("package integrity: %v %+v", err, pkg)
	}
	if httpStatus, _, body := env.request(alice, http.MethodDelete, bindingPath+"?expected_binding_version=2", nil, "effective-unbind"); httpStatus != 200 && httpStatus != 204 {
		t.Fatalf("unbind: %d %s", httpStatus, body)
	}
	if !bytes.Equal(zipBytes, readPackage(manifestID, 200)) {
		t.Fatal("old exact package changed after unbinding")
	}
	// The Agent reads a private Skill of its Sponsor, the deployment's Human.
	env.seedSkillPackage(acmeTenant, "actor_acme_alice", map[string]any{
		"skill_id": "skill_own_private", "manifest_version": "1.0.0", "description": "Read effective config",
		"config_schema": map[string]any{"type": "object"}, "access_scope": "owner",
	}, content)
	var privateID string
	if err := env.pool.QueryRow(t.Context(), `SELECT manifest_id FROM skill_manifests WHERE skill_id='skill_own_private'`).Scan(&privateID); err != nil {
		t.Fatal(err)
	}
	readPackage(privateID, 200)

	// A disabled exact version stays readable for running and recovered
	// executions; a revoked one does not.
	for _, state := range []struct {
		value string
		want  int
	}{{"disabled", 200}, {"revoked", 403}} {
		if _, err := env.pool.Exec(t.Context(), `UPDATE skill_manifests SET state=$2 WHERE manifest_id=$1`, manifestID, state.value); err != nil {
			t.Fatal(err)
		}
		readPackage(manifestID, state.want)
	}
	if _, err := env.pool.Exec(t.Context(), `UPDATE agent_registrations SET status='revoked' WHERE agent_management_id=$1`, acmeOfficialAgentManagementID); err != nil {
		t.Fatal(err)
	}
	read(resourcePath, 404)
	if httpStatus, _, _ := agentSkillPackage(t, env, issued.AccessToken, manifestID); httpStatus == http.StatusOK {
		t.Fatal("a revoked Agent read a Skill package")
	}
}
