package integration_test

import (
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentauth"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentcreationapproval"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/messagecreation"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/typedcard"
)

// A pending creation approval keeps its decision owner and the requesting
// Agent in the Room. A Human outside the Room cannot find the card; a member
// who does not own the decision may not take it. A denial tells the Room why.
func TestRoomMemberRemovalWaitsForPendingCreationApproval(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice, issued, roomID := newAgentCLIIdentity(t)
	bob := seedPeerHuman(t, env)
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	if _, err := env.pool.Exec(t.Context(), `UPDATE agent_registrations SET agent_type='anotherme',receives_all_messages=true,represented_human_actor_id='actor_acme_alice',visibility_scope='sponsor' WHERE actor_id='actor_acme_official'`); err != nil {
		t.Fatal(err)
	}
	segments := []messagecreation.Segment{{Type: "text", Content: "Plan the launch"}}
	members := []string{"actor_acme_alice", "actor_acme_official"}
	approval, err := agentcreationapproval.New(env.pool, agentauth.New(env.pool), typedcard.New(env.pool)).Submit(
		agentauth.WithTarget(t.Context(), "room", roomID), issued.AccessToken,
		agentcreationapproval.Input{
			RequestKind: "room_creation", InvocationID: "agent-invocation-sha256:" + strings.Repeat("e", 64),
			RoomCaller:    &agentcreationapproval.RoomCallerInput{Name: "Launch room " + suffix, MemberIDs: members, InitialMessageSegments: segments},
			RoomEffective: &agentcreationapproval.RoomEffectivePayload{Name: "Launch room " + suffix, MemberIDs: members, InitialMessageSegments: segments},
		})
	if err != nil || approval.CreationApprovalRequestID == "" {
		t.Fatalf("Room approval result=%+v err=%v", approval, err)
	}
	decide := func(client *http.Client, decision map[string]any, key string) (int, []byte) {
		status, _, body := env.request(client, http.MethodPost,
			"/v0/decisions/"+approval.CreationApprovalRequestID, decision, key)
		return status, body
	}
	approve := map[string]any{"decision": "approve", "expected_version": 1}
	if status, body := decide(bob, approve, "outsider-approval-"+suffix); status != http.StatusNotFound || !containsJSONText(body, "CARD_SOURCE_NOT_FOUND") {
		t.Fatalf("outsider decision status=%d body=%s", status, body)
	}
	promoteSecondOwner(t, env, alice, roomID)
	if status, body := decide(bob, approve, "member-approval-"+suffix); status != http.StatusForbidden || !containsJSONText(body, "CARD_FORBIDDEN") {
		t.Fatalf("non-owner decision status=%d body=%s", status, body)
	}

	assertPendingDecisionBlocksMemberRemoval(t, env, bob, roomID, "actor_acme_alice")
	assertPendingDecisionBlocksMemberRemoval(t, env, bob, roomID, "actor_acme_official")
	if status, body := decide(alice, map[string]any{"decision": "deny", "expected_version": 1, "comment": "Use the launch Room."}, "deny-approval-"+suffix); status != http.StatusOK {
		t.Fatalf("deny status=%d body=%s", status, body)
	}
	if got := countRows(t, env, `select count(*) from messages where card_context_message_id=$1 and message_kind='conversation' and body=$2`,
		approval.MessageID, "Collaboration request declined: Use the launch Room."); got != 1 {
		t.Fatalf("denial result messages=%d want=1", got)
	}
	assertMemberRemovalSucceeds(t, env, bob, roomID, "actor_acme_official")
	assertMemberRemovalSucceeds(t, env, bob, roomID, "actor_acme_alice")
}

func promoteSecondOwner(t *testing.T, env *testEnv, owner *http.Client, roomID string) {
	t.Helper()
	if status, body := putRoomMember(t, env, owner, roomID, "actor_acme_bob", "owner"); status != http.StatusOK {
		t.Fatalf("promote Bob status=%d body=%s", status, body)
	}
}

func assertPendingDecisionBlocksMemberRemoval(t *testing.T, env *testEnv, owner *http.Client, roomID, actorID string) {
	t.Helper()
	status, _, body := env.request(owner, http.MethodDelete, "/v0/rooms/"+roomID+"/members/"+actorID, nil, "")
	if status != http.StatusConflict || !containsJSONText(body, "PENDING_CARD_DECISION") {
		t.Fatalf("remove pending card member %s status=%d body=%s", actorID, status, body)
	}
	if got := countRows(t, env, "select count(*) from room_members where room_id=$1 and actor_id=$2", roomID, actorID); got != 1 {
		t.Fatalf("pending card member %s membership rows=%d want=1", actorID, got)
	}
}

func assertMemberRemovalSucceeds(t *testing.T, env *testEnv, owner *http.Client, roomID, actorID string) {
	t.Helper()
	status, _, body := env.request(owner, http.MethodDelete, "/v0/rooms/"+roomID+"/members/"+actorID, nil, "")
	if status == http.StatusNoContent {
		return
	}
	if status != http.StatusNoContent {
		t.Fatalf("remove terminal card member %s status=%d body=%s", actorID, status, body)
	}
}
