package integration_test

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
)

type roomDocumentCommentThreadResponse struct {
	ID           string `json:"id"`
	DocumentID   string `json:"document_id"`
	AnchorStatus string `json:"anchor_status"`
	Resolved     bool   `json:"resolved"`
	Anchor       struct {
		Kind              string `json:"kind"`
		DocumentVersionID string `json:"document_version_id"`
		ID                string `json:"id"`
		QuotedText        string `json:"quoted_text"`
		BlockID           string `json:"block_id"`
		ContextBefore     string `json:"context_before"`
		ContextAfter      string `json:"context_after"`
	} `json:"anchor"`
	Comments []struct {
		ID            string `json:"id"`
		VersionNumber int    `json:"version_number"`
		DeletedAt     string `json:"deleted_at"`
	} `json:"comments"`
}

func TestHumanCreatesWholeDocumentVersionComment(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newRoomDocumentRealtimeEnv(t)
	unique := strings.ReplaceAll(time.Now().Format("150405.000000000"), ".", "")
	status, _, body := requestUnifiedDocumentMultipart(t, env, alice,
		"/v0/tenants/"+acmeTenant+"/documents/uploads", "version-comment-upload-"+unique,
		map[string]string{
			"filename": "review.pdf", "representation_format": "pdf", "media_type": "application/pdf",
		}, "review.pdf", []byte("stable review bytes"))
	if status != http.StatusCreated {
		t.Fatalf("upload Version Comment Document status=%d body=%s", status, body)
	}
	var document previewDocumentResponse
	decode(t, body, &document)
	if document.CurrentVersion == nil {
		t.Fatalf("Version Comment Document has no current Version: %s", body)
	}

	status, _, body = env.request(alice, http.MethodPost,
		"/v0/documents/"+document.ID+"/comment-threads", map[string]any{
			"document_version_id": document.CurrentVersion.ID,
			"initial_comment": map[string]any{
				"segments": []map[string]any{{"type": "text", "content": "Review the whole file"}},
			},
		}, "version-comment-thread-"+unique)
	if status != http.StatusCreated {
		t.Fatalf("create whole-Document Comment status=%d body=%s", status, body)
	}
	var thread roomDocumentCommentThreadResponse
	decode(t, body, &thread)
	if thread.AnchorStatus != "attached" || thread.Anchor.Kind != "document_version" ||
		thread.Anchor.DocumentVersionID != document.CurrentVersion.ID ||
		thread.Anchor.QuotedText != "review.pdf" || thread.Anchor.BlockID != "" {
		t.Fatalf("whole-Document Comment Thread=%+v", thread)
	}
	status, _, body = env.request(alice, http.MethodPost,
		"/v0/document-comment-threads/"+thread.ID+"/comments", map[string]any{
			"segments": []map[string]any{{"type": "text", "content": "Whole-file reply"}},
		}, "version-comment-reply-"+unique)
	if status != http.StatusCreated {
		t.Fatalf("reply to whole-Document Comment status=%d body=%s", status, body)
	}
	status, _, body = env.request(alice, http.MethodGet,
		"/v0/document-comment-threads/"+thread.ID, nil, "")
	if status != http.StatusOK {
		t.Fatalf("get whole-Document Comment status=%d body=%s", status, body)
	}
	var reloaded roomDocumentCommentThreadResponse
	decode(t, body, &reloaded)
	if reloaded.Anchor.Kind != "document_version" ||
		reloaded.Anchor.DocumentVersionID != document.CurrentVersion.ID ||
		len(reloaded.Comments) != 2 {
		t.Fatalf("reloaded whole-Document Comment=%+v", reloaded)
	}

	var before int
	if err := env.pool.QueryRow(t.Context(), `SELECT count(*) FROM room_document_comment_threads
		WHERE document_id=$1`, document.ID).Scan(&before); err != nil {
		t.Fatal(err)
	}
	status, _, body = env.request(alice, http.MethodPost,
		"/v0/documents/"+document.ID+"/comment-threads", map[string]any{
			"document_version_id": document.CurrentVersion.ID,
			"anchor": map[string]any{
				"quoted_text": "invalid", "block_id": "block_invalid",
				"context_before": "", "context_after": "",
			},
			"initial_comment": map[string]any{
				"segments": []map[string]any{{"type": "text", "content": "Must fail"}},
			},
		}, "version-comment-ambiguous-"+unique)
	if status != http.StatusBadRequest {
		t.Fatalf("ambiguous Comment target status=%d body=%s", status, body)
	}
	var after int
	if err := env.pool.QueryRow(t.Context(), `SELECT count(*) FROM room_document_comment_threads
		WHERE document_id=$1`, document.ID).Scan(&after); err != nil {
		t.Fatal(err)
	}
	if after != before {
		t.Fatalf("ambiguous Comment target wrote Threads before=%d after=%d", before, after)
	}
}

