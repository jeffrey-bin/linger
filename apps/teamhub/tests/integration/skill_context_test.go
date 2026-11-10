package integration_test

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sort"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentcredential"
	artifactstore "github.com/simplexai-labs/linger/apps/teamhub/internal/artifact"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/config"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/ids"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/skill"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

func TestTenantSkillAgentBindingLifecycle(t *testing.T) {
	allowParallelIntegrationTest(t)
	databaseURL := newIntegrationDatabase(t)
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	artifactRoot := t.TempDir()
	application, err := newIntegrationApp(ctx, config.ForTest(func(c *config.Config) {
		c.DatabaseURL = databaseURL
		c.SessionTTL = time.Hour
		c.CookieName = "teamhub_session"
		c.TeamHubInternalToken = teamHubInternalToken
		c.NodeServicesInternalToken = nodeServicesInternalToken
		c.AgentRunTokenSecret = agentRunTokenSecret
		c.ArtifactStorageRoot = artifactRoot
	}))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(application.Close)
	server := httptest.NewServer(application.Handler())
	registerIntegrationServerCleanup(t, server)
	env := &testEnv{t: t, databaseURL: databaseURL, pool: pool, server: server, artifactRoot: artifactRoot}
	alice := env.login("alice", alicePassword)
	suffix := fmt.Sprintf("%d", time.Now().UnixNano())
	skillID := "skill_test_" + suffix
	manifest := map[string]any{
		"skill_id": skillID, "manifest_version": "1.0.0",
		"description": "Describes a configured capability",
		"config_schema": map[string]any{
			"type": "object", "additionalProperties": false,
			"properties": map[string]any{"prefix": map[string]any{"type": "string"}},
		},
	}
	skillPackage := makeIntegrationSkillZIP(t, "test-skill", manifest["description"].(string), true, map[string]string{"references/examples.md": "# Example\n"})
	env.seedSkillPackage(acmeTenant, "actor_acme_alice", manifest, skillPackage)

	listedManifest, found := findListedSkillManifest(t, env, alice, acmeTenant, skillID, "1.0.0")
	if !found || listedManifest.PackageName != "test-skill" || listedManifest.AccessScope != httpapi.SkillManifestAccessScopeTenant ||
		listedManifest.CreatedByActorId != "actor_acme_alice" {
		t.Fatalf("listed manifest: %+v", listedManifest)
	}
	unauthenticated := newClient(t)
	status, _, _ := env.request(unauthenticated, http.MethodGet, "/v0/tenants/"+acmeTenant+"/skill-manifests", nil, "")
	if status != http.StatusUnauthorized {
		t.Fatalf("unauthenticated manifest market status=%d want=401", status)
	}

	if _, err := pool.Exec(ctx, "update skill_manifests set description='mutated' where skill_id=$1 and manifest_version='1.0.0'", skillID); err == nil {
		t.Fatal("immutable package metadata accepted an update")
	}
	if _, err := pool.Exec(ctx, "update skill_manifests set files=jsonb_set(files,'{0,media_type}','\"text/plain\"') where skill_id=$1 and manifest_version='1.0.0'", skillID); err == nil {
		t.Fatal("immutable package file accepted an update")
	}

	bindingPath := "/v0/tenants/" + acmeTenant + "/agents/actor_acme_official/skill-bindings/" + skillID
	binding := map[string]any{"expected_binding_version": 1, "manifest_version": "1.0.0", "enabled": true, "config": map[string]any{"prefix": "agent"}}
	status, _, bindingBody := env.request(alice, http.MethodPut, bindingPath, binding, "bind-skill-"+suffix)
	if status != http.StatusOK || !bytes.Contains(bindingBody, []byte(`"binding_version":2`)) || !bytes.Contains(bindingBody, []byte(`"updated_by_actor_id":"actor_acme_alice"`)) {
		t.Fatalf("put Agent Skill binding status=%d body=%s", status, bindingBody)
	}
	status, _, bindingBody = env.request(alice, http.MethodGet, bindingPath, nil, "")
	if status != http.StatusOK || !bytes.Contains(bindingBody, []byte(skillID)) {
		t.Fatalf("get Agent Skill binding status=%d body=%s", status, bindingBody)
	}
	status, _, listBody := env.request(alice, http.MethodGet, "/v0/tenants/"+acmeTenant+"/agents/actor_acme_official/skill-bindings", nil, "")
	if status != http.StatusOK || !bytes.Contains(listBody, []byte(skillID)) {
		t.Fatalf("list Agent Skill bindings status=%d body=%s", status, listBody)
	}
	pkg := readRuntimeSkillPackage(t, env, acmeOfficialAgentManagementID, listedManifest)
	if len(pkg.Files) != 2 || pkg.Files[0].Path != "SKILL.md" || pkg.Files[1].Path != "references/examples.md" ||
		pkg.Files[1].MediaType != "text/markdown; charset=utf-8" || string(pkg.Files[1].Content) != "# Example\n" {
		t.Fatalf("unexpected Runtime package files: %+v", pkg.Files)
	}
	roomID := env.createRoom(alice, acmeTenant, "Skill message "+suffix, "skill-message-room-"+suffix)
	skillSegments := func(id string) []map[string]any {
		return []map[string]any{
			{"type": "reference", "content": "@Official", "target": "actor_acme_official", "target_type": "agent"},
			{"type": "text", "content": " "},
			{"type": "skill", "content": "/test-skill", "target": "actor_acme_official", "skill_id": id, "manifest_version": "1.0.0"},
		}
	}
	skillMessage := func(idempotencyKey, rawMessage string, segments []map[string]any) (int, []byte) {
		status, _, body := env.request(alice, http.MethodPost, "/v0/rooms/"+roomID+"/messages", map[string]any{
			"raw_message": rawMessage,
			"segments":    segments,
		}, idempotencyKey)
		return status, body
	}
	status, skillMessageBody := skillMessage("bare-skill-message-"+suffix, "/test-skill", []map[string]any{
		{"type": "skill", "content": "/test-skill", "target": "actor_acme_official", "skill_id": skillID, "manifest_version": "1.0.0"},
	})
	if status != http.StatusBadRequest || !bytes.Contains(skillMessageBody, []byte("INVALID_SKILL")) {
		t.Fatalf("bare Skill Message status=%d body=%s", status, skillMessageBody)
	}
	status, skillMessageBody = skillMessage("out-of-room-skill-message-"+suffix, "@Official /test-skill", skillSegments(skillID))
	if status != http.StatusBadRequest || !bytes.Contains(skillMessageBody, []byte("INVALID_SKILL")) {
		t.Fatalf("out-of-Room Skill Message status=%d body=%s", status, skillMessageBody)
	}
	if status, memberBody := putRoomMember(t, env, alice, roomID, "actor_acme_official", "member"); status != http.StatusOK {
		t.Fatalf("add skill Agent status=%d body=%s", status, memberBody)
	}
	status, skillMessageBody = skillMessage("mismatched-skill-message-"+suffix, "@Alice /test-skill", []map[string]any{
		{"type": "reference", "content": "@Alice", "target": "actor_acme_alice", "target_type": "user"},
		{"type": "text", "content": " "},
		{"type": "skill", "content": "/test-skill", "target": "actor_acme_official", "skill_id": skillID, "manifest_version": "1.0.0"},
	})
	if status != http.StatusBadRequest || !bytes.Contains(skillMessageBody, []byte("INVALID_SKILL")) {
		t.Fatalf("mismatched Skill Message status=%d body=%s", status, skillMessageBody)
	}
	status, skillMessageBody = skillMessage("valid-skill-message-"+suffix, "@Official /test-skill", skillSegments(skillID))
	if status != http.StatusCreated {
		t.Fatalf("create Skill Message status=%d body=%s", status, skillMessageBody)
	}
	if _, err := pool.Exec(ctx, `
		UPDATE agent_registrations
		SET agent_type='anotherme',receives_all_messages=true,represented_human_actor_id=created_by_actor_id
		WHERE actor_id='actor_acme_official'
	`); err != nil {
		t.Fatal(err)
	}
	workItemsBeforeMeetingSkill := countRows(t, env, "select count(*) from work_items")
	workRoomsBeforeMeetingSkill := countRows(t, env, "select count(*) from work_item_room_links where link_type='work'")
	generationsBeforeMeetingSkill := countRows(t, env, "select count(*) from task_execution_generations")
	status, skillMessageBody = skillMessage("platform-skill-message-"+suffix, "@Official /create-meeting-minutes", []map[string]any{
		{"type": "reference", "content": "@Official", "target": "actor_acme_official", "target_type": "agent"},
		{"type": "text", "content": " "},
		{"type": "skill", "content": "/create-meeting-minutes", "target": "actor_acme_official", "skill_id": "simplexai_create_meeting_minutes", "manifest_version": "1.0.0"},
	})
	if status != http.StatusCreated {
		t.Fatalf("create AnotherMe platform Skill Message status=%d body=%s", status, skillMessageBody)
	}
	if got := countRows(t, env, "select count(*) from work_items"); got != workItemsBeforeMeetingSkill {
		t.Fatalf("meeting-minutes Skill created Work Items: got=%d want=%d", got, workItemsBeforeMeetingSkill)
	}
	if got := countRows(t, env, "select count(*) from work_item_room_links where link_type='work'"); got != workRoomsBeforeMeetingSkill {
		t.Fatalf("meeting-minutes Skill created Task Work Rooms: got=%d want=%d", got, workRoomsBeforeMeetingSkill)
	}
	if got := countRows(t, env, "select count(*) from task_execution_generations"); got != generationsBeforeMeetingSkill {
		t.Fatalf("meeting-minutes Skill created managed generations: got=%d want=%d", got, generationsBeforeMeetingSkill)
	}
	if _, err := pool.Exec(ctx, `
		UPDATE agent_registrations
		SET agent_type='general',represented_human_actor_id=NULL
		WHERE actor_id='actor_acme_official'
	`); err != nil {
		t.Fatal(err)
	}
	status, skillMessageBody = skillMessage("restricted-platform-skill-message-"+suffix, "@Official /create-meeting-minutes", []map[string]any{
		{"type": "reference", "content": "@Official", "target": "actor_acme_official", "target_type": "agent"},
		{"type": "text", "content": " "},
		{"type": "skill", "content": "/create-meeting-minutes", "target": "actor_acme_official", "skill_id": "simplexai_create_meeting_minutes", "manifest_version": "1.0.0"},
	})
	if status != http.StatusBadRequest || !bytes.Contains(skillMessageBody, []byte("INVALID_SKILL")) {
		t.Fatalf("general Agent platform Skill Message status=%d body=%s", status, skillMessageBody)
	}
	status, _, directoryBody := env.request(alice, http.MethodGet, "/v0/tenants/"+acmeTenant+"/agents", nil, "")
	if status != http.StatusOK || !bytes.Contains(directoryBody, []byte(skillID)) {
		t.Fatalf("active Skill missing from Agent directory status=%d body=%s", status, directoryBody)
	}
	status, skillMessageBody = skillMessage("missing-skill-message-"+suffix, "@Official /test-skill", skillSegments("skill_missing"))
	if status != http.StatusBadRequest || !bytes.Contains(skillMessageBody, []byte("INVALID_SKILL")) {
		t.Fatalf("missing Skill Message status=%d body=%s", status, skillMessageBody)
	}

	disabledBinding := cloneMap(binding)
	disabledBinding["enabled"] = false
	disabledBinding["expected_binding_version"] = 2
	status, _, disabledBindingBody := env.request(alice, http.MethodPut, bindingPath, disabledBinding, "disable-skill-binding-"+suffix)
	if status != http.StatusOK || !bytes.Contains(disabledBindingBody, []byte(`"enabled":false`)) {
		t.Fatalf("disable Agent Skill binding status=%d body=%s", status, disabledBindingBody)
	}
	status, skillMessageBody = skillMessage("disabled-skill-message-"+suffix, "@Official /test-skill", skillSegments(skillID))
	if status != http.StatusBadRequest || !bytes.Contains(skillMessageBody, []byte("INVALID_SKILL")) {
		t.Fatalf("disabled Skill Message status=%d body=%s", status, skillMessageBody)
	}
	status, _, _ = env.request(alice, http.MethodDelete, bindingPath+"?expected_binding_version=3", nil, "delete-skill-binding-"+suffix)
	if status != http.StatusNoContent {
		t.Fatalf("delete Agent Skill binding status=%d", status)
	}
	status, _, _ = env.request(alice, http.MethodGet, bindingPath, nil, "")
	if status != http.StatusNotFound {
		t.Fatalf("deleted Agent Skill binding status=%d", status)
	}

	for _, oldPath := range []string{
		"/v0/skill-manifests", "/v0/tenants/" + acmeTenant + "/skill-bindings/" + skillID,
		"/v0/rooms/room_missing/effective-skills",
	} {
		status, _, _ = env.request(alice, http.MethodGet, oldPath, nil, "")
		if status != http.StatusNotFound {
			t.Fatalf("legacy route %s status=%d want=404", oldPath, status)
		}
	}
	for _, table := range []string{"skill_bindings", "skill_idempotency_keys", "mcp_manifests", "agent_registration_mcps"} {
		var exists bool
		if err := pool.QueryRow(ctx, "select to_regclass('public.' || $1) is not null", table).Scan(&exists); err != nil {
			t.Fatal(err)
		}
		if exists {
			t.Fatalf("legacy table %s still exists", table)
		}
	}
}

