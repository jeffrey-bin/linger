package integration_test

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"mime/multipart"
	"net/http"
	"testing"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentcredential"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

func TestUploadAgentSkillPackageCreatesUpgradesAndRejectsDefaults(t *testing.T) {
	allowParallelIntegrationTest(t)
	management := &recordingAgentManagement{}
	env, alice := newAgentRegistrationEnv(t, management)
	status, _, body := env.request(alice, http.MethodPost, "/v0/tenants/"+acmeTenant+"/agents", map[string]any{
		"name": "upload-agent", "instructions": "Use uploaded Skills.", "runtime": fixtureRuntime("gpt-5"),
	}, "create-upload-agent")
	if status != 201 {
		t.Fatalf("create: %d %s", status, body)
	}
	var agent httpapi.TenantAgent
	decode(t, body, &agent)
	path := "/v0/tenants/" + acmeTenant + "/agents/" + agent.Actor.Id + "/skill-packages"
	markdown := []byte("---\nname: sidebar-notes\ndescription: First sidebar Skill.\nversion: 1.0.0\n---\n\n# Notes\n")
	status, _, body = env.uploadAgentSkillPackage(alice, path, markdown, "skill.md", "upload-markdown")
	if status != 201 {
		t.Fatalf("markdown upload: %d %s", status, body)
	}
	var created httpapi.AgentSkillBinding
	decode(t, body, &created)
	if created.Skill.ManifestVersion != "1.0.0" || created.BindingVersion != 2 {
		t.Fatalf("new binding: %+v", created)
	}
	status, headers, replay := env.uploadAgentSkillPackage(alice, path, markdown, "skill.md", "upload-markdown")
	if status != 201 || headers.Get("Idempotent-Replay") != "true" || !bytes.Equal(replay, body) {
		t.Fatalf("lost-response retry: %d %s", status, replay)
	}
	defaultSkill := []byte("---\nname: teamhub-files\ndescription: Must not replace a managed default.\n---\n\n# Default\n")
	status, _, body = env.uploadAgentSkillPackage(alice, path, defaultSkill, "SKILL.md", "upload-default")
	if status != 409 || !bytes.Contains(body, []byte("SKILL_SET_CONFLICT")) {
		t.Fatalf("default name: %d %s", status, body)
	}
	upgraded := makeIntegrationSkillZIP(t, "sidebar-notes", "Updated sidebar Skill.", false, map[string]string{"references/extra.md": "# Extra\n"})
	status, _, body = env.uploadAgentSkillPackage(alice, path, upgraded, "skill.zip", "upload-upgrade")
	if status != 201 {
		t.Fatalf("zip upgrade: %d %s", status, body)
	}
	var next httpapi.AgentSkillBinding
	decode(t, body, &next)
	if next.Skill.SkillId != created.Skill.SkillId || next.Skill.ManifestVersion != "1.0.1" || next.BindingVersion != created.BindingVersion+1 {
		t.Fatalf("upgrade binding: %+v", next)
	}
	// Paths the stored file rows reject make an invalid package, not a failed insert.
	for key, files := range map[string]map[string]string{
		"upload-non-ascii-path": {"references/caf\u00e9.md": "# Cafe\n"},
		"upload-case-duplicate": {"references/Notes.md": "# One\n", "references/notes.md": "# Two\n"},
	} {
		invalid := makeIntegrationSkillZIP(t, "sidebar-notes", "Invalid sidebar Skill.", false, files)
		status, _, body = env.uploadAgentSkillPackage(alice, path, invalid, "skill.zip", key)
		if status != 400 || !bytes.Contains(body, []byte("INVALID_SKILL_PACKAGE")) {
			t.Fatalf("%s: %d %s", key, status, body)
		}
	}
	bindings := readEditorBindings(t, env, alice, agent.Actor.Id)
	if len(bindings.Items) != 1 || bindings.Items[0].Skill.ManifestVersion != "1.0.1" {
		t.Fatalf("listed bindings: %+v", bindings)
	}
}

func (e *testEnv) uploadAgentSkillPackage(client *http.Client, path string, archive []byte, filename, key string) (int, http.Header, []byte) {
	e.t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	part, err := writer.CreateFormFile("package", filename)
	if err != nil {
		e.t.Fatal(err)
	}
	if _, err = part.Write(archive); err != nil {
		e.t.Fatal(err)
	}
	if err = writer.Close(); err != nil {
		e.t.Fatal(err)
	}
	request, err := http.NewRequest(http.MethodPost, e.server.URL+path, &body)
	if err != nil {
		e.t.Fatal(err)
	}
	request.Header.Set("Content-Type", writer.FormDataContentType())
	request.Header.Set("Idempotency-Key", key)
	response, err := client.Do(request)
	if err != nil {
		e.t.Fatal(err)
	}
	defer response.Body.Close()
	content, err := io.ReadAll(response.Body)
	if err != nil {
		e.t.Fatal(err)
	}
	return response.StatusCode, response.Header, content
}