type roomDocumentCommentThreadPageResponse struct {
	Items []roomDocumentCommentThreadResponse `json:"items"`
	Page  struct {
		HasMore    bool   `json:"has_more"`
		NextCursor string `json:"next_cursor"`
	} `json:"page"`
}

func TestHumanCreatesRoomDocumentThreadBeforeAnchorMarkIsSaved(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newRoomDocumentRealtimeEnv(t)
	unique := strings.ReplaceAll(time.Now().Format("150405.000000000"), ".", "")
	roomID := createPrivateRoom(t, env, alice, "Document comments "+unique, "document-comments-room-"+unique)
	status, _, body := env.request(alice, http.MethodPost, "/v0/rooms/"+roomID+"/documents", map[string]any{}, "document-comments-document-"+unique)
	if status != http.StatusCreated {
		t.Fatalf("create Document status=%d body=%s", status, body)
	}
	var createdDocument roomDocumentResponse
	decode(t, body, &createdDocument)

	status, headers, body := env.request(alice, http.MethodPost, "/v0/documents/"+createdDocument.ID+"/comment-threads", map[string]any{
		"current_context": map[string]any{"binding_kind": "room", "context_id": roomID},
		"anchor": map[string]any{
			"quoted_text":    "review this sentence",
			"block_id":       "block_comment_target",
			"context_before": "before",
			"context_after":  "after",
		},
		"initial_comment": map[string]any{
			"segments": []map[string]any{
				{"type": "text", "content": "Please review"},
			},
		},
	}, "document-comment-thread-"+unique)
	if status != http.StatusCreated {
		t.Fatalf("create Comment Thread status=%d body=%s", status, body)
	}
	if headers.Get("Idempotent-Replay") != "" {
		t.Fatalf("first Comment Thread create was reported as replay")
	}
	var thread roomDocumentCommentThreadResponse
	decode(t, body, &thread)
	if thread.ID == "" || thread.DocumentID != createdDocument.ID || thread.AnchorStatus != "pending" || thread.Resolved {
		t.Fatalf("created Comment Thread=%+v", thread)
	}
	if thread.Anchor.ID == "" || thread.Anchor.QuotedText != "review this sentence" ||
		thread.Anchor.BlockID != "block_comment_target" || thread.Anchor.ContextBefore != "before" ||
		thread.Anchor.ContextAfter != "after" {
		t.Fatalf("created Anchor=%+v", thread.Anchor)
	}
	if len(thread.Comments) != 1 || thread.Comments[0].ID == "" ||
		thread.Comments[0].VersionNumber != 1 || thread.Comments[0].DeletedAt != "" {
		t.Fatalf("initial Comment=%+v", thread.Comments)
	}
	bodyHead := func() (int64, string) {
		t.Helper()
		var seq int64
		var fingerprint string
		if err := env.pool.QueryRow(t.Context(), `SELECT seq,encode(sha256(state),'hex')
			FROM document_bodies WHERE document_id=$1`, createdDocument.ID).Scan(&seq, &fingerprint); err != nil {
			t.Fatal(err)
		}
		return seq, fingerprint
	}
	expectedSeq, expectedFingerprint := bodyHead()
	runtimeCalls := 0
	service := document.NewCommentService(env.pool, documentRuntimeStub{apply: applyToBody(env.pool, func(
		input document.ApplyRequest, _ []byte,
	) ([]byte, []byte, []string, []string, string, error) {
		runtimeCalls++
		if input.CommentAnchor == nil || input.CommentAnchor.ThreadID != thread.ID ||
			input.CommentAnchor.QuotedText != "review this sentence" || input.ActorID != "actor_acme_alice" {
			t.Fatalf("anchor Runtime input=%+v", input)
		}
		return []byte{3}, []byte{4}, nil, []string{thread.ID}, "", nil
	})})
	attachInput := document.AnchorAttachmentInput{
		AccountID: "account_alice", ThreadID: thread.ID,
		ExpectedPersistedSeq: expectedSeq, ExpectedFullStateFingerprint: expectedFingerprint,
	}
	attached, err := service.AttachSelectionAnchor(t.Context(), attachInput)
	if err != nil || attached.Status != "attached" || attached.RevisionID == "" ||
		attached.Thread.AnchorStatus != "attached" || runtimeCalls != 1 {
		t.Fatalf("attached Anchor=%+v calls=%d error=%v", attached, runtimeCalls, err)
	}
	var seq, histories int
	var currentRevision string
	if err := env.pool.QueryRow(t.Context(), `SELECT body.seq,current_document_revision_id(body.document_id),
		(SELECT count(*) FROM document_revisions WHERE document_id=$1 AND history_trigger IS NOT NULL)
		FROM document_bodies body WHERE body.document_id=$1`, createdDocument.ID).Scan(
		&seq, &currentRevision, &histories); err != nil {
		t.Fatal(err)
	}
	if seq != int(expectedSeq)+1 || currentRevision != attached.RevisionID || histories != 0 {
		t.Fatalf("Anchor attach head seq=%d revision=%s history=%d", seq, currentRevision, histories)
	}
	replayed, err := service.AttachSelectionAnchor(t.Context(), attachInput)
	if err != nil || replayed.Status != "already_attached" || replayed.RevisionID != attached.RevisionID || runtimeCalls != 1 {
		t.Fatalf("repeated Anchor attach=%+v calls=%d error=%v", replayed, runtimeCalls, err)
	}

	// The test environment's Runtime applies nothing: the HTTP attach fails
	// as unavailable and changes nothing.
	status, _, body = env.request(alice, http.MethodPost, "/v0/documents/"+createdDocument.ID+"/comment-threads", map[string]any{
		"anchor":          map[string]any{"quoted_text": "failure", "block_id": "block_failure", "context_before": "", "context_after": ""},
		"initial_comment": map[string]any{"segments": []map[string]any{{"type": "text", "content": "failure"}}},
	}, "document-comment-failure-"+unique)
	if status != http.StatusCreated {
		t.Fatalf("create Runtime failure Comment status=%d body=%s", status, body)
	}
	var failureThread roomDocumentCommentThreadResponse
	decode(t, body, &failureThread)
	headSeq, headFingerprint := bodyHead()
	status, _, body = env.request(alice, http.MethodPost,
		"/v0/document-comment-threads/"+failureThread.ID+"/anchor-attachments", map[string]any{
			"expected_persisted_seq": headSeq, "expected_full_state_fingerprint": headFingerprint,
		}, "attach-http-failure-"+unique)
	if status != http.StatusServiceUnavailable || !bytes.Contains(body, []byte(`"code":"DOCUMENT_RUNTIME_UNAVAILABLE"`)) {
		t.Fatalf("HTTP Anchor Runtime failure status=%d body=%s", status, body)
	}
	if seqAfter, _ := bodyHead(); seqAfter != headSeq {
		t.Fatalf("Runtime failure changed the body seq=%d/%d", seqAfter, headSeq)
	}

	// A body that moved after the caller saw it conflicts before the Runtime.
	if _, err := service.AttachSelectionAnchor(t.Context(), document.AnchorAttachmentInput{
		AccountID: "account_alice", ThreadID: failureThread.ID,
		ExpectedPersistedSeq: headSeq, ExpectedFullStateFingerprint: strings.Repeat("e", 64),
	}); !errors.Is(err, document.ErrCommentConflict) || runtimeCalls != 1 {
		t.Fatalf("stale Anchor attach calls=%d error=%v", runtimeCalls, err)
	}
	// A selection the Runtime cannot find is a conflict too.
	missing := document.NewCommentService(env.pool, documentRuntimeStub{apply: func(
		context.Context, document.ApplyRequest,
	) (document.ApplyResult, error) {
		return document.ApplyResult{}, errors.Join(document.ErrInvalidInput, errors.New("quoted text not found"))
	}})
	if _, err := missing.AttachSelectionAnchor(t.Context(), document.AnchorAttachmentInput{
		AccountID: "account_alice", ThreadID: failureThread.ID,
		ExpectedPersistedSeq: headSeq, ExpectedFullStateFingerprint: headFingerprint,
	}); !errors.Is(err, document.ErrCommentConflict) {
		t.Fatalf("missing selection error=%v", err)
	}
}

