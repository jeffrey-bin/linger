package integration_test

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentauth"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentcredential"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/taskdelegation"
)

// delegatedTaskWorker drives a delegated Task through the real Task Worker
// HTTP protocol, standing in for the Agent Service's Task Worker.
type delegatedTaskWorker struct {
	t      *testing.T
	env    *testEnv
	taskID string
	bundle taskWorkerHTTPBundle
}

func claimDelegatedTask(t *testing.T, env *testEnv, taskID, workerID string) *delegatedTaskWorker {
	t.Helper()
	bundle := claimTaskWorker(t, env, workerID)
	if bundle.Execution.TaskID != taskID || bundle.Lease == nil {
		t.Fatalf("claimed bundle=%+v want Task %s", bundle, taskID)
	}
	return &delegatedTaskWorker{t: t, env: env, taskID: taskID, bundle: bundle}
}

func (w *delegatedTaskWorker) transition(name string, payload map[string]any) {
	w.t.Helper()
	w.bundle = transitionTaskWorker(w.t, w.env, w.bundle, w.bundle.Lease.WorkerID, w.bundle.Lease.LeaseToken,
		w.bundle.Lease.LeaseGeneration, name, payload)
}

// startTurn dispatches the pending turn and records its Local Run.
func (w *delegatedTaskWorker) startTurn(runRef string) string {
	w.t.Helper()
	effect := taskEffectByOperation(w.t, w.bundle, "submit_agent_turn", "pending")
	w.transition("begin_effect_dispatch", map[string]any{"effect_id": effect.ID})
	w.transition("record_agent_turn", map[string]any{
		"effect_id": effect.ID,
		"participant_runs": []map[string]any{{
			"actor_id": "actor_acme_official", "agent_management_id": acmeOfficialAgentManagementID,
			"agent_run_ref": runRef,
		}},
	})
	return effect.ID
}

func (w *delegatedTaskWorker) endTurn(effectID, runRef, status, message string) {
	w.t.Helper()
	terminal := map[string]any{"agent_run_ref": runRef, "status": status}
	if message != "" {
		terminal["terminal_message"] = message
	}
	w.transition("record_agent_terminal", map[string]any{
		"effect_id": effectID, "participant_terminals": []map[string]any{terminal},
	})
}

func (w *delegatedTaskWorker) advance() {
	w.t.Helper()
	w.transition("advance", map[string]any{})
}

// insertAlterEgoLocalRun persists the Run whose final reply reports the Task,
// as the Agent Service does when the Run finishes.
func insertAlterEgoLocalRun(t *testing.T, env *testEnv, taskID, runRef, finalResponse string) string {
	t.Helper()
	contextKey := alterEgoContextKey(taskID)
	if _, err := env.pool.Exec(t.Context(), `
		INSERT INTO agent_execution_contexts(context_key,context_kind,agent_management_id,agent_actor_id,tenant_id,task_id,target_residency)
		VALUES($1,'alter_ego',$2,'actor_acme_official',$3,$4,'active') ON CONFLICT (context_key) DO NOTHING`,
		contextKey, acmeOfficialAgentManagementID, acmeTenant, taskID); err != nil {
		t.Fatalf("insert AlterEgo Context: %v", err)
	}
	terminal, _ := json.Marshal(map[string]any{"type": "succeeded", "finalResponse": finalResponse})
	if _, err := env.pool.Exec(t.Context(), `
		INSERT INTO agent_local_runs(run_id,context_key,status,terminal,started_at,finished_at)
		VALUES($1,$2,'succeeded',$3,clock_timestamp(),clock_timestamp())`, runRef, contextKey, terminal); err != nil {
		t.Fatalf("insert AlterEgo Local Run: %v", err)
	}
	return contextKey
}

func alterEgoContextKey(taskID string) string {
	key, _ := json.Marshal([]string{"alter_ego", acmeOfficialAgentManagementID, taskID})
	return string(key)
}

