package integration_test

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"
)

// The Runtime checks a new Thread reference and saves the body; the body's
// trigger attaches and orphans Threads to match the saved references.
func TestDocumentRuntimeValidatesAndReconcilesCompleteCommentThreadReferences(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newRoomDocumentRealtimeEnv(t)
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	roomID := createPrivateRoom(t, env, alice, "Comment refs "+suffix, "comment-refs-room-"+suffix)
	document := createRoomDocumentForCommentRefs(t, env, alice, roomID, "Comment refs document", "comment-refs-document-"+suffix)
	otherDocument := createRoomDocumentForCommentRefs(t, env, alice, roomID, "Other comment refs document", "other-comment-refs-document-"+suffix)
	thread := createRoomDocumentThreadForRefs(t, env, alice, document.ID, "thread target", "comment-refs-thread-"+suffix)
	otherThread := createRoomDocumentThreadForRefs(t, env, alice, otherDocument.ID, "other target", "other-comment-refs-thread-"+suffix)
	credential := openRoomDocumentSessionForCommentRefs(t, env, alice, document.ID, "comment_refs_runtime_"+suffix)
	authorID := credential.claims(t).ActorID

	if check := validateCommentThreadRefs(t, env, document.ID, []string{"document_thread_missing"}); check != "thread_unknown" {
		t.Fatalf("unknown Thread ref check=%s", check)
	}
	if check := validateCommentThreadRefs(t, env, document.ID, []string{otherThread.ID}); check != "thread_unknown" {
		t.Fatalf("cross-Document Thread ref check=%s", check)
	}
	if check := validateCommentThreadRefs(t, env, document.ID, []string{thread.ID}); check != "available" {
		t.Fatalf("valid Thread ref check=%s", check)
	}
	appendCommentThreadRefs(t, env, document.ID, authorID, "attach_thread_batch_"+suffix, 0, []string{thread.ID})
	assertRoomDocumentThreadAnchorStatus(t, env, alice, thread.ID, "attached")

	appendCommentThreadRefs(t, env, document.ID, authorID, "orphan_thread_batch_"+suffix, 1, []string{})
	assertRoomDocumentThreadAnchorStatus(t, env, alice, thread.ID, "orphaned")
	status, _, body := env.request(alice, http.MethodGet, "/v0/documents/"+document.ID+"/comment-threads", nil, "")
	if status != http.StatusOK || strings.Contains(string(body), thread.ID) {
		t.Fatalf("deleted selection remains in comment list: %d %s", status, body)
	}
	status, _, body = env.request(alice, http.MethodPost, "/v0/document-comment-threads/"+thread.ID+"/comments", map[string]any{"segments": []map[string]any{{"type": "text", "content": "No ghost reply"}}}, "deleted-selection-reply-"+suffix)
	if status != http.StatusNotFound {
		t.Fatalf("deleted selection accepted a reply: %d %s", status, body)
	}
	// Undo restores the original mark and its original discussion, without recreating it.
	appendCommentThreadRefs(t, env, document.ID, authorID, "undo_thread_batch_"+suffix, 2, []string{thread.ID})
	assertRoomDocumentThreadAnchorStatus(t, env, alice, thread.ID, "attached")
	appendCommentThreadRefs(t, env, document.ID, authorID, "remove_again_batch_"+suffix, 3, []string{})
	assertRoomDocumentThreadAnchorStatus(t, env, alice, thread.ID, "orphaned")

	status, _, body = env.request(alice, http.MethodPost, "/v0/document-comment-threads/"+thread.ID+"/anchors", map[string]any{
		"quoted_text": "new thread target", "block_id": "block_new_thread_target",
		"context_before": "new before", "context_after": "new after",
	}, "reanchor-comment-ref-"+suffix)
	if status != http.StatusOK {
		t.Fatalf("re-anchor orphaned Thread status=%d body=%s", status, body)
	}
	assertRoomDocumentThreadAnchorStatus(t, env, alice, thread.ID, "pending")
	// A saved state that carries the Thread attaches it at its current anchor.
	appendCommentThreadRefs(t, env, document.ID, authorID, "reattach_thread_batch_"+suffix, 4, []string{thread.ID})
	assertRoomDocumentThreadAnchorStatus(t, env, alice, thread.ID, "attached")
}

func createRoomDocumentForCommentRefs(
	t *testing.T,
	env *testEnv,
	client *http.Client,
	roomID, name, key string,
) roomDocumentResponse {
	t.Helper()
	status, _, body := env.request(client, http.MethodPost, "/v0/rooms/"+roomID+"/documents", map[string]any{}, key)
	if status != http.StatusCreated {
		t.Fatalf("create Room Document status=%d body=%s", status, body)
	}
	var document roomDocumentResponse
	decode(t, body, &document)
	document.DurableHead = loadRoomDocumentDurableHeadForCommentRefs(t, env, client, document.ID)
	return document
}