func TestHumanRepliesToAndReadsExistingRoomDocumentThread(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newRoomDocumentRealtimeEnv(t)
	unique := strings.ReplaceAll(time.Now().Format("150405.000000000"), ".", "")
	roomID := createPrivateRoom(t, env, alice, "Document reply "+unique, "document-reply-room-"+unique)
	status, _, body := env.request(alice, http.MethodPost, "/v0/rooms/"+roomID+"/documents", map[string]any{}, "document-reply-document-"+unique)
	if status != http.StatusCreated {
		t.Fatalf("create Document status=%d body=%s", status, body)
	}
	var document roomDocumentResponse
	decode(t, body, &document)

	status, _, body = env.request(alice, http.MethodPost, "/v0/documents/"+document.ID+"/comment-threads", map[string]any{
		"anchor": map[string]any{
			"quoted_text": "reply target", "block_id": "block_reply_target",
			"context_before": "before", "context_after": "after",
		},
		"initial_comment": map[string]any{
			"segments": []map[string]any{{"type": "text", "content": "Initial review"}},
		},
	}, "document-reply-thread-"+unique)
	if status != http.StatusCreated {
		t.Fatalf("create Comment Thread status=%d body=%s", status, body)
	}
	var thread roomDocumentCommentThreadResponse
	decode(t, body, &thread)

	status, headers, body := env.request(alice, http.MethodPost, "/v0/document-comment-threads/"+thread.ID+"/comments", map[string]any{
		"parent_comment_id": thread.Comments[0].ID,
		"segments":          []map[string]any{{"type": "text", "content": "Human reply"}},
	}, "document-reply-comment-"+unique)
	if status != http.StatusCreated {
		t.Fatalf("create Comment reply status=%d body=%s", status, body)
	}
	if headers.Get("Idempotent-Replay") != "" {
		t.Fatalf("first Comment reply was reported as replay")
	}
	var reply struct {
		ID              string `json:"id"`
		ThreadID        string `json:"thread_id"`
		ParentCommentID string `json:"parent_comment_id"`
		VersionNumber   int64  `json:"version_number"`
	}
	decode(t, body, &reply)
	if reply.ID == "" || reply.ThreadID != thread.ID || reply.ParentCommentID != thread.Comments[0].ID || reply.VersionNumber != 1 {
		t.Fatalf("created Comment reply=%+v", reply)
	}

	status, _, body = env.request(alice, http.MethodGet, "/v0/document-comment-threads/"+thread.ID, nil, "")
	if status != http.StatusOK {
		t.Fatalf("get Comment Thread status=%d body=%s", status, body)
	}
	var got roomDocumentCommentThreadResponse
	decode(t, body, &got)
	if len(got.Comments) != 2 || got.Comments[1].ID != reply.ID {
		t.Fatalf("retrieved Comment Thread=%+v", got)
	}

	status, _, body = env.request(alice, http.MethodGet, "/v0/documents/"+document.ID+"/comment-threads?limit=200", nil, "")
	if status != http.StatusOK {
		t.Fatalf("list Comment Threads status=%d body=%s", status, body)
	}
	var page roomDocumentCommentThreadPageResponse
	decode(t, body, &page)
	if len(page.Items) != 1 || page.Items[0].ID != thread.ID || len(page.Items[0].Comments) != 2 || page.Page.HasMore || page.Page.NextCursor != "" {
		t.Fatalf("Comment Thread page=%+v", page)
	}
}

