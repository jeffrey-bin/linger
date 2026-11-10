package integration_test

import (
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"
)

func TestRoomDocumentCommentReactionsAreActorScopedAndIdempotent(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newRoomDocumentRealtimeEnv(t)
	bob := seedPeerHuman(t, env)
	unique := strings.ReplaceAll(time.Now().Format("150405.000000000"), ".", "")
	roomID := createPrivateRoom(t, env, alice, "Comment reactions "+unique, "comment-reactions-room-"+unique)
	status, _, body := env.request(alice, http.MethodPut, "/v0/rooms/"+roomID+"/members/actor_acme_bob", map[string]any{
		"role": "member",
	}, "")
	if status != http.StatusOK {
		t.Fatalf("add Bob to Room status=%d body=%s", status, body)
	}
	status, _, body = env.request(alice, http.MethodPost, "/v0/rooms/"+roomID+"/documents", map[string]any{}, "comment-reactions-document-"+unique)
	if status != http.StatusCreated {
		t.Fatalf("create Document status=%d body=%s", status, body)
	}
	var document roomDocumentResponse
	decode(t, body, &document)
	status, _, body = env.request(alice, http.MethodPost, "/v0/documents/"+document.ID+"/comment-threads", map[string]any{
		"anchor": map[string]any{
			"quoted_text": "reaction target", "block_id": "block_reaction_target",
			"context_before": "before", "context_after": "after",
		},
		"initial_comment": map[string]any{
			"segments": []map[string]any{{"type": "text", "content": "React here"}},
		},
	}, "comment-reactions-thread-"+unique)
	if status != http.StatusCreated {
		t.Fatalf("create Comment Thread status=%d body=%s", status, body)
	}
	var thread roomDocumentCommentThreadResponse
	decode(t, body, &thread)
	eventsAfter := latestUnifiedDocumentEventSequence(t, env, document.ID)
	emoji := "\U0001F44D"
	reactionPath := "/v0/document-comments/" + thread.Comments[0].ID + "/reactions/" + url.PathEscape(emoji)

	for attempt := 0; attempt < 2; attempt++ {
		status, _, body = env.request(alice, http.MethodPut, reactionPath, nil, "")
		if status != http.StatusNoContent {
			t.Fatalf("Alice put reaction attempt=%d status=%d body=%s", attempt+1, status, body)
		}
	}
	status, _, body = env.request(bob, http.MethodPut, reactionPath, nil, "")
	if status != http.StatusNoContent {
		t.Fatalf("Bob put reaction status=%d body=%s", status, body)
	}

	assertCommentReactionActors(t, env, alice, thread.ID, emoji, []string{"actor_acme_alice", "actor_acme_bob"})
	for attempt := 0; attempt < 2; attempt++ {
		status, _, body = env.request(alice, http.MethodDelete, reactionPath, nil, "")
		if status != http.StatusNoContent {
			t.Fatalf("Alice delete reaction attempt=%d status=%d body=%s", attempt+1, status, body)
		}
	}
	assertCommentReactionActors(t, env, alice, thread.ID, emoji, []string{"actor_acme_bob"})
	if events := countUnifiedDocumentCommentEvents(t, env, document.ID, eventsAfter); events != 3 {
		t.Fatalf("reaction change events=%d want=3", events)
	}
}

func TestRoomDocumentCommentReactionsAreBounded(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newRoomDocumentRealtimeEnv(t)
	unique := strings.ReplaceAll(time.Now().Format("150405.000000000"), ".", "")
	roomID := createPrivateRoom(t, env, alice, "Reaction capacity "+unique, "reaction-capacity-room-"+unique)
	status, _, body := env.request(alice, http.MethodPost, "/v0/rooms/"+roomID+"/documents", map[string]any{}, "reaction-capacity-document-"+unique)
	if status != http.StatusCreated {
		t.Fatalf("create Document status=%d body=%s", status, body)
	}
	var document roomDocumentResponse
	decode(t, body, &document)
	status, _, body = env.request(alice, http.MethodPost, "/v0/documents/"+document.ID+"/comment-threads", map[string]any{
		"anchor": map[string]any{
			"quoted_text": "reaction capacity target", "block_id": "block_reaction_capacity_target",
			"context_before": "before", "context_after": "after",
		},
		"initial_comment": map[string]any{
			"segments": []map[string]any{{"type": "text", "content": "React here"}},
		},
	}, "reaction-capacity-thread-"+unique)
	if status != http.StatusCreated {
		t.Fatalf("create Comment Thread status=%d body=%s", status, body)
	}
	var thread roomDocumentCommentThreadResponse
	decode(t, body, &thread)
	commentID := thread.Comments[0].ID
	if _, err := env.pool.Exec(t.Context(), `
INSERT INTO room_document_comment_reactions(
    tenant_id,room_id,document_id,thread_id,comment_id,actor_id,emoji
)
	SELECT comment.tenant_id,comment.room_id,comment.document_id,comment.thread_id,
	       comment.id,
	       CASE WHEN series=1000 THEN 'actor_acme_official' ELSE comment.author_actor_id END,
	       'fixture-' || LEAST(series,999)
FROM room_document_comments comment
CROSS JOIN generate_series(1,1000) series
WHERE comment.id=$1
`, commentID); err != nil {
		t.Fatal(err)
	}

	eventsAfter := latestUnifiedDocumentEventSequence(t, env, document.ID)
	existingPath := "/v0/document-comments/" + commentID + "/reactions/" + url.PathEscape("fixture-1")
	status, _, body = env.request(alice, http.MethodPut, existingPath, nil, "")
	if status != http.StatusNoContent {
		t.Fatalf("put existing reaction at capacity status=%d body=%s", status, body)
	}
	newPath := "/v0/document-comments/" + commentID + "/reactions/" + url.PathEscape("fixture-1001")
	status, _, body = env.request(alice, http.MethodPut, newPath, nil, "")
	if status != http.StatusConflict || !strings.Contains(string(body), `"code":"COMMENT_CAPACITY_REACHED"`) {
		t.Fatalf("put new reaction beyond capacity status=%d body=%s", status, body)
	}
	if events := countUnifiedDocumentCommentEvents(t, env, document.ID, eventsAfter); events != 0 {
		t.Fatalf("reaction change events=%d want=0", events)
	}
	var count int
	if err := env.pool.QueryRow(t.Context(), `
	SELECT count(*) FROM room_document_comment_reactions WHERE comment_id=$1
	`, commentID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1000 {
		t.Fatalf("reaction count=%d want=1000", count)
	}
}

func assertCommentReactionActors(
	t *testing.T,
	env *testEnv,
	client *http.Client,
	threadID, emoji string,
	wantActorIDs []string,
) {
	t.Helper()
	status, _, body := env.request(client, http.MethodGet, "/v0/document-comment-threads/"+threadID, nil, "")
	if status != http.StatusOK {
		t.Fatalf("get Comment Thread status=%d body=%s", status, body)
	}
	var projection struct {
		Comments []struct {
			Reactions []struct {
				Emoji    string   `json:"emoji"`
				ActorIDs []string `json:"actor_ids"`
			} `json:"reactions"`
		} `json:"comments"`
	}
	decode(t, body, &projection)
	if len(projection.Comments) != 1 || len(projection.Comments[0].Reactions) != 1 ||
		projection.Comments[0].Reactions[0].Emoji != emoji ||
		strings.Join(projection.Comments[0].Reactions[0].ActorIDs, ",") != strings.Join(wantActorIDs, ",") {
		t.Fatalf("Comment reactions=%+v want actors=%v", projection.Comments, wantActorIDs)
	}
}
