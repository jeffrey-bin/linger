package integration_test

import (
	"errors"
	"net/http"
	"strconv"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
)

func TestDocumentCommentMentionsRejectUndiscoverableActorWithoutSideEffects(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newRoomDocumentRealtimeEnv(t)
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	boundRoomID := createPrivateRoom(t, env, alice, "Bound Comment Context "+suffix, "bound-comment-context-"+suffix)
	document := createRoomDocumentForCommentRefs(
		t, env, alice, boundRoomID, "Current Context document", "current-context-document-"+suffix,
	)
	payload := func(actorID string) map[string]any {
		return map[string]any{
			"anchor": map[string]any{
				"quoted_text": "context target", "block_id": "block_context_target",
				"context_before": "before", "context_after": "after",
			},
			"initial_comment": map[string]any{"segments": []map[string]any{
				{"type": "reference", "content": "@Unavailable", "actor_id": actorID},
			}},
		}
	}
	path := "/v0/documents/" + document.ID + "/comment-threads"
	for index, actorID := range []string{"actor_missing"} {
		status, _, body := env.request(alice, http.MethodPost, path, payload(actorID),
			"undiscoverable-comment-target-"+strconv.Itoa(index)+"-"+suffix)
		if status != http.StatusBadRequest {
			t.Fatalf("undiscoverable target %q status=%d body=%s", actorID, status, body)
		}
	}

	var threads, effects, documentEvents, roomEvents int
	if err := env.pool.QueryRow(t.Context(), `SELECT
		(SELECT count(*) FROM room_document_comment_threads WHERE document_id=$1),
		(SELECT count(*) FROM agent_runtime_inputs WHERE source_inbox_id='document:'||$1),
		(SELECT count(*) FROM document_events WHERE document_id=$1 AND event_type='document.comment_updated'),
		(SELECT count(*) FROM room_events WHERE room_id=$2 AND event_type='document.comment.changed')`,
		document.ID, boundRoomID).Scan(
		&threads, &effects, &documentEvents, &roomEvents,
	); err != nil {
		t.Fatal(err)
	}
	if threads != 0 || effects != 0 || documentEvents != 0 || roomEvents != 0 {
		t.Fatalf("undiscoverable target leaked threads/effects/document events/room events=%d/%d/%d/%d",
			threads, effects, documentEvents, roomEvents)
	}
}

func TestAgentCommentMentionsHumanWithoutRecursivelyInvokingAgent(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newRoomDocumentRealtimeEnv(t)
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	roomID := createPrivateRoom(t, env, alice, "Agent Comment mentions "+suffix, "agent-comment-mentions-room-"+suffix)
	for _, actorID := range []string{"actor_acme_official"} {
		status, _, body := env.request(alice, http.MethodPut, "/v0/rooms/"+roomID+"/members/"+actorID, map[string]any{
			"role": "member",
		}, "")
		if status != http.StatusOK {
			t.Fatalf("add %s to Room status=%d body=%s", actorID, status, body)
		}
	}
	createdDocument := createRoomDocumentForCommentRefs(t, env, alice, roomID, "Agent Comment mention document", "agent-comment-mentions-document-"+suffix)
	thread := createRoomDocumentThreadForRefs(t, env, alice, createdDocument.ID, "agent mention target", "agent-comment-mentions-thread-"+suffix)

	// The Agent comments through the MCP comment tools, which share this domain
	// call and pass no Room context.
	comments := document.NewCommentService(env.pool, nil)
	agentReply := func(key string, segments ...document.Segment) (document.Comment, error) {
		result, err := comments.ReplyForAgent(t.Context(), document.AgentReplyInput{
			AgentManagementID: acmeOfficialAgentManagementID, ThreadID: thread.ID,
			IdempotencyKey: key, Segments: segments,
		})
		return result.Comment, err
	}
	// An Agent reply may name the Space's Human; the name is only displayed.
	reply, err := agentReply("agent-mentions-human-"+suffix,
		document.Segment{Type: "text", Content: "Please inspect "},
		document.Segment{Type: "reference", Content: "@alice", ActorID: "actor_acme_alice"})
	if err != nil {
		t.Fatalf("Agent mention Human: %v", err)
	}
	// Without a Room context an Agent cannot @ an Agent, so its comments never
	// invoke one.
	if _, err := agentReply("agent-reference-only-"+suffix,
		document.Segment{Type: "reference", Content: "@official", ActorID: "actor_acme_official"}); !errors.Is(err, document.ErrCommentInvalidInput) {
		t.Fatalf("Agent-authored @Agent Comment err=%v want invalid input", err)
	}
	if got := countRows(t, env, `SELECT count(*) FROM agent_runtime_inputs
		WHERE source_kind='inbox' AND source_message_id=$1`, reply.ID); got != 0 {
		t.Fatalf("Agent-authored Comment created %d self-notification Runtime inputs", got)
	}
	if got := countRows(t, env, `SELECT count(*) FROM agent_execution_contexts
		WHERE context_kind='document' AND document_id=$1`, createdDocument.ID); got != 0 {
		t.Fatalf("Agent-authored Comment created %d Document contexts", got)
	}

	status, _, body := env.request(alice, http.MethodPost, "/v0/document-comment-threads/"+thread.ID+"/comments", map[string]any{
		"current_context": map[string]any{"binding_kind": "room", "context_id": roomID},
		"segments": []map[string]any{
			{"type": "text", "content": "Agent reference only "},
			{"type": "reference", "content": "@official", "actor_id": "actor_acme_official"},
		},
		"durable_head": map[string]any{
			"persisted_seq": createdDocument.DurableHead.PersistedSeq, "state_hash": createdDocument.DurableHead.StateHash,
			"state_hash_version": createdDocument.DurableHead.StateHashVersion,
		},
	}, "human-mentions-agent-"+suffix)
	if status != http.StatusCreated {
		t.Fatalf("Human mention Agent status=%d body=%s", status, body)
	}
	var humanReply struct {
		ID string `json:"id"`
	}
	decode(t, body, &humanReply)
	if got := countRows(t, env, `SELECT count(*) FROM agent_runtime_inputs input
		JOIN agent_execution_contexts execution_context ON execution_context.context_key=input.context_key
		WHERE input.source_kind='inbox' AND input.source_message_id=$1
		  AND execution_context.agent_actor_id='actor_acme_official'`, humanReply.ID); got != 1 {
		t.Fatalf("Human @Agent Runtime inputs=%d want=1", got)
	}
}

func latestUnifiedDocumentEventSequence(t *testing.T, env *testEnv, documentID string) int64 {
	t.Helper()
	var sequence int64
	if err := env.pool.QueryRow(t.Context(), `SELECT coalesce(max(sequence),0)
		FROM document_events WHERE document_id=$1`, documentID).Scan(&sequence); err != nil {
		t.Fatal(err)
	}
	return sequence
}

func countUnifiedDocumentCommentEvents(
	t *testing.T,
	env *testEnv,
	documentID string,
	after int64,
) int {
	t.Helper()
	var count int
	if err := env.pool.QueryRow(t.Context(), `SELECT count(*) FROM document_events
		WHERE document_id=$1 AND sequence>$2 AND event_type='document.comment_updated'
		  AND resource_kind='comment_thread'`, documentID, after).Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}
