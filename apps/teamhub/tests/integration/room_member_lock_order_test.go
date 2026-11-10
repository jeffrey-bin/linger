package integration_test

import (
	"context"
	"net/http"
	"strconv"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

// Lock order: memberships -> Contexts -> rooms. A human message must lock the
// Room memberships of its mentioned and skill-referenced Agents before any
// rooms row, because the runtime takes member SHARE, then the Context, then
// rooms SHARE. The helpers below mirror that runtime path
// (lockFencedInboxContextForOwner + requireContextInboxAuthority) with the
// same queries and the same order.

const roomMemberLockOrderAgentID = "actor_acme_official"

// roomMemberLockOrderFixture creates a private Room with the official Agent as
// a member and returns the Room ID, the Agent's meta Context key, and the
// human owner's client.
func roomMemberLockOrderFixture(t *testing.T, env *testEnv, suffix string) (string, string) {
	t.Helper()
	owner := env.login("alice", alicePassword)
	roomID := createPrivateRoom(t, env, owner, "Room member lock order "+suffix, "room-member-lock-order-"+suffix)
	if status, body := putRoomMember(t, env, owner, roomID, roomMemberLockOrderAgentID, "member"); status != http.StatusOK {
		t.Fatalf("add Agent member status=%d body=%s", status, body)
	}
	var contextKey string
	if err := env.pool.QueryRow(t.Context(), `SELECT context_key FROM agent_execution_contexts WHERE room_id=$1 AND agent_actor_id=$2 LIMIT 1`,
		roomID, roomMemberLockOrderAgentID).Scan(&contextKey); err != nil {
		t.Fatalf("load Agent Context key: %v", err)
	}
	return roomID, contextKey
}

// roomMemberLockOrderMentionPost posts a human message that mentions the Agent.
func roomMemberLockOrderMentionPost(t *testing.T, env *testEnv, roomID, key string) <-chan lockOrderResult[lockOrderHTTPResult] {
	owner := env.login("alice", alicePassword)
	return startLockOrderOperation(func() (lockOrderHTTPResult, error) {
		status, _, body := env.request(owner, http.MethodPost, "/v0/rooms/"+roomID+"/messages", map[string]any{
			"raw_message": "@official please look",
			"segments": []map[string]any{
				{"type": "reference", "content": "@official", "target": roomMemberLockOrderAgentID, "target_type": "agent"},
				{"type": "text", "content": " please look"},
			},
		}, key)
		return lockOrderHTTPResult{status: status, body: body}, nil
	})
}

// roomMemberLockOrderScriptedTx opens a transaction on the pool for a scripted
// runtime or Context-holder path and returns it with its backend PID.
func roomMemberLockOrderScriptedTx(t *testing.T, env *testEnv) (pgx.Tx, int) {
	t.Helper()
	tx, err := env.pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = tx.Rollback(t.Context()) })
	var pid int
	if err := tx.QueryRow(t.Context(), `SELECT pg_backend_pid()`).Scan(&pid); err != nil {
		t.Fatal(err)
	}
	return tx, pid
}

// Guard: a human message that mentions an Agent must not deadlock with the
// runtime's member SHARE -> Context -> rooms SHARE path.
func TestRoomMemberLockOrderMessageMentionVsContextRecovery(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, _ := newRoomDocumentRealtimeEnv(t)
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	roomID, contextKey := roomMemberLockOrderFixture(t, env, suffix)
	monitor := connectLockOrderMonitor(t, env)

	runtimeTx, runtimePID := roomMemberLockOrderScriptedTx(t, env)
	if _, err := store.New(runtimeTx).LockDirectInboxMembershipAuthority(t.Context(), store.LockDirectInboxMembershipAuthorityParams{
		RoomIds: []string{roomID}, TenantID: acmeTenant, AgentActorID: roomMemberLockOrderAgentID,
	}); err != nil {
		t.Fatal(err)
	}

	post := roomMemberLockOrderMentionPost(t, env, roomID, "room-member-lock-order-mention-"+suffix)
	waitForLockOrderWaiter(t, monitor, runtimePID, 0, 0, false)

	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	queries := store.New(runtimeTx)
	if _, err := queries.LockAgentExecutionContext(ctx, contextKey); err != nil {
		t.Fatalf("runtime Context lock while message waits on membership: %v", err)
	}
	if _, err := queries.LockDirectInboxRoomAuthority(ctx, store.LockDirectInboxRoomAuthorityParams{
		TenantID: acmeTenant, RoomID: roomID,
	}); err != nil {
		t.Fatalf("runtime rooms SHARE lock while message waits on membership: %v", err)
	}
	if err := runtimeTx.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}

	awaitLockOrderOperationsWithoutCycle(t, monitor, lockOrderDone(post))
	result := receiveLockOrderResult(t, post, "mention message")
	if result.err != nil || result.value.status != http.StatusCreated {
		t.Fatalf("mention message err=%v status=%d body=%s", result.err, result.value.status, result.value.body)
	}
}

