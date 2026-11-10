package integration_test

import (
	"encoding/json"
	"io"
	"net/http"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentruntimestate"
)

// A Human resends a finished Run's uncertain follow-up to the same Agent:
// TeamHub places the follow-up Message again for that Context only, at most
// once, without a new Message.
func TestRoomRunRedeliversUnconfirmedFollowUps(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newAgentRunEnv(t, "http://agent-service.invalid")
	if _, err := env.pool.Exec(t.Context(), `UPDATE agent_registrations SET agent_type='anotherme',receives_all_messages=true,represented_human_actor_id=created_by_actor_id WHERE actor_id='actor_acme_official'`); err != nil {
		t.Fatal(err)
	}
	roomID := createPrivateRoom(t, env, alice, "Run redelivery", "room-redeliver")
	if status, body := putRoomMember(t, env, alice, roomID, "actor_acme_official", "member"); status != 200 {
		t.Fatalf("member %d %s", status, body)
	}
	const peerActorID = "actor_redeliver_peer"
	seedPeerAgent(t, env, peerActorID)
	if _, err := env.pool.Exec(t.Context(), `UPDATE agent_registrations SET receives_all_messages=true WHERE actor_id=$1`, peerActorID); err != nil {
		t.Fatal(err)
	}
	if status, body := putRoomMember(t, env, alice, roomID, peerActorID, "member"); status != 200 {
		t.Fatalf("peer member %d %s", status, body)
	}
	runtime := agentruntimestate.New(env.pool)
	peer, err := runtime.EnsureContext(t.Context(), agentruntimestate.EnsureContextInput{Ref: agentruntimestate.ContextRef{Kind: "meta", AgentID: "management-" + peerActorID, RoomID: roomID}, TargetResidency: "active"})
	if err != nil {
		t.Fatal(err)
	}
	ensured, err := runtime.EnsureContext(t.Context(), agentruntimestate.EnsureContextInput{Ref: agentruntimestate.ContextRef{Kind: "meta", AgentID: acmeOfficialAgentManagementID, RoomID: roomID}, TargetResidency: "active"})
	if err != nil {
		t.Fatal(err)
	}
	const epoch = "run-redeliver-test"
	startRuntimeEpoch(t, runtime, epoch)
	contextKey := ensured.Context.ContextKey
	state := runtimeStateTestEnv{pool: env.pool, service: runtime, contextKey: contextKey, epoch: epoch}
	bob := seedPeerHuman(t, env)

	type redeliverResult struct {
		RunID            string `json:"run_id"`
		Status           string `json:"status"`
		RedeliveredCount int    `json:"redelivered_count"`
	}
	redeliver := func(client *http.Client, runID string) (int, redeliverResult) {
		t.Helper()
		request, err := http.NewRequest(http.MethodPost, env.server.URL+"/v0/rooms/"+roomID+"/runs/"+runID+"/redeliver-unconfirmed-inputs", nil)
		if err != nil {
			t.Error(err)
			return 0, redeliverResult{}
		}
		response, err := client.Do(request)
		if err != nil {
			t.Error(err)
			return 0, redeliverResult{}
		}
		defer response.Body.Close()
		body, err := io.ReadAll(response.Body)
		if err != nil {
			t.Error(err)
			return 0, redeliverResult{}
		}
		var result redeliverResult
		if response.StatusCode == http.StatusOK {
			if err := json.Unmarshal(body, &result); err != nil || result.RunID != runID {
				t.Errorf("redeliver body %s: %v", body, err)
			}
		}
		return response.StatusCode, result
	}
	inputsFor := func(messageID string) int {
		return countRows(t, env, `SELECT count(*) FROM agent_runtime_inputs WHERE context_key=$1 AND source_message_id=$2`, contextKey, messageID)
	}
	claim := func(claimID, runID string) {
		t.Helper()
		claimed, err := runtime.ClaimLocalRun(t.Context(), agentruntimestate.ClaimLocalRunInput{ClaimID: claimID, ContextKey: contextKey, Epoch: epoch})
		if err != nil || claimed.Run == nil || claimed.Run.RunID != runID {
			t.Fatalf("claim %s: result=%+v err=%v", runID, claimed, err)
		}
	}
	settleUncertain := func(runID, group string) {
		t.Helper()
		if err := runtime.AssignSteerRun(t.Context(), agentruntimestate.AssignSteerRunInput{ContextKey: contextKey, Epoch: epoch, GroupID: group, RunID: runID}); err != nil {
			t.Fatal(err)
		}
		if err := runtime.CompleteSteer(t.Context(), agentruntimestate.CompleteSteerInput{ContextKey: contextKey, Epoch: epoch, GroupID: group, RunID: runID, Outcome: "uncertain"}); err != nil {
			t.Fatal(err)
		}
	}
	finishAs := func(runID, terminal string) {
		t.Helper()
		if _, err := runtime.FinishLocalRun(t.Context(), agentruntimestate.FinishLocalRunInput{ContextKey: contextKey, Epoch: epoch, RunID: runID, Terminal: json.RawMessage(terminal)}); err != nil {
			t.Fatal(err)
		}
	}
	finish := func(runID string) { t.Helper(); finishAs(runID, `{"type":"succeeded"}`) }
	// steerMention posts a mention while a Run serves the Room Inbox, so it
	// steers into that Run, and returns the Message and its steer group.
	steerMention := func(key string) (string, string) {
		t.Helper()
		messageID := createMentionMessage(t, env, alice, roomID, key, "actor_acme_official", "agent")
		queued := queuedRuntimeInbox(t, env.pool, contextKey, messageID)
		if queued.Status != "steering" || queued.SteerGroupID == "" {
			t.Fatalf("mention did not steer: %+v", queued)
		}
		return messageID, queued.SteerGroupID
	}

	firstMessage := createHumanMessage(t, env, alice, roomID, "Start working", "redeliver-first")
	first := acceptPresentationInboxMessage(t, state, roomID, firstMessage)
	claim("claim-first", first.RunID)
	followUp, followUpGroup := steerMention("redeliver-follow-up")
	// The peer Agent received the follow-up too; a resend must not reach it.
	if got := countRows(t, env, `SELECT count(*) FROM agent_runtime_inputs WHERE context_key=$1 AND source_message_id IN ($2,$3)`, peer.Context.ContextKey, firstMessage, followUp); got != 2 {
		t.Fatalf("peer Agent did not receive the Messages: %d", got)
	}
	settleUncertain(first.RunID, followUpGroup)
	// A runtime question answer settles uncertain on the same Run, but its
	// Run is gone once it finishes, so it is never placed again.
	answerSource := createHumanMessage(t, env, alice, roomID, "Answer source", "redeliver-answer-source")
	if _, err := env.pool.Exec(t.Context(), `INSERT INTO agent_runtime_inputs(context_key,input_id,payload,payload_hash,source_kind,source_message_id,
		status,selection_result,steer_group_id,local_run_id)
		VALUES($1,'runtime-response-test',jsonb_build_object('messageId','runtime-response-test'),sha256(convert_to(jsonb_build_object('messageId','runtime-response-test')::text,'UTF8')),
		'internal',$2,'steering','{"selected":"runtime_response"}'::jsonb,'steer-runtime-response-test',$3)`, contextKey, answerSource, first.RunID); err != nil {
		t.Fatal(err)
	}
	settleUncertain(first.RunID, "steer-runtime-response-test")

	if status, result := redeliver(alice, first.RunID); status != 200 || result.Status != "nothing_to_redeliver" || result.RedeliveredCount != 0 {
		t.Fatalf("running Run redelivered: %d %+v", status, result)
	}
	if got := inputsFor(followUp); got != 1 {
		t.Fatalf("running Run placed the follow-up again: %d", got)
	}
	finish(first.RunID)

	// The database function refuses a follow-up whose Message is gone or
	// whose Context no longer takes input.
	for name, change := range map[string][]any{
		"deleted Message":    {`DELETE FROM messages WHERE id=$1`, followUp},
		"terminated Context": {`UPDATE agent_execution_contexts SET terminal_reason='context_deleted',terminated_at=clock_timestamp() WHERE context_key=$1`, contextKey},
	} {
		func() {
			tx, err := env.pool.Begin(t.Context())
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback(t.Context())
			if _, err := tx.Exec(t.Context(), change[0].(string), change[1:]...); err != nil {
				t.Fatalf("%s: %v", name, err)
			}
			var placed *string
			if err := tx.QueryRow(t.Context(), `SELECT redeliver_agent_runtime_input($1,$2)`, contextKey, queuedRuntimeInbox(t, env.pool, contextKey, followUp).InputID).Scan(&placed); err != nil {
				t.Fatalf("%s: %v", name, err)
			}
			if placed != nil {
				t.Fatalf("%s placed input %s", name, *placed)
			}
		}()
	}

	if status, _ := redeliver(bob, first.RunID); status != 404 {
		t.Fatalf("non-member status %d", status)
	}
	if status, _ := redeliver(alice, "missing-run"); status != 404 {
		t.Fatalf("missing Run status %d", status)
	}
	answersBefore := inputsFor(answerSource)
	messagesBefore := countRows(t, env, `SELECT count(*) FROM messages WHERE room_id=$1`, roomID)
	peerInputs := countRows(t, env, `SELECT count(*) FROM agent_runtime_inputs WHERE context_key=$1`, peer.Context.ContextKey)
	otherInputs := countRows(t, env, `SELECT count(*) FROM agent_runtime_inputs WHERE context_key<>$1`, contextKey)
	// Both resends wait behind a held Context lock, so they race for it at once.
	holder, err := env.pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer holder.Rollback(t.Context())
	if _, err := holder.Exec(t.Context(), `SELECT 1 FROM agent_execution_contexts WHERE context_key=$1 FOR NO KEY UPDATE`, contextKey); err != nil {
		t.Fatal(err)
	}
	results := make(chan redeliverResult, 2)
	var finished atomic.Int32
	var wait sync.WaitGroup
	for range 2 {
		wait.Add(1)
		go func() {
			defer wait.Done()
			defer finished.Add(1)
			status, result := redeliver(alice, first.RunID)
			if status != 200 {
				t.Errorf("concurrent redeliver status %d", status)
			}
			results <- result
		}()
	}
	deadline := time.Now().Add(30 * time.Second)
	for finished.Load() < 2 && countRows(t, env, `SELECT count(*) FROM pg_stat_activity
		WHERE datname=current_database() AND wait_event_type='Lock'`) < 2 {
		if time.Now().After(deadline) {
			t.Fatal("resends never waited for the Context lock")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err := holder.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
	wait.Wait()
	close(results)
	redelivered := 0
	for result := range results {
		if result.Status == "redelivered" {
			redelivered += result.RedeliveredCount
		} else if result.Status != "nothing_to_redeliver" {
			t.Fatalf("unexpected status %+v", result)
		}
	}
	if redelivered != 1 || inputsFor(followUp) != 2 || inputsFor(answerSource) != answersBefore {
		t.Fatalf("concurrent redelivery placed %d, follow-up inputs %d, answer inputs %d", redelivered, inputsFor(followUp), inputsFor(answerSource))
	}
	if got := countRows(t, env, `SELECT count(*) FROM agent_runtime_inputs WHERE context_key<>$1`, contextKey); got != otherInputs {
		t.Fatalf("resend reached another Context: %d -> %d", otherInputs, got)
	}
	if got := countRows(t, env, `SELECT count(*) FROM agent_runtime_inputs WHERE context_key=$1`, peer.Context.ContextKey); got != peerInputs {
		t.Fatalf("resend reached the peer Agent: %d -> %d", peerInputs, got)
	}
	if got := countRows(t, env, `SELECT count(*) FROM messages WHERE room_id=$1`, roomID); got != messagesBefore {
		t.Fatalf("redelivery created Messages: %d -> %d", messagesBefore, got)
	}
	var resentRun, resentStatus string
	if err := env.pool.QueryRow(t.Context(), `SELECT input.local_run_id,input.status FROM agent_runtime_inputs input
		JOIN agent_local_runs run ON run.run_id=input.local_run_id
		JOIN agent_local_run_inputs relation ON relation.run_id=run.run_id AND relation.input_id=input.input_id AND relation.relation='initial'
		WHERE input.context_key=$1 AND input.source_message_id=$2 AND input.steer_outcome IS NULL AND run.status='queued'
		 AND input.payload->>'messageId'=input.input_id`, contextKey, followUp).Scan(&resentRun, &resentStatus); err != nil {
		t.Fatalf("resent follow-up is not in a queued Run: %v", err)
	}
	if status, result := redeliver(alice, first.RunID); status != 200 || result.Status != "nothing_to_redeliver" || inputsFor(followUp) != 2 {
		t.Fatalf("repeat redeliver: %d %+v inputs %d", status, result, inputsFor(followUp))
	}

	// A resend steers into the Run that serves the Room Inbox by then.
	claim("claim-resent", resentRun)
	secondFollowUp, secondGroup := steerMention("redeliver-second-follow-up")
	settleUncertain(resentRun, secondGroup)
	finish(resentRun)
	next := acceptPresentationInboxMessage(t, state, roomID, createHumanMessage(t, env, alice, roomID, "Keep going", "redeliver-next"))
	claim("claim-next", next.RunID)
	if status, result := redeliver(alice, resentRun); status != 200 || result.Status != "redelivered" || result.RedeliveredCount != 1 {
		t.Fatalf("redeliver into running Run: %d %+v", status, result)
	}
	if got := countRows(t, env, `SELECT count(*) FROM agent_runtime_inputs WHERE context_key=$1 AND source_message_id=$2
		AND status='steering' AND steer_group_id IS NOT NULL AND local_run_id IS NULL`, contextKey, secondFollowUp); got != 1 {
		t.Fatalf("resent follow-up did not steer: %d", got)
	}
	if got := countRows(t, env, `SELECT count(*) FROM agent_runtime_inputs WHERE context_key<>$1 AND source_message_id=$2`, contextKey, secondFollowUp); got != 1 {
		t.Fatalf("resend reached another Context: %d", got)
	}

	// A resend that itself ends uncertain, here on a failed Run, can be resent
	// once more.
	resentGroup := queuedRuntimeSteer(t, env, contextKey, secondFollowUp)
	settleUncertain(next.RunID, resentGroup)
	finishAs(next.RunID, `{"type":"failed","error":"boom"}`)
	if status, result := redeliver(alice, next.RunID); status != 200 || result.Status != "redelivered" || result.RedeliveredCount != 1 {
		t.Fatalf("redeliver an uncertain resend of a failed Run: %d %+v", status, result)
	}
	if got := inputsFor(secondFollowUp); got != 3 {
		t.Fatalf("uncertain resend was not placed again: %d", got)
	}
	if status, result := redeliver(alice, next.RunID); status != 200 || result.Status != "nothing_to_redeliver" || inputsFor(secondFollowUp) != 3 {
		t.Fatalf("repeat redeliver of the failed Run: %d %+v", status, result)
	}

	// Ordinary queuing still drops a Message the Context already has.
	if _, err := env.pool.Exec(t.Context(), `SELECT queue_agent_inbox_notification($1,$2,'tenant_acme',$3,1,true)`, contextKey, "room:"+roomID, secondFollowUp); err != nil {
		t.Fatal(err)
	}
	if got := inputsFor(secondFollowUp); got != 3 {
		t.Fatalf("ordinary queue placed a known Message again: %d", got)
	}
}

// queuedRuntimeSteer returns the steer group of the Message's input still
// steering on the Context.
func queuedRuntimeSteer(t *testing.T, env *testEnv, contextKey, messageID string) string {
	t.Helper()
	var group string
	if err := env.pool.QueryRow(t.Context(), `SELECT steer_group_id FROM agent_runtime_inputs
		WHERE context_key=$1 AND source_message_id=$2 AND status='steering'`, contextKey, messageID).Scan(&group); err != nil {
		t.Fatalf("read the steering input of %s: %v", messageID, err)
	}
	return group
}