// A Runtime publish names the Agent by its management ID, the same handle the
// tree and file publications carry. TeamHub must resolve it to the actor the
// binding tables key on; before the fix the transaction keyed on the management
// ID directly and every publish failed with NOT_FOUND.
func TestUploadAgentSkillPackageResolvesRuntimeManagementID(t *testing.T) {
	allowParallelIntegrationTest(t)
	management := &recordingAgentManagement{}
	env, alice := newAgentRegistrationEnv(t, management)
	status, _, body := env.request(alice, http.MethodPost, "/v0/tenants/"+acmeTenant+"/agents", map[string]any{
		"name": "runtime-publisher", "instructions": "Publish Skills at Runtime.", "runtime": fixtureRuntime("gpt-5"),
	}, "create-runtime-publisher")
	if status != 201 {
		t.Fatalf("create: %d %s", status, body)
	}
	var agent httpapi.TenantAgent
	decode(t, body, &agent)

	var managementID string
	if err := env.pool.QueryRow(t.Context(), "select agent_management_id from agent_registrations where actor_id=$1", agent.Actor.Id).Scan(&managementID); err != nil {
		t.Fatalf("management id: %v", err)
	}
	if managementID == "" || managementID == agent.Actor.Id {
		t.Fatalf("management id %q must differ from actor %q", managementID, agent.Actor.Id)
	}

	credentialService := agentcredential.New(env.pool)
	issued, err := credentialService.IssueManaged(t.Context(), managementID, "standalone Skill publisher")
	if err != nil {
		t.Fatal(err)
	}

	archive := makeIntegrationSkillZIP(t, "runtime-notes", "Published by the Runtime itself.", false, nil)
	status, _, body = env.publishDirectSkillPackage(issued.AccessToken, archive, "runtime-publish")
	if status != 201 {
		t.Fatalf("runtime publish: %d %s", status, body)
	}
	// The Runtime endpoint returns the flat CLI result. Its name must carry the
	// published Skill name: an empty name fails the Runtime's own response
	// validation and reports a successful publish as a failure.
	var created struct {
		SkillID         string `json:"skill_id"`
		Name            string `json:"name"`
		ManifestVersion string `json:"manifest_version"`
		BindingVersion  int64  `json:"binding_version"`
		Replayed        bool   `json:"replayed"`
	}
	decode(t, body, &created)
	if created.Name != "runtime-notes" || created.ManifestVersion != "1.0.0" || created.BindingVersion < 2 || created.Replayed {
		t.Fatalf("runtime binding: %+v", created)
	}

	// The binding lands on the actor, so the Sponsor's editor lists it.
	bindings := readEditorBindings(t, env, alice, agent.Actor.Id)
	if len(bindings.Items) != 1 || bindings.Items[0].Skill.SkillId != created.SkillID {
		t.Fatalf("listed bindings: %+v", bindings)
	}

	// A lost-response retry replays rather than allocating a second version.
	rotated, err := credentialService.IssueManaged(t.Context(), managementID, "rotated publisher")
	if err != nil {
		t.Fatal(err)
	}
	status, _, replay := env.publishDirectSkillPackage(rotated.AccessToken, archive, "runtime-publish")
	if status != 201 {
		t.Fatalf("runtime replay: %d %s", status, replay)
	}
	var replayed struct {
		SkillID        string `json:"skill_id"`
		BindingVersion int64  `json:"binding_version"`
		Replayed       bool   `json:"replayed"`
	}
	decode(t, replay, &replayed)
	if !replayed.Replayed || replayed.SkillID != created.SkillID || replayed.BindingVersion != created.BindingVersion {
		t.Fatalf("runtime replay allocated a new version: %+v", replayed)
	}
	var lifecycleCount int
	if err := env.pool.QueryRow(t.Context(), `SELECT count(*) FROM agent_local_runs`).Scan(&lifecycleCount); err != nil || lifecycleCount != 0 {
		t.Fatalf("Skill publication created lifecycle state: count=%d err=%v", lifecycleCount, err)
	}
	if err := revokeAgentCredential(t.Context(), env.pool, rotated.CredentialID); err != nil {
		t.Fatal(err)
	}
	status, _, body = env.publishDirectSkillPackage(rotated.AccessToken, archive, "runtime-revoked")
	if status != http.StatusUnauthorized {
		t.Fatalf("revoked publication: %d %s", status, body)
	}
}

func (e *testEnv) publishDirectSkillPackage(token string, archive []byte, key string) (int, http.Header, []byte) {
	e.t.Helper()
	sum := sha256.Sum256(archive)
	request, err := http.NewRequest(http.MethodPost, e.server.URL+"/api/agent/v1/skills/packages", bytes.NewReader(archive))
	if err != nil {
		e.t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/zip")
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("X-Package-SHA256", hex.EncodeToString(sum[:]))
	request.Header.Set("X-TeamHub-Operation-Id", key)
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		e.t.Fatal(err)
	}
	defer response.Body.Close()
	content, err := io.ReadAll(response.Body)
	if err != nil {
		e.t.Fatal(err)
	}
	return response.StatusCode, response.Header, content
}
