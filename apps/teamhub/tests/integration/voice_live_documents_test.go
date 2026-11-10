package integration_test

import (
	"encoding/json"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/config"
	teamhubinternal "github.com/simplexai-labs/linger/contracts-go/teamhubinternal"
)

// The live voice renames and edits a Document as the call's Agent, and
// comments on it as the user only after the user said yes.
func TestVoiceLiveRenamesEditsAndCommentsOnADocument(t *testing.T) {
	allowParallelIntegrationTest(t)
	var computes atomic.Int32
	replaced := make(chan string, 64)
	var bodies *pgxpool.Pool
	runtime := canvasRuntime(t, &computes, replaced, func() *pgxpool.Pool { return bodies })
	env, _, roomID, sessionID := newVoiceLiveRoom(t, func(cfg *config.Config) {
		cfg.RoomDocument.RuntimeURL = runtime.URL
	})
	bodies = env.pool
	call := func(turnID, callID, name string, arguments map[string]any) map[string]any {
		t.Helper()
		encoded, _ := json.Marshal(arguments)
		var result teamhubinternal.VoiceLiveToolResult
		decode(t, voiceRuntimeCall(t, env, http.MethodPost, "/internal/v1/voice/live-tool-calls", map[string]any{
			"voice_session_id": sessionID, "turn_id": turnID, "call_id": callID, "name": name, "arguments": string(encoded),
		}, http.StatusOK), &result)
		var output map[string]any
		if err := json.Unmarshal([]byte(result.Output), &output); err != nil {
			t.Fatalf("%s output=%s", callID, result.Output)
		}
		return output
	}
	opened := call("lt_open", "open-1", "open_email_canvas", map[string]any{
		"to": "amy@example.com", "subject": "Wed pickup", "body": "Hi Amy,\n\nWed 9 am, can you pick me up at the airport?",
	})
	documentID, _ := opened["document_id"].(string)
	if documentID == "" {
		t.Fatalf("open=%v", opened)
	}

	// A rename sets the title the side panel and chat show.
	if renamed := call("lt_rename", "rename-1", "rename_document", map[string]any{"document_id": documentID, "title": " Wed pickup \ndraft "}); renamed["status"] != "renamed" || renamed["title"] != "Wed pickup draft" {
		t.Fatalf("rename=%v", renamed)
	}
	if countRows(t, env, `SELECT count(*) FROM documents WHERE id=$1 AND title='Wed pickup draft'`, documentID) != 1 {
		t.Fatal("title not renamed")
	}
	if missing := call("lt_rename", "rename-2", "rename_document", map[string]any{"document_id": "document_missing", "title": "x"}); missing["error"] != "document_not_editable" {
		t.Fatalf("rename missing=%v", missing)
	}

	// Text is replaced only where it occurs once.
	if changed := call("lt_edit", "edit-1", "replace_document_text", map[string]any{"document_id": documentID, "find": "9 am", "replace_with": "3 pm"}); changed["status"] != "changed" {
		t.Fatalf("replace=%v", changed)
	}
	if missing := call("lt_edit", "edit-2", "replace_document_text", map[string]any{"document_id": documentID, "find": "9 am", "replace_with": "x"}); missing["error"] != "text_not_found" {
		t.Fatalf("replace missing=%v", missing)
	}
	// A rewrite first hands back the latest text and its revision.
	seen := call("lt_edit", "edit-3", "edit_document", map[string]any{"document_id": documentID, "command": "rewrite", "content": "anything"})
	text, _ := seen["text"].(string)
	if seen["error"] != "document_changed" || !strings.Contains(text, "3 pm") || seen["revision_id"] == "" {
		t.Fatalf("rewrite without revision=%v", seen)
	}
	rewritten := strings.Replace(text, "can you pick me up at the airport?", "can you pick me up at the airport?Thanks!", 1)
	if changed := call("lt_edit", "edit-4", "edit_document", map[string]any{"document_id": documentID, "command": "rewrite", "content": rewritten, "revision_id": seen["revision_id"]}); changed["status"] != "changed" {
		t.Fatalf("rewrite=%v", changed)
	}

	// A comment is posted as the user only after a yes in a later turn.
	comment := map[string]any{"document_id": documentID, "quote": "Thanks!", "text": "Make the tone a bit more formal here"}
	if asked := call("lt_ask", "comment-1", "add_comment", comment); asked["status"] != "needs_confirmation" {
		t.Fatalf("comment ask=%v", asked)
	}
	if countRows(t, env, `SELECT count(*) FROM room_document_comment_threads WHERE document_id=$1`, documentID) != 0 {
		t.Fatal("commented before the yes")
	}
	if ambiguous := call("lt_ask", "comment-2", "add_comment", map[string]any{"document_id": documentID, "quote": "Wed", "text": "x"}); ambiguous["error"] != "ambiguous_quote" {
		t.Fatalf("ambiguous quote=%v", ambiguous)
	}
	comment["confirmed"] = true
	posted := call("lt_yes", "comment-3", "add_comment", comment)
	threadID, _ := posted["thread_id"].(string)
	if posted["status"] != "commented" || threadID == "" {
		t.Fatalf("comment=%v", posted)
	}
	if countRows(t, env, `SELECT count(*) FROM room_document_comment_threads
 WHERE id=$1 AND anchor_quoted_text='Thanks!' AND anchor_created_by_actor_id='actor_acme_alice'`, threadID) != 1 {
		t.Fatal("the comment is not the user's, on the quote")
	}
	listed := call("lt_list", "list-1", "list_comments", map[string]any{"document_id": documentID})
	threads, _ := listed["threads"].([]any)
	if len(threads) != 1 || threads[0].(map[string]any)["quote"] != "Thanks!" {
		t.Fatalf("list=%v", listed)
	}
	reply := map[string]any{"thread_id": threadID, "text": "OK, I will fix it"}
	if asked := call("lt_reply", "reply-1", "reply_comment", reply); asked["status"] != "needs_confirmation" {
		t.Fatalf("reply ask=%v", asked)
	}
	reply["confirmed"] = true
	if replied := call("lt_reply_yes", "reply-2", "reply_comment", reply); replied["status"] != "replied" {
		t.Fatalf("reply=%v", replied)
	}
	if resolved := call("lt_resolve", "resolve-1", "resolve_comment", map[string]any{"thread_id": threadID}); resolved["status"] != "resolved" {
		t.Fatalf("resolve=%v", resolved)
	}
	if countRows(t, env, `SELECT count(*) FROM room_document_comment_threads WHERE id=$1 AND resolved_at IS NOT NULL`, threadID) != 1 || roomID == "" {
		t.Fatal("thread not resolved")
	}
}
