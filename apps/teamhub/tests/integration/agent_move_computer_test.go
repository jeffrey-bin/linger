package integration_test

import (
	"errors"
	"net/http"
	"testing"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentcredential"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentruntimestate"
)

func TestTenantAgentUpdateMovesAgentToAnotherOnlineComputer(t *testing.T) {
	allowParallelIntegrationTest(t)
	management := &recordingAgentManagement{}
	env, alice := newAgentRegistrationEnv(t, management)
	seedOwnedFixtureComputer(t, env.pool, "computer_fixture_two", acmeTenant, "actor_acme_alice")
	status, _, body := env.request(alice, http.MethodPost, "/v0/tenants/"+acmeTenant+"/agents", map[string]any{"name": "Mover", "instructions": "Keep work", "runtime": fixtureRuntime("codex-default")}, "move-create")
	if status != http.StatusCreated {
		t.Fatalf("create %d %s", status, body)
	}
	var created tenantAgentUpdateView
	decode(t, body, &created)
	path := "/v0/tenants/" + acmeTenant + "/agents/" + created.Actor.ID
	before, _, err := agentcredential.New(env.pool).EnsureManagedForPlacement(t.Context(), created.AgentManagementID, "before move", agentcredential.ExpectedPlacement{ComputerID: fixtureComputerID, WorkspaceGrantID: "grant_files"}, nil)
	if err != nil {
		t.Fatal(err)
	}

	status, _, body = env.request(alice, http.MethodPatch, path, map[string]any{"expected_configuration_revision": 1, "runtime": fixtureRuntimeOn("computer_fixture_two", "codex-default")}, "move-to-two")
	if status != http.StatusOK {
		t.Fatalf("move %d %s", status, body)
	}
	var moved tenantAgentUpdateView
	decode(t, body, &moved)
	if moved.ConfigurationRevision != 2 || moved.Actor.ID != created.Actor.ID {
		t.Fatalf("moved view: %+v", moved)
	}
	if countRows(t, env, `SELECT count(*) FROM agent_registrations WHERE actor_id=$1 AND computer_id='computer_fixture_two'`, created.Actor.ID) != 1 {
		t.Fatal("the move did not land the new placement")
	}
	// The move's row change ends the token the previous Computer holds.
	if _, err := agentcredential.Authenticate(t.Context(), env.pool, before.AccessToken); !errors.Is(err, agentcredential.ErrInvalid) {
		t.Fatalf("the previous Computer's token after the move: %v", err)
	}
	if notified := management.notifiedSnapshot(); len(notified) != 1 || notified[0] != created.AgentManagementID {
		t.Fatalf("Agent Service notifications: %v", notified)
	}
	// A placement-aware issuance refuses the Computer the Agent left.
	if _, _, err := agentcredential.New(env.pool).EnsureManagedForPlacement(t.Context(), created.AgentManagementID, "stale computer", agentcredential.ExpectedPlacement{ComputerID: fixtureComputerID, WorkspaceGrantID: "grant_files"}, nil); !errors.Is(err, agentcredential.ErrForbidden) {
		t.Fatalf("stale placement issuance error=%v", err)
	}
	after, _, err := agentcredential.New(env.pool).EnsureManagedForPlacement(t.Context(), created.AgentManagementID, "new computer", agentcredential.ExpectedPlacement{ComputerID: "computer_fixture_two", WorkspaceGrantID: "grant_files"}, nil)
	if err != nil {
		t.Fatalf("new placement issuance error=%v", err)
	}
	if _, err := agentcredential.Authenticate(t.Context(), env.pool, after.AccessToken); err != nil {
		t.Fatalf("the new Computer's token: %v", err)
	}
}