// seedSkillPackage stores one immutable Skill Package version of a new Tenant
// Skill the way the Agent upload path stores a package. The Skill is
// Tenant-scoped unless manifest["access_scope"] is "owner", which makes actorID
// its owner. No Human route publishes Tenant-scoped packages, so tests that
// need one write it directly.
func (e *testEnv) seedSkillPackage(tenantID, actorID string, manifest map[string]any, archive []byte) {
	e.t.Helper()
	ctx := e.t.Context()
	pkg, err := skill.ParsePackage(bytes.NewReader(archive), int64(len(archive)), skill.PackageLimits{
		MaxFiles: 256, MaxFileBytes: 8 << 20, MaxTotalBytes: 32 << 20, MaxCompressionRatio: 200,
	})
	if err != nil {
		e.t.Fatalf("parse Skill Package fixture: %v", err)
	}
	if manifest["description"] != pkg.Description {
		e.t.Fatalf("Skill fixture description %q does not match SKILL.md %q", manifest["description"], pkg.Description)
	}
	configSchema, err := json.Marshal(manifest["config_schema"])
	if err != nil {
		e.t.Fatal(err)
	}
	objects, err := artifactstore.NewLocalStore(e.artifactRoot, 64<<20)
	if err != nil {
		e.t.Fatal(err)
	}
	tx, err := e.pool.Begin(ctx)
	if err != nil {
		e.t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	queries := store.New(tx)
	skillID, version := manifest["skill_id"].(string), manifest["manifest_version"].(string)
	actor := pgtype.Text{String: actorID, Valid: true}
	scope, owner := "tenant", pgtype.Text{}
	if manifest["access_scope"] == "owner" {
		scope, owner = "owner", actor
	}
	if err := queries.CreateTenantSkill(ctx, store.CreateTenantSkillParams{
		SkillID: skillID, TenantID: pgtype.Text{String: tenantID, Valid: true}, Name: pkg.Name,
		AccessScope: scope, OwnerActorID: owner, CreatedByActorID: actor,
	}); err != nil {
		e.t.Fatalf("insert Skill fixture: %v", err)
	}
	manifestFiles := make([]skill.ManifestFile, 0, len(pkg.Files))
	for _, file := range pkg.Files {
		object, err := objects.Put(ctx, bytes.NewReader(file.Content))
		if err != nil {
			e.t.Fatal(err)
		}
		manifestFiles = append(manifestFiles, skill.NewManifestFile(file, object.Key))
	}
	encodedFiles, err := skill.EncodeManifestFiles(manifestFiles)
	if err != nil {
		e.t.Fatalf("encode Skill file fixture: %v", err)
	}
	manifestID := ids.New("skill_manifest")
	if err := queries.CreateSkillManifest(ctx, store.CreateSkillManifestParams{
		ManifestID: manifestID, SkillID: skillID, ManifestVersion: version,
		Description: pkg.Description, ConfigSchema: configSchema,
		FrontmatterExtra: pkg.Frontmatter.FrontmatterExtra, ContentHash: pkg.SHA256[:],
		FileCount: int32(len(pkg.Files)), SizeBytes: pkg.SizeBytes, CreatedByActorID: actor,
		Files: encodedFiles,
	}); err != nil {
		e.t.Fatalf("insert Skill Manifest fixture: %v", err)
	}
	if err := queries.SealSkillManifest(ctx, manifestID); err != nil {
		e.t.Fatalf("seal Skill Manifest fixture: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		e.t.Fatal(err)
	}
}

func makeIntegrationSkillZIP(t *testing.T, packageName, description string, wrapped bool, files map[string]string) []byte {
	t.Helper()
	prefix := ""
	if wrapped {
		prefix = packageName + "/"
	}
	entries := map[string]string{
		"SKILL.md": fmt.Sprintf("---\nname: %s\ndescription: %q\n---\n\n# Instructions\n", packageName, description),
	}
	for name, content := range files {
		entries[name] = content
	}
	paths := make([]string, 0, len(entries))
	for name := range entries {
		paths = append(paths, name)
	}
	sort.Strings(paths)
	var output bytes.Buffer
	writer := zip.NewWriter(&output)
	for _, name := range paths {
		part, err := writer.Create(prefix + name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = io.WriteString(part, entries[name]); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return output.Bytes()
}

func cloneMap(input map[string]any) map[string]any {
	encoded, _ := json.Marshal(input)
	var output map[string]any
	_ = json.Unmarshal(encoded, &output)
	return output
}

// findListedSkillManifest exercises the current Human market without relying on
// the retired single-Manifest/editor browsing endpoints.
func findListedSkillManifest(t *testing.T, env *testEnv, client *http.Client, tenantID, skillID, version string) (httpapi.SkillManifest, bool) {
	t.Helper()
	cursor := ""
	for {
		code, _, body := env.request(client, http.MethodGet, "/v0/tenants/"+tenantID+"/skill-manifests?limit=100&cursor="+url.QueryEscape(cursor), nil, "")
		if code != http.StatusOK {
			t.Fatalf("list Skill market: %d %s", code, body)
		}
		var page httpapi.SkillManifestPage
		decode(t, body, &page)
		for _, item := range page.Items {
			if item.SkillId == skillID && item.ManifestVersion == version {
				return item, true
			}
		}
		if !page.Page.HasMore {
			return httpapi.SkillManifest{}, false
		}
		if page.Page.NextCursor == nil || *page.Page.NextCursor == cursor {
			t.Fatal("Skill market pagination did not advance")
		}
		cursor = *page.Page.NextCursor
	}
}

// readRuntimeSkillPackage reads the bound Skill from the Agent's effective set
// and downloads its exact immutable Manifest the way a Runtime does.
func readRuntimeSkillPackage(t *testing.T, env *testEnv, managementID string, manifest httpapi.SkillManifest) skill.Package {
	t.Helper()
	request := func(bearer, requestPath string) (int, http.Header, []byte) {
		t.Helper()
		request, err := http.NewRequestWithContext(t.Context(), http.MethodGet, env.server.URL+requestPath, nil)
		if err != nil {
			t.Fatal(err)
		}
		if bearer != "" {
			request.Header.Set("Authorization", "Bearer "+bearer)
		}
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		content, err := io.ReadAll(response.Body)
		if err != nil {
			t.Fatal(err)
		}
		return response.StatusCode, response.Header, content
	}
	code, _, body := request(teamHubInternalToken, "/v0/agents/"+managementID+"/effective-resources")
	if code != http.StatusOK {
		t.Fatalf("read effective Skills: %d %s", code, body)
	}
	var effective struct {
		Skills []struct {
			SkillID         string `json:"skill_id"`
			ManifestID      string `json:"manifest_id"`
			ManifestVersion string `json:"manifest_version"`
			PackageSHA256   string `json:"package_sha256"`
		} `json:"skills"`
	}
	decode(t, body, &effective)
	manifestID := ""
	for _, item := range effective.Skills {
		if item.SkillID == manifest.SkillId && item.ManifestVersion == manifest.ManifestVersion {
			manifestID = item.ManifestID
			if item.PackageSHA256 != manifest.PackageSha256 {
				t.Fatal("effective Skill changed the immutable Package identity")
			}
		}
	}
	if manifestID == "" {
		t.Fatal("bound Skill is missing from the effective set")
	}
	download := func(bearer string) (int, http.Header, []byte) {
		return agentSkillPackage(t, env, bearer, manifestID)
	}
	for _, bearer := range []string{"", "invalid"} {
		code, _, _ := download(bearer)
		if code != http.StatusUnauthorized {
			t.Fatalf("Runtime Package without an Agent credential status=%d want=401", code)
		}
	}
	issued, err := agentcredential.New(env.pool).IssueManaged(t.Context(), managementID, "Computer Skill fetch")
	if err != nil {
		t.Fatal(err)
	}
	code, headers, content := download(issued.AccessToken)
	if code != http.StatusOK || headers.Get("Content-Type") != "application/zip" || headers.Get("ETag") != `"`+manifest.PackageSha256+`"` {
		t.Fatalf("Runtime Package status=%d content-type=%s etag=%s", code, headers.Get("Content-Type"), headers.Get("ETag"))
	}
	pkg, err := skill.ParsePackage(bytes.NewReader(content), int64(len(content)), skill.DefaultPackageLimits())
	if err != nil {
		t.Fatal(err)
	}
	if len(pkg.Files) != manifest.FileCount || hex.EncodeToString(pkg.SHA256[:]) != manifest.PackageSha256 {
		t.Fatal("Runtime Package files differ from the immutable market Manifest")
	}
	return pkg
}
