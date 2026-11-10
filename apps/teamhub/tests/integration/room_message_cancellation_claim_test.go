package integration_test

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentruntimestate"
)

// TestClaimSkipsQueuedRunOfCanceledRoomMessage pins that a cancellation fact
// recorded after a Room Message queued its Run keeps Claim from starting that
// Run, while later Messages stay runnable.
func TestClaimSkipsQueuedRunOfCanceledRoomMessage(t *testing.T) {
	allowParallelIntegrationTest(t)
	for _, scope := range []string{"room", "thread"} {
		t.Run(scope, func(t *testing.T) {
			gateway := httptest.NewServer(http.NotFoundHandler())
			defer gateway.Close()
			env, alice := newAgentRunEnv(t, gateway.URL)
			if scope != "thread" {
				if _, err := env.pool.Exec(t.Context(), `UPDATE agent_registrations SET agent_type='anotherme',receives_all_messages=true,represented_human_actor_id=created_by_actor_id WHERE actor_id='actor_acme_official'`); err != nil {
					t.Fatal(err)
				}
			}
			roomID := createPrivateRoom(t, env, alice, "Canceled claim", "cancel-before-claim")
			if code, body := putRoomMember(t, env, alice, roomID, "actor_acme_official", "member"); code != 200 {
				t.Fatalf("member %d %s", code, body)
			}
			cancel := func(messageRoomID, messageID string) {
				t.Helper()
				if _, err := env.pool.Exec(t.Context(), `INSERT INTO room_agent_message_cancellations(tenant_id,room_id,agent_actor_id,message_id)
					VALUES('tenant_acme',$1,'actor_acme_official',$2)`, messageRoomID, messageID); err != nil {
					t.Fatal(err)
				}
			}
			contextRoomID := roomID
			if scope == "thread" {
				rootID := createMentionMessage(t, env, alice, roomID, "cancel-thread-root", "actor_acme_official", "agent")
				thread := requestMessageThread(t, env, alice, roomID, rootID, "cancel-create-thread")
				if thread.status != http.StatusCreated {
					t.Fatalf("thread %d %s", thread.status, thread.body)
				}
				// The root mention queued a Run in the parent Room's Context;
				// cancel it so only the Thread Messages are left to claim.
				cancel(contextRoomID, rootID)
				roomID = thread.room.ID
			}
			runtime := agentruntimestate.New(env.pool)
			ref := agentruntimestate.ContextRef{Kind: "meta", AgentID: acmeOfficialAgentManagementID, RoomID: contextRoomID}
			ensured, err := runtime.EnsureContext(t.Context(), agentruntimestate.EnsureContextInput{Ref: ref, TargetResidency: "active"})
			if err != nil {
				t.Fatal(err)
			}
			const fence = "cancel-claim-instance"
			startRuntimeEpoch(t, runtime, fence)
			createRunnableMessage := func(body, key string) string {
				if scope == "thread" {
					return createMentionMessage(t, env, alice, roomID, key, "actor_acme_official", "agent")
				}
				return createHumanMessage(t, env, alice, roomID, body, key)
			}
			canceledID := createRunnableMessage("Queued message", "cancel-queued-message")
			queued := queuedRuntimeInbox(t, env.pool, ensured.Context.ContextKey, canceledID)
			cancel(roomID, canceledID)
			claimed, err := runtime.ClaimLocalRun(t.Context(), agentruntimestate.ClaimLocalRunInput{ClaimID: "cancel-queued-claim", ContextKey: ensured.Context.ContextKey, Epoch: fence})
			if err != nil || claimed.Run != nil {
				t.Fatalf("canceled queue started %+v %v", claimed, err)
			}
			observed, err := runtime.GetLocalRun(t.Context(), ensured.Context.ContextKey, queued.RunID)
			if err != nil || observed.Status != "canceled" {
				t.Fatalf("queue terminal %+v %v", observed, err)
			}
			freshID := createRunnableMessage("Fresh message", "cancel-fresh-message")
			accepted := queuedRuntimeInbox(t, env.pool, ensured.Context.ContextKey, freshID)
			claimed, err = runtime.ClaimLocalRun(t.Context(), agentruntimestate.ClaimLocalRunInput{ClaimID: "cancel-fresh-claim", ContextKey: ensured.Context.ContextKey, Epoch: fence})
			if err != nil || claimed.Run == nil || claimed.Run.RunID != accepted.RunID {
				t.Fatalf("fresh work %+v %v", claimed, err)
			}
		})
	}
}