// Guard: a human message that mentions an Agent must not deadlock with a
// Context-holding transaction that allocates a Room sequence while the runtime
// waits for that Context. The cycle is message -> runtime -> Context holder ->
// message.
func TestRoomMemberLockOrderMessageMentionVsContextAndRoomSeq(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, _ := newRoomDocumentRealtimeEnv(t)
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	roomID, contextKey := roomMemberLockOrderFixture(t, env, suffix)
	monitor := connectLockOrderMonitor(t, env)

	runtimeTx, runtimePID := roomMemberLockOrderScriptedTx(t, env)
	if _, err := store.New(runtimeTx).LockDirectInboxMembershipAuthority(t.Context(), store.LockDirectInboxMembershipAuthorityParams{
		RoomIds: []string{roomID}, TenantID: acmeTenant, AgentActorID: roomMemberLockOrderAgentID,
	}); err != nil {
		t.Fatal(err)
	}
	contextTx, contextPID := roomMemberLockOrderScriptedTx(t, env)
	if _, err := store.New(contextTx).LockAgentExecutionContext(t.Context(), contextKey); err != nil {
		t.Fatal(err)
	}

	post := roomMemberLockOrderMentionPost(t, env, roomID, "room-member-lock-order-seq-"+suffix)
	waitForLockOrderWaiter(t, monitor, runtimePID, contextPID, 0, false)

	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	seqResults := startLockOrderOperation(func() (int64, error) {
		return store.New(contextTx).AllocateRoomSeq(ctx, roomID)
	})
	runtimeResults := startLockOrderOperation(func() (struct{}, error) {
		return struct{}{}, roomMemberLockOrderRuntimeContextOnly(ctx, runtimeTx, contextKey)
	})

	// Context holder allocates a Room sequence, then commits. The sequence
	// stays unused, and that is acceptable for this lock-order guard.
	seq := receiveLockOrderResult(t, seqResults, "Room sequence allocation")
	if seq.err != nil {
		t.Fatalf("Room sequence allocation while message waits: %v", seq.err)
	}
	if err := contextTx.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}

	runtime := receiveLockOrderResult(t, runtimeResults, "runtime Context lock")
	if runtime.err != nil {
		t.Fatalf("runtime Context lock after Context holder commit: %v", runtime.err)
	}
	if err := runtimeTx.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}

	awaitLockOrderOperationsWithoutCycle(t, monitor, lockOrderDone(post))
	result := receiveLockOrderResult(t, post, "mention message")
	if result.err != nil || result.value.status != http.StatusCreated {
		t.Fatalf("mention message err=%v status=%d body=%s", result.err, result.value.status, result.value.body)
	}
}

// roomMemberLockOrderRuntimeContextOnly takes the runtime's Context lock after
// the member SHARE it already holds.
func roomMemberLockOrderRuntimeContextOnly(ctx context.Context, tx pgx.Tx, contextKey string) error {
	_, err := store.New(tx).LockAgentExecutionContext(ctx, contextKey)
	return err
}

