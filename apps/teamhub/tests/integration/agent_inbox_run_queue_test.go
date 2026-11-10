package integration_test

import (
	"encoding/json"
	"testing"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentruntimestate"
)

// A Message's transaction decides how it reaches each Context: it joins the
// newest queued Run that holds only the same Inbox's notifications, starts a
// queued Run otherwise, and enters each Context once.
func TestInboxMessagesQueueRunsInTheirTransaction(t *testing.T) {
	allowParallelIntegrationTest(t)
	env := newRuntimeStateTestEnv(t)
	useAllActionableRuntimeAgent(t, env)

	first := queueRuntimeInboxMessage(t, env, "queue-first", "1", "first", false)
	second := queueRuntimeInboxMessage(t, env, "queue-second", "2", "second", false)
	if first.RunID == "" || second.RunID != first.RunID || first.Status != "handled" {
		t.Fatalf("same-Inbox notifications did not share the queued Run: first=%+v second=%+v", first, second)
	}
	again := queueRuntimeInboxMessage(t, env, "queue-again", "3", "again", false)
	if _, err := env.pool.Exec(t.Context(), `SELECT queue_agent_inbox_notification($1,$2,'tenant_acme','queue-again',3,false)`,
		env.contextKey, "room:"+testRuntimeInboxRoom); err != nil {
		t.Fatal(err)
	}
	if got := countRuntimeInputs(t, env.pool, "queue-again"); got != 1 || again.RunID != first.RunID {
		t.Fatalf("repeated Message entered the Context %d times: %+v", got, again)
	}

	// A trusted turn in the queue keeps later notifications out of its Run.
	trusted, err := env.service.SubmitTrustedTurn(t.Context(), agentruntimestate.SubmitTrustedTurnInput{ContextKey: env.contextKey, Epoch: env.epoch,
		Inputs: []agentruntimestate.RuntimeInput{runtimeInput("queue-trusted-input", "trusted_turn", "", "trusted")},
	})
	if err != nil {
		t.Fatal(err)
	}
	after := queueRuntimeInboxMessage(t, env, "queue-after-trusted", "4", "after", false)
	if after.RunID == "" || after.RunID == first.RunID || after.RunID == trusted.RunID {
		t.Fatalf("notification after a trusted turn joined another Run: %+v trusted=%s", after, trusted.RunID)
	}

	// The first claim takes the oldest Run; it continues nothing.
	claimed, err := env.service.ClaimLocalRun(t.Context(), agentruntimestate.ClaimLocalRunInput{
		ClaimID: "queue-claim-first", ContextKey: env.contextKey, Epoch: env.epoch,
	})
	if err != nil || claimed.Run == nil || claimed.Run.RunID != first.RunID || len(claimed.Run.Inputs) != 3 || claimed.Run.ContinuesContext {
		t.Fatalf("claim first Run=%+v err=%v", claimed, err)
	}

	// A targeted Message steers the running Run that reads its Inbox.
	steered := queueRuntimeInboxMessage(t, env, "queue-mention", "5", "mention", true)
	if steered.Status != "steering" || steered.SteerGroupID == "" || steered.RunID != "" {
		t.Fatalf("mention beside the reading Run did not steer: %+v", steered)
	}
	var payload json.RawMessage
	if err := env.pool.QueryRow(t.Context(), `SELECT payload FROM agent_runtime_inputs WHERE input_id=$1`, steered.InputID).Scan(&payload); err != nil {
		t.Fatal(err)
	}
	var notification struct {
		Accepted struct {
			Targeted bool `json:"targeted"`
			Messages []struct {
				ID           string `json:"id"`
				Mentioned    bool   `json:"mentioned"`
				MessageKind  string `json:"messageKind"`
				FiredRoutine *bool  `json:"firedRoutine"`
			} `json:"messages"`
		} `json:"acceptedNotification"`
	}
	if err := json.Unmarshal(payload, &notification); err != nil || !notification.Accepted.Targeted ||
		len(notification.Accepted.Messages) != 1 || notification.Accepted.Messages[0].ID != "queue-mention" || !notification.Accepted.Messages[0].Mentioned ||
		notification.Accepted.Messages[0].MessageKind != "conversation" || notification.Accepted.Messages[0].FiredRoutine != nil {
		t.Fatalf("steer payload=%s err=%v", payload, err)
	}
	if _, err := env.service.FinishLocalRun(t.Context(), agentruntimestate.FinishLocalRunInput{ContextKey: env.contextKey, Epoch: env.epoch,
		RunID: first.RunID, Terminal: json.RawMessage(`{"type":"succeeded"}`),
	}); err != nil {
		t.Fatal(err)
	}

	// A running Run that does not read the Inbox is not steered.
	if _, err := env.service.CancelLocalRun(t.Context(), agentruntimestate.CancelLocalRunInput{ContextKey: env.contextKey, Epoch: env.epoch, RunID: after.RunID}); err != nil {
		t.Fatal(err)
	}
	other, err := env.service.ClaimLocalRun(t.Context(), agentruntimestate.ClaimLocalRunInput{
		ClaimID: "queue-claim-trusted", ContextKey: env.contextKey, Epoch: env.epoch,
	})
	if err != nil || other.Run == nil || other.Run.RunID != trusted.RunID || !other.Run.ContinuesContext {
		t.Fatalf("claim trusted Run=%+v err=%v", other, err)
	}
	beside := queueRuntimeInboxMessage(t, env, "queue-beside", "6", "beside", true)
	if beside.Status != "handled" || beside.RunID == "" || beside.RunID == trusted.RunID {
		t.Fatalf("mention beside a Run that does not read the Inbox: %+v", beside)
	}
}