func TestTenantAgentUpdateRefusesUnavailableMoveTargets(t *testing.T) {
	allowParallelIntegrationTest(t)
	management := &recordingAgentManagement{}
	env, alice := newAgentRegistrationEnv(t, management)
	seedOwnedFixtureComputer(t, env.pool, "computer_fixture_removed", acmeTenant, "actor_acme_alice")
	if _, err := env.pool.Exec(t.Context(), `UPDATE local_computers SET status='removed',removed_at=clock_timestamp() WHERE computer_id='computer_fixture_removed'`); err != nil {
		t.Fatal(err)
	}
	status, _, body := env.request(alice, http.MethodPost, "/v0/tenants/"+acmeTenant+"/agents", map[string]any{"name": "Stayer", "instructions": "Keep work", "runtime": fixtureRuntime("codex-default")}, "move-refuse-create")
	if status != http.StatusCreated {
		t.Fatalf("create %d %s", status, body)
	}
	var created tenantAgentUpdateView
	decode(t, body, &created)
	path := "/v0/tenants/" + acmeTenant + "/agents/" + created.Actor.ID
	for name, runtime := range map[string]map[string]any{
		"missing":        fixtureRuntimeOn("computer_nowhere", "codex-default"),
		"removed-target": fixtureRuntimeOn("computer_fixture_removed", "codex-default"),
	} {
		status, _, body = env.request(alice, http.MethodPatch, path, map[string]any{"expected_configuration_revision": 1, "runtime": runtime}, "move-refuse-"+name)
		if status != http.StatusConflict || !containsJSONText(body, "AGENT_PLACEMENT_TARGET_UNAVAILABLE") {
			t.Fatalf("%s: %d %s", name, status, body)
		}
	}
	readOnly := fixtureRuntime("codex-default")
	readOnly["placement"].(map[string]any)["workspace_grant_id"] = "grant_unknown"
	status, _, body = env.request(alice, http.MethodPatch, path, map[string]any{"expected_configuration_revision": 1, "runtime": readOnly}, "move-refuse-grant")
	if status != http.StatusConflict || !containsJSONText(body, "AGENT_PLACEMENT_TARGET_UNAVAILABLE") {
		t.Fatalf("unknown grant: %d %s", status, body)
	}
	if len(management.notifiedSnapshot()) != 0 || countRows(t, env, `SELECT count(*) FROM agent_registrations WHERE actor_id=$1 AND status='active' AND computer_id=$2`, created.Actor.ID, fixtureComputerID) != 1 {
		t.Fatal("a refused move reached Agent Service or changed the registration")
	}
}

