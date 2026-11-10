package integration_test

import (
	"bytes"
	"errors"
	"net/http"
	"strconv"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentruntimestate"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

func TestHumanTaskArchiveCancelsContextAndUnarchiveRestoresAuthority(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice, task, service, contextKey := newTaskArchiveContextFixture(t)
	const instance = "task-archive-instance"
	startRuntimeEpoch(t, service, instance)
	fence := instance
	submitted, err := service.SubmitTrustedTurn(t.Context(), agentruntimestate.SubmitTrustedTurnInput{ContextKey: contextKey, Epoch: fence,
		Inputs: []agentruntimestate.RuntimeInput{runtimeInput("archive-input", "trusted_turn", "meta:actor_acme_official:"+task.ID, "Continue this Task")},
	})
	if err != nil {
		t.Fatal(err)
	}
	started, err := service.ClaimLocalRun(t.Context(), agentruntimestate.ClaimLocalRunInput{
		ClaimID: "archive-start-run", ContextKey: contextKey, Epoch: fence,
	})
	if err != nil || started.Run == nil || started.Run.RunID != submitted.RunID {
		t.Fatalf("start Task Local Run=%+v err=%v", started, err)
	}
	if run, err := store.New(env.pool).GetAgentRunStatus(t.Context(), submitted.RunID); err != nil || run.Status != "running" {
		t.Fatalf("running Task status=%+v err=%v", run, err)
	}
	pending, err := service.AcceptTrustedNotification(t.Context(), agentruntimestate.AcceptTrustedNotificationInput{ContextKey: contextKey, Epoch: fence, ExecutionRunRef: submitted.RunID, Input: runtimeInput("archive-pending-input", "internal", "", "Steering when archived")})
	if err != nil || pending.Status != "committed" {
		t.Fatalf("steering archive fixture: %+v %v", pending, err)
	}
	before := taskArchiveContext(t, env, contextKey)
	archivePayload := map[string]any{"expected_version": task.Version}
	archiveKey := "archive-running-task"
	for _, statement := range []string{
		`CREATE FUNCTION reject_task_archive_context_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'archive Context write failed'; END $$`,
		`CREATE TRIGGER reject_task_archive_context_write BEFORE UPDATE ON agent_execution_contexts FOR EACH ROW EXECUTE FUNCTION reject_task_archive_context_write()`,
	} {
		if _, err := env.pool.Exec(t.Context(), statement); err != nil {
			t.Fatal(err)
		}
	}
	status, _, failedBody := env.request(alice, http.MethodPost, "/v0/work-items/"+task.ID+"/archive", archivePayload, archiveKey)
	if status != http.StatusInternalServerError || countRows(t, env, `SELECT count(*) FROM work_items WHERE id=$1 AND archived_at IS NULL AND version=$2`, task.ID, task.Version) != 1 || taskArchiveContext(t, env, contextKey).StateRevision != before.StateRevision {
		t.Fatalf("Context write failure left partial Task archive status=%d body=%s", status, failedBody)
	}
	if run, err := service.GetLocalRun(t.Context(), contextKey, submitted.RunID); err != nil || run.Status != "running" {
		t.Fatalf("rolled-back archive changed Local Run=%+v err=%v", run, err)
	}
	if _, err := env.pool.Exec(t.Context(), `DROP TRIGGER reject_task_archive_context_write ON agent_execution_contexts`); err != nil {
		t.Fatal(err)
	}
	status, _, archiveBody := env.request(alice, http.MethodPost, "/v0/work-items/"+task.ID+"/archive", archivePayload, archiveKey)
	if status != http.StatusOK {
		t.Fatalf("archive running Task status=%d body=%s", status, archiveBody)
	}
	var archived workItemResponse
	decode(t, archiveBody, &archived)
	if archived.ArchivedAt == nil || archived.State != task.State || countRows(t, env, `SELECT count(*) FROM work_items WHERE id=$1 AND task_execution_status='running'`, task.ID) != 1 {
		t.Fatalf("archive changed Task lifecycle: %+v", archived)
	}
	after := taskArchiveContext(t, env, contextKey)
	if after.TargetResidency != "suspended" || after.TerminalReason.Valid || after.StateRevision <= before.StateRevision {
		t.Fatalf("archive did not suspend Context authority: before=%+v after=%+v", before, after)
	}
	if countRows(t, env, `SELECT count(*) FROM agent_runtime_inputs WHERE context_key=$1 AND status='steering'`, contextKey) != 0 {
		t.Fatal("archive left pending inputs")
	}
	if _, err = service.SubmitTrustedTurn(t.Context(), agentruntimestate.SubmitTrustedTurnInput{ContextKey: contextKey, Epoch: fence, Inputs: []agentruntimestate.RuntimeInput{runtimeInput("archive-stale-input", "trusted_turn", "", "Stale")}}); err == nil {
		t.Fatal("archived old fence accepted input")
	}
	run, err := service.GetLocalRun(t.Context(), contextKey, submitted.RunID)
	if err != nil || run.Status != "canceled" {
		t.Fatalf("archive left Local Run alive: %+v err=%v", run, err)
	}
	if eventType, event := lastRunStatusEvent(t, env.pool, submitted.RunID); eventType != "status.changed" || event["status"] != "stopped" || event["outcome"] != "canceled" {
		t.Fatalf("archive did not stop the Task status: %s %v", eventType, event)
	}
	if got := countRows(t, env, `SELECT count(*) FROM task_effects WHERE task_id=$1 AND operation='submit_agent_turn' AND status='pending'`, task.ID); got != 1 {
		t.Fatalf("archive changed pending Task effects=%d want=1", got)
	}
	status, headers, replayBody := env.request(alice, http.MethodPost, "/v0/work-items/"+task.ID+"/archive", archivePayload, archiveKey)
	if status != http.StatusOK || headers.Get("Idempotent-Replay") != "true" || !bytes.Equal(replayBody, archiveBody) || taskArchiveContext(t, env, contextKey).StateRevision != after.StateRevision {
		t.Fatalf("archive replay mutated Context status=%d headers=%v body=%s", status, headers, replayBody)
	}
	status, _, unarchiveBody := env.request(alice, http.MethodPost, "/v0/work-items/"+task.ID+"/unarchive", map[string]any{"expected_version": archived.Version}, "unarchive-running-task")
	if status != http.StatusOK {
		t.Fatalf("unarchive Task status=%d body=%s", status, unarchiveBody)
	}
	var restored workItemResponse
	decode(t, unarchiveBody, &restored)
	reactivated := taskArchiveContext(t, env, contextKey)
	if restored.ArchivedAt != nil || restored.State != task.State || reactivated.TargetResidency != "active" || reactivated.StateRevision <= after.StateRevision {
		t.Fatalf("unarchive did not restore Task Context: item=%+v context=%+v", restored, reactivated)
	}
	if run, err := service.GetLocalRun(t.Context(), contextKey, submitted.RunID); err != nil || run.Status != "canceled" {
		t.Fatalf("unarchive resurrected canceled Run=%+v err=%v", run, err)
	}
	status, headers, replayBody = env.request(alice, http.MethodPost, "/v0/work-items/"+task.ID+"/archive", archivePayload, archiveKey)
	if status != http.StatusOK || headers.Get("Idempotent-Replay") != "true" || !bytes.Equal(replayBody, archiveBody) || taskArchiveContext(t, env, contextKey).TargetResidency != "active" {
		t.Fatalf("old archive replay crossed newer unarchive status=%d headers=%v body=%s", status, headers, replayBody)
	}
	status, _, body := env.request(alice, http.MethodPost, "/v0/work-items/"+task.ID+"/archive", map[string]any{"expected_version": restored.Version}, "archive-running-task-again")
	if status != http.StatusOK || taskArchiveContext(t, env, contextKey).TargetResidency != "suspended" {
		t.Fatalf("second archive status=%d body=%s", status, body)
	}
	decode(t, body, &archived)
	status, _, body = env.request(alice, http.MethodPost, "/v0/work-items/"+task.ID+"/unarchive", map[string]any{"expected_version": archived.Version}, "unarchive-running-task-again")
	if status != http.StatusOK || taskArchiveContext(t, env, contextKey).TargetResidency != "active" {
		t.Fatalf("second unarchive status=%d body=%s", status, body)
	}
}

func TestHumanTaskUnarchivePreservesOtherSuspensionAndInvalidContexts(t *testing.T) {
	allowParallelIntegrationTest(t)
	for _, scenario := range []string{"already_suspended", "independent_suspension", "terminal_context", "inactive_identity", "other_generation"} {
		t.Run(scenario, func(t *testing.T) {
			env, alice, task, service, contextKey := newTaskArchiveContextFixture(t)
			if scenario == "already_suspended" {
				if _, err := env.pool.Exec(t.Context(), `UPDATE agent_execution_contexts SET target_residency='suspended',state_revision=state_revision+1 WHERE context_key=$1`, contextKey); err != nil {
					t.Fatal(err)
				}
			}
			status, _, body := env.request(alice, http.MethodPost, "/v0/work-items/"+task.ID+"/archive", map[string]any{"expected_version": task.Version}, "archive-for-invalid-context")
			if status != http.StatusOK {
				t.Fatalf("archive Task status=%d body=%s", status, body)
			}
			var archived workItemResponse
			decode(t, body, &archived)
			if scenario == "already_suspended" {
				row := taskArchiveContext(t, env, contextKey)
				advanced, err := store.New(env.pool).ActivateAgentExecutionContextForInput(t.Context(), store.ActivateAgentExecutionContextForInputParams{ContextKey: contextKey, InputSequence: row.NextInputSequence + 1})
				if !errors.Is(err, pgx.ErrNoRows) {
					t.Fatalf("input advancement reactivated an archived, previously suspended Task Context: %+v %v", advanced, err)
				}
			}
			switch scenario {
			case "independent_suspension":
				row := taskArchiveContext(t, env, contextKey)
				if _, err := service.SetContextResidency(t.Context(), agentruntimestate.SetContextResidencyInput{ContextKey: contextKey, ExpectedRevision: row.StateRevision, TargetResidency: "suspended"}); err != nil {
					t.Fatal(err)
				}
			case "terminal_context":
				if _, err := env.pool.Exec(t.Context(), `UPDATE agent_execution_contexts SET terminal_reason='context_deleted',terminated_at=clock_timestamp(),state_revision=state_revision+1 WHERE context_key=$1`, contextKey); err != nil {
					t.Fatal(err)
				}
			case "inactive_identity":
				if _, err := env.pool.Exec(t.Context(), `UPDATE agent_registrations SET status='revoked' WHERE agent_management_id=$1`, acmeOfficialAgentManagementID); err != nil {
					t.Fatal(err)
				}
			case "other_generation":
				advanceTaskArchiveFixtureGeneration(t, env, task.ID)
			}
			before := taskArchiveContext(t, env, contextKey)
			status, _, body = env.request(alice, http.MethodPost, "/v0/work-items/"+task.ID+"/unarchive", map[string]any{"expected_version": archived.Version}, "unarchive-invalid-context")
			if status != http.StatusOK {
				t.Fatalf("unarchive Task status=%d body=%s", status, body)
			}
			after := taskArchiveContext(t, env, contextKey)
			if after.TargetResidency != "suspended" || after.StateRevision != before.StateRevision || after.TerminalReason != before.TerminalReason {
				t.Fatalf("unarchive restored invalid or independently suspended Context: before=%+v after=%+v", before, after)
			}
		})
	}
}

func newTaskArchiveContextFixture(t *testing.T) (*testEnv, *http.Client, workItemResponse, *agentruntimestate.Service, string) {
	t.Helper()
	env, alice := newTaskWorkerEnv(t)
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	origin := createPrivateRoom(t, env, alice, "Task archive origin", "archive-origin-"+suffix)
	if status, body := putRoomMember(t, env, alice, origin, "actor_acme_official", "member"); status != http.StatusOK {
		t.Fatalf("add Task participant status=%d body=%s", status, body)
	}
	created := createManagedTaskFixture(t, env, origin, "archive-"+suffix)
	createWorkRoomFixture(t, env, alice, created.ID, "Task archive Work Room", "actor_acme_official")
	status, _, body := env.request(alice, http.MethodGet, "/v0/work-items/"+created.ID, nil, "")
	if status != http.StatusOK {
		t.Fatalf("get Task status=%d body=%s", status, body)
	}
	var task workItemResponse
	decode(t, body, &task)
	service := agentruntimestate.New(env.pool)
	ensured, err := service.EnsureContext(t.Context(), agentruntimestate.EnsureContextInput{Ref: agentruntimestate.ContextRef{Kind: "alter_ego", AgentID: acmeOfficialAgentManagementID, TaskID: task.ID}, TargetResidency: "active"})
	if err != nil {
		t.Fatal(err)
	}
	return env, alice, task, service, ensured.Context.ContextKey
}

func taskArchiveContext(t *testing.T, env *testEnv, contextKey string) store.GetAgentExecutionContextRow {
	t.Helper()
	row, err := store.New(env.pool).GetAgentExecutionContext(t.Context(), contextKey)
	if err != nil {
		t.Fatal(err)
	}
	return row
}

// Production has no generation-replacement command. Retain the old generation
// with its valid participant to prove recovery consults only the current one.
func advanceTaskArchiveFixtureGeneration(t *testing.T, env *testEnv, taskID string) {
	t.Helper()
	tx, err := env.pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(t.Context())
	for _, statement := range []string{
		`INSERT INTO task_execution_generations(task_id,tenant_id,generation,source_key,result_agent_actor_id,spec,spec_hash) SELECT task_id,tenant_id,2,source_key,result_agent_actor_id,spec,spec_hash FROM task_execution_generations WHERE task_id=$1 AND generation=1`,
		`INSERT INTO task_execution_participants(task_id,tenant_id,generation,actor_id,agent_management_id,execution_context_ref) SELECT task_id,tenant_id,2,actor_id,'other-generation-agent',execution_context_ref FROM task_execution_participants WHERE task_id=$1 AND generation=1`,
		`INSERT INTO task_execution_facts(id,task_id,tenant_id,generation,execution_revision,fact_kind,execution_status,control_settled_revision,payload,payload_hash,caused_by_actor_id) SELECT id||'-g2',task_id,tenant_id,2,1,fact_kind,execution_status,control_settled_revision,payload,payload_hash,caused_by_actor_id FROM task_execution_facts WHERE task_id=$1 AND generation=1 AND execution_revision=1`,
		`UPDATE work_items SET task_execution_generation=2,task_execution_revision=1 WHERE id=$1`,
	} {
		if _, err := tx.Exec(t.Context(), statement, taskID); err != nil {
			t.Fatal(err)
		}
	}
	if err := tx.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
}
