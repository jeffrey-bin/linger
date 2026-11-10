package integration_test

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentcredential"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/messagecreation"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

type messageReactionResponse struct {
	ReactionID string   `json:"reaction_id"`
	ActorIDs   []string `json:"actor_ids"`
}

func messageReactions(t *testing.T, env *testEnv, client *http.Client, roomID, messageID string) []messageReactionResponse {
	t.Helper()
	status, _, body := env.request(client, http.MethodGet, "/v0/rooms/"+roomID+"/messages/"+messageID, nil, "")
	if status != http.StatusOK {
		t.Fatalf("get Message status=%d body=%s", status, body)
	}
	var message struct {
		Reactions []messageReactionResponse `json:"reactions"`
	}
	decode(t, body, &message)
	return message.Reactions
}

func reactionSummary(reactions []messageReactionResponse) string {
	parts := make([]string, 0, len(reactions))
	for _, reaction := range reactions {
		parts = append(parts, reaction.ReactionID+"="+strings.Join(reaction.ActorIDs, "+"))
	}
	return strings.Join(parts, ",")
}

func TestMessageReactionsArePublicIdempotentAndQuiet(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newRoomDocumentRealtimeEnv(t)
	bob := seedPeerHuman(t, env)
	unique := strings.ReplaceAll(time.Now().Format("150405.000000000"), ".", "")
	roomID := createPrivateRoom(t, env, alice, "Message reactions "+unique, "message-reactions-room-"+unique)
	if status, body := putRoomMember(t, env, alice, roomID, "actor_acme_bob", "member"); status != http.StatusOK {
		t.Fatalf("add Bob status=%d body=%s", status, body)
	}
	messageID := createHumanMessage(t, env, alice, roomID, "Shipped the release!", "message-reactions-target-"+unique)
	path := "/v0/rooms/" + roomID + "/messages/" + messageID + "/reactions/"
	before := roomListItemByID(t, env, bob, roomID)

	for _, step := range []struct {
		client *http.Client
		method string
		id     string
	}{
		{alice, http.MethodPut, "tada"}, {alice, http.MethodPut, "tada"},
		{bob, http.MethodPut, "tada"}, {alice, http.MethodPut, "ok"},
		{bob, http.MethodDelete, "tada"}, {bob, http.MethodDelete, "tada"},
	} {
		if status, _, body := env.request(step.client, step.method, path+step.id, nil, ""); status != http.StatusNoContent {
			t.Fatalf("%s %s status=%d body=%s", step.method, step.id, status, body)
		}
	}
	if got := reactionSummary(messageReactions(t, env, bob, roomID, messageID)); got != "tada=actor_acme_alice,ok=actor_acme_alice" {
		t.Fatalf("aggregate=%s", got)
	}
	var events int
	var lastPayload []byte
	if err := env.pool.QueryRow(t.Context(), `SELECT count(*),(array_agg(payload ORDER BY room_seq DESC))[1]
		FROM room_events WHERE room_id=$1 AND event_type='message.reactions.changed' AND resource_id=$2`,
		roomID, messageID).Scan(&events, &lastPayload); err != nil {
		t.Fatal(err)
	}
	var payload struct {
		Kind      string                    `json:"kind"`
		MessageID string                    `json:"message_id"`
		Reactions []messageReactionResponse `json:"reactions"`
	}
	if err := json.Unmarshal(lastPayload, &payload); err != nil {
		t.Fatal(err)
	}
	// Repeated adds and removals change nothing and emit no event.
	if events != 4 || payload.Kind != "message.reactions.changed" || payload.MessageID != messageID ||
		reactionSummary(payload.Reactions) != "tada=actor_acme_alice,ok=actor_acme_alice" {
		t.Fatalf("events=%d payload=%s", events, lastPayload)
	}
	after := roomListItemByID(t, env, bob, roomID)
	if after.UnreadMessageCount != before.UnreadMessageCount || after.UnreadMentionCount != before.UnreadMentionCount ||
		after.LatestMessage == nil || before.LatestMessage == nil || after.LatestMessage.ID != before.LatestMessage.ID {
		t.Fatalf("Reactions changed unread or recent ordering: before=%+v after=%+v", before, after)
	}

	if status, _, body := env.request(alice, http.MethodPut, path+"unicorn", nil, ""); status != http.StatusBadRequest {
		t.Fatalf("unknown Reaction status=%d body=%s", status, body)
	}
	// Only conversation Messages accept Reactions. Create a hidden Runtime
	// Message and its event atomically instead of changing membership.
	tx, err := env.pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(t.Context())
	queries := store.New(tx)
	author, err := queries.GetActor(t.Context(), store.GetActorParams{ID: "actor_acme_alice", TenantID: acmeTenant})
	if err != nil {
		t.Fatal(err)
	}
	content, err := messagecreation.Normalize([]messagecreation.Segment{{Type: "text", Content: "Runtime input"}})
	if err != nil {
		t.Fatal(err)
	}
	created, err := messagecreation.Create(t.Context(), queries, messagecreation.Draft{
		TenantID: acmeTenant, RoomID: roomID, Author: author, Content: content, Kind: "agent_runtime",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
	runtimeMessageID := created.Message.ID
	if status, _, body := env.request(alice, http.MethodPut, "/v0/rooms/"+roomID+"/messages/"+runtimeMessageID+"/reactions/ok", nil, ""); status != http.StatusBadRequest || !strings.Contains(string(body), "MESSAGE_REACTION_UNSUPPORTED") {
		t.Fatalf("unsupported Message status=%d body=%s", status, body)
	}
	assertMemberRemovalSucceeds(t, env, alice, roomID, "actor_acme_bob")
	if status, _, body := env.request(bob, http.MethodPut, path+"ok", nil, ""); status != http.StatusNotFound {
		t.Fatalf("former member status=%d body=%s", status, body)
	}
}

func TestAgentSendEmojiReactsOnceInItsRoom(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newRoomDocumentRealtimeEnvWithRuntimeOptions(t, 0, 0, 0, roomDocumentRuntimeTestOptions{})
	unique := strings.ReplaceAll(time.Now().Format("150405.000000000"), ".", "")
	roomID := createPrivateRoom(t, env, alice, "Agent emoji "+unique, "agent-emoji-room-"+unique)
	if status, body := putRoomMember(t, env, alice, roomID, "actor_acme_official", "member"); status != http.StatusOK {
		t.Fatalf("add Agent status=%d body=%s", status, body)
	}
	issued, err := agentcredential.New(env.pool).IssueManaged(t.Context(), acmeOfficialAgentManagementID, "emoji CLI")
	if err != nil {
		t.Fatal(err)
	}
	messageID := createHumanMessage(t, env, alice, roomID, "We closed the round!", "agent-emoji-message-"+unique)
	send := func(emoji, operation string) (int, []byte) {
		t.Helper()
		return postAgentInRoom(t, env, issued.AccessToken, roomID, "/api/agent/v1/emoji-reactions", map[string]any{
			"invocation_id": mcpFileInvocationID(operation + "-" + unique), "message_id": messageID, "emoji": emoji,
		})
	}

	if status, body := send("tada", "first"); status != http.StatusOK || !strings.Contains(string(body), `"emoji":"tada"`) {
		t.Fatalf("send emoji status=%d body=%s", status, body)
	}
	// A retry or a second identical choice keeps one Reaction and writes no new event.
	events := countRows(t, env, `SELECT count(*) FROM room_events WHERE room_id=$1 AND event_type='message.reactions.changed'`, roomID)
	if status, body := send("tada", "retry"); status != http.StatusOK {
		t.Fatalf("repeat emoji status=%d body=%s", status, body)
	}
	if got := reactionSummary(messageReactions(t, env, alice, roomID, messageID)); got != "tada=actor_acme_official" {
		t.Fatalf("emoji aggregate=%s", got)
	}
	if after := countRows(t, env, `SELECT count(*) FROM room_events WHERE room_id=$1 AND event_type='message.reactions.changed'`, roomID); after != events {
		t.Fatalf("repeat emoji appended events %d->%d", events, after)
	}
	if status, body := send("not_an_emoji", "invalid"); status != http.StatusBadRequest {
		t.Fatalf("invalid emoji status=%d body=%s", status, body)
	}
	assertMemberRemovalSucceeds(t, env, alice, roomID, "actor_acme_official")
	if status, body := send("heart", "removed"); status != http.StatusForbidden {
		t.Fatalf("former member status=%d body=%s", status, body)
	}
}