func TestRoomDocumentCommentThreadRejectsReplyBeyondCapacity(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newRoomDocumentRealtimeEnv(t)
	unique := strings.ReplaceAll(time.Now().Format("150405.000000000"), ".", "")
	roomID := createPrivateRoom(t, env, alice, "Comment capacity "+unique, "comment-capacity-room-"+unique)
	status, _, body := env.request(alice, http.MethodPost, "/v0/rooms/"+roomID+"/documents", map[string]any{}, "comment-capacity-document-"+unique)
	if status != http.StatusCreated {
		t.Fatalf("create Document status=%d body=%s", status, body)
	}
	var document roomDocumentResponse
	decode(t, body, &document)
	status, _, body = env.request(alice, http.MethodPost, "/v0/documents/"+document.ID+"/comment-threads", map[string]any{
		"anchor": map[string]any{
			"quoted_text": "capacity target", "block_id": "block_capacity_target",
			"context_before": "before", "context_after": "after",
		},
		"initial_comment": map[string]any{
			"segments": []map[string]any{{"type": "text", "content": "Initial review"}},
		},
	}, "comment-capacity-thread-"+unique)
	if status != http.StatusCreated {
		t.Fatalf("create Comment Thread status=%d body=%s", status, body)
	}
	var thread roomDocumentCommentThreadResponse
	decode(t, body, &thread)

	tx, err := env.pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(t.Context())
	if _, err := tx.Exec(t.Context(), "SET CONSTRAINTS ALL DEFERRED"); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(t.Context(), `
INSERT INTO room_document_comments(
    id,tenant_id,room_id,document_id,thread_id,parent_comment_id,
    author_actor_id,body,segments
)
SELECT 'comment_capacity_' || $2 || '_' || series,
       source.tenant_id,source.room_id,source.document_id,source.thread_id,NULL,
       source.author_actor_id,'Capacity fixture',
       '[{"type":"text","content":"Capacity fixture"}]'::jsonb
FROM room_document_comments source
CROSS JOIN generate_series(1,999) series
WHERE source.id=$1
`, thread.Comments[0].ID, unique); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}

	status, _, body = env.request(alice, http.MethodPost, "/v0/document-comment-threads/"+thread.ID+"/comments", map[string]any{
		"segments": []map[string]any{{"type": "text", "content": "One too many"}},
	}, "comment-capacity-reply-"+unique)
	if status != http.StatusConflict || !bytes.Contains(body, []byte(`"code":"COMMENT_CAPACITY_REACHED"`)) {
		t.Fatalf("reply beyond Comment capacity status=%d body=%s", status, body)
	}
	var count int
	if err := env.pool.QueryRow(t.Context(), `
SELECT count(*) FROM room_document_comments WHERE thread_id=$1
`, thread.ID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1000 {
		t.Fatalf("Comment count=%d want=1000", count)
	}
}