func TestTenantAgentUpdateMovesAwayFromOfflineComputerAndEndsStrandedWork(t *testing.T) {
	allowParallelIntegrationTest(t)
	management := &recordingAgentManagement{}
	env, alice := newAgentRegistrationEnv(t, management)
	seedOwnedFixtureComputer(t, env.pool, "computer_fixture_two", acmeTenant, "actor_acme_alice")
	status, _, body := env.request(alice, http.MethodPost, "/v0/tenants/"+acmeTenant+"/agents", map[string]any{"name": "Stranded", "instructions": "Keep work", "runtime": fixtureRuntime("codex-default")}, "stranded-create")
	if status != http.StatusCreated {
		t.Fatalf("create %d %s", status, body)
	}
	var created tenantAgentUpdateView
	decode(t, body, &created)
	path := "/v0/tenants/" + acmeTenant + "/agents/" + created.Actor.ID
	const roomID = "room_move_stranded"
	insertRuntimeRoomMembershipForAgent(t, env.pool, roomID, created.Actor.ID)
	ensured, err := agentruntimestate.New(env.pool).EnsureContext(t.Context(), agentruntimestate.EnsureContextInput{Ref: agentruntimestate.ContextRef{Kind: "meta", AgentID: created.AgentManagementID, RoomID: roomID}, TargetResidency: "active"})
	if err != nil {
		t.Fatal(err)
	}
	key := ensured.Context.ContextKey
	if _, err := env.pool.Exec(t.Context(), `INSERT INTO agent_local_runs(run_id,context_key,status,started_at) VALUES('stranded-run',$1,'running',clock_timestamp())`, key); err != nil {
		t.Fatal(err)
	}
	if _, err := env.pool.Exec(t.Context(), `INSERT INTO agent_runtime_inputs(context_key,input_id,input_sequence,payload,payload_hash,source_kind,status,steer_group_id,selection_result) VALUES($1,'stranded-steer',1,'{}',decode(repeat('00',32),'hex'),'internal','steering','stranded-steer-group','{"selected":"steer"}')`, key); err != nil {
		t.Fatal(err)
	}
	// While the previous Computer is online, stranded work still blocks the move.
	status, _, body = env.request(alice, http.MethodPatch, path, map[string]any{"expected_configuration_revision": 1, "runtime": fixtureRuntimeOn("computer_fixture_two", "codex-default")}, "stranded-move-online")
	if status != http.StatusConflict || !containsJSONText(body, "AGENT_BUSY") {
		t.Fatalf("busy move: %d %s", status, body)
	}
	if _, err := env.pool.Exec(t.Context(), `UPDATE local_computers SET status='offline' WHERE computer_id=$1`, fixtureComputerID); err != nil {
		t.Fatal(err)
	}
	// Work held by the offline Computer can never finish there, so the move
	// ends it in the same transaction.
	payload := map[string]any{"expected_configuration_revision": 1, "runtime": fixtureRuntimeOn("computer_fixture_two", "codex-default")}
	status, _, body = env.request(alice, http.MethodPatch, path, payload, "stranded-move-offline")
	if status != http.StatusOK {
		t.Fatalf("move from offline Computer: %d %s", status, body)
	}
	var runStatus, runError, inputStatus, computerID string
	if err := env.pool.QueryRow(t.Context(), `SELECT run.status,run.terminal->>'error',input.status,registration.computer_id
		FROM agent_local_runs run, agent_runtime_inputs input, agent_registrations registration
		WHERE run.run_id='stranded-run' AND input.input_id='stranded-steer' AND registration.actor_id=$1`, created.Actor.ID).Scan(&runStatus, &runError, &inputStatus, &computerID); err != nil {
		t.Fatal(err)
	}
	if runStatus != "failed" || runError != "local_computer_unavailable" || inputStatus != "handled" || computerID != "computer_fixture_two" {
		t.Fatalf("stranded work after move: run=%s/%s input=%s computer=%s", runStatus, runError, inputStatus, computerID)
	}
}

// The target Computer may be offline: the Agent waits for it and runs there
// once it connects.
func TestTenantAgentUpdateMovesAgentToAnOfflineComputer(t *testing.T) {
	allowParallelIntegrationTest(t)
	management := &recordingAgentManagement{}
	env, alice := newAgentRegistrationEnv(t, management)
	seedOwnedFixtureComputer(t, env.pool, "computer_fixture_asleep", acmeTenant, "actor_acme_alice")
	if _, err := env.pool.Exec(t.Context(), `UPDATE local_computers SET status='offline',last_seen_at=now()-interval '1 hour' WHERE computer_id='computer_fixture_asleep'`); err != nil {
		t.Fatal(err)
	}
	status, _, body := env.request(alice, http.MethodPost, "/v0/tenants/"+acmeTenant+"/agents", map[string]any{"name": "Traveller", "instructions": "Keep work", "runtime": fixtureRuntime("codex-default")}, "move-offline-create")
	if status != http.StatusCreated {
		t.Fatalf("create %d %s", status, body)
	}
	var created tenantAgentUpdateView
	decode(t, body, &created)
	path := "/v0/tenants/" + acmeTenant + "/agents/" + created.Actor.ID
	status, _, body = env.request(alice, http.MethodPatch, path, map[string]any{"expected_configuration_revision": 1, "runtime": fixtureRuntimeOn("computer_fixture_asleep", "codex-default")}, "move-to-asleep")
	if status != http.StatusOK {
		t.Fatalf("move to an offline Computer: %d %s", status, body)
	}
	if countRows(t, env, `SELECT count(*) FROM agent_registrations WHERE actor_id=$1 AND status='active' AND computer_id='computer_fixture_asleep' AND configuration_revision=2`, created.Actor.ID) != 1 {
		t.Fatal("the move did not land the new placement")
	}
	status, _, availability := env.request(alice, http.MethodGet, "/v0/tenants/"+acmeTenant+"/agent-availability?limit=200", nil, "")
	if status != http.StatusOK || !containsJSONText(availability, "Waiting for the computer to connect") {
		t.Fatalf("availability after the move: %d %s", status, availability)
	}
	if notified := management.notifiedSnapshot(); len(notified) != 1 || notified[0] != created.AgentManagementID {
		t.Fatalf("Agent Service notifications: %v", notified)
	}
}

