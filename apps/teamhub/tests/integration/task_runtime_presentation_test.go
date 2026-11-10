package integration_test

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentruntimestate"
)

func TestTaskRuntimePresentationHistoryAndPrivacy(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newAgentRunEnv(t, "http://unused-agent.invalid")
	const taskID, roomID = "task_activity_history", "room_task_activity_history"
	insertRuntimeRoomMembership(t, env.pool, roomID)
	seedTaskActivityParticipant(t, env, taskID, roomID)
	service := agentruntimestate.New(env.pool)
	ensured, err := service.EnsureContext(t.Context(), agentruntimestate.EnsureContextInput{Ref: agentruntimestate.ContextRef{Kind: "alter_ego", AgentID: testRuntimeAgentID, TaskID: taskID}, TargetResidency: "active"})
	if err != nil {
		t.Fatal(err)
	}
	startRuntimeEpoch(t, service, "task-activity-instance")
	fence := "task-activity-instance"
	source := "meta:actor_acme_official:" + taskID
	type runStatus struct {
		RunID  string `json:"run_id"`
		Status string `json:"status"`
	}
	type page struct {
		Active  []runStatus `json:"active_items"`
		History []runStatus `json:"history_items"`
		Cursor  string      `json:"next_cursor"`
		RoomID  string      `json:"work_room_id"`
	}
	get := func(client *http.Client, path string, status int) []byte {
		t.Helper()
		response, err := client.Get(env.server.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		body, err := io.ReadAll(response.Body)
		if err != nil || response.StatusCode != status {
			t.Fatalf("GET %s: %d %s %v", path, response.StatusCode, body, err)
		}
		return body
	}
	path := "/v0/tasks/" + taskID + "/runtime-presentation-runs"
	readPage := func(suffix string) page {
		t.Helper()
		body := get(alice, path+suffix, 200)
		var result page
		if err := json.Unmarshal(body, &result); err != nil {
			t.Fatal(err)
		}
		if result.Active == nil || result.History == nil || result.RoomID != roomID {
			t.Fatalf("invalid activity page %s", body)
		}
		return result
	}
	submit := func(id string) string {
		t.Helper()
		result, err := service.SubmitTrustedTurn(t.Context(), agentruntimestate.SubmitTrustedTurnInput{ContextKey: ensured.Context.ContextKey, Epoch: fence,
			Inputs: []agentruntimestate.RuntimeInput{runtimeInput(id, "trusted_turn", source, "private Task input")},
		})
		if err != nil {
			t.Fatal(err)
		}
		return result.RunID
	}
	first := submit("first")
	initial := readPage("")
	if len(initial.Active) != 1 || initial.Active[0].RunID != first || len(initial.History) != 1 {
		t.Fatalf("queued Run not shown: %+v", initial)
	}
	run, err := service.ClaimLocalRun(t.Context(), agentruntimestate.ClaimLocalRunInput{ClaimID: "claim-first", ContextKey: ensured.Context.ContextKey, Epoch: fence})
	if err != nil || run.Run == nil {
		t.Fatalf("claim: %+v %v", run, err)
	}
	offer := func(id, payload string) (agentruntimestate.OfferPresentationEventResult, error) {
		return service.OfferRuntimePresentationEvents(t.Context(), agentruntimestate.OfferPresentationEventsInput{LocalRunID: first, Events: []agentruntimestate.OfferedPresentationEvent{{CommandID: id, Event: json.RawMessage(payload)}}})
	}
	start := `{"type":"activity.started","activity_id":"tool-1","kind":"command","title":"Checking workspace","content":[{"format":"code","content":"private command"}]}`
	firstEvent, err := offer("start-tool", start)
	if err != nil {
		t.Fatal(err)
	}
	replay, err := offer("start-tool", start)
	if err != nil || replay.EventOrdinal != firstEvent.EventOrdinal {
		t.Fatalf("replay: %+v %v", replay, err)
	}
	// A replay is compared with the stored event: a field the filter drops does
	// not count, a stored field does.
	filtered, err := offer("start-tool", strings.ReplaceAll(start, "private command", "changed private command"))
	if err != nil || filtered.EventOrdinal != firstEvent.EventOrdinal {
		t.Fatalf("replay with a changed filtered field: %+v %v", filtered, err)
	}
	if _, err := offer("start-tool", strings.ReplaceAll(start, "Checking workspace", "Checking files")); !errors.Is(err, agentruntimestate.ErrIdempotencyConflict) {
		t.Fatalf("stored field must conflict: %v", err)
	}
	if _, err := offer("update-tool", `{"type":"activity.updated","activity_id":"tool-1","detail":"private detail"}`); err != nil {
		t.Fatal(err)
	}
	active := readPage("")
	if len(active.Active) != 1 || len(active.History) != 1 {
		t.Fatalf("active Task: %+v", active)
	}
	runID := active.Active[0].RunID
	eventsPath := "/v0/rooms/" + roomID + "/runs/" + runID + "/runtime-presentation-events"
	body := get(alice, eventsPath, 200)
	if strings.Contains(string(body), "private") || !strings.Contains(string(body), "Working") || !strings.Contains(string(body), "Checking workspace") {
		t.Fatalf("public Task events: %s", body)
	}
	native := get(alice, "/v0/rooms/"+roomID+"/runs/"+runID+"/activities", 200)
	if !strings.Contains(string(native), `"status":"unavailable"`) {
		t.Fatalf("native history leaked %s", native)
	}
	get(http.DefaultClient, path, 401)
	// Finish with no tool completion and no Message. The Run still owns history.
	if _, err := service.FinishLocalRun(t.Context(), agentruntimestate.FinishLocalRunInput{ContextKey: ensured.Context.ContextKey, Epoch: fence, RunID: first, Terminal: json.RawMessage(`{"type":"succeeded"}`)}); err != nil {
		t.Fatal(err)
	}
	finished := readPage("")
	if len(finished.Active) != 0 || len(finished.History) != 1 || finished.History[0].Status == "active" {
		t.Fatalf("finished history: %+v", finished)
	}
	if body = get(alice, eventsPath, 200); strings.Contains(string(body), "unconfirmed_input_ids") {
		t.Fatalf("private input IDs leaked: %s", body)
	}
	second := submit("second")
	if second == first {
		t.Fatal("new Run was not created")
	}
	newest := readPage("?limit=1")
	if len(newest.Active) != 1 || len(newest.History) != 1 || newest.Cursor == "" {
		t.Fatalf("first history page: %+v", newest)
	}
	older := readPage("?limit=1&cursor=" + url.QueryEscape(newest.Cursor))
	if len(older.Active) != 1 || len(older.History) != 1 || older.History[0].RunID != runID || older.Cursor != "" {
		t.Fatalf("older history keeps active: %+v", older)
	}
	get(alice, path+"?cursor=invalid", 400)
	// A fresh HTTP request after Room revocation must reject persisted activity.
	if _, err := env.pool.Exec(t.Context(), `DELETE FROM room_members WHERE room_id=$1 AND actor_id='actor_acme_alice'`, roomID); err != nil {
		t.Fatal(err)
	}
	get(alice, path, 404)
}

// seedTaskActivityParticipant seeds a running Task in roomID. A coordinator
// Context, when given, coordinates the generation as the official Agent.
func seedTaskActivityParticipant(t *testing.T, env *testEnv, taskID, roomID string, coordinatorContextKey ...string) {
	t.Helper()
	var coordinatorActorID, coordinatorKey any
	if len(coordinatorContextKey) == 1 {
		coordinatorActorID, coordinatorKey = "actor_acme_official", coordinatorContextKey[0]
	}
	tx, err := env.pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(t.Context())
	queries := []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO work_items(id,tenant_id,number,kind,title,created_by_actor_id,updated_by_actor_id,state,task_execution_generation,task_execution_status,task_execution_revision,task_desired_control,task_control_revision,task_control_settled_revision,task_execution_updated_at,task_next_reconcile_at,task_lease_generation) VALUES($1,'tenant_acme',9876,'task','Task activity','actor_acme_alice','actor_acme_alice','in_progress',1,'idle',1,'run',0,0,clock_timestamp(),clock_timestamp(),0)`, []any{taskID}},
		{`INSERT INTO task_execution_generations(task_id,tenant_id,generation,result_agent_actor_id,spec,spec_hash,coordinator_actor_id,coordinator_context_key) VALUES($1,'tenant_acme',1,'actor_acme_official','{}'::jsonb,decode(repeat('00',32),'hex'),$2,$3)`, []any{taskID, coordinatorActorID, coordinatorKey}},
		{`INSERT INTO task_execution_participants(task_id,tenant_id,generation,actor_id,agent_management_id,execution_context_ref) VALUES($1,'tenant_acme',1,'actor_acme_official',$2,jsonb_build_object('kind','alter_ego','agentId',$2::text,'taskId',$1::text))`, []any{taskID, testRuntimeAgentID}},
		{`INSERT INTO task_meta_inboxes(task_id,tenant_id,agent_actor_id) VALUES($1,'tenant_acme','actor_acme_official')`, []any{taskID}},
		{`INSERT INTO work_item_room_links(work_item_id,tenant_id,link_type,room_id,linked_by_actor_id) VALUES($1,'tenant_acme','work',$2,'actor_acme_alice')`, []any{taskID, roomID}},
	}
	for i, query := range queries {
		if _, err := tx.Exec(t.Context(), query.sql, query.args...); err != nil {
			t.Fatal(fmt.Errorf("seed Task step %d: %w", i, err))
		}
	}
	if err := tx.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
}
