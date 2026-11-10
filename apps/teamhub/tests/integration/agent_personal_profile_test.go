package integration_test

import (
	"bytes"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

// agentProfilePost calls one owner Profile route as the Agent holding token,
// optionally in a business Context, and returns the status and decoded body.
func agentProfilePost(t *testing.T, env *testEnv, token, route, contextKind, contextID string, input any) (int, map[string]any) {
	t.Helper()
	encoded, err := json.Marshal(input)
	if err != nil {
		t.Fatal(err)
	}
	request, err := http.NewRequestWithContext(t.Context(), http.MethodPost, env.server.URL+"/api/agent/v1/"+route, bytes.NewReader(encoded))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Content-Type", "application/json")
	if contextKind != "" {
		request.Header.Set("X-TeamHub-Context-Kind", contextKind)
		request.Header.Set("X-TeamHub-Context-Id", contextID)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var body map[string]any
	_ = json.NewDecoder(response.Body).Decode(&body)
	return response.StatusCode, body
}

func agentProfileErrorCode(body map[string]any) string {
	envelope, _ := body["error"].(map[string]any)
	code, _ := envelope["code"].(string)
	return code
}

func profileInvocation(seed string) string {
	return "agent-invocation-sha256:" + strings.Repeat(seed, 64)
}

// newAnotherMeProfileAgent makes the fixture Agent Alice's AnotherMe and
// returns its credential.
func newAnotherMeProfileAgent(t *testing.T) (*testEnv, string, string) {
	t.Helper()
	env, _, issued, roomID := newAgentCLIIdentity(t)
	if _, err := env.pool.Exec(t.Context(), `UPDATE agent_registrations SET agent_type='anotherme',receives_all_messages=true,represented_human_actor_id='actor_acme_alice' WHERE actor_id='actor_acme_official'`); err != nil {
		t.Fatal(err)
	}
	return env, issued.AccessToken, roomID
}

// profileDocument is a minimal valid Personal Profile document whose
// Preferences overview is preference.
func profileDocument(name, preference string) map[string]any {
	module := func(overview string) map[string]any { return map[string]any{"overview": overview, "points": []any{}} }
	return map[string]any{
		"name": name,
		"background": map[string]any{"overview": "", "points": []any{}, "timeline": []any{
			map[string]any{"period": "2019–Present", "organization": "Acme", "place": "", "role": "Engineer", "description": "", "details": []any{"Owns billing"}},
		}},
		"communication_style": module("Direct."),
		"working_style":       module("Plans first."),
		"preferences":         module(preference),
		"writing_style":       module("Short sentences."),
	}
}

func TestAgentPersonalProfileWritesOwnerProfileWithRevisionCAS(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, token, roomID := newAnotherMeProfileAgent(t)
	show := func(contextKind, contextID string) (int, map[string]any) {
		return agentProfilePost(t, env, token, "personal-profile/query", contextKind, contextID, map[string]any{})
	}
	write := func(invocation string, body map[string]any) (int, map[string]any) {
		body["invocation_id"] = profileInvocation(invocation)
		return agentProfilePost(t, env, token, "personal-profile/revisions", "", "", body)
	}
	revisions := func() int {
		return countRows(t, env, `SELECT count(*) FROM personal_profile_revisions WHERE tenant_id=$1 AND owner_actor_id='actor_acme_alice'`, acmeTenant)
	}
	currentID := func() string {
		var id string
		_ = env.pool.QueryRow(t.Context(), `SELECT revision_id FROM personal_profile_currents WHERE tenant_id=$1 AND owner_actor_id='actor_acme_alice'`, acmeTenant).Scan(&id)
		return id
	}

	if status, body := show("", ""); status != http.StatusOK || body["current"] != nil {
		t.Fatalf("show without a Profile: %d %v", status, body)
	}
	first := profileDocument(" Alice ", "Likes concise updates.")
	status, created := write("a", map[string]any{"profile": first})
	revisionID, _ := created["revision_id"].(string)
	if status != http.StatusOK || revisionID == "" || created["markdown"] != nil {
		t.Fatalf("first write: %d %v", status, created)
	}
	status, shown := show("", "")
	current, _ := shown["current"].(map[string]any)
	profile, _ := current["profile"].(map[string]any)
	markdown, _ := current["markdown"].(string)
	if status != http.StatusOK || current["revision_id"] != revisionID || profile["name"] != "Alice" ||
		!strings.HasPrefix(markdown, "# Alice\n\n## Background\n\n### Timeline\n\n- 2019–Present · Acme\n  Engineer\n  - Owns billing") ||
		!strings.Contains(markdown, "## Preferences\n\nLikes concise updates.") {
		t.Fatalf("show after write: %d %v", status, shown)
	}
	// The shown document is the editable form: writing it back changes nothing.
	if status, body := write("c", map[string]any{"profile": profile, "base_revision_id": revisionID}); status != http.StatusOK || body["revision_id"] != revisionID || revisions() != 1 {
		t.Fatalf("identical write: %d %v revisions=%d", status, body, revisions())
	}
	if status, replay := write("a", map[string]any{"profile": first}); status != http.StatusOK || replay["revision_id"] != revisionID || revisions() != 1 {
		t.Fatalf("replay: %d %v revisions=%d", status, replay, revisions())
	}
	if status, body := write("a", map[string]any{"profile": profileDocument("Alice", "More.")}); status != http.StatusConflict || agentProfileErrorCode(body) != "idempotency_conflict" {
		t.Fatalf("reused invocation: %d %v", status, body)
	}
	for _, stale := range []map[string]any{
		{"profile": profileDocument("Overwrite", "x")},
		{"profile": profileDocument("Overwrite", "x"), "base_revision_id": "personal_profile_revision_stale"},
	} {
		if status, body := write("b", stale); status != http.StatusConflict || agentProfileErrorCode(body) != "profile_revision_conflict" || currentID() != revisionID {
			t.Fatalf("stale base %v: %d %v current=%s", stale, status, body, currentID())
		}
	}
	longTimeline := make([]any, 41)
	for i := range longTimeline {
		longTimeline[i] = map[string]any{"period": "2020", "organization": "Acme", "place": "", "role": "", "description": "", "details": []any{}}
	}
	for _, invalid := range []struct {
		name, code, path string
		edit             func(map[string]any)
	}{
		{"empty module", "profile_module_empty", "writing_style", func(d map[string]any) {
			d["writing_style"] = map[string]any{"overview": " ", "points": []any{}}
		}},
		{"missing module", "profile_module_empty", "working_style", func(d map[string]any) { delete(d, "working_style") }},
		{"long timeline", "profile_document_invalid", "background.timeline", func(d map[string]any) {
			d["background"].(map[string]any)["timeline"] = longTimeline
		}},
		{"heading line", "profile_document_invalid", "preferences.overview", func(d map[string]any) {
			d["preferences"] = map[string]any{"overview": "Fine.\n## Injected", "points": []any{}}
		}},
		{"image", "profile_document_invalid", "communication_style.overview", func(d map[string]any) {
			d["communication_style"] = map[string]any{"overview": "![photo](https://example.com/a.png)", "points": []any{}}
		}},
		{"unknown field", "invalid_input", "", func(d map[string]any) { d["summary"] = "extra" }},
	} {
		document := profileDocument("Alice", "Changed.")
		invalid.edit(document)
		status, body := write("d", map[string]any{"profile": document, "base_revision_id": revisionID})
		envelope, _ := body["error"].(map[string]any)
		issues, _ := envelope["issues"].([]any)
		path := ""
		if len(issues) == 1 {
			path, _ = issues[0].(map[string]any)["path"].(string)
		}
		if status != http.StatusBadRequest || agentProfileErrorCode(body) != invalid.code || path != invalid.path || revisions() != 1 || currentID() != revisionID {
			t.Fatalf("%s: %d %v revisions=%d", invalid.name, status, body, revisions())
		}
	}
	// Rejected writes stored no receipt, so their key still accepts a new write.
	status, updated := write("d", map[string]any{"profile": profileDocument("Alice", "Prefers mornings."), "base_revision_id": revisionID})
	if status != http.StatusOK || updated["revision_id"] == revisionID || currentID() != updated["revision_id"] || revisions() != 2 {
		t.Fatalf("second revision: %d %v revisions=%d", status, updated, revisions())
	}

	const taskID = "task_profile_alter_ego"
	seedTaskActivityParticipant(t, env, taskID, roomID)
	if status, body := show("task", taskID); status != http.StatusOK || body["current"] == nil {
		t.Fatalf("Task Context show: %d %v", status, body)
	}

	if _, err := env.pool.Exec(t.Context(), `UPDATE agent_registrations SET agent_type='general',represented_human_actor_id=NULL WHERE actor_id='actor_acme_official'`); err != nil {
		t.Fatal(err)
	}
	if status, body := show("", ""); status != http.StatusForbidden {
		t.Fatalf("general Agent read a Profile: %d %v", status, body)
	}
}

func TestAgentAccountProfileUpdateSetsOwnerFields(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, token, _ := newAnotherMeProfileAgent(t)
	update := func(body map[string]any) (int, map[string]any) {
		body["invocation_id"] = profileInvocation("f")
		return agentProfilePost(t, env, token, "account-profile/updates", "", "", body)
	}
	show := func() (int, map[string]any) {
		return agentProfilePost(t, env, token, "account-profile/query", "", "", map[string]any{})
	}
	if status, body := show(); status != http.StatusOK || body["name"] == "" || body["bio"] != "" || body["organization"] != "" || body["email"] != nil {
		t.Fatalf("show before update: %d %v", status, body)
	}
	if status, body := agentProfilePost(t, env, token, "account-profile/query", "", "", map[string]any{"name": "x"}); status != http.StatusBadRequest {
		t.Fatalf("show accepted a field: %d %v", status, body)
	}
	status, body := update(map[string]any{"name": "Alice Owner", "bio": "Builds things.", "organization": "Acme"})
	if status != http.StatusOK || body["name"] != "Alice Owner" || body["bio"] != "Builds things." || body["organization"] != "Acme" || body["email"] != nil {
		t.Fatalf("update: %d %v", status, body)
	}
	if status, body := show(); status != http.StatusOK || body["name"] != "Alice Owner" || body["bio"] != "Builds things." || body["organization"] != "Acme" {
		t.Fatalf("show after update: %d %v", status, body)
	}
	var displayName string
	var nameManaged, bioManaged, organizationManaged bool
	if err := env.pool.QueryRow(t.Context(), `SELECT actor.display_name,account.profile_name_user_managed,account.profile_bio_user_managed,account.profile_organization_user_managed
		FROM actors actor JOIN accounts account ON account.id=actor.account_id
		WHERE actor.id='actor_acme_alice' AND actor.tenant_id=$1`, acmeTenant).Scan(&displayName, &nameManaged, &bioManaged, &organizationManaged); err != nil {
		t.Fatal(err)
	}
	if displayName != "Alice Owner" || !nameManaged || !bioManaged || !organizationManaged {
		t.Fatalf("stored: name=%q managed=%v/%v/%v", displayName, nameManaged, bioManaged, organizationManaged)
	}
	for _, invalid := range []map[string]any{{"name": "  "}, {}} {
		if status, body := update(invalid); status != http.StatusBadRequest || agentProfileErrorCode(body) != "invalid_input" {
			t.Fatalf("invalid update %v: %d %v", invalid, status, body)
		}
	}
}

func TestAgentProfileRecordsOnlyReportedOwnedSourceApps(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, token, _ := newAnotherMeProfileAgent(t)
	for _, provider := range []string{"gmail", "github", "outlook"} {
		_, err := env.pool.Exec(t.Context(), `INSERT INTO external_connections(id, account_id, provider, upstream_connection_id, status) SELECT $1, account_id, $2, $3, 'active' FROM actors WHERE tenant_id=$4 AND id='actor_acme_alice'`, "profile-"+provider, provider, "upstream-"+provider, acmeTenant)
		if err != nil {
			t.Fatal(err)
		}
	}
	input := map[string]any{"invocation_id": profileInvocation("9"), "profile": profileDocument("Alice", "A profile."), "source_apps": []string{"gmail", "github"}}
	status, created := agentProfilePost(t, env, token, "personal-profile/revisions", "", "", input)
	if status != http.StatusOK {
		t.Fatalf("write: %d %v", status, created)
	}
	status, shown := agentProfilePost(t, env, token, "personal-profile/query", "", "", map[string]any{})
	current, _ := shown["current"].(map[string]any)
	apps, _ := current["source_apps"].([]any)
	if status != http.StatusOK || len(apps) != 2 || apps[0] != "github" || apps[1] != "gmail" {
		t.Fatalf("sources: %d %v", status, shown)
	}
	alice := env.login("alice", alicePassword)
	publicStatus, _, publicBody := env.request(alice, http.MethodGet, "/v0/tenants/"+acmeTenant+"/personal-profile", nil, "")
	var public map[string]any
	if err := json.Unmarshal(publicBody, &public); err != nil {
		t.Fatal(err)
	}
	publicCurrent, _ := public["current"].(map[string]any)
	publicApps, _ := publicCurrent["source_apps"].([]any)
	if publicStatus != http.StatusOK || len(publicApps) != 2 || publicApps[0] != "github" || publicApps[1] != "gmail" {
		t.Fatalf("public sources: %d %s", publicStatus, publicBody)
	}
	if status, replay := agentProfilePost(t, env, token, "personal-profile/revisions", "", "", input); status != http.StatusOK || replay["revision_id"] != created["revision_id"] {
		t.Fatalf("source replay: %d %v", status, replay)
	}
	if status, body := agentProfilePost(t, env, token, "personal-profile/revisions", "", "", map[string]any{"invocation_id": profileInvocation("9"), "profile": profileDocument("Alice", "A profile."), "source_apps": []string{"gmail"}}); status != http.StatusConflict || agentProfileErrorCode(body) != "idempotency_conflict" {
		t.Fatalf("changed source replay: %d %v", status, body)
	}
	if status, body := agentProfilePost(t, env, token, "personal-profile/revisions", "", "", map[string]any{"invocation_id": profileInvocation("8"), "base_revision_id": created["revision_id"], "profile": profileDocument("Alice", "Updated."), "source_apps": []string{"not-owned"}}); status != http.StatusBadRequest {
		t.Fatalf("unknown source: %d %v", status, body)
	}
	status, cleared := agentProfilePost(t, env, token, "personal-profile/revisions", "", "", map[string]any{"invocation_id": profileInvocation("7"), "base_revision_id": created["revision_id"], "profile": profileDocument("Alice", "A profile."), "source_apps": []string{}})
	if status != http.StatusOK || cleared["revision_id"] == created["revision_id"] {
		t.Fatalf("changed sources: %d %v", status, cleared)
	}
	status, shown = agentProfilePost(t, env, token, "personal-profile/query", "", "", map[string]any{})
	current, _ = shown["current"].(map[string]any)
	apps, ok := current["source_apps"].([]any)
	if status != http.StatusOK || !ok || len(apps) != 0 {
		t.Fatalf("empty sources: %d %v", status, shown)
	}
}

func TestAgentProfileBuildShowsUntilTheNextRevision(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, token, _ := newAnotherMeProfileAgent(t)
	alice := env.login("alice", alicePassword)
	buildingSince := func() any {
		t.Helper()
		status, _, body := env.request(alice, http.MethodGet, "/v0/tenants/"+acmeTenant+"/personal-profile", nil, "")
		var public map[string]any
		if status != http.StatusOK || json.Unmarshal(body, &public) != nil {
			t.Fatalf("public profile: %d %s", status, body)
		}
		return public["building_since"]
	}
	if since := buildingSince(); since != nil {
		t.Fatalf("no build yet: %v", since)
	}
	status, started := agentProfilePost(t, env, token, "personal-profile/builds", "", "", map[string]any{"invocation_id": profileInvocation("5")})
	if status != http.StatusOK || started["building_since"] == nil {
		t.Fatalf("start: %d %v", status, started)
	}
	if status, again := agentProfilePost(t, env, token, "personal-profile/builds", "", "", map[string]any{"invocation_id": profileInvocation("5")}); status != http.StatusOK || again["building_since"] != started["building_since"] {
		t.Fatalf("a build in progress keeps its start: %d %v", status, again)
	}
	if since := buildingSince(); since == nil {
		t.Fatal("the Profile page must see the build")
	}
	if status, body := agentProfilePost(t, env, token, "personal-profile/revisions", "", "", map[string]any{"invocation_id": profileInvocation("6"), "profile": profileDocument("Alice", "A profile.")}); status != http.StatusOK {
		t.Fatalf("write: %d %v", status, body)
	}
	if since := buildingSince(); since != nil {
		t.Fatalf("the revision ends the build: %v", since)
	}
	if _, err := env.pool.Exec(t.Context(), `INSERT INTO personal_profile_builds(tenant_id,owner_actor_id,started_at,expires_at) VALUES($1,'actor_acme_alice',now()-interval '2 hours',now()-interval '1 hour')`, acmeTenant); err != nil {
		t.Fatal(err)
	}
	if since := buildingSince(); since != nil {
		t.Fatalf("an expired build is over: %v", since)
	}
}