// Guard for the NO KEY UPDATE choice of the message's membership prelock. A
// FOR UPDATE prelock would conflict with the FOR KEY SHARE that
// ListRoomMentionTargets takes on the same membership, and agent send paths take
// that KEY SHARE after holding rooms SHARE. This test checks the reader is not
// blocked by the message.
func TestRoomMemberLockOrderMessageMentionVsAgentKeyShareReader(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, _ := newRoomDocumentRealtimeEnv(t)
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	roomID, _ := roomMemberLockOrderFixture(t, env, suffix)
	monitor := connectLockOrderMonitor(t, env)

	sharedTx, sharedPID := roomMemberLockOrderScriptedTx(t, env)
	if _, err := sharedTx.Exec(t.Context(), `SELECT id FROM rooms WHERE id=$1 FOR SHARE`, roomID); err != nil {
		t.Fatal(err)
	}

	post := roomMemberLockOrderMentionPost(t, env, roomID, "room-member-lock-order-keyshare-"+suffix)
	waitForLockOrderWaiter(t, monitor, sharedPID, 0, 0, false)

	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	targets := startLockOrderOperation(func() (int, error) {
		rows, err := store.New(sharedTx).ListRoomMentionTargets(ctx, store.ListRoomMentionTargetsParams{
			RoomID: roomID, ActorIds: []string{roomMemberLockOrderAgentID},
		})
		return len(rows), err
	})
	target := receiveLockOrderResult(t, targets, "mention target KEY SHARE read")
	if target.err != nil || target.value != 1 {
		t.Fatalf("mention target KEY SHARE read targets=%d err=%v, want 1 target without blocking", target.value, target.err)
	}
	if err := sharedTx.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}

	awaitLockOrderOperationsWithoutCycle(t, monitor, lockOrderDone(post))
	result := receiveLockOrderResult(t, post, "mention message")
	if result.err != nil || result.value.status != http.StatusCreated {
		t.Fatalf("mention message err=%v status=%d body=%s", result.err, result.value.status, result.value.body)
	}
}

// roomMemberLockOrderRemove removes a member in one request.
func roomMemberLockOrderRemove(t *testing.T, env *testEnv, owner *http.Client, roomID, actorID string) {
	t.Helper()
	status, _, body := env.request(owner, http.MethodDelete, "/v0/rooms/"+roomID+"/members/"+actorID, nil, "")
	if status != http.StatusNoContent {
		t.Fatalf("remove member status=%d body=%s", status, body)
	}
}

// roomMemberLockOrderRunFinishTx holds an Agent's per-room meta Context the way a
// run finish does: Context first, then a Room sequence allocation.
func roomMemberLockOrderRunFinishContext(t *testing.T, env *testEnv, contextKey string) (pgx.Tx, int) {
	t.Helper()
	tx, pid := roomMemberLockOrderScriptedTx(t, env)
	if _, err := store.New(tx).LockAgentExecutionContext(t.Context(), contextKey); err != nil {
		t.Fatal(err)
	}
	return tx, pid
}

// roomMemberLockOrderAllocateThenCommit allocates a Room sequence on the run
// finish transaction within 10s, then commits it.
func roomMemberLockOrderAllocateThenCommit(t *testing.T, tx pgx.Tx, roomID string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	if _, err := store.New(tx).AllocateRoomSeq(ctx, roomID); err != nil {
		t.Fatalf("run finish Room sequence allocation while the lock waits: %v", err)
	}
	if err := tx.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
}

// Guard: removing an Agent takes its per-room Context before the membership
// write. A run finish that holds the Context and allocates a Room sequence
// must not wait on the removal.
func TestRoomMemberLockOrderRevocationVsRunFinish(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newRoomDocumentRealtimeEnv(t)
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	roomID, contextKey := roomMemberLockOrderFixture(t, env, suffix)
	monitor := connectLockOrderMonitor(t, env)
	finish, finishPID := roomMemberLockOrderRunFinishContext(t, env, contextKey)

	remove := startLockOrderOperation(func() (lockOrderHTTPResult, error) {
		status, _, body := env.request(alice, http.MethodDelete, "/v0/rooms/"+roomID+"/members/"+roomMemberLockOrderAgentID, nil, "")
		return lockOrderHTTPResult{status: status, body: body}, nil
	})
	waitForLockOrderWaiter(t, monitor, finishPID, 0, 0, false)

	roomMemberLockOrderAllocateThenCommit(t, finish, roomID)
	result := receiveLockOrderResult(t, remove, "Agent removal")
	if result.err != nil || result.value.status != http.StatusNoContent {
		t.Fatalf("Agent removal err=%v status=%d body=%s", result.err, result.value.status, result.value.body)
	}
}

