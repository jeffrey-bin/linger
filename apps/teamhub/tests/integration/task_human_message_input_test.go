package integration_test

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/url"
	"strconv"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/taskexecution"
)

func TestHumanTaskRoomMessagePromotesWhilePreviousTurnIsDispatching(t *testing.T) {
	allowParallelIntegrationTest(t)
	env := newRoomMembershipEnv(t)
	alice := env.login("alice", alicePassword)
	suffix := "human-task-input-" + strconv.FormatInt(time.Now().UnixNano(), 36)
	roomID := createPrivateRoom(t, env, alice, "Human Task input "+suffix, "human-task-input-room-"+suffix)

	if status, body := putRoomMember(t, env, alice, roomID, "actor_acme_official", "member"); status != http.StatusOK {
		t.Fatalf("add Task participant status=%d body=%s", status, body)
	}
	created := createManagedTaskFixture(t, env, roomID, suffix)
	createTaskWorkRoomLink(t, env, created.ID, roomID)

	first := claimTaskWorker(t, env, "human-task-input-first-worker-"+suffix)
	initialEffect := taskEffectByOperation(t, first, "submit_agent_turn", "pending")
	first = transitionTaskWorker(
		t, env, first, first.Lease.WorkerID, first.Lease.LeaseToken,
		first.Lease.LeaseGeneration, "begin_effect_dispatch",
		map[string]any{"effect_id": initialEffect.ID},
	)
	if effect := taskEffectByID(t, first, initialEffect.ID); effect.Status != "dispatching" {
		t.Fatalf("initial submit effect status=%s want=dispatching", effect.Status)
	}
	oldWorkerPath := "/v0/task-executions/" + created.ID + "?worker_id=" +
		url.QueryEscape(first.Lease.WorkerID) + "&lease_generation=" +
		strconv.FormatInt(first.Lease.LeaseGeneration, 10)

	messagePayload := humanTextMessage("Use this Human follow-up as the next Task input.")
	idempotencyKey := "human-task-input-message-" + suffix
	status, headers, body := env.request(
		alice, http.MethodPost, "/v0/rooms/"+roomID+"/messages", messagePayload, idempotencyKey,
	)
	if status != http.StatusCreated {
		t.Fatalf("create Human Task Room message status=%d body=%s", status, body)
	}
	var publicMessage struct {
		ID          string `json:"id"`
		MessageKind string `json:"message_kind"`
		RawMessage  string `json:"raw_message"`
	}
	decode(t, body, &publicMessage)
	if publicMessage.ID == "" || publicMessage.MessageKind != "conversation" ||
		publicMessage.RawMessage != messagePayload["raw_message"] {
		t.Fatalf("public Human message=%+v", publicMessage)
	}
	if headers.Get("Idempotent-Replay") != "" {
		t.Fatal("first Human Task input was marked as replay")
	}
	status, _, staleBody := taskWorkerJSONRequest(
		t, env, http.MethodGet, oldWorkerPath, teamHubInternalToken, nil,
		taskLeaseHeader(first.Lease.LeaseToken),
	)
	if status != http.StatusConflict {
		t.Fatalf("old worker lease survived Human promotion status=%d body=%s", status, staleBody)
	}

	assertHumanTaskInputLedger(t, env, created.ID, publicMessage.ID, initialEffect.ID,
		[]string{"actor_acme_official"})
	if got := countRows(t, env, `select count(*) from task_input_revisions where task_id=$1`, created.ID); got != 2 {
		t.Fatalf("InputRevision rows after promotion=%d want=2", got)
	}
	if got := countRows(t, env, `select count(*) from task_effects where task_id=$1`, created.ID); got != 2 {
		t.Fatalf("Task effect rows after promotion=%d want=2", got)
	}
	if got := countRows(t, env, `select count(*) from task_meta_messages where task_id=$1`, created.ID); got != 2 {
		t.Fatalf("Meta wake rows after promotion=%d want=2", got)
	}
	if got := countRows(t, env, `select count(*) from task_execution_facts where task_id=$1`, created.ID); got != 2 {
		t.Fatalf("execution facts after promotion=%d want=2", got)
	}

	replayStatus, replayHeaders, replayBody := env.request(
		alice, http.MethodPost, "/v0/rooms/"+roomID+"/messages", messagePayload, idempotencyKey,
	)
	if replayStatus != http.StatusCreated || replayHeaders.Get("Idempotent-Replay") != "true" ||
		!bytes.Equal(replayBody, body) {
		t.Fatalf("Human Task input replay status=%d headers=%v body=%s", replayStatus, replayHeaders, replayBody)
	}
	for name, query := range map[string]string{
		"InputRevision": "select count(*) from task_input_revisions where task_id=$1",
		"effect":        "select count(*) from task_effects where task_id=$1",
		"Meta wake":     "select count(*) from task_meta_messages where task_id=$1",
		"fact":          "select count(*) from task_execution_facts where task_id=$1",
	} {
		want := 2
		if got := countRows(t, env, query, created.ID); got != want {
			t.Fatalf("%s rows after replay=%d want=%d", name, got, want)
		}
	}

	second := claimTaskWorker(t, env, "human-task-input-second-worker-"+suffix)
	if second.Execution.TaskID != created.ID || second.Execution.ExecutionRevision != 2 ||
		second.Execution.CurrentAttempt == nil || second.Execution.CurrentAttempt.CurrentInputRevision != 2 {
		t.Fatalf("reclaimed promoted Task=%+v", second)
	}
	if effect := taskEffectByID(t, second, initialEffect.ID); effect.Status != "dispatching" {
		t.Fatalf("old dispatching effect after reclaim=%+v", effect)
	}
	second = transitionTaskWorker(
		t, env, second, second.Lease.WorkerID, second.Lease.LeaseToken,
		second.Lease.LeaseGeneration, "record_agent_turn", map[string]any{
			"effect_id": initialEffect.ID,
			"participant_runs": []map[string]any{
				{"actor_id": "actor_acme_official", "agent_management_id": acmeOfficialAgentManagementID, "agent_run_ref": "human-task-input-old-official-" + suffix},
			},
		},
	)
	if effect := taskEffectByID(t, second, initialEffect.ID); effect.Status != "succeeded" {
		t.Fatalf("new lease could not reconcile old dispatching effect=%+v", effect)
	}
	if effect := taskEffectByOperation(t, second, "submit_agent_turn", "pending"); effect.ID == initialEffect.ID {
		t.Fatalf("new Human submit effect was not independently pending: %+v", effect)
	}

	// Agent-authored Messages never recursively create Human InputRevisions.
	seedAgentMessage(t, env, roomID, "actor_acme_official", "Agent public output.")
	if got := countRows(t, env, `select count(*) from task_input_revisions where task_id=$1`, created.ID); got != 2 {
		t.Fatalf("Agent Message recursively promoted InputRevisions=%d want=2", got)
	}

	assertHumanTaskInputNoopStates(t, env, alice, created.ID, roomID, suffix)

	ordinaryRoomID := createPrivateRoom(t, env, alice, "Ordinary room "+suffix, "ordinary-human-message-room-"+suffix)
	status, _, ordinaryBody := env.request(
		alice, http.MethodPost, "/v0/rooms/"+ordinaryRoomID+"/messages",
		humanTextMessage("Ordinary public message."), "ordinary-human-message-"+suffix,
	)
	if status != http.StatusCreated {
		t.Fatalf("ordinary Room message status=%d body=%s", status, ordinaryBody)
	}
	if got := countRows(t, env, `select count(*) from task_input_revisions where task_id=$1`, created.ID); got != 2 {
		t.Fatalf("ordinary Room message changed managed Task InputRevisions=%d want=2", got)
	}
}

