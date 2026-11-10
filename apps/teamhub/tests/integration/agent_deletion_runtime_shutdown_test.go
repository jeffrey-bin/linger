package integration_test

import (
	"net/http"
	"strconv"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentruntimestate"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

type runtimeShutdownAgent struct {
	managementID string
	actorID      string
}

func runtimeShutdownCreateAgent(t *testing.T, env *testEnv, sponsor *http.Client, name, key string) runtimeShutdownAgent {
	t.Helper()
	status, _, body := env.request(sponsor, http.MethodPost, "/v0/tenants/"+acmeTenant+"/agents", map[string]any{
		"name": name, "instructions": "Work in Rooms.", "runtime": fixtureRuntime("gpt-5"),
	}, key)
	if status != http.StatusCreated {
		t.Fatalf("create Agent %s status=%d body=%s", name, status, body)
	}
	var agent struct {
		AgentManagementID string `json:"agent_management_id"`
		Actor             struct {
			ID string `json:"id"`
		} `json:"actor"`
	}
	decode(t, body, &agent)
	return runtimeShutdownAgent{managementID: agent.AgentManagementID, actorID: agent.Actor.ID}
}

// runtimeShutdownContextRows returns every persisted Context row of one Agent,
// including updated_at, so an untouched row compares equal across requests.
func runtimeShutdownContextRows(t *testing.T, pool *pgxpool.Pool, agentManagementID string) string {
	t.Helper()
	var rows string
	if err := pool.QueryRow(t.Context(), `SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY context_key),'[]')::text FROM agent_execution_contexts c WHERE agent_management_id=$1`, agentManagementID).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	return rows
}

type runtimeShutdownContextRow struct {
	TerminalReason  string
	TerminatedAtSet bool
	TargetResidency string
	StateRevision   int64
}

func readRuntimeShutdownRow(t *testing.T, env *testEnv, key string) runtimeShutdownContextRow {
	t.Helper()
	var row runtimeShutdownContextRow
	if err := env.pool.QueryRow(t.Context(), `
		SELECT coalesce(terminal_reason,''), terminated_at IS NOT NULL, target_residency, state_revision
		FROM agent_execution_contexts WHERE context_key=$1`, key).Scan(
		&row.TerminalReason, &row.TerminatedAtSet, &row.TargetResidency, &row.StateRevision); err != nil {
		t.Fatal(err)
	}
	return row
}

func TestAgentDeletionTerminatesRuntimeContextsAndKeepsHistory(t *testing.T) {
	allowParallelIntegrationTest(t)
	management := &recordingAgentManagement{}
	env, alice := newAgentRegistrationEnv(t, management)
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	deleted := runtimeShutdownCreateAgent(t, env, alice, "Runtime shutdown "+suffix, "runtime-shutdown-deleted-"+suffix)
	kept := runtimeShutdownCreateAgent(t, env, alice, "Runtime survivor "+suffix, "runtime-shutdown-kept-"+suffix)

	roomA := createPrivateRoom(t, env, alice, "Runtime shutdown A "+suffix, "runtime-shutdown-a-"+suffix)
	roomB := createPrivateRoom(t, env, alice, "Runtime shutdown B "+suffix, "runtime-shutdown-b-"+suffix)
	roomC := createPrivateRoom(t, env, alice, "Runtime shutdown C "+suffix, "runtime-shutdown-c-"+suffix)
	for _, roomID := range []string{roomA, roomB, roomC} {
		for _, agent := range []runtimeShutdownAgent{deleted, kept} {
			if status, body := putRoomMember(t, env, alice, roomID, agent.actorID, "member"); status != http.StatusOK {
				t.Fatalf("add Agent status=%d body=%s", status, body)
			}
		}
	}

	service := agentruntimestate.New(env.pool)
	ensure := func(agent runtimeShutdownAgent, roomID string) string {
		t.Helper()
		result, err := service.EnsureContext(t.Context(), agentruntimestate.EnsureContextInput{TargetResidency: "active",
			Ref: agentruntimestate.ContextRef{Kind: "meta", AgentID: agent.managementID, RoomID: roomID},
		})
		if err != nil {
			t.Fatalf("ensure Context: %v", err)
		}
		return result.Context.ContextKey
	}
	openA := ensure(deleted, roomA)
	openC := ensure(deleted, roomC)
	terminalB := ensure(deleted, roomB)
	keptContext := ensure(kept, roomA)
	if _, err := env.pool.Exec(t.Context(), `
		UPDATE agent_execution_contexts
		SET target_residency='suspended', terminal_reason='room_deleted', terminated_at=clock_timestamp(), state_revision=state_revision+1
		WHERE context_key=$1`, terminalB); err != nil {
		t.Fatal(err)
	}

	startRuntimeEpoch(t, service, "runtime-shutdown-"+suffix)

	// Queued Local Run showing its status with an event on openC;
	// a succeeded Run with a status event on openC keeps Runtime history.
	queuedRun := "run-shutdown-queued-" + suffix
	historyRun := "run-shutdown-history-" + suffix
	// Removing the Agent from roomC directly keeps openC open without a Room
	// membership revocation, so the queued Run is canceled by context deletion.
	if _, err := env.pool.Exec(t.Context(), `DELETE FROM room_members WHERE room_id=$1 AND actor_id=$2`, roomC, deleted.actorID); err != nil {
		t.Fatalf("detach Agent from roomC for context-only deletion: %v", err)
	}
	seed := []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO agent_local_runs(run_id,context_key,status) VALUES($1,$2,'queued')`, []any{queuedRun, openC}},
		{`INSERT INTO agent_local_runs(run_id,context_key,status,terminal,finished_at)
			VALUES($1,$2,'succeeded','{"type":"succeeded"}'::jsonb,clock_timestamp())`, []any{historyRun, openA}},
		{`UPDATE agent_local_runs SET status_room_id=$2 WHERE run_id=$1`, []any{queuedRun, roomC}},
		{`UPDATE agent_local_runs SET status_room_id=$2 WHERE run_id=$1`, []any{historyRun, roomA}},
		{`INSERT INTO agent_runtime_status_events(local_run_id,event_ordinal,segment_id,command_id,event_type,payload)
			VALUES($1,1,$2,$3,'status.changed','{"type":"status.changed","status":"working"}'::jsonb)`, []any{queuedRun, "segment-shutdown-queued-" + suffix, "event-shutdown-queued-" + suffix}},
		{`INSERT INTO agent_runtime_status_events(local_run_id,event_ordinal,segment_id,command_id,event_type,payload)
			VALUES($1,1,$2,$3,'status.changed','{"type":"status.changed","status":"done"}'::jsonb)`, []any{historyRun, "segment-shutdown-history-" + suffix, "event-shutdown-history-" + suffix}},
	}
	for _, step := range seed {
		if _, err := env.pool.Exec(t.Context(), step.sql, step.args...); err != nil {
			t.Fatalf("seed Local Run or status history: %v", err)
		}
	}

	seedAgentMessage(t, env, roomA, deleted.actorID, "Keep this reply after shutdown.")

	statusEvents := func() int {
		return countRows(t, env, "select count(*) from agent_runtime_status_events where local_run_id in ($1,$2)", queuedRun, historyRun)
	}
	messagesBefore := countRows(t, env, "select count(*) from messages where author_actor_id=$1", deleted.actorID)
	eventsBefore := statusEvents()
	keptBefore := runtimeShutdownContextRows(t, env.pool, kept.managementID)
	terminalBefore := runtimeShutdownContextRows(t, env.pool, deleted.managementID)
	if eventsBefore != 2 || messagesBefore == 0 {
		t.Fatalf("fixture history events=%d messages=%d", eventsBefore, messagesBefore)
	}

	var terminatedAtBefore string
	if err := env.pool.QueryRow(t.Context(), `SELECT terminated_at::text FROM agent_execution_contexts WHERE context_key=$1`, terminalB).Scan(&terminatedAtBefore); err != nil {
		t.Fatal(err)
	}
	status, _, body := env.request(alice, http.MethodDelete, "/v0/tenants/"+acmeTenant+"/agents/"+deleted.actorID, nil, "")
	if status != http.StatusNoContent || len(body) != 0 {
		t.Fatalf("delete Agent status=%d body=%s", status, body)
	}

	for _, key := range []string{openA, openC} {
		row := readRuntimeShutdownRow(t, env, key)
		if row.TerminalReason != "context_deleted" || !row.TerminatedAtSet || row.TargetResidency != "suspended" || row.StateRevision < 2 {
			t.Fatalf("terminated Context %s = %+v", key, row)
		}
	}
	var terminatedAtAfter string
	if err := env.pool.QueryRow(t.Context(), `SELECT terminated_at::text FROM agent_execution_contexts WHERE context_key=$1`, terminalB).Scan(&terminatedAtAfter); err != nil {
		t.Fatal(err)
	}
	if row := readRuntimeShutdownRow(t, env, terminalB); row.TerminalReason != "room_deleted" || terminatedAtAfter != terminatedAtBefore {
		t.Fatalf("pre-terminal Context changed: row=%+v terminated_at before=%s after=%s", row, terminatedAtBefore, terminatedAtAfter)
	}
	if got := countRows(t, env, "select count(*) from agent_local_runs where run_id=$1 and status='canceled' and terminal->>'reason'='context_deleted'", queuedRun); got != 1 {
		t.Fatal("queued Local Run was not canceled by context deletion")
	}
	if got := countRows(t, env, `select count(*) from agent_runtime_status_events where local_run_id=$1 and event_type='status.changed' and payload->>'status'='stopped' and payload->>'outcome'='canceled'`, queuedRun); got != 1 {
		t.Fatalf("queued Run stopped event was not recorded")
	}

	listed := func(agentID string) map[string]bool {
		t.Helper()
		contexts, err := service.ListContexts(t.Context(), agentID)
		if err != nil {
			t.Fatal(err)
		}
		keys := map[string]bool{}
		for _, value := range contexts {
			keys[value.ContextKey] = true
		}
		return keys
	}
	keys := listed("")
	for _, key := range []string{openA, openC, terminalB} {
		if keys[key] {
			t.Fatalf("runtime list still exposes deleted Agent Context %s", key)
		}
	}
	// Agent Service lists a revoked Agent's terminated Contexts to stop them.
	if keys := listed(deleted.managementID); !keys[openA] || !keys[openC] {
		t.Fatalf("revoked Agent Contexts are not listed for shutdown: %v", keys)
	}
	if !listed("")[keptContext] || !listed(kept.managementID)[keptContext] {
		t.Fatal("runtime list dropped a surviving Agent Context")
	}

	queries := store.New(env.pool)
	history, err := queries.ListAgentExecutionContextsByManagementID(t.Context(), deleted.managementID)
	if err != nil {
		t.Fatal(err)
	}
	if len(history) != 3 {
		t.Fatalf("deletion history Contexts=%d want 3", len(history))
	}

	if got := countRows(t, env, "select count(*) from messages where author_actor_id=$1", deleted.actorID); got != messagesBefore {
		t.Fatalf("messages after shutdown=%d before=%d", got, messagesBefore)
	}
	// Only the canceled queued Run gains its stopped event; history stays.
	if got := statusEvents(); got != eventsBefore+1 {
		t.Fatalf("status events after shutdown=%d before=%d", got, eventsBefore)
	}
	if got := countRows(t, env, "select count(*) from agent_runtime_status_events where local_run_id=$1 and command_id='stopped:'||local_run_id and payload->>'outcome'='canceled'", queuedRun); got != 1 {
		t.Fatal("canceled queued Run has no stopped status event")
	}
	if runtimeShutdownContextRows(t, env.pool, kept.managementID) != keptBefore {
		t.Fatal("surviving Agent Context rows changed")
	}

	// Replaying the delete and re-running the revocation step must not touch rows.
	terminatedOnce := runtimeShutdownContextRows(t, env.pool, deleted.managementID)
	if terminatedOnce == terminalBefore {
		t.Fatal("deletion did not change deleted Agent Context rows")
	}
	status, _, body = env.request(alice, http.MethodDelete, "/v0/tenants/"+acmeTenant+"/agents/"+deleted.actorID, nil, "")
	if status != http.StatusNoContent || len(management.notifiedSnapshot()) != 1 {
		t.Fatalf("delete replay status=%d body=%s upstream=%v", status, body, management.notifiedSnapshot())
	}
	tx, err := env.pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(t.Context())
	if err := agentruntimestate.LockContextsForAgentRevocation(t.Context(), store.New(tx), "tenant_acme", deleted.actorID, nil); err != nil {
		t.Fatalf("repeat revocation lock: %v", err)
	}
	if err := agentruntimestate.TerminateContextsForAgentRevocation(t.Context(), store.New(tx), "tenant_acme", deleted.actorID); err != nil {
		t.Fatalf("repeat revocation termination: %v", err)
	}
	if err := tx.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
	if got := runtimeShutdownContextRows(t, env.pool, deleted.managementID); got != terminatedOnce {
		t.Fatal("repeated revocation changed Context rows")
	}
}