// Guard: re-adding an Agent rebinds its existing per-room Context. A run finish
// that holds that Context must not wait on the Room sequence held by the add.
func TestRoomMemberLockOrderReadmissionVsRunFinish(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newRoomDocumentRealtimeEnv(t)
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	roomID, contextKey := roomMemberLockOrderFixture(t, env, suffix)
	monitor := connectLockOrderMonitor(t, env)
	roomMemberLockOrderRemove(t, env, alice, roomID, roomMemberLockOrderAgentID)
	finish, finishPID := roomMemberLockOrderRunFinishContext(t, env, contextKey)

	readd := startLockOrderOperation(func() (lockOrderHTTPResult, error) {
		status, body := putRoomMember(t, env, alice, roomID, roomMemberLockOrderAgentID, "member")
		return lockOrderHTTPResult{status: status, body: body}, nil
	})
	waitForLockOrderWaiter(t, monitor, finishPID, 0, 0, false)

	roomMemberLockOrderAllocateThenCommit(t, finish, roomID)
	result := receiveLockOrderResult(t, readd, "Agent re-add")
	if result.err != nil || result.value.status != http.StatusOK {
		t.Fatalf("Agent re-add err=%v status=%d body=%s", result.err, result.value.status, result.value.body)
	}
}

// Guard: deleting a Room revokes its Agent members, which takes their per-room
// Contexts before the Room's deletion write.
func TestRoomMemberLockOrderRoomDeletionVsRunFinish(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newRoomDocumentRealtimeEnv(t)
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	roomID, contextKey := roomMemberLockOrderFixture(t, env, suffix)
	monitor := connectLockOrderMonitor(t, env)
	finish, finishPID := roomMemberLockOrderRunFinishContext(t, env, contextKey)

	deletion := startLockOrderOperation(func() (lockOrderHTTPResult, error) {
		status, _, body := env.request(alice, http.MethodDelete, "/v0/rooms/"+roomID, nil, "lock-order-room-delete-"+suffix)
		return lockOrderHTTPResult{status: status, body: body}, nil
	})
	waitForLockOrderWaiter(t, monitor, finishPID, 0, 0, false)

	roomMemberLockOrderAllocateThenCommit(t, finish, roomID)
	result := receiveLockOrderResult(t, deletion, "Room deletion")
	if result.err != nil || result.value.status != http.StatusNoContent {
		t.Fatalf("Room deletion err=%v status=%d body=%s", result.err, result.value.status, result.value.body)
	}
}

// Guard: a human message that mentions a removed Agent admits it again and
// rebinds its per-room Context. That admission must take the Context before
// the rooms lock, so a run finish holding the Context cannot deadlock it.
func TestRoomMemberLockOrderMentionReadmissionVsRunFinish(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newRoomDocumentRealtimeEnv(t)
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	roomID, contextKey := roomMemberLockOrderFixture(t, env, suffix)
	monitor := connectLockOrderMonitor(t, env)
	roomMemberLockOrderRemove(t, env, alice, roomID, roomMemberLockOrderAgentID)
	finish, finishPID := roomMemberLockOrderRunFinishContext(t, env, contextKey)

	post := roomMemberLockOrderMentionPost(t, env, roomID, "room-member-lock-order-readmit-"+suffix)
	waitForLockOrderWaiter(t, monitor, finishPID, 0, 0, false)

	roomMemberLockOrderAllocateThenCommit(t, finish, roomID)
	result := receiveLockOrderResult(t, post, "mention re-admission")
	if result.err != nil || result.value.status != http.StatusCreated {
		t.Fatalf("mention re-admission err=%v status=%d body=%s", result.err, result.value.status, result.value.body)
	}
}
