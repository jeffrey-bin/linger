package integration_test

import (
	"net/http"
	"strings"
	"testing"
	"time"
)

type roomDocumentCommentResolutionResponse struct {
	ID         string `json:"id"`
	Resolved   bool   `json:"resolved"`
	ResolvedAt string `json:"resolved_at"`
	ResolvedBy *struct {
		ID string `json:"id"`
	} `json:"resolved_by"`
}

func TestHumanResolvesAndReopensDocumentCommentThread(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newRoomDocumentRealtimeEnv(t)
	unique := strings.ReplaceAll(time.Now().Format("150405.000000000"), ".", "")
	roomID := createPrivateRoom(t, env, alice, "Comment resolution "+unique, "comment-resolution-room-"+unique)
	status, _, body := env.request(alice, http.MethodPost, "/v0/rooms/"+roomID+"/documents", map[string]any{}, "comment-resolution-document-"+unique)
	if status != http.StatusCreated {
		t.Fatalf("create Document status=%d body=%s", status, body)
	}
	var document roomDocumentResponse
	decode(t, body, &document)
	status, _, body = env.request(alice, http.MethodPost, "/v0/documents/"+document.ID+"/comment-threads", map[string]any{
		"anchor": map[string]any{
			"quoted_text": "resolution target", "block_id": "block_resolution_target",
			"context_before": "before", "context_after": "after",
		},
		"initial_comment": map[string]any{
			"segments": []map[string]any{{"type": "text", "content": "Resolve this discussion"}},
		},
	}, "comment-resolution-thread-"+unique)
	if status != http.StatusCreated {
		t.Fatalf("create Comment Thread status=%d body=%s", status, body)
	}
	var thread roomDocumentCommentThreadResponse
	decode(t, body, &thread)
	threadPath := "/v0/document-comment-threads/" + thread.ID
	eventsAfter := latestUnifiedDocumentEventSequence(t, env, document.ID)

	resolvePayload := map[string]any{"resolved": true}
	status, _, body = env.request(alice, http.MethodPatch, threadPath, resolvePayload, "")
	if status != http.StatusOK {
		t.Fatalf("Room Member resolve status=%d body=%s", status, body)
	}
	var resolved roomDocumentCommentResolutionResponse
	decode(t, body, &resolved)
	if resolved.ID != thread.ID || !resolved.Resolved || resolved.ResolvedAt == "" ||
		resolved.ResolvedBy == nil || resolved.ResolvedBy.ID != "actor_acme_alice" {
		t.Fatalf("resolved Comment Thread=%+v", resolved)
	}
	// A repeated resolve keeps the original resolver evidence.
	status, _, body = env.request(alice, http.MethodPatch, threadPath, resolvePayload, "")
	if status != http.StatusOK {
		t.Fatalf("resolve already resolved Thread status=%d body=%s", status, body)
	}
	var stillResolved roomDocumentCommentResolutionResponse
	decode(t, body, &stillResolved)
	if stillResolved.ResolvedBy == nil || stillResolved.ResolvedBy.ID != "actor_acme_alice" || stillResolved.ResolvedAt != resolved.ResolvedAt {
		t.Fatalf("repeated resolve replaced original resolver evidence: %+v", stillResolved)
	}

	status, _, body = env.request(alice, http.MethodPatch, threadPath, map[string]any{"resolved": false}, "comment-reopen-"+unique)
	if status != http.StatusOK {
		t.Fatalf("Room Member reopen status=%d body=%s", status, body)
	}
	var reopened roomDocumentCommentResolutionResponse
	decode(t, body, &reopened)
	if reopened.ID != thread.ID || reopened.Resolved || reopened.ResolvedAt != "" || reopened.ResolvedBy != nil {
		t.Fatalf("reopened Comment Thread retained resolver evidence: %+v", reopened)
	}
	if events := countUnifiedDocumentCommentEvents(t, env, document.ID, eventsAfter); events != 2 {
		t.Fatalf("resolution change events=%d want=2", events)
	}
}
