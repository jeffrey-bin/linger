package integration_test

import (
	"net/http"
	"strings"
	"testing"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentruntimestate"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/taskexecution"
	teamhubinternal "github.com/simplexai-labs/linger/contracts-go/teamhubinternal"
)

func readTaskProgress(t *testing.T, env *testEnv, roomID string) (int, teamhubinternal.TaskProgressSnapshot, []byte) {
	t.Helper()
	status, body := agentRuntimeStateRequest(t, env.server.Config.Handler, http.MethodGet,
		"/v0/rooms/"+roomID+"/agents/"+acmeOfficialAgentManagementID+"/task-progress", teamHubInternalToken, nil)
	var snapshot teamhubinternal.TaskProgressSnapshot
	if status == http.StatusOK {
		decode(t, body, &snapshot)
	}
	return status, snapshot, body
}

func TestTaskProgressReadsTheTasksAMetaCoordinates(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice, issued, roomID := newAgentCLIIdentity(t)
	withoutAgentRoomID := createPrivateRoom(t, env, alice, "Without the Agent", "task-progress-without-agent")
	if status, _, body := readTaskProgress(t, env, withoutAgentRoomID); status != http.StatusNotFound || !strings.Contains(string(body), "META_CONTEXT_NOT_FOUND") {
		t.Fatalf("without a Meta Context=%d %s", status, body)
	}
	if status, snapshot, body := readTaskProgress(t, env, roomID); status != http.StatusOK || snapshot.LiveForeground ||
		len(snapshot.Tasks) != 0 || snapshot.AgentLastSpokeAt != nil {
		t.Fatalf("nothing at work=%d %s", status, body)
	}

	created := createDelegatedTask(t, env, issued, "task-progress-report", "Competitor report", "Compare the pricing pages.", roomID)
	// A Task another Room's Meta coordinates is not this Meta's.
	otherRoomID := createPrivateRoom(t, env, alice, "Other origin", "task-progress-other-room")
	if code, body := putRoomMember(t, env, alice, otherRoomID, "actor_acme_official", "member"); code != http.StatusOK {
		t.Fatalf("add Agent: %d %s", code, body)
	}
	createDelegatedTask(t, env, issued, "task-progress-other", "Other Room work", "Not this Meta's.", otherRoomID)
	status, snapshot, body := readTaskProgress(t, env, roomID)
	if status != http.StatusOK || len(snapshot.Tasks) != 1 {
		t.Fatalf("coordinated Tasks=%d %s", status, body)
	}
	if task := snapshot.Tasks[0]; task.TaskId != created.TaskID || task.Title != "Competitor report" ||
		task.Status != teamhubinternal.TaskProgressRunning || task.PendingApprovals != 0 || task.LastReportAt != nil || task.LatestStep != nil {
		t.Fatalf("new Task=%s", body)
	}

	// The newest step of the Task's latest Run is its latest step.
	alterEgo, err := agentruntimestate.New(env.pool).EnsureContext(t.Context(), agentruntimestate.EnsureContextInput{
		TargetResidency: "active",
		Ref:             agentruntimestate.ContextRef{Kind: "alter_ego", AgentID: acmeOfficialAgentManagementID, TaskID: created.TaskID},
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, statement := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO agent_local_runs(run_id,context_key,status,started_at)
			VALUES('run-task-progress',$1,'running',clock_timestamp())`, []any{alterEgo.Context.ContextKey}},
		{`INSERT INTO agent_runtime_status_events(local_run_id,event_ordinal,segment_id,command_id,event_type,payload)
			VALUES('run-task-progress',1,'segment-task-progress','task-progress-1','status.changed','{"type":"status.changed","status":"thinking","title":"Read the brief"}'),
			      ('run-task-progress',2,'segment-task-progress','task-progress-2','status.changed','{"type":"status.changed","status":"working","title":"Search pricing"}')`, nil},
	} {
		if _, err := env.pool.Exec(t.Context(), statement.sql, statement.args...); err != nil {
			t.Fatal(err)
		}
	}
	seedAgentMessage(t, env, otherRoomID, "actor_acme_official", "Elsewhere")
	if _, snapshot, body := readTaskProgress(t, env, roomID); len(snapshot.Tasks) != 1 || snapshot.Tasks[0].LatestStep == nil ||
		snapshot.Tasks[0].LatestStep.Title != "Search pricing" || snapshot.AgentLastSpokeAt != nil {
		t.Fatalf("latest step=%s", body)
	}
	seedAgentMessage(t, env, roomID, "actor_acme_official", "On it")
	if _, snapshot, body := readTaskProgress(t, env, roomID); snapshot.AgentLastSpokeAt == nil {
		t.Fatalf("Agent spoke=%s", body)
	}

	// A Live call holding the Meta's foreground is all there is to read.
	if _, err := env.pool.Exec(t.Context(), `UPDATE agent_registrations SET agent_type='anotherme',receives_all_messages=true,represented_human_actor_id='actor_acme_alice' WHERE actor_id='actor_acme_official'`); err != nil {
		t.Fatal(err)
	}
	if _, err := env.pool.Exec(t.Context(), `INSERT INTO voice_sessions(id,tenant_id,room_id,created_by_actor_id,status,provider_room_name,participant_identity,purpose)
		VALUES('voice-task-progress','tenant_acme',$1,'actor_acme_alice','provisioning','task-progress-live','alice-task-progress','chat_live')`, roomID); err != nil {
		t.Fatal(err)
	}
	if status, snapshot, body := readTaskProgress(t, env, roomID); status != http.StatusOK || !snapshot.LiveForeground || len(snapshot.Tasks) != 0 {
		t.Fatalf("during Live=%d %s", status, body)
	}
	if _, err := env.pool.Exec(t.Context(), `UPDATE voice_sessions SET live_lease_until=clock_timestamp()-interval '1 second' WHERE id='voice-task-progress'`); err != nil {
		t.Fatal(err)
	}
	if _, snapshot, body := readTaskProgress(t, env, roomID); snapshot.LiveForeground || len(snapshot.Tasks) != 1 {
		t.Fatalf("after Live=%s", body)
	}

	// A Task that stopped is no longer at work.
	tx, err := env.pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(t.Context())
	if _, err := taskexecution.StopTask(t.Context(), store.New(tx), created.TaskID, "actor_acme_alice"); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
	if _, snapshot, body := readTaskProgress(t, env, roomID); len(snapshot.Tasks) != 0 {
		t.Fatalf("stopped Task=%s", body)
	}
}