func TestDocumentCommentAuthorEditsAndSoftDeletesWithExpectedVersion(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newRoomDocumentRealtimeEnv(t)
	unique := strings.ReplaceAll(time.Now().Format("150405.000000000"), ".", "")
	roomID := createPrivateRoom(t, env, alice, "Comment versions "+unique, "comment-versions-room-"+unique)
	status, _, body := env.request(alice, http.MethodPost, "/v0/rooms/"+roomID+"/documents", map[string]any{}, "comment-versions-document-"+unique)
	if status != http.StatusCreated {
		t.Fatalf("create Document status=%d body=%s", status, body)
	}
	var document roomDocumentResponse
	decode(t, body, &document)
	status, _, body = env.request(alice, http.MethodPost, "/v0/documents/"+document.ID+"/comment-threads", map[string]any{
		"anchor": map[string]any{
			"quoted_text": "version target", "block_id": "block_version_target",
			"context_before": "before", "context_after": "after",
		},
		"initial_comment": map[string]any{
			"segments": []map[string]any{{"type": "text", "content": "Version one"}},
		},
	}, "comment-versions-thread-"+unique)
	if status != http.StatusCreated {
		t.Fatalf("create Comment Thread status=%d body=%s", status, body)
	}
	var thread roomDocumentCommentThreadResponse
	decode(t, body, &thread)
	commentPath := "/v0/document-comments/" + thread.Comments[0].ID

	updatePayload := map[string]any{
		"expected_version": 1,
		"segments":         []map[string]any{{"type": "text", "content": "Version two"}},
	}
	status, _, body = env.request(alice, http.MethodPatch, commentPath, updatePayload, "comment-edit-"+unique)
	if status != http.StatusOK {
		t.Fatalf("author Comment edit status=%d body=%s", status, body)
	}
	var edited struct {
		Body          string `json:"body"`
		VersionNumber int64  `json:"version_number"`
	}
	decode(t, body, &edited)
	if edited.Body != "Version two" || edited.VersionNumber != 2 {
		t.Fatalf("edited Comment=%+v", edited)
	}
	status, _, body = env.request(alice, http.MethodPatch, commentPath, updatePayload, "comment-stale-edit-"+unique)
	if status != http.StatusConflict {
		t.Fatalf("stale Comment edit status=%d want=409 body=%s", status, body)
	}

	status, _, body = env.request(alice, http.MethodDelete, commentPath, map[string]any{
		"expected_version": 2,
	}, "comment-delete-"+unique)
	if status != http.StatusOK {
		t.Fatalf("author Comment delete status=%d body=%s", status, body)
	}
	var deleted struct {
		Body          string           `json:"body"`
		Segments      []map[string]any `json:"segments"`
		VersionNumber int64            `json:"version_number"`
		DeletedAt     string           `json:"deleted_at"`
	}
	decode(t, body, &deleted)
	if deleted.Body != "" || len(deleted.Segments) != 0 || deleted.VersionNumber != 3 || deleted.DeletedAt == "" {
		t.Fatalf("deleted Comment tombstone=%+v", deleted)
	}
}