func assertHumanTaskInputLedger(
	t *testing.T,
	env *testEnv,
	taskID, publicMessageID, initialEffectID string,
	wantRecipients []string,
) {
	t.Helper()
	var attemptRevision, executionRevision int64
	var workerID pgtype.Text
	if err := env.pool.QueryRow(t.Context(), `
		select attempt.current_input_revision,item.task_execution_revision,item.task_worker_id
		from work_items item
		join task_attempts attempt on attempt.task_id=item.id
		 and attempt.generation=item.task_execution_generation and attempt.status='running'
		where item.id=$1
	`, taskID).Scan(&attemptRevision, &executionRevision, &workerID); err != nil {
		t.Fatal(err)
	}
	if attemptRevision != 2 || executionRevision != 2 || workerID.Valid {
		t.Fatalf("promoted Task fence input=%d execution=%d worker=%v", attemptRevision, executionRevision, workerID)
	}
	var recipientsJSON, manifestJSON, effectIDsJSON []byte
	if err := env.pool.QueryRow(t.Context(), `
		select recipient_actor_ids,input_manifest,message_effect_ids
		from task_input_revisions
		where task_id=$1 and generation=1 and input_revision=2
		 and cause='human_message' and source_message_id=$2
	`, taskID, publicMessageID).Scan(&recipientsJSON, &manifestJSON, &effectIDsJSON); err != nil {
		t.Fatal(err)
	}
	var recipients []string
	var effectIDs []string
	if json.Unmarshal(recipientsJSON, &recipients) != nil || json.Unmarshal(effectIDsJSON, &effectIDs) != nil ||
		len(effectIDs) != 1 || effectIDs[0] == initialEffectID {
		t.Fatalf("Human InputRevision recipients=%s effects=%s", recipientsJSON, effectIDsJSON)
	}
	assertSameStrings(t, recipients, wantRecipients)

	var effectStatus string
	var payloadJSON []byte
	if err := env.pool.QueryRow(t.Context(), `
		select status,payload from task_effects where id=$1 and task_id=$2
	`, effectIDs[0], taskID).Scan(&effectStatus, &payloadJSON); err != nil {
		t.Fatal(err)
	}
	if effectStatus != "pending" {
		t.Fatalf("Human submit effect status=%s want=pending", effectStatus)
	}
	var payload taskexecution.SubmitTurnEffectPayload
	if err := json.Unmarshal(payloadJSON, &payload); err != nil {
		t.Fatal(err)
	}
	if payload.InputRevision != 2 || payload.PublicContextMessage == nil ||
		payload.PublicContextMessage.MessageID != publicMessageID || len(payload.RecipientWakes) != len(wantRecipients) {
		t.Fatalf("Human submit payload=%s", payloadJSON)
	}
	assertHumanTurnMessageAuthor(t, payload.PublicContextMessage.Author)
	assertSameStrings(t, payload.RecipientActorIDs, wantRecipients)
	for _, wake := range payload.RecipientWakes {
		if wake.AuthorActorID != "actor_acme_alice" || len(wake.PublicMessageIDs) != 1 ||
			wake.PublicMessageIDs[0] != publicMessageID || wake.MetaSeq != 2 {
			t.Fatalf("Human recipient wake=%+v", wake)
		}
		if got := countRows(t, env, `
			select count(*) from task_meta_messages
			where id=$1 and task_id=$2 and agent_actor_id=$3 and meta_seq=$4
			 and author_actor_id='actor_acme_alice'
		`, wake.Message.MessageID, taskID, wake.ActorID, wake.MetaSeq); got != 1 {
			t.Fatalf("durable Meta wake for %s rows=%d want=1", wake.ActorID, got)
		}
	}
	var manifest struct {
		PublicMessageIDs     []string                            `json:"public_message_ids"`
		PublicContextMessage taskexecution.TurnMessageInput      `json:"public_context_message"`
		RecipientWakes       []taskexecution.ParticipantMetaWake `json:"recipient_wakes"`
		WakeAuthorID         string                              `json:"wake_author_actor_id"`
	}
	if err := json.Unmarshal(manifestJSON, &manifest); err != nil {
		t.Fatal(err)
	}
	if len(manifest.PublicMessageIDs) != 1 || manifest.PublicMessageIDs[0] != publicMessageID ||
		manifest.WakeAuthorID != "actor_acme_alice" || len(manifest.RecipientWakes) != len(wantRecipients) {
		t.Fatalf("Human InputRevision manifest=%s", manifestJSON)
	}
	assertHumanTurnMessageAuthor(t, manifest.PublicContextMessage.Author)
	if got := countRows(t, env, `
		select count(*) from task_execution_facts
		where task_id=$1 and generation=1 and execution_revision=2
		 and fact_kind='TASK_EXECUTION_CHANGED' and execution_status='running'
		 and caused_by_actor_id='actor_acme_alice'
		 and payload->>'source_message_id'=$2
	`, taskID, publicMessageID); got != 1 {
		t.Fatalf("Human input execution fact rows=%d want=1", got)
	}
}

