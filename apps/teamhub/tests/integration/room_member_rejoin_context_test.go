package integration_test

import (
	"net/http"
	"strconv"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentruntimestate"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

func TestAgentRoomContextSuspendsAndRebindsAcrossMembershipEpochs(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newRoomDocumentRealtimeEnv(t)
	if _, err := env.pool.Exec(t.Context(), `
		DELETE FROM agent_execution_contexts
		WHERE agent_management_id=$1 AND context_kind='meta'`, testRuntimeAgentID); err != nil {
		t.Fatalf("clear existing Meta Contexts: %v", err)
	}
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	roomID := createPrivateRoom(t, env, alice, "Agent Context rejoin "+suffix, "agent-context-rejoin-"+suffix)
	if status, body := putRoomMember(t, env, alice, roomID, "actor_acme_official", "member"); status != http.StatusOK {
		t.Fatalf("add Agent status=%d body=%s", status, body)
	}

	contextKey, err := agentruntimestate.EncodeContextRef(agentruntimestate.ContextRef{
		Kind: "meta", AgentID: testRuntimeAgentID, RoomID: roomID,
	})
	if err != nil {
		t.Fatal(err)
	}
	service := agentruntimestate.New(env.pool)
	initial, err := service.GetContext(t.Context(), contextKey)
	if err != nil || initial.TargetResidency != "suspended" || initial.MembershipEpochID == "" {
		t.Fatalf("cold per-Room Context after admission: context=%+v err=%v", initial, err)
	}
	const fence = "agent-context-rejoin-instance"
	startRuntimeEpoch(t, service, fence)
	configurationRevision := activeRuntimeConfigurationRevision(t, env.pool)
	session, err := service.CheckpointRuntimeSession(t.Context(), agentruntimestate.CheckpointSessionInput{ContextKey: contextKey, Epoch: fence,
		Checkpoint: runtimeSessionCheckpoint(0, configurationRevision, "thread-room-rejoin"),
	})
	if err != nil || session.ThreadID != "thread-room-rejoin" {
		t.Fatalf("checkpoint Room RuntimeSession: session=%+v err=%v", session, err)
	}
	queued, err := service.SubmitTrustedTurn(t.Context(), agentruntimestate.SubmitTrustedTurnInput{ContextKey: contextKey, Epoch: fence,
		Inputs: []agentruntimestate.RuntimeInput{
			runtimeInput("agent-room-rejoin-input", "trusted_turn", "room:"+roomID, "before leave"),
		},
	})
	if err != nil {
		t.Fatalf("queue Room work before removal: %v", err)
	}

	status, _, body := env.request(alice, http.MethodDelete, "/v0/rooms/"+roomID+"/members/actor_acme_official", nil, "")
	if status != http.StatusNoContent {
		t.Fatalf("remove Agent status=%d body=%s", status, body)
	}
	left, err := service.GetContext(t.Context(), contextKey)
	if err != nil || left.TargetResidency != "suspended" || left.MembershipEpochID != initial.MembershipEpochID {
		t.Fatalf("Context after leave: context=%+v err=%v", left, err)
	}
	retainedSession, err := service.GetRuntimeSession(t.Context(), contextKey)
	if err != nil || retainedSession == nil || retainedSession.ThreadID != "thread-room-rejoin" {
		t.Fatalf("leave did not retain RuntimeSession: session=%+v err=%v", retainedSession, err)
	}
	retiredRun, err := service.GetLocalRun(t.Context(), contextKey, queued.RunID)
	if err != nil || retiredRun.Status != "canceled" {
		t.Fatalf("leave did not cancel queued Room work: run=%+v err=%v", retiredRun, err)
	}
	env.createMessage(alice, roomID, "during Agent absence", "agent-context-absence-"+suffix)
	if status, body := putRoomMember(t, env, alice, roomID, "actor_acme_official", "member"); status != http.StatusOK {
		t.Fatalf("re-add Agent status=%d body=%s", status, body)
	}

	rejoined, err := service.GetContext(t.Context(), contextKey)
	if err != nil || rejoined.MembershipEpochID == initial.MembershipEpochID || rejoined.TargetResidency != "active" {
		t.Fatalf("rejoined Context was not rebound active: context=%+v err=%v", rejoined, err)
	}
	rejoinedSession, err := service.GetRuntimeSession(t.Context(), contextKey)
	if err != nil || rejoinedSession == nil || rejoinedSession.ThreadID != "thread-room-rejoin" {
		t.Fatalf("rejoin did not restore original thread: session=%+v err=%v", rejoinedSession, err)
	}
	inboxInputs := func() int {
		t.Helper()
		return countRows(t, env, `SELECT count(*) FROM agent_runtime_inputs WHERE context_key=$1 AND source_kind='inbox'`, contextKey)
	}
	// A Message written while the Agent was away never reaches the Context.
	if got := inboxInputs(); got != 0 {
		t.Fatalf("rejoin replayed %d absence Inbox inputs", got)
	}
	retiredRun, err = service.GetLocalRun(t.Context(), contextKey, queued.RunID)
	if err != nil || retiredRun.Status != "canceled" {
		t.Fatalf("rejoin reopened revoked work: run=%+v err=%v", retiredRun, err)
	}
	// The running process writes under the new membership; the Context
	// record names it, so the Agent Service rebuilds what it prepared before.
	if _, err := service.SubmitTrustedTurn(t.Context(), agentruntimestate.SubmitTrustedTurnInput{ContextKey: contextKey, Epoch: fence,
		Inputs: []agentruntimestate.RuntimeInput{runtimeInput("rejoined-room-input", "trusted_turn", "room:"+roomID, "rejoined")},
	}); err != nil {
		t.Fatalf("current epoch write after rejoin: %v", err)
	}
	// Every later Message reaches an all-actionable Agent, so the rejoined
	// Context receives exactly the fresh one.
	if _, err := env.pool.Exec(t.Context(), `UPDATE agent_registrations SET agent_type='anotherme',receives_all_messages=true,represented_human_actor_id=created_by_actor_id WHERE actor_id='actor_acme_official'`); err != nil {
		t.Fatal(err)
	}
	env.createMessage(alice, roomID, "after Agent rejoin", "agent-context-return-"+suffix)
	if got := inboxInputs(); got != 1 {
		t.Fatalf("rejoined Context Inbox inputs=%d, want the fresh Message only", got)
	}
	// Routine reconciliation must preserve an intentional suspension in the same epoch.
	current, err := service.GetContext(t.Context(), contextKey)
	if err != nil {
		t.Fatal(err)
	}
	suspended, err := service.SetContextResidency(t.Context(), agentruntimestate.SetContextResidencyInput{ContextKey: contextKey, ExpectedRevision: current.StateRevision, TargetResidency: "suspended"})
	if err != nil {
		t.Fatal(err)
	}
	if err := agentruntimestate.EnsurePerRoomMetaContexts(t.Context(), store.New(env.pool), "actor_acme_official"); err != nil {
		t.Fatal(err)
	}
	unchanged, err := service.GetContext(t.Context(), contextKey)
	if err != nil || unchanged.TargetResidency != "suspended" || unchanged.StateRevision != suspended.StateRevision {
		t.Fatalf("same-epoch reconcile changed an intentional suspension: context=%+v err=%v", unchanged, err)
	}
	// A retained deletion tombstone must not roll back a new membership epoch.
	deleted, err := service.DeleteContext(t.Context(), agentruntimestate.DeleteContextInput{ContextKey: contextKey, ExpectedRevision: unchanged.StateRevision})
	if err != nil || !deleted {
		t.Fatalf("delete retained Context: %t %v", deleted, err)
	}
	tombstone, err := service.GetContext(t.Context(), contextKey)
	if err != nil || tombstone.TerminalReason != "context_deleted" {
		t.Fatalf("retained Context tombstone: %+v %v", tombstone, err)
	}
	status, _, body = env.request(alice, http.MethodDelete, "/v0/rooms/"+roomID+"/members/actor_acme_official", nil, "")
	if status != http.StatusNoContent {
		t.Fatalf("remove terminal Context member: %d %s", status, body)
	}
	if status, body := putRoomMember(t, env, alice, roomID, "actor_acme_official", "member"); status != http.StatusOK {
		t.Fatalf("rejoin after Context deletion: %d %s", status, body)
	}
	rebuilt, err := service.GetContext(t.Context(), contextKey)
	if err != nil || rebuilt.TerminalReason != "" || rebuilt.TargetResidency != "active" || rebuilt.MembershipEpochID == tombstone.MembershipEpochID {
		t.Fatalf("new epoch did not rebuild deleted Context: %+v %v", rebuilt, err)
	}
	if run, err := service.GetLocalRun(t.Context(), contextKey, queued.RunID); err != nil || run.Status != "canceled" {
		t.Fatalf("Context rebuild revived old Run: %+v %v", run, err)
	}
}
