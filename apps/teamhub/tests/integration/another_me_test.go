package integration_test

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/config"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/platform/agenttemplates"
)

// newAnotherMeEnv starts an app whose Human has no Another Me and no Computer
// yet, with the built-in Agent templates the starter workspace uses.
func newAnotherMeEnv(t *testing.T) (*testEnv, *http.Client, *recordingAgentManagement) {
	t.Helper()
	databaseURL := newIntegrationDatabase(t)
	pool, err := pgxpool.New(t.Context(), databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	// The integration app skips built-in installation; the template clone
	// already carries the built-in Skills the templates bind.
	if err := agenttemplates.Ensure(t.Context(), pool); err != nil {
		t.Fatal(err)
	}
	agentManagement := &recordingAgentManagement{}
	artifactRoot := integrationArtifactRoot(t)
	application, err := newIntegrationApp(t.Context(), config.ForTest(func(c *config.Config) {
		c.DatabaseURL = databaseURL
		c.SessionTTL = time.Hour
		c.CookieName = "teamhub_session"
		c.TeamHubInternalToken = teamHubInternalToken
		c.NodeServicesInternalToken = nodeServicesInternalToken
		c.AgentRunTokenSecret = agentRunTokenSecret
		c.ArtifactStorageRoot = artifactRoot
	}), withAgentManagement(agentManagement), withLocalComputers(&recordingLocalComputers{}))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(application.Close)
	server := httptest.NewServer(application.Handler())
	registerIntegrationServerCleanup(t, server)
	env := &testEnv{t: t, databaseURL: databaseURL, pool: pool, server: server, artifactRoot: artifactRoot}
	return env, env.login("alice", alicePassword), agentManagement
}

// newConnectedAnotherMeEnv starts an app with River and connects Alice's
// Computer, which creates her Another Me with its Chat and opening.
func newConnectedAnotherMeEnv(t *testing.T, configure func(*config.Config), options ...appOption) (*testEnv, *pgxpool.Pool) {
	t.Helper()
	databaseURL := newIntegrationDatabase(t)
	pool, err := pgxpool.New(t.Context(), databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	cfg := config.ForTest(func(c *config.Config) {
		c.DatabaseURL = databaseURL
		c.SessionTTL = time.Hour
		c.CookieName = "teamhub_session"
		c.TeamHubInternalToken = teamHubInternalToken
		c.NodeServicesInternalToken = nodeServicesInternalToken
		c.AgentRunTokenSecret = agentRunTokenSecret
		c.ArtifactStorageRoot = t.TempDir()
		c.Jobs.PollInterval = riverTestPollInterval
	})
	if configure != nil {
		configure(&cfg)
	}
	application, err := newTestApp(t.Context(), cfg, append(append(riverTestOnlyOptions(), withAgentManagement(&recordingAgentManagement{}),
		withLocalComputers(&recordingLocalComputers{})), options...)...)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(application.Close)
	server := httptest.NewServer(application.Handler())
	registerIntegrationServerCleanup(t, server)
	env := &testEnv{t: t, databaseURL: databaseURL, pool: pool, server: server}
	if connectAnotherMeComputer(t, env, acmeTenant, "actor_acme_alice") == "" {
		t.Fatal("connecting the Computer created no Another Me")
	}
	return env, pool
}

// anotherMeRoomID is the Human's live Chat with their Another Me.
func anotherMeRoomID(t *testing.T, pool *pgxpool.Pool, humanActorID string) string {
	t.Helper()
	var roomID string
	if err := pool.QueryRow(t.Context(), `
		SELECT room.id FROM rooms room
		JOIN agent_registrations registration ON registration.actor_id=room.direct_agent_actor_id
		WHERE room.tenant_id=$1 AND room.direct_human_actor_id=$2 AND room.deletion_started_at IS NULL
		  AND registration.agent_type='anotherme'
	`, acmeTenant, humanActorID).Scan(&roomID); err != nil {
		t.Fatalf("Another Me room err=%v", err)
	}
	return roomID
}

// The Computer's first online observation creates the Another Me on its ready
// Runtime with its Chat, the template opening and the starter workspace, all
// at once. A later observation creates nothing again.
func TestComputerComingOnlineCreatesAnotherMeOnce(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice, _ := newAnotherMeEnv(t)
	anotherMePath := "/v0/tenants/" + acmeTenant + "/another-me"
	status, _, body := env.request(alice, http.MethodGet, anotherMePath, nil, "")
	if status != http.StatusOK || string(body) != "{}" {
		t.Fatalf("Another Me before a Computer status=%d body=%s", status, body)
	}

	actorID := connectAnotherMeComputer(t, env, acmeTenant, "actor_acme_alice")
	if actorID == "" {
		t.Fatal("the Computer coming online created no Another Me")
	}
	var model, effort, computerID, runtimeType, grantID, createdBy string
	var receivesAll bool
	if err := env.pool.QueryRow(t.Context(), `
		SELECT runtime_model,coalesce(runtime_reasoning_effort,''),computer_id,local_runtime_type,workspace_grant_id,created_by_actor_id,
		       receives_all_messages
		FROM agent_registrations WHERE actor_id=$1
	`, actorID).Scan(&model, &effort, &computerID, &runtimeType, &grantID, &createdBy, &receivesAll); err != nil {
		t.Fatal(err)
	}
	if model != anotherMeFixtureModel || effort != "high" || computerID != anotherMeFixtureComputerID(acmeTenant, "actor_acme_alice") ||
		runtimeType != "codex" || grantID != anotherMeFixtureGrant || createdBy != "actor_acme_alice" || !receivesAll {
		t.Fatalf("Another Me placement model=%q effort=%q computer=%q runtime=%q grant=%q sponsor=%q receives all=%v",
			model, effort, computerID, runtimeType, grantID, createdBy, receivesAll)
	}
	if got := countRows(t, env, `SELECT count(*) FROM agent_skill_bindings WHERE agent_actor_id=$1`, actorID); got != 0 {
		t.Fatalf("Another Me Skill bindings=%d want=0", got)
	}
	var roomID string
	if err := env.pool.QueryRow(t.Context(), `
		SELECT id FROM rooms WHERE tenant_id=$1 AND direct_human_actor_id='actor_acme_alice' AND direct_agent_actor_id=$2
	`, acmeTenant, actorID).Scan(&roomID); err != nil {
		t.Fatal(err)
	}
	assertAgentRoomMetaContextKind(t, env.pool, actorID, roomID, "direct")
	var greeting string
	if err := env.pool.QueryRow(t.Context(), `
		SELECT body FROM messages WHERE room_id=$1 AND author_actor_id=$2 ORDER BY room_seq LIMIT 1
	`, roomID, actorID).Scan(&greeting); err != nil {
		t.Fatal(err)
	}
	if greeting != "Hi alice, I'm your Another Me — think of me as another you in Linger." {
		t.Fatalf("Another Me greeting=%q", greeting)
	}
	assertAnotherMeChat(t, env, roomID)
	assertStarterWorkspace(t, env, actorID)
	status, _, body = env.request(alice, http.MethodGet, anotherMePath, nil, "")
	if status != http.StatusOK || !containsJSONText(body, `"agent_actor_id":"`+actorID+`"`) || !containsJSONText(body, `"room_id":"`+roomID+`"`) {
		t.Fatalf("Another Me projection status=%d body=%s", status, body)
	}

	// Coming online again, or with new diagnostics, creates nothing more.
	if again := connectAnotherMeComputer(t, env, acmeTenant, "actor_acme_alice"); again != actorID {
		t.Fatalf("Another Me after reconnecting=%q want %q", again, actorID)
	}
	if got := countRows(t, env, `
		SELECT count(*) FROM agent_registrations WHERE tenant_id=$1 AND represented_human_actor_id='actor_acme_alice' AND agent_type='anotherme'
	`, acmeTenant); got != 1 {
		t.Fatalf("Another Me registrations=%d want=1", got)
	}
	assertAnotherMeChat(t, env, roomID)
	assertStarterWorkspace(t, env, actorID)
}

// A Computer without a ready Runtime creates no Another Me; one whose Runtime
// becomes ready while it stays online does.
func TestAnotherMeWaitsForAReadyRuntimeWithoutAJob(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, _, _ := newAnotherMeEnv(t)
	seedAnotherMeComputers(t, env.pool)
	computerID := anotherMeFixtureComputerID(acmeTenant, "actor_acme_alice")
	if _, err := env.pool.Exec(t.Context(), `
		UPDATE local_computers
		SET status='offline',last_seen_at=now()-interval '1 minute',
		    runtime_diagnostics=jsonb_build_array(jsonb_build_object('type','codex','status','not_installed','protocol','app-server','checked_at',to_jsonb(now())))
		WHERE computer_id=$1
	`, computerID); err != nil {
		t.Fatal(err)
	}
	touchAnotherMeComputer(t, env, computerID, nil)
	if actorID := anotherMeActorID(t, env, acmeTenant, "actor_acme_alice"); actorID != "" {
		t.Fatalf("Another Me created without a ready Runtime: %s", actorID)
	}
	if got := countRows(t, env, `SELECT count(*) FROM river_job WHERE kind LIKE 'another_me.%' OR kind LIKE 'maintenance.another_me%'`); got != 0 {
		t.Fatalf("Another Me jobs=%d want=0", got)
	}
	touchAnotherMeComputer(t, env, computerID, []map[string]any{{
		"type": "codex", "status": "ready", "protocol": "app-server", "checked_at": time.Now().UTC(),
		"models": []map[string]any{{"id": anotherMeFixtureModel, "label": "GPT-5.4"}},
	}})
	if actorID := anotherMeActorID(t, env, acmeTenant, "actor_acme_alice"); actorID == "" {
		t.Fatal("a Runtime that became ready created no Another Me")
	}
}

// A starter template that cannot be installed is skipped: the Another Me, the
// other starter Agent and the Getting Started Room are still created.
func TestAnotherMeSkipsABrokenStarterTemplate(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, _, _ := newAnotherMeEnv(t)
	// A repeated Skill makes the Code Reviewer's bindings invalid.
	if _, err := env.pool.Exec(t.Context(), `
		UPDATE agent_templates SET skill_bindings=skill_bindings || jsonb_build_array(skill_bindings->0)
		WHERE template_id='code-reviewer'
	`); err != nil {
		t.Fatal(err)
	}
	actorID := connectAnotherMeComputer(t, env, acmeTenant, "actor_acme_alice")
	if actorID == "" {
		t.Fatal("a broken starter template blocked the Another Me")
	}
	if got := countRows(t, env, `
		SELECT count(*) FROM agent_registrations
		WHERE tenant_id=$1 AND created_by_actor_id='actor_acme_alice' AND status='active' AND template_id IS NOT NULL
	`, acmeTenant); got != 1 {
		t.Fatalf("starter Agents=%d want=1", got)
	}
	if got := countRows(t, env, `
		SELECT count(*) FROM room_members member
		JOIN rooms room ON room.id=member.room_id
		WHERE room.tenant_id=$1 AND room.name='Getting Started' AND room.deleted_at IS NULL
	`, acmeTenant); got != 3 {
		t.Fatalf("starter Room members=%d want=3", got)
	}
}

// A creation that failed is retried by the next heartbeat of a Computer that
// stays online, with no change to its Runtimes or workspaces.
func TestAnotherMeCreationRetriesOnTheNextHeartbeat(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, _, _ := newAnotherMeEnv(t)
	seedAnotherMeComputers(t, env.pool)
	computerID := anotherMeFixtureComputerID(acmeTenant, "actor_acme_alice")
	if _, err := env.pool.Exec(t.Context(), `
		CREATE SEQUENCE fail_another_me_attempts;
		CREATE FUNCTION fail_another_me_once() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN
			-- A sequence survives the rollback that the failure causes.
			IF nextval('fail_another_me_attempts') = 1 THEN
				RAISE EXCEPTION 'injected Another Me failure';
			END IF;
			RETURN NEW;
		END $$;
		CREATE TRIGGER fail_another_me_once BEFORE INSERT ON agent_registrations
		FOR EACH ROW WHEN (NEW.agent_type='anotherme') EXECUTE FUNCTION fail_another_me_once();
	`); err != nil {
		t.Fatal(err)
	}
	touchAnotherMeComputer(t, env, computerID, nil)
	if actorID := anotherMeActorID(t, env, acmeTenant, "actor_acme_alice"); actorID != "" {
		t.Fatalf("Another Me created despite the injected failure: %s", actorID)
	}
	touchAnotherMeComputer(t, env, computerID, nil)
	if actorID := anotherMeActorID(t, env, acmeTenant, "actor_acme_alice"); actorID == "" {
		t.Fatal("the next heartbeat did not retry the Another Me")
	}
}

func TestAnotherMeOwnerCanEditNameAndRuntimeButNotInstructionsOrDelete(t *testing.T) {
	allowParallelIntegrationTest(t)
	agentManagement := &recordingAgentManagement{}
	env, alice := newAgentRegistrationEnv(t, agentManagement)
	const actorID = "actor_another_me_protected"
	if _, err := env.pool.Exec(t.Context(), `
		INSERT INTO actors(id,tenant_id,kind,display_name,handle)
		VALUES($1,$2,'agent','Alice''s Another Me','@protected-another-me')
	`, actorID, acmeTenant); err != nil {
		t.Fatal(err)
	}
	if _, err := env.pool.Exec(t.Context(), `
		INSERT INTO agent_registrations(
			actor_id,tenant_id,agent_management_id,status,description,instructions,
			runtime_model,created_by_actor_id,visibility_scope,agent_type,represented_human_actor_id,
			computer_id,local_runtime_type,workspace_grant_id
		) VALUES($1,$2,'management-protected-another-me','active','Private delegate',
			'Delegate safely','openai/gpt-5.4','actor_acme_alice','sponsor','anotherme','actor_acme_alice','computer_fixture','codex','grant_files')
	`, actorID, acmeTenant); err != nil {
		t.Fatal(err)
	}
	seedAnotherMeComputers(t, env.pool)
	bindLocalFixtureRegistration(t, env.pool, actorID)
	path := "/v0/tenants/" + acmeTenant + "/agents/" + actorID
	status, _, body := env.request(alice, http.MethodPatch, path, map[string]any{
		"expected_configuration_revision": 1,
		"description":                     "Mutated delegate",
	}, "edit-protected-another-me")
	if status != http.StatusConflict || !containsJSONText(body, "AGENT_UPDATE_UNAVAILABLE") {
		t.Fatalf("edit Another Me status=%d body=%s", status, body)
	}
	status, _, body = env.request(alice, http.MethodDelete, path, nil, "")
	if status != http.StatusConflict || !containsJSONText(body, "AGENT_DELETION_UNAVAILABLE") {
		t.Fatalf("delete Another Me status=%d body=%s", status, body)
	}
	if got := countRows(t, env, `SELECT count(*) FROM agent_registrations WHERE actor_id=$1 AND status='active'`, actorID); got != 1 {
		t.Fatalf("protected Another Me active registrations=%d want=1", got)
	}
	if notified := agentManagement.notifiedSnapshot(); len(notified) != 0 {
		t.Fatalf("protected Another Me reached Agent Service: %v", notified)
	}
	request := map[string]any{
		"expected_configuration_revision": 1,
		"runtime": map[string]any{"model": "claude-sonnet", "reasoning_effort": "high", "placement": map[string]any{
			"type": "local", "computer_id": anotherMeFixtureComputerID(acmeTenant, "actor_acme_alice"),
			"runtime_type": "claude", "workspace_grant_id": anotherMeFixtureGrant,
		}},
	}
	status, _, body = env.request(alice, http.MethodPatch, path, request, "anotherme-runtime-choice")
	if status != http.StatusOK {
		t.Fatalf("runtime update status=%d body=%s", status, body)
	}
	var model, effort, state string
	var revision int64
	if err := env.pool.QueryRow(t.Context(), `SELECT runtime_model,runtime_reasoning_effort,status,configuration_revision FROM agent_registrations WHERE actor_id=$1`, actorID).Scan(&model, &effort, &state, &revision); err != nil {
		t.Fatal(err)
	}
	if model != "claude-sonnet" || effort != "high" || state != "active" || revision != 2 {
		t.Fatalf("runtime choice not saved: %s %s %s revision=%d", model, effort, state, revision)
	}
	if notified := agentManagement.notifiedSnapshot(); len(notified) != 1 || notified[0] != "management-protected-another-me" {
		t.Fatalf("runtime update notifications: %v", notified)
	}
	status, _, body = env.request(alice, http.MethodPatch, path, map[string]any{
		"expected_configuration_revision": 2,
		"name":                            "Alice's Delegate",
		"instructions":                    "Mutated instructions",
	}, "anotherme-rename-with-instructions")
	if status != http.StatusConflict || !containsJSONText(body, "AGENT_UPDATE_UNAVAILABLE") {
		t.Fatalf("rename with instructions status=%d body=%s", status, body)
	}
	status, _, body = env.request(alice, http.MethodPatch, path, map[string]any{
		"expected_configuration_revision": 2,
		"name":                            "Alice's Delegate",
	}, "anotherme-rename")
	if status != http.StatusOK {
		t.Fatalf("rename Another Me status=%d body=%s", status, body)
	}
	var displayName, instructions string
	if err := env.pool.QueryRow(t.Context(), `
		SELECT actor.display_name,registration.instructions,registration.configuration_revision
		FROM actors actor JOIN agent_registrations registration ON registration.actor_id=actor.id
		WHERE actor.id=$1
	`, actorID).Scan(&displayName, &instructions, &revision); err != nil {
		t.Fatal(err)
	}
	if displayName != "Alice's Delegate" || instructions != "Delegate safely" || revision != 3 {
		t.Fatalf("Another Me rename not saved: name=%q instructions=%q revision=%d", displayName, instructions, revision)
	}
	// A rename is profile-only: it keeps every Session and skips Agent Service.
	if notified := agentManagement.notifiedSnapshot(); len(notified) != 1 {
		t.Fatalf("Another Me rename reached Agent Service: %v", notified)
	}
}

// assertAnotherMeChat checks the Chat holds the Human and the Another Me and
// exactly the opening: the greeting and the profile setup apps card.
func assertAnotherMeChat(t *testing.T, env *testEnv, roomID string) {
	t.Helper()
	if got := countRows(t, env, `SELECT count(*) FROM room_members WHERE room_id=$1`, roomID); got != 2 {
		t.Fatalf("Another Me Chat members=%d want=2", got)
	}
	if got := countRows(t, env, `SELECT count(*) FROM messages WHERE room_id=$1`, roomID); got != 2 {
		t.Fatalf("Another Me opening Messages (greeting and apps card)=%d want=2", got)
	}
	if got := countRows(t, env, `
		SELECT count(*) FROM decisions WHERE room_id=$1 AND kind='profile_setup_apps'
	`, roomID); got != 1 {
		t.Fatalf("Another Me profile setup apps cards=%d want=1", got)
	}
}

// assertStarterWorkspace checks the two starter template Agents and the
// Getting Started Room with the Human, their Another Me and the Research Analyst.
func assertStarterWorkspace(t *testing.T, env *testEnv, anotherMeID string) {
	t.Helper()
	if got := countRows(t, env, `
		SELECT count(*) FROM agent_registrations registration
		WHERE registration.tenant_id=$1 AND registration.created_by_actor_id='actor_acme_alice' AND registration.status='active'
		  AND registration.template_id IN ('research-analyst','code-reviewer') AND registration.template_installed_at IS NOT NULL
	`, acmeTenant); got != 2 {
		t.Fatalf("starter Agents=%d want=2", got)
	}
	if got := countRows(t, env, `
		SELECT count(*) FROM agent_skill_bindings binding
		JOIN agent_registrations registration ON registration.actor_id=binding.agent_actor_id
		WHERE registration.template_id='code-reviewer'
		  AND binding.skill_id IN ('simplexai_superpowers','simplexai_impeccable','simplexai_taste')
	`); got != 3 {
		t.Fatalf("Code Reviewer current Skill bindings=%d want=3", got)
	}
	if got := countRows(t, env, `
		SELECT count(*) FROM rooms WHERE tenant_id=$1 AND name='Getting Started' AND deleted_at IS NULL
	`, acmeTenant); got != 1 {
		t.Fatalf("starter Rooms=%d want=1", got)
	}
	if got := countRows(t, env, `
		SELECT count(*) FROM room_members member
		JOIN rooms room ON room.id=member.room_id
		LEFT JOIN agent_registrations registration ON registration.actor_id=member.actor_id
		WHERE room.tenant_id=$1 AND room.name='Getting Started'
		  AND (member.actor_id='actor_acme_alice' AND member.role='owner'
		       OR member.actor_id=$2 OR registration.template_id='research-analyst')
	`, acmeTenant, anotherMeID); got != 3 {
		t.Fatalf("starter Room expected members=%d want=3", got)
	}
}