func assertHumanTurnMessageAuthor(t *testing.T, author *taskexecution.TurnMessageAuthor) {
	t.Helper()
	if author == nil || author.ActorID != "actor_acme_alice" || author.Kind != "human" || author.DisplayName != "alice" {
		t.Fatalf("Human public Task message author=%+v", author)
	}
}

func assertHumanTaskInputNoopStates(
	t *testing.T,
	env *testEnv,
	alice *http.Client,
	taskID, roomID, suffix string,
) {
	t.Helper()
	// A Task that is not running gets no Work Room input; a Meta wakes it.
	for _, state := range []struct{ name, status string }{
		{name: "idle", status: "idle"},
		{name: "waiting", status: "waiting_for_approval"},
		{name: "failed", status: "failed"},
		{name: "canceled", status: "canceled"},
	} {
		if _, err := env.pool.Exec(t.Context(), `
			update work_items set task_execution_status=$2,
			 task_worker_id=null,task_lease_token_hash=null,task_lease_expires_at=null
			where id=$1
		`, taskID, state.status); err != nil {
			t.Fatal(err)
		}
		status, _, body := env.request(
			alice, http.MethodPost, "/v0/rooms/"+roomID+"/messages",
			humanTextMessage("Public message while Task is "+state.name+"."),
			"human-task-input-noop-"+state.name+"-"+suffix,
		)
		if status != http.StatusCreated {
			t.Fatalf("%s Task public message status=%d body=%s", state.name, status, body)
		}
		if got := countRows(t, env, `select count(*) from task_input_revisions where task_id=$1`, taskID); got != 2 {
			t.Fatalf("%s Task message promoted InputRevision rows=%d want=2", state.name, got)
		}
	}
}

func assertSameStrings(t *testing.T, got, want []string) {
	t.Helper()
	gotSet := make(map[string]int, len(got))
	for _, value := range got {
		gotSet[value]++
	}
	wantSet := make(map[string]int, len(want))
	for _, value := range want {
		wantSet[value]++
	}
	if len(gotSet) != len(wantSet) {
		t.Fatalf("strings=%v want=%v", got, want)
	}
	for value, count := range wantSet {
		if gotSet[value] != count {
			t.Fatalf("strings=%v want=%v", got, want)
		}
	}
}

func createTaskWorkRoomLink(t *testing.T, env *testEnv, taskID, roomID string) {
	t.Helper()
	queries := store.New(env.pool)
	if _, err := queries.CreateWorkItemRoomLink(t.Context(), store.CreateWorkItemRoomLinkParams{
		WorkItemID: taskID, TenantID: acmeTenant, LinkType: "work", RoomID: roomID,
		OriginMessageID: pgtype.Text{}, LinkedByActorID: "actor_acme_alice",
	}); err != nil {
		t.Fatal(err)
	}
}