func taskReports(t *testing.T, env *testEnv, taskID string) []string {
	t.Helper()
	rows, err := env.pool.Query(t.Context(), `SELECT body FROM task_meta_callback_messages
		WHERE task_id=$1 AND author_actor_id='actor_acme_official' AND NOT non_actionable ORDER BY meta_seq`, taskID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var bodies []string
	for rows.Next() {
		var body string
		if err := rows.Scan(&body); err != nil {
			t.Fatal(err)
		}
		bodies = append(bodies, body)
	}
	return bodies
}

func assertDelegatedTaskState(t *testing.T, env *testEnv, taskID, status, reason string) {
	t.Helper()
	if got := countRows(t, env, `SELECT count(*) FROM work_items item
		JOIN task_execution_generations generation ON generation.task_id=item.id AND generation.generation=item.task_execution_generation
		WHERE item.id=$1 AND item.task_execution_status=$2 AND COALESCE(item.task_execution_reason_code,'')=$3
		  AND item.state='in_progress' AND item.resolution IS NULL AND generation.terminal_at IS NULL`,
		taskID, status, reason); got != 1 {
		var gotStatus, gotReason string
		_ = env.pool.QueryRow(t.Context(), `SELECT task_execution_status,COALESCE(task_execution_reason_code,'') FROM work_items WHERE id=$1`, taskID).Scan(&gotStatus, &gotReason)
		t.Fatalf("Task state=%s/%s want %s/%s", gotStatus, gotReason, status, reason)
	}
}

func postTaskCommand(t *testing.T, env *testEnv, issued agentcredential.Issued, command string, body map[string]any, headers ...http.Header) (int, []byte) {
	t.Helper()
	code, _, response := taskWorkerJSONRequest(t, env, http.MethodPost, "/api/agent/v1/tasks/"+command, issued.AccessToken, body, headers...)
	return code, response
}

func sendDelegatedTask(t *testing.T, env *testEnv, issued agentcredential.Issued, roomID, invocation, taskID, message string, steer bool) map[string]any {
	t.Helper()
	code, body := postTaskCommand(t, env, issued, "send", map[string]any{
		"invocation_id": mcpCreationInvocationID(invocation), "task_id": taskID, "message": message, "steer": steer,
	}, taskDelegationRoomContext(roomID))
	var result map[string]any
	if code != http.StatusOK || json.Unmarshal(body, &result) != nil {
		t.Fatalf("task send=%d %s", code, body)
	}
	return result
}

func TestDelegatedTaskTurnOutcomesAndReports(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice, issued, roomID := newAgentCLIIdentity(t)
	backgroundTasks := func(t *testing.T) []string {
		t.Helper()
		code, _, body := env.request(alice, http.MethodGet, "/v0/rooms/"+roomID+"/background-tasks", nil, "")
		var list struct {
			Items []struct{ ID, Title, Requirement string } `json:"items"`
		}
		if code != http.StatusOK || json.Unmarshal(body, &list) != nil {
			t.Fatalf("background tasks=%d %s", code, body)
		}
		ids := []string{}
		for _, item := range list.Items {
			ids = append(ids, item.ID+"|"+item.Title+"|"+item.Requirement)
		}
		return ids
	}

	t.Run("a finished turn makes the Task idle and reports its final reply", func(t *testing.T) {
		created := createDelegatedTask(t, env, issued, "outcome-idle", "Summarize notes", "Summarize the notes.", roomID)
		worker := claimDelegatedTask(t, env, created.TaskID, "worker-outcome-idle")
		effectID := worker.startTurn("run-outcome-idle")
		// The Room shows the running Task above its composer until it is idle.
		if got := backgroundTasks(t); len(got) != 1 || got[0] != created.TaskID+"|Summarize notes|Summarize the notes." {
			t.Fatalf("running background tasks=%q", got)
		}
		insertAlterEgoLocalRun(t, env, created.TaskID, "run-outcome-idle", "Here is the summary: all good.")
		worker.endTurn(effectID, "run-outcome-idle", "succeeded", "")
		worker.advance()

		assertDelegatedTaskState(t, env, created.TaskID, "idle", "run_succeeded")
		if got := backgroundTasks(t); len(got) != 0 {
			t.Fatalf("idle Task still listed: %q", got)
		}
		reports := taskReports(t, env, created.TaskID)
		want := "Task Summarize notes (" + created.TaskID + ") is idle. If it is done, deliver it to the user with teamhub message card: a title, " +
			"a one-line result, and its files from ./playground/" + created.TaskID + "/ with --attach; then say in one " +
			"ordinary message what the user should add or check, if anything.\nHere is the summary: all good."
		if len(reports) != 1 || reports[0] != want {
			t.Fatalf("reports=%q want %q", reports, want)
		}
		// The report wakes the origin Room's Meta through the Task callback stream.
		if got := countRows(t, env, `SELECT count(*) FROM task_meta_callbacks callback
			WHERE callback.task_id=$1 AND callback.coordinator_actor_id='actor_acme_official'
			  AND callback.coordinator_context_key=$2 AND callback.through_seq=1`,
			created.TaskID, `["meta","`+acmeOfficialAgentManagementID+`","room","`+roomID+`"]`); got != 1 {
			t.Fatalf("Meta callback cursor rows=%d want=1", got)
		}
		if got := countRows(t, env, `SELECT count(*) FROM task_attempts WHERE task_id=$1 AND status='passed'`, created.TaskID); got != 1 {
			t.Fatalf("passed Attempts=%d want=1", got)
		}
		if got := countRows(t, env, `SELECT count(*) FROM agent_execution_contexts WHERE task_id=$1 AND target_residency='active'`, created.TaskID); got != 1 {
			t.Fatalf("idle Task suspended its AlterEgo Context")
		}
		if worker.bundle.Lease != nil {
			worker.advance()
		}
	})

	t.Run("an empty final reply is reported as no reply", func(t *testing.T) {
		created := createDelegatedTask(t, env, issued, "outcome-empty", "Quiet task", "Do it quietly.", roomID)
		worker := claimDelegatedTask(t, env, created.TaskID, "worker-outcome-empty")
		effectID := worker.startTurn("run-outcome-empty")
		insertAlterEgoLocalRun(t, env, created.TaskID, "run-outcome-empty", "  ")
		worker.endTurn(effectID, "run-outcome-empty", "succeeded", "")
		worker.advance()
		if reports := taskReports(t, env, created.TaskID); len(reports) != 1 || !strings.HasSuffix(reports[0], "with --attach.\n(no reply)") {
			t.Fatalf("reports=%q", reports)
		}
	})

	t.Run("a failed Run fails the Task without retrying and reports the error", func(t *testing.T) {
		created := createDelegatedTask(t, env, issued, "outcome-failed", "Fetch data", "Fetch the data.", roomID)
		worker := claimDelegatedTask(t, env, created.TaskID, "worker-outcome-failed")
		effectID := worker.startTurn("run-outcome-failed")
		worker.endTurn(effectID, "run-outcome-failed", "failed", "provider quota exceeded")
		worker.advance()

		assertDelegatedTaskState(t, env, created.TaskID, "failed", "agent_run_failed")
		reports := taskReports(t, env, created.TaskID)
		if len(reports) != 1 || reports[0] != "Task Fetch data ("+created.TaskID+") failed: provider quota exceeded" {
			t.Fatalf("reports=%q", reports)
		}
		if got := countRows(t, env, `SELECT count(*) FROM task_attempts WHERE task_id=$1`, created.TaskID); got != 1 {
			t.Fatalf("failed Task retried: Attempts=%d want=1", got)
		}
	})

	t.Run("a turn that ends with a pending approval card waits without a report", func(t *testing.T) {
		created := createDelegatedTask(t, env, issued, "outcome-waiting", "Send the quote", "Send the quote.", roomID)
		worker := claimDelegatedTask(t, env, created.TaskID, "worker-outcome-waiting")
		effectID := worker.startTurn("run-outcome-waiting")
		contextKey := insertAlterEgoLocalRun(t, env, created.TaskID, "run-outcome-waiting", "Waiting for approval.")
		insertPendingRuntimePermission(t, env, roomID, contextKey, "interaction_outcome_waiting")
		worker.endTurn(effectID, "run-outcome-waiting", "succeeded", "")
		worker.advance()

		assertDelegatedTaskState(t, env, created.TaskID, "waiting_for_approval", "pending_approval")
		if reports := taskReports(t, env, created.TaskID); len(reports) != 0 {
			t.Fatalf("waiting Task reported=%q", reports)
		}
	})
}

// insertPendingRuntimePermission stands for a Runtime permission card the
// AlterEgo raised during its turn; it expires in 10 minutes.
func insertPendingRuntimePermission(t *testing.T, env *testEnv, roomID, contextKey, decisionID string) {
	t.Helper()
	messageID := "message_" + decisionID
	for _, statement := range []struct {
		query string
		args  []any
	}{
		{`INSERT INTO messages(id,tenant_id,room_id,author_actor_id,body,segments) VALUES($1,$2,$3,'actor_acme_official','Approve?','[{"type":"text","content":"Approve?"}]')`, []any{messageID, acmeTenant, roomID}},
		{`INSERT INTO message_cards(message_id,tenant_id,room_id,decision_owner_actor_id,card_type,intent) VALUES($1,$2,$3,'actor_acme_alice','personal_notice','decision_requested')`, []any{messageID, acmeTenant, roomID}},
		{`INSERT INTO decisions(id,tenant_id,room_id,message_id,kind,requested_by_actor_id,decider_actor_id,alter_ego_task_id,request,view,expires_at)
			SELECT $1,$2,$3,$4,'runtime_permission','actor_acme_official','actor_acme_alice',context.task_id,
			  jsonb_build_object('context_key',$5::text,'action_digest','sha256:'||repeat('a',64),'runtime','{}'::jsonb),
			  '{"kind":"code","title":"Send the quote"}',clock_timestamp()+interval '10 minutes'
			FROM agent_execution_contexts context WHERE context.context_key=$5`, []any{decisionID, acmeTenant, roomID, messageID, contextKey}},
	} {
		if _, err := env.pool.Exec(t.Context(), statement.query, statement.args...); err != nil {
			t.Fatalf("insert pending permission: %v", err)
		}
	}
}

func TestDelegatedTaskSendStopAndCheck(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice, issued, roomID := newAgentCLIIdentity(t)
	created := createDelegatedTask(t, env, issued, "manage", "Draft the plan", "Draft the plan.", roomID)

	// Running: a message queues as the next turn of the current Attempt.
	queued := sendDelegatedTask(t, env, issued, roomID, "manage-queue", created.TaskID, "Also add a timeline.", false)
	if queued["delivery"] != "queued" || queued["status"] != "running" || queued["duplicate_request"] != false {
		t.Fatalf("queued send=%v", queued)
	}
	if got := countRows(t, env, `SELECT count(*) FROM task_input_revisions input
		JOIN task_effects effect ON effect.task_id=input.task_id AND input.message_effect_ids ? effect.id
		WHERE input.task_id=$1 AND input.cause='meta_message' AND input.input_revision=2
		  AND effect.status='pending' AND NOT (effect.payload ? 'steer')
		  AND effect.payload->'message'->>'raw_message'='Also add a timeline.'`, created.TaskID); got != 1 {
		t.Fatalf("queued input witnesses=%d want=1", got)
	}
	if got := countRows(t, env, `SELECT count(*) FROM task_attempts WHERE task_id=$1`, created.TaskID); got != 1 {
		t.Fatalf("queued send created an Attempt")
	}
	replay := sendDelegatedTask(t, env, issued, roomID, "manage-queue", created.TaskID, "Also add a timeline.", false)
	if replay["duplicate_request"] != true || replay["delivery"] != "queued" {
		t.Fatalf("replayed send=%v", replay)
	}

	// Steer: the submit effect asks the Agent to join the running turn.
	steered := sendDelegatedTask(t, env, issued, roomID, "manage-steer", created.TaskID, "Use the Q3 numbers.", true)
	if steered["delivery"] != "steered" {
		t.Fatalf("steered send=%v", steered)
	}
	if got := countRows(t, env, `SELECT count(*) FROM task_effects WHERE task_id=$1 AND (payload->>'steer')::boolean
		AND payload->'message'->>'raw_message'='Use the Q3 numbers.'`, created.TaskID); got != 1 {
		t.Fatalf("steer effect witnesses=%d want=1", got)
	}

	// Stop: the current turn is canceled, the AlterEgo session stays.
	contextKey := alterEgoContextKey(created.TaskID)
	if _, err := env.pool.Exec(t.Context(), `INSERT INTO agent_execution_contexts(context_key,context_kind,agent_management_id,agent_actor_id,tenant_id,task_id,target_residency)
		VALUES($1,'alter_ego',$2,'actor_acme_official',$3,$4,'active')`, contextKey, acmeOfficialAgentManagementID, acmeTenant, created.TaskID); err != nil {
		t.Fatal(err)
	}
	code, body := postTaskCommand(t, env, issued, "stop", map[string]any{
		"invocation_id": mcpCreationInvocationID("manage-stop"), "task_id": created.TaskID,
	}, taskDelegationRoomContext(roomID))
	if code != http.StatusOK || !strings.Contains(string(body), `"status":"canceled"`) {
		t.Fatalf("task stop=%d %s", code, body)
	}
	assertDelegatedTaskState(t, env, created.TaskID, "canceled", "stopped")
	if got := countRows(t, env, `SELECT count(*) FROM task_attempts WHERE task_id=$1 AND status='stopped' AND stop_reason_code='stopped'`, created.TaskID); got != 1 {
		t.Fatalf("stopped Attempts=%d want=1", got)
	}
	if got := countRows(t, env, `SELECT count(*) FROM task_effects WHERE task_id=$1 AND operation='submit_agent_turn' AND status IN ('pending','dispatching')`, created.TaskID); got != 0 {
		t.Fatalf("stop left live turns=%d", got)
	}
	if got := countRows(t, env, `SELECT count(*) FROM agent_execution_contexts WHERE context_key=$1 AND target_residency='active'`, contextKey); got != 1 {
		t.Fatal("stop suspended the AlterEgo Context")
	}
	if reports := taskReports(t, env, created.TaskID); len(reports) != 0 {
		t.Fatalf("stop reported=%q", reports)
	}

	// A canceled Task wakes with a new Attempt.
	started := sendDelegatedTask(t, env, issued, roomID, "manage-wake", created.TaskID, "Continue from where you stopped.", false)
	if started["delivery"] != "started" || started["status"] != "running" {
		t.Fatalf("wake send=%v", started)
	}
	assertDelegatedTaskState(t, env, created.TaskID, "running", "")
	if got := countRows(t, env, `SELECT count(*) FROM task_attempts WHERE task_id=$1 AND attempt_number=2 AND status='running' AND current_input_revision=1`, created.TaskID); got != 1 {
		t.Fatalf("woken Attempt rows=%d want=1", got)
	}

	// Check shows the Task to its Meta.
	code, body = postTaskCommand(t, env, issued, "check", map[string]any{"task_id": created.TaskID}, taskDelegationRoomContext(roomID))
	var detail struct {
		Task struct {
			TaskID         string `json:"task_id"`
			Name           string `json:"name"`
			Status         string `json:"status"`
			OriginRoomID   string `json:"origin_room_id"`
			RecentActivity []struct {
				Kind string `json:"kind"`
			} `json:"recent_activity"`
			PendingApprovals []any `json:"pending_approvals"`
		} `json:"task"`
	}
	if code != http.StatusOK || json.Unmarshal(body, &detail) != nil || detail.Task.TaskID != created.TaskID ||
		detail.Task.Name != "Draft the plan" || detail.Task.Status != "running" || detail.Task.OriginRoomID != roomID ||
		len(detail.Task.RecentActivity) == 0 || detail.Task.RecentActivity[0].Kind != "message" || detail.Task.PendingApprovals == nil {
		t.Fatalf("task check=%d %s", code, body)
	}
	code, body = postTaskCommand(t, env, issued, "check", map[string]any{}, taskDelegationRoomContext(roomID))
	if code != http.StatusOK || !strings.Contains(string(body), `"task_id":"`+created.TaskID+`"`) {
		t.Fatalf("task check list=%d %s", code, body)
	}

	// Another Room's Meta of the same Agent neither sees nor manages it.
	otherRoomID := createPrivateRoom(t, env, alice, "Other origin", "task-manage-other-room")
	if code, body := putRoomMember(t, env, alice, otherRoomID, "actor_acme_official", "member"); code != http.StatusOK {
		t.Fatalf("add Agent: %d %s", code, body)
	}
	for _, request := range []struct {
		command string
		body    map[string]any
	}{
		{"check", map[string]any{"task_id": created.TaskID}},
		{"send", map[string]any{"invocation_id": mcpCreationInvocationID("manage-other-send"), "task_id": created.TaskID, "message": "hi"}},
		{"stop", map[string]any{"invocation_id": mcpCreationInvocationID("manage-other-stop"), "task_id": created.TaskID}},
	} {
		if code, body := postTaskCommand(t, env, issued, request.command, request.body, taskDelegationRoomContext(otherRoomID)); code != http.StatusNotFound {
			t.Fatalf("other Room %s=%d %s", request.command, code, body)
		}
	}
	code, body = postTaskCommand(t, env, issued, "check", map[string]any{}, taskDelegationRoomContext(otherRoomID))
	if code != http.StatusOK || strings.Contains(string(body), created.TaskID) {
		t.Fatalf("other Room check list=%d %s", code, body)
	}
}

func TestTaskContextCannotSpeakOrManageTasks(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, _, issued, roomID := newAgentCLIIdentity(t)
	created := createDelegatedTask(t, env, issued, "blocklist", "Blocked actions", "Try the blocked actions.", roomID)
	taskContext := http.Header{"X-TeamHub-Context-Kind": {"task"}, "X-TeamHub-Context-Id": {created.TaskID}}
	for _, request := range []struct {
		path string
		body map[string]any
	}{
		{"/api/agent/v1/tasks/check", map[string]any{}},
		{"/api/agent/v1/tasks/send", map[string]any{"invocation_id": mcpCreationInvocationID("blocked-send"), "task_id": created.TaskID, "message": "hi"}},
		{"/api/agent/v1/tasks/stop", map[string]any{"invocation_id": mcpCreationInvocationID("blocked-stop"), "task_id": created.TaskID}},
		{"/api/agent/v1/direct-messages", map[string]any{"invocation_id": mcpCreationInvocationID("blocked-direct"), "messages": []string{"hi"}}},
	} {
		code, _, body := taskWorkerJSONRequest(t, env, http.MethodPost, request.path, issued.AccessToken, request.body, taskContext)
		if code != http.StatusForbidden || !strings.Contains(string(body), "write files to ./playground/") {
			t.Fatalf("%s from a Task Context=%d %s", request.path, code, body)
		}
	}
	code, body := commitAgentMessage(t, env, issued.AccessToken, "task", created.TaskID, agentTextMessage("room:"+roomID, "blocked-message", "hi"))
	if code != http.StatusForbidden || !strings.Contains(string(body), "write files to ./playground/") {
		t.Fatalf("message commit from a Task Context=%d %s", code, body)
	}
}

// An approval card's result reaches the AlterEgo through the same Task input
// as a Meta message: it wakes a waiting Task and queues behind a running one.
func TestApprovalResultWakesDelegatedTask(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, _, issued, roomID := newAgentCLIIdentity(t)
	created := createDelegatedTask(t, env, issued, "card-wake", "Send the invoice", "Send the invoice.", roomID)
	worker := claimDelegatedTask(t, env, created.TaskID, "worker-card-wake")
	effectID := worker.startTurn("run-card-wake")
	contextKey := insertAlterEgoLocalRun(t, env, created.TaskID, "run-card-wake", "Waiting for approval.")
	insertPendingRuntimePermission(t, env, roomID, contextKey, "interaction_card_wake")
	worker.endTurn(effectID, "run-card-wake", "succeeded", "")
	worker.advance()
	assertDelegatedTaskState(t, env, created.TaskID, "waiting_for_approval", "pending_approval")

	delegation := taskdelegation.New(env.pool, agentauth.New(env.pool))
	woken, err := delegation.SendSystemInput(t.Context(), acmeOfficialAgentManagementID, created.TaskID, "Approval interaction_card_wake was approved.")
	if err != nil || woken.Delivery != "started" || woken.Status != "running" || woken.ExecutionRevision < 1 {
		t.Fatalf("approval wake=%+v err=%v", woken, err)
	}
	assertDelegatedTaskState(t, env, created.TaskID, "running", "")
	queued, err := delegation.SendSystemInput(t.Context(), acmeOfficialAgentManagementID, created.TaskID, "Connector call finished.")
	if err != nil || queued.Delivery != "queued" {
		t.Fatalf("approval while running=%+v err=%v", queued, err)
	}
	if got := countRows(t, env, `SELECT count(*) FROM task_input_revisions input
		JOIN task_meta_messages message ON message.task_id=input.task_id
		 AND message.id=input.input_manifest->'recipient_wakes'->0->'message'->>'message_id'
		WHERE input.task_id=$1 AND input.cause='system' AND message.author_actor_id='actor_acme_official'`, created.TaskID); got != 2 {
		t.Fatalf("system Task inputs=%d want=2", got)
	}
	if _, err := delegation.SendSystemInput(t.Context(), "another-agent", created.TaskID, "spoofed"); !errors.Is(err, taskdelegation.ErrNotFound) {
		t.Fatalf("another Agent's approval result err=%v", err)
	}
}
