package integration_test

import (
	"net/http"
	"strings"
	"testing"
	"time"
)

type roomDocumentCommentAnchorMutationResponse struct {
	ID           string `json:"id"`
	AnchorStatus string `json:"anchor_status"`
	Anchor       struct {
		ID            string `json:"id"`
		QuotedText    string `json:"quoted_text"`
		BlockID       string `json:"block_id"`
		ContextBefore string `json:"context_before"`
		ContextAfter  string `json:"context_after"`
		CreatedBy     struct {
			ID string `json:"id"`
		} `json:"created_by"`
	} `json:"anchor"`
}

func TestHumanReanchorsDocumentCommentThread(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newRoomDocumentRealtimeEnv(t)
	unique := strings.ReplaceAll(time.Now().Format("150405.000000000"), ".", "")
	roomID := createPrivateRoom(t, env, alice, "Comment re-anchor "+unique, "comment-reanchor-room-"+unique)
	status, _, body := env.request(alice, http.MethodPost, "/v0/rooms/"+roomID+"/documents", map[string]any{}, "comment-reanchor-document-"+unique)
	if status != http.StatusCreated {
		t.Fatalf("create Document status=%d body=%s", status, body)
	}
	var document roomDocumentResponse
	decode(t, body, &document)
	status, _, body = env.request(alice, http.MethodPost, "/v0/documents/"+document.ID+"/comment-threads", map[string]any{
		"anchor": map[string]any{
			"quoted_text": "old target", "block_id": "block_old_target",
			"context_before": "old before", "context_after": "old after",
		},
		"initial_comment": map[string]any{
			"segments": []map[string]any{{"type": "text", "content": "Move this discussion"}},
		},
	}, "comment-reanchor-thread-"+unique)
	if status != http.StatusCreated {
		t.Fatalf("create Comment Thread status=%d body=%s", status, body)
	}
	var thread roomDocumentCommentThreadResponse
	decode(t, body, &thread)
	anchorPath := "/v0/document-comment-threads/" + thread.ID + "/anchors"
	payload := map[string]any{
		"quoted_text": "new target", "block_id": "block_new_target",
		"context_before": "new before", "context_after": "new after",
	}
	status, _, body = env.request(alice, http.MethodPost, anchorPath, payload, "comment-reanchor-pending-"+unique)
	if status != http.StatusOK {
		t.Fatalf("recover pending Thread anchor status=%d body=%s", status, body)
	}
	var recovered roomDocumentCommentAnchorMutationResponse
	decode(t, body, &recovered)
	if recovered.ID != thread.ID || recovered.AnchorStatus != "pending" ||
		recovered.Anchor.ID == "" || recovered.Anchor.ID == thread.Anchor.ID ||
		recovered.Anchor.QuotedText != "new target" || recovered.Anchor.BlockID != "block_new_target" ||
		recovered.Anchor.ContextBefore != "new before" || recovered.Anchor.ContextAfter != "new after" ||
		recovered.Anchor.CreatedBy.ID != "actor_acme_alice" {
		t.Fatalf("recovered pending Comment Thread=%+v", recovered)
	}
	thread.Anchor.ID = recovered.Anchor.ID

	credential := openRoomDocumentSessionForCommentRefs(t, env, alice, document.ID, "comment_reanchor_runtime_"+unique)
	if check := validateCommentThreadRefs(t, env, document.ID, []string{thread.ID}); check != "available" {
		t.Fatalf("authorize initial Comment mark: %s", check)
	}
	appendCommentThreadRefs(t, env, document.ID, credential.claims(t).ActorID, "comment_reanchor_attach_batch_"+unique, 0, []string{thread.ID})
	status, _, body = env.request(alice, http.MethodPost, anchorPath, payload, "comment-reanchor-attached-"+unique)
	if status != http.StatusConflict {
		t.Fatalf("re-anchor attached Thread status=%d want=409 body=%s", status, body)
	}
	if check := validateCommentThreadRefs(t, env, document.ID, []string{}); check != "available" {
		t.Fatalf("authorize Comment mark removal: %s", check)
	}
	appendCommentThreadRefs(t, env, document.ID, credential.claims(t).ActorID, "comment_reanchor_orphan_batch_"+unique, 1, []string{})
	assertRoomDocumentThreadAnchorStatus(t, env, alice, thread.ID, "orphaned")
	eventsAfter := latestUnifiedDocumentEventSequence(t, env, document.ID)

	status, _, body = env.request(alice, http.MethodPost, anchorPath, payload, "")
	if status != http.StatusOK {
		t.Fatalf("Room Member re-anchor status=%d body=%s", status, body)
	}
	var reanchored roomDocumentCommentAnchorMutationResponse
	decode(t, body, &reanchored)
	if reanchored.ID != thread.ID || reanchored.AnchorStatus != "pending" ||
		reanchored.Anchor.ID == "" || reanchored.Anchor.ID == thread.Anchor.ID ||
		reanchored.Anchor.QuotedText != "new target" || reanchored.Anchor.BlockID != "block_new_target" ||
		reanchored.Anchor.ContextBefore != "new before" || reanchored.Anchor.ContextAfter != "new after" ||
		reanchored.Anchor.CreatedBy.ID != "actor_acme_alice" {
		t.Fatalf("re-anchored Comment Thread=%+v", reanchored)
	}
	if events := countUnifiedDocumentCommentEvents(t, env, document.ID, eventsAfter); events != 1 {
		t.Fatalf("re-anchor change events=%d want=1", events)
	}
}