// A Human moves their Another Me off a Computer that never came back; no
// platform update can hold the Agent in between.
func TestTenantAgentUpdateMovesAnotherMeOffAnOfflineComputer(t *testing.T) {
	allowParallelIntegrationTest(t)
	management := &recordingAgentManagement{}
	env, alice := newAgentRegistrationEnv(t, management)
	seedOwnedFixtureComputer(t, env.pool, "computer_fixture_two", acmeTenant, "actor_acme_alice")
	const actorID = "actor_move_bob_me"
	const managementID = "management_move_bob_me"
	if _, err := env.pool.Exec(t.Context(), `INSERT INTO actors(id,tenant_id,kind,display_name,handle) VALUES($1,$2,'agent','Alice''s Another Me','alice-me-move')`, actorID, acmeTenant); err != nil {
		t.Fatal(err)
	}
	if _, err := env.pool.Exec(t.Context(), `
		INSERT INTO agent_registrations(
			actor_id,tenant_id,agent_management_id,status,description,instructions,
			runtime_model,created_by_actor_id,visibility_scope,agent_type,represented_human_actor_id,
			computer_id,local_runtime_type,workspace_grant_id,configuration_revision,runtime_configuration_revision
		) VALUES($1,$2,$3,'active','Private delegate','Delegate safely',
			'codex-default','actor_acme_alice','sponsor','anotherme','actor_acme_alice',$4,'codex','grant_files',3,3)
	`, actorID, acmeTenant, managementID, fixtureComputerID); err != nil {
		t.Fatal(err)
	}
	if _, err := env.pool.Exec(t.Context(), `UPDATE local_computers SET status='offline' WHERE computer_id=$1`, fixtureComputerID); err != nil {
		t.Fatal(err)
	}
	path := "/v0/tenants/" + acmeTenant + "/agents/" + actorID
	status, _, body := env.request(alice, http.MethodPatch, path, map[string]any{"expected_configuration_revision": 2, "runtime": fixtureRuntimeOn("computer_fixture_two", "codex-default")}, "another-me-stale")
	if status != http.StatusConflict || !containsJSONText(body, "AGENT_CONFIGURATION_CONFLICT") {
		t.Fatalf("stale move: %d %s", status, body)
	}
	status, _, body = env.request(alice, http.MethodPatch, path, map[string]any{"expected_configuration_revision": 3, "runtime": fixtureRuntimeOn("computer_fixture_two", "codex-default")}, "another-me-move")
	if status != http.StatusOK {
		t.Fatalf("move: %d %s", status, body)
	}
	var moved tenantAgentUpdateView
	decode(t, body, &moved)
	if moved.ConfigurationRevision != 4 {
		t.Fatalf("moved view: %+v", moved)
	}
	if countRows(t, env, `SELECT count(*) FROM agent_registrations WHERE actor_id=$1 AND status='active' AND computer_id='computer_fixture_two' AND configuration_revision=4`, actorID) != 1 {
		t.Fatal("the move did not land the new placement")
	}
	if notified := management.notifiedSnapshot(); len(notified) != 1 || notified[0] != managementID {
		t.Fatalf("Agent Service notifications: %v", notified)
	}
}
