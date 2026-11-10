package integration_test

import (
	"encoding/json"
	"net/http"
	"slices"
	"testing"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentruntimestate"
)

func TestTenantRoomActivityAuthorizationAndLifecycle(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newAgentRunEnv(t, "http://unused-agent.invalid")
	runtime := agentruntimestate.New(env.pool)
	createRun := func(client *http.Client, label, agentID, actorID string) (string, string) {
		t.Helper()
		roomID := createPrivateRoom(t, env, client, label, label)
		if code, body := putRoomMember(t, env, client, roomID, actorID, "member"); code != 200 {
			t.Fatalf("member %d %s", code, body)
		}
		ensured, err := runtime.EnsureContext(t.Context(), agentruntimestate.EnsureContextInput{Ref: agentruntimestate.ContextRef{Kind: "meta", AgentID: agentID, RoomID: roomID}, TargetResidency: "active"})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := env.pool.Exec(t.Context(), `INSERT INTO agent_local_runs(run_id,context_key,status) VALUES($1,$2,'queued')`, label, ensured.Context.ContextKey); err != nil {
			t.Fatal(err)
		}
		return roomID, ensured.Context.ContextKey
	}
	roomID, contextKey := createRun(alice, "activity-visible", acmeOfficialAgentManagementID, "actor_acme_official")
	request := func(client *http.Client, tenantID string, expectedCode int) (running []string, failed []string) {
		t.Helper()
		response, err := client.Get(env.server.URL + "/v0/tenants/" + tenantID + "/room-activity")
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		if response.StatusCode != expectedCode {
			t.Fatalf("activity status = %d, want %d", response.StatusCode, expectedCode)
		}
		if expectedCode != 200 {
			return nil, nil
		}
		var result struct {
			FailedRoomIDs  []string `json:"failed_room_ids"`
			RunningRoomIDs []string `json:"running_room_ids"`
		}
		if err := json.NewDecoder(response.Body).Decode(&result); err != nil {
			t.Fatal(err)
		}
		if result.RunningRoomIDs == nil {
			t.Fatal("running_room_ids must be an array")
		}
		if result.FailedRoomIDs == nil {
			t.Fatal("failed_room_ids must be an array")
		}
		return result.RunningRoomIDs, result.FailedRoomIDs
	}
	assertRooms := func(want ...string) {
		t.Helper()
		got, _ := request(alice, "tenant_acme", 200)
		if !slices.Equal(got, want) {
			t.Fatalf("running rooms = %v, want %v", got, want)
		}
	}
	assertFailed := func(want ...string) {
		t.Helper()
		_, got := request(alice, "tenant_acme", 200)
		if !slices.Equal(got, want) {
			t.Fatalf("failed rooms = %v, want %v", got, want)
		}
	}
	request(http.DefaultClient, "tenant_acme", 401)
	request(alice, "tenant-does-not-exist", 404)
	assertRooms() // A queued Run does not light the Room until a Computer claims it.
	assertFailed()
	if _, err := env.pool.Exec(t.Context(), `UPDATE agent_local_runs SET status='running',started_at=clock_timestamp() WHERE run_id IN ('activity-visible','activity-hidden')`); err != nil {
		t.Fatal(err)
	}
	assertRooms(roomID) // Running work lights the Room; another member's private Room must not leak.
	assertRooms(roomID) // A fresh read reconstructs the same persisted snapshot.
	// Multiple Agents in one Room still produce one ID; one finishing must not clear the other.
	insertRuntimeRegistrationFixture(t, env.pool, "activity-second-agent", "active")
	if code, body := putRoomMember(t, env, alice, roomID, "actor-activity-second-agent", "member"); code != 200 {
		t.Fatalf("second Agent %d %s", code, body)
	}
	second, err := runtime.EnsureContext(t.Context(), agentruntimestate.EnsureContextInput{Ref: agentruntimestate.ContextRef{Kind: "meta", AgentID: "activity-second-agent", RoomID: roomID}, TargetResidency: "active"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := env.pool.Exec(t.Context(), `INSERT INTO agent_local_runs(run_id,context_key,status,started_at) VALUES('activity-second',$1,'running',clock_timestamp())`, second.Context.ContextKey); err != nil {
		t.Fatal(err)
	}
	assertRooms(roomID)
	if _, err := env.pool.Exec(t.Context(), `UPDATE agent_local_runs SET status='succeeded',terminal='{"type":"succeeded"}',finished_at=clock_timestamp() WHERE run_id='activity-second'`); err != nil {
		t.Fatal(err)
	}
	assertRooms(roomID)
	if _, err := env.pool.Exec(t.Context(), `UPDATE agent_local_runs SET status='succeeded',terminal='{"type":"succeeded"}',finished_at=clock_timestamp() WHERE run_id='activity-visible'`); err != nil {
		t.Fatal(err)
	}
	assertRooms()
	assertFailed()
	if _, err := env.pool.Exec(t.Context(), `UPDATE agent_local_runs SET status='failed',terminal='{"type":"failed"}',finished_at=clock_timestamp() WHERE run_id='activity-second'`); err != nil {
		t.Fatal(err)
	}
	assertRooms()
	assertFailed(roomID)
	if _, err := env.pool.Exec(t.Context(), `UPDATE agent_local_runs SET status='canceled',terminal='{"type":"canceled"}',finished_at=clock_timestamp() WHERE run_id='activity-second'`); err != nil {
		t.Fatal(err)
	}
	assertRooms()
	assertFailed()
	// A new run can become active after a terminal one without reviving history.
	if _, err := env.pool.Exec(t.Context(), `INSERT INTO agent_local_runs(run_id,context_key,status,started_at) VALUES('activity-next',$1,'running',clock_timestamp())`, contextKey); err != nil {
		t.Fatal(err)
	}
	assertRooms(roomID)
	if _, err := env.pool.Exec(t.Context(), `DELETE FROM room_members WHERE room_id=$1 AND actor_id='actor_acme_alice'`, roomID); err != nil {
		t.Fatal(err)
	}
	assertRooms()
	direct := requestDirectRoom(alice, env.server.URL, "actor_acme_official")
	if direct.err != nil || (direct.status != 200 && direct.status != 201) {
		t.Fatalf("Direct Room %d %s %v", direct.status, direct.body, direct.err)
	}
	directContext, err := runtime.EnsureContext(t.Context(), agentruntimestate.EnsureContextInput{Ref: agentruntimestate.ContextRef{Kind: "meta", AgentID: acmeOfficialAgentManagementID, RoomID: direct.roomID}, TargetResidency: "active"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := env.pool.Exec(t.Context(), `INSERT INTO agent_local_runs(run_id,context_key,status,started_at) VALUES('activity-direct',$1,'running',clock_timestamp())`, directContext.Context.ContextKey); err != nil {
		t.Fatal(err)
	}
	assertRooms(direct.roomID)
	if _, err := env.pool.Exec(t.Context(), `DELETE FROM room_members WHERE room_id=$1 AND actor_id='actor_acme_official'`, direct.roomID); err != nil {
		t.Fatal(err)
	}
	assertRooms()
	deletedRoom, _ := createRun(alice, "activity-deleted", acmeOfficialAgentManagementID, "actor_acme_official")
	if _, err := env.pool.Exec(t.Context(), `UPDATE agent_local_runs SET status='running',started_at=clock_timestamp() WHERE run_id='activity-deleted'`); err != nil {
		t.Fatal(err)
	}
	assertRooms(deletedRoom)
	if code, _, body := env.request(alice, http.MethodDelete, "/v0/rooms/"+deletedRoom, nil, "activity-delete-group"); code != http.StatusNoContent {
		t.Fatalf("delete Room %d %s", code, body)
	}
	assertRooms()
}