// An Inbox input names each Message's kind and whether a Routine fired it, so
// the Agent Service can tell a Routine from a proactive wake.
func TestInboxInputNamesWhatQueuedIt(t *testing.T) {
	allowParallelIntegrationTest(t)
	env := newRuntimeStateTestEnv(t)
	payload := func(messageID string, firedRoutine bool) json.RawMessage {
		t.Helper()
		if _, err := env.pool.Exec(t.Context(), `
			INSERT INTO messages(id,tenant_id,room_id,author_actor_id,body,segments,message_kind,fired_routine_id,fired_routine_instruction)
			VALUES($1,'tenant_acme',$2,'actor_acme_alice','wake','[{"type":"text","content":"wake"}]'::jsonb,'agent_runtime',
				CASE WHEN $3 THEN 'routine-1' END,CASE WHEN $3 THEN 'check in' END)`,
			messageID, testRuntimeInboxRoom, firedRoutine); err != nil {
			t.Fatal(err)
		}
		var payload json.RawMessage
		if err := env.pool.QueryRow(t.Context(), `
			SELECT agent_inbox_notification_payload('input-'||$1,'tenant_acme',agent_actor_id,$2,$1,1,false,false)
			FROM agent_execution_contexts WHERE context_key=$3`,
			messageID, "room:"+testRuntimeInboxRoom, env.contextKey).Scan(&payload); err != nil {
			t.Fatal(err)
		}
		return payload
	}
	type origin struct {
		Accepted struct {
			Messages []struct {
				MessageKind  string `json:"messageKind"`
				FiredRoutine *bool  `json:"firedRoutine"`
			} `json:"messages"`
		} `json:"acceptedNotification"`
	}
	for _, test := range []struct {
		messageID    string
		firedRoutine bool
	}{{"wake-routine", true}, {"wake-proactive", false}} {
		var got origin
		raw := payload(test.messageID, test.firedRoutine)
		if err := json.Unmarshal(raw, &got); err != nil || len(got.Accepted.Messages) != 1 ||
			got.Accepted.Messages[0].MessageKind != "agent_runtime" ||
			(got.Accepted.Messages[0].FiredRoutine != nil) != test.firedRoutine {
			t.Fatalf("%s payload=%s err=%v", test.messageID, raw, err)
		}
	}
}

// A queued Run lists its Context in the fallback scan once it has waited past
// the grace period, and in the work a new epoch takes up regardless of age,
// without any wake hint reaching the Agent Service.
func TestQueuedInboxRunIsDurableWork(t *testing.T) {
	allowParallelIntegrationTest(t)
	env := newRuntimeStateTestEnv(t)
	useAllActionableRuntimeAgent(t, env)
	if _, err := env.pool.Exec(t.Context(), `UPDATE agent_execution_contexts SET target_residency='suspended' WHERE context_key=$1`, env.contextKey); err != nil {
		t.Fatal(err)
	}
	waiting := func() []string {
		t.Helper()
		keys, err := env.service.ListWaitingContexts(t.Context())
		if err != nil {
			t.Fatal(err)
		}
		return keys
	}
	if keys := waiting(); len(keys) != 0 {
		t.Fatalf("idle Context waits: %v", keys)
	}
	queueRuntimeInboxMessage(t, env, "durable-queued", "1", "queued", false)
	// The fallback scan only reports Runs that waited past its grace period.
	if keys := waiting(); len(keys) != 0 {
		t.Fatalf("fresh queued Run waits: %v", keys)
	}
	if _, err := env.pool.Exec(t.Context(), `UPDATE agent_local_runs SET created_at=clock_timestamp()-interval '31 seconds' WHERE context_key=$1 AND status='queued'`, env.contextKey); err != nil {
		t.Fatal(err)
	}
	if keys := waiting(); len(keys) != 1 || keys[0] != env.contextKey {
		t.Fatalf("waiting Contexts=%v, want the queued one", keys)
	}
	started, err := env.service.StartEpoch(t.Context(), "durable-queued-epoch")
	if err != nil || len(started.WaitingContextKeys) != 1 || started.WaitingContextKeys[0] != env.contextKey {
		t.Fatalf("queued Run was not taken up by a new epoch: %+v %v", started, err)
	}
}
