package integration_test

import (
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentcredential"
)

// An ask-user card asks the Agent's Sponsor and carries no Runtime request:
// its answer is the hidden decision Message that mentions the Agent, so it
// notifies the Agent's Room Context like any other card result, even after the
// asking Run has ended.
func TestAgentAskUserPostsQuestionCardAnsweredAsMention(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newRoomDocumentRealtimeEnvWithRuntimeOptions(t, 0, 0, 0, roomDocumentRuntimeTestOptions{})
	unique := strings.ReplaceAll(time.Now().Format("150405.000000000"), ".", "")
	roomID := createPrivateRoom(t, env, alice, "Agent question "+unique, "agent-question-room-"+unique)
	if status, body := putRoomMember(t, env, alice, roomID, "actor_acme_official", "member"); status != http.StatusOK {
		t.Fatalf("add Agent status=%d body=%s", status, body)
	}
	issued, err := agentcredential.New(env.pool).IssueManaged(t.Context(), acmeOfficialAgentManagementID, "ask-user CLI")
	if err != nil {
		t.Fatal(err)
	}
	questions := []any{
		map[string]any{"question": "Noodles or rice?", "options": []any{"Noodles", "Rice"}},
		map[string]any{"question": "Sides?", "options": []any{"Egg", "Tofu", "Greens"}, "multiple": true},
		map[string]any{"question": "Anything to avoid?", "options": []any{"Nothing", "Spicy"}},
	}
	ask := func(operation, title string) (int, []byte) {
		t.Helper()
		return postAgentInRoom(t, env, issued.AccessToken, roomID, "/api/agent/v1/user-questions", map[string]any{
			"invocation_id": mcpFileInvocationID(operation + "-" + unique), "title": title, "questions": questions,
		})
	}

	status, body := ask("first", "Lunch order")
	if status != http.StatusOK || !strings.Contains(string(body), `"status":"pending"`) {
		t.Fatalf("ask status=%d body=%s", status, body)
	}
	var created struct {
		InteractionID string `json:"interaction_id"`
		MessageID     string `json:"message_id"`
	}
	decode(t, body, &created)
	if status, replay := ask("first", "Lunch order"); status != http.StatusOK || !strings.Contains(string(replay), created.InteractionID) {
		t.Fatalf("replay status=%d body=%s", status, replay)
	}
	if status, body := ask("first", "Dinner order"); status != http.StatusConflict {
		t.Fatalf("changed replay status=%d body=%s", status, body)
	}
	if status, body := postAgentInRoom(t, env, issued.AccessToken, roomID, "/api/agent/v1/user-questions", map[string]any{
		"invocation_id": mcpFileInvocationID("repeated-" + unique), "title": "Lunch order",
		"questions": []any{map[string]any{"question": "Noodles or rice?", "options": []any{"Rice", " Rice"}}},
	}); status != http.StatusBadRequest {
		t.Fatalf("repeated option status=%d body=%s", status, body)
	}
	// An open question belongs in a message, so a question without options is refused.
	if status, body := postAgentInRoom(t, env, issued.AccessToken, roomID, "/api/agent/v1/user-questions", map[string]any{
		"invocation_id": mcpFileInvocationID("open-" + unique), "title": "Lunch order",
		"questions": []any{map[string]any{"question": "Anything to avoid?"}},
	}); status != http.StatusBadRequest {
		t.Fatalf("question without options status=%d body=%s", status, body)
	}
	if got := countRows(t, env, `SELECT count(*) FROM decisions WHERE id=$1 AND kind='question' AND request='{}'::jsonb AND expires_at IS NULL
 AND requested_by_actor_id='actor_acme_official' AND decider_actor_id='actor_acme_alice' AND status='pending'`, created.InteractionID); got != 1 {
		t.Fatalf("question card rows=%d", got)
	}

	status, _, body = env.request(alice, http.MethodPost, "/v0/decisions/"+created.InteractionID, map[string]any{
		"expected_version": 1, "decision": "submit", "answers": map[string]any{
			"q1": "o2", "q2": []any{"o1", "o3", "Kimchi"}, "q3": "No cilantro",
		},
	}, "ask-user-decision-"+unique)
	if status != http.StatusOK {
		t.Fatalf("decision status=%d body=%s", status, body)
	}
	var answerID, answer, disposition string
	if err := env.pool.QueryRow(t.Context(), `SELECT message.id, message.body,
 (SELECT disposition FROM agent_inbox_message_disposition('tenant_acme','actor_acme_official',NULL,'room:'||$1,message.id))
 FROM messages message WHERE message.card_context_message_id=$2 AND message.message_kind='agent_runtime'`, roomID, created.MessageID).Scan(&answerID, &answer, &disposition); err != nil {
		t.Fatal(err)
	}
	if disposition != "notify" || !strings.HasSuffix(answer, " Human interaction "+created.InteractionID+
		" answered:\n- Noodles or rice? → Rice\n- Sides? → Egg, Greens, Kimchi\n- Anything to avoid? → No cilantro") {
		t.Fatalf("answer %s disposition=%s body=%q", answerID, disposition, answer)
	}
	assertHumanVisibleMessageIDs(t, env, alice, roomID, answerID, false)

	assertMemberRemovalSucceeds(t, env, alice, roomID, "actor_acme_official")
	if status, body := ask("removed", "Lunch order"); status != http.StatusForbidden {
		t.Fatalf("former member status=%d body=%s", status, body)
	}
}