func loadRoomDocumentDurableHeadForCommentRefs(
	t *testing.T,
	env *testEnv,
	client *http.Client,
	documentID string,
) struct {
	PersistedSeq     int64  `json:"persisted_seq"`
	StateVector      string `json:"state_vector"`
	StateHash        string `json:"state_hash"`
	StateHashVersion int    `json:"state_hash_version"`
} {
	t.Helper()
	body, ok := loadRuntimeDocumentBody(t, env, documentID)
	if !ok {
		t.Fatalf("Comment Document %s has no body", documentID)
	}
	digest := sha256.Sum256(body.State)
	return struct {
		PersistedSeq     int64  `json:"persisted_seq"`
		StateVector      string `json:"state_vector"`
		StateHash        string `json:"state_hash"`
		StateHashVersion int    `json:"state_hash_version"`
	}{body.Seq, base64.StdEncoding.EncodeToString(body.StateVector), hex.EncodeToString(digest[:]), 1}
}

func createRoomDocumentThreadForRefs(
	t *testing.T,
	env *testEnv,
	client *http.Client,
	documentID, quotedText, key string,
) roomDocumentCommentThreadResponse {
	t.Helper()
	status, _, body := env.request(client, http.MethodPost, "/v0/documents/"+documentID+"/comment-threads", map[string]any{
		"anchor": map[string]any{
			"quoted_text": quotedText, "block_id": "block_" + strings.ReplaceAll(key, "-", "_"),
			"context_before": "before", "context_after": "after",
		},
		"initial_comment": map[string]any{
			"segments": []map[string]any{{"type": "text", "content": "Track this range"}},
		},
	}, key)
	if status != http.StatusCreated {
		t.Fatalf("create Comment Thread status=%d body=%s", status, body)
	}
	var thread roomDocumentCommentThreadResponse
	decode(t, body, &thread)
	return thread
}

func openRoomDocumentSessionForCommentRefs(
	t *testing.T,
	env *testEnv,
	client *http.Client,
	documentID, runtimeInstanceID string,
) roomDocumentCollaborationCredential {
	t.Helper()
	status, _, body := env.request(client, http.MethodPost, "/v0/documents/"+documentID+"/collaboration-credentials", nil, "")
	if status != http.StatusCreated {
		t.Fatalf("issue collaboration credential status=%d body=%s", status, body)
	}
	var credential roomDocumentCollaborationCredential
	decode(t, body, &credential)
	return credential
}

func validateCommentThreadRefs(
	t *testing.T,
	env *testEnv,
	documentID string,
	threadIDs []string,
) string {
	t.Helper()
	return checkRuntimeReferences(t, env, documentID, []string{}, threadIDs)
}

// appendCommentThreadRefs saves a body carrying the Thread references, as the
// Runtime does, and returns its state hash.
func appendCommentThreadRefs(
	t *testing.T,
	env *testEnv,
	documentID, authorID, batchID string,
	basePersistedSeq int64,
	threadIDs []string,
) string {
	t.Helper()
	state := []byte{byte(basePersistedSeq + 1), 2, 3, 4}
	if _, saved, err := saveDocumentBody(t.Context(), env.pool, documentBodySave{
		DocumentID: documentID, BaseSeq: basePersistedSeq, State: state,
		StateVector: []byte{byte(basePersistedSeq + 1)}, ThreadIDs: threadIDs,
		EditorIDs: []string{authorID},
	}); err != nil || !saved {
		t.Fatalf("save Comment Thread refs %s saved=%t error=%v", batchID, saved, err)
	}
	digest := sha256.Sum256(state)
	return hex.EncodeToString(digest[:])
}

func assertRoomDocumentThreadAnchorStatus(
	t *testing.T,
	env *testEnv,
	client *http.Client,
	threadID, want string,
) {
	t.Helper()
	status, _, body := env.request(client, http.MethodGet, "/v0/document-comment-threads/"+threadID, nil, "")
	if want == "orphaned" {
		if status != http.StatusNotFound {
			t.Fatalf("removed Thread is still accessible: %d %s", status, body)
		}
		var stored string
		if err := env.pool.QueryRow(t.Context(), "SELECT anchor_status FROM room_document_comment_threads WHERE id=$1", threadID).Scan(&stored); err != nil {
			t.Fatal(err)
		}
		if stored != want {
			t.Fatalf("stored anchor status=%q want=%q", stored, want)
		}
		return
	}
	if status != http.StatusOK {
		t.Fatalf("get Comment Thread status=%d body=%s", status, body)
	}
	var thread roomDocumentCommentThreadResponse
	decode(t, body, &thread)
	if thread.AnchorStatus != want {
		t.Fatalf("Comment Thread anchor status=%q want=%q", thread.AnchorStatus, want)
	}
}