// A question card asked in a Thread of the Agent's Context Room lives in that
// Thread: the Sponsor answers it there through the parent Room membership, and
// the answer notifies the Agent through the Thread Inbox. A Thread of another
// Room is refused.
func TestAgentAskUserInThreadAnswersIntoThread(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newRoomDocumentRealtimeEnvWithRuntimeOptions(t, 0, 0, 0, roomDocumentRuntimeTestOptions{})
	unique := strings.ReplaceAll(time.Now().Format("150405.000000000"), ".", "")
	roomID := createPrivateRoom(t, env, alice, "Thread question "+unique, "thread-question-room-"+unique)
	otherRoomID := createPrivateRoom(t, env, alice, "Other question "+unique, "other-question-room-"+unique)
	for _, room := range []string{roomID, otherRoomID} {
		if status, body := putRoomMember(t, env, alice, room, "actor_acme_official", "member"); status != http.StatusOK {
			t.Fatalf("add Agent status=%d body=%s", status, body)
		}
	}
	insertHistoryFixture(t, env, roomID, "ask_thread_root_"+unique, "conversation", "Thread root")
	insertHistoryFixture(t, env, otherRoomID, "ask_other_root_"+unique, "conversation", "Other root")
	thread := requestMessageThread(t, env, alice, roomID, "ask_thread_root_"+unique, "ask-thread-"+unique)
	other := requestMessageThread(t, env, alice, otherRoomID, "ask_other_root_"+unique, "ask-other-thread-"+unique)
	if thread.room.ID == "" || other.room.ID == "" {
		t.Fatalf("create Threads: %d %s / %d %s", thread.status, thread.body, other.status, other.body)
	}
	// Like a reply that mentions it, the Agent takes part in both Threads.
	for _, threadID := range []string{thread.room.ID, other.room.ID} {
		if _, err := env.pool.Exec(t.Context(), `INSERT INTO room_member_states(room_id,actor_id,thread_opened_at)
 VALUES ($1,'actor_acme_official',now()) ON CONFLICT (room_id,actor_id) DO UPDATE SET thread_opened_at=excluded.thread_opened_at`, threadID); err != nil {
			t.Fatal(err)
		}
	}
	issued, err := agentcredential.New(env.pool).IssueManaged(t.Context(), acmeOfficialAgentManagementID, "ask-user Thread CLI")
	if err != nil {
		t.Fatal(err)
	}
	ask := func(operation, threadID string) (int, []byte) {
		t.Helper()
		return postAgentInRoom(t, env, issued.AccessToken, roomID, "/api/agent/v1/user-questions", map[string]any{
			"invocation_id": mcpFileInvocationID(operation + "-" + unique), "thread_id": threadID, "title": "Venue",
			"questions": []any{map[string]any{"question": "Which venue?", "options": []any{"Park", "Hall"}}},
		})
	}

	if status, body := ask("other-thread", other.room.ID); status != http.StatusForbidden {
		t.Fatalf("other Room's Thread status=%d body=%s", status, body)
	}
	status, body := ask("thread", thread.room.ID)
	if status != http.StatusOK {
		t.Fatalf("ask in Thread status=%d body=%s", status, body)
	}
	var created struct {
		InteractionID string `json:"interaction_id"`
		MessageID     string `json:"message_id"`
	}
	decode(t, body, &created)
	if got := countRows(t, env, `SELECT count(*) FROM decisions decision JOIN messages message ON message.id=decision.message_id
 WHERE decision.id=$1 AND decision.room_id=$2 AND message.room_id=$2`, created.InteractionID, thread.room.ID); got != 1 {
		t.Fatalf("question card is not in the Thread")
	}

	status, _, body = env.request(alice, http.MethodPost, "/v0/decisions/"+created.InteractionID, map[string]any{
		"expected_version": 1, "decision": "submit", "answers": map[string]any{"q1": "o2"},
	}, "ask-user-thread-decision-"+unique)
	if status != http.StatusOK {
		t.Fatalf("decision status=%d body=%s", status, body)
	}
	var answerRoomID, answer, disposition string
	if err := env.pool.QueryRow(t.Context(), `SELECT message.room_id, message.body,
 (SELECT disposition FROM agent_inbox_message_disposition('tenant_acme','actor_acme_official',NULL,'thread:'||$1,message.id))
 FROM messages message WHERE message.card_context_message_id=$2 AND message.message_kind='agent_runtime'`, thread.room.ID, created.MessageID).Scan(&answerRoomID, &answer, &disposition); err != nil {
		t.Fatal(err)
	}
	if answerRoomID != thread.room.ID || disposition != "notify" ||
		!strings.HasSuffix(answer, " Human interaction "+created.InteractionID+" answered:\n- Which venue? → Hall") {
		t.Fatalf("answer room=%s disposition=%s body=%q", answerRoomID, disposition, answer)
	}
}
