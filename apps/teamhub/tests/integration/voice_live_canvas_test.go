package integration_test

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/config"
	nodeservicesinternal "github.com/simplexai-labs/linger/contracts-go/nodeservicesinternal"
	teamhubinternal "github.com/simplexai-labs/linger/contracts-go/teamhubinternal"
)

// canvasRuntime is a Document Runtime whose state is the canvas Markdown
// itself: it exports that Markdown, its header and paragraphs as blocks, and
// applies a whole-canvas block_replace to the body in pool.
// canvasAttachmentLink is an attachment line as the Markdown export writes
// a file block: its name and its Document Asset.
var canvasAttachmentLink = regexp.MustCompile(`^\[([^\]]*)\]\(document-asset:([A-Za-z0-9_-]+)\)$`)

func canvasRuntime(t *testing.T, computes *atomic.Int32, replaced chan<- string, pool func() *pgxpool.Pool) *httptest.Server {
	t.Helper()
	digest := func(data []byte) string {
		sum := sha256.Sum256(data)
		return hex.EncodeToString(sum[:])
	}
	none := nodeservicesinternal.CompleteReferences{DocumentAssetIds: []string{}, DocumentThreadIds: []string{}}
	blocks := func(markdown string) []byte {
		parts := strings.SplitN(markdown, "```\n\n", 2)
		list := []map[string]any{{
			"id": "b1", "type": "codeBlock",
			"content": []map[string]string{{"type": "text", "text": strings.TrimSuffix(strings.TrimPrefix(parts[0], "```\n"), "\n")}},
		}}
		if len(parts) == 2 {
			for index, paragraph := range strings.Split(strings.TrimSpace(parts[1]), "\n\n") {
				block := map[string]any{
					"id": "b" + string(rune('2'+index)), "type": "paragraph",
					"content": []map[string]string{{"type": "text", "text": paragraph}},
				}
				// A Document Asset link line is a file block, as an attachment
				// exports; an image line is an image block.
				if strings.HasPrefix(paragraph, "![") {
					block = map[string]any{"id": block["id"], "type": "image", "props": map[string]string{"url": "document-asset:document_asset_chart"}}
				} else if link := canvasAttachmentLink.FindStringSubmatch(paragraph); link != nil {
					block = map[string]any{"id": block["id"], "type": "file", "props": map[string]string{"url": "document-asset:" + link[2], "name": link[1]}}
				}
				list = append(list, block)
			}
		}
		encoded, _ := json.Marshal(map[string]any{"blocks": list})
		return encoded
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		write := func(value any) { _ = json.NewEncoder(w).Encode(value) }
		switch {
		case r.URL.Path == "/internal/v1/documents/import":
			var request nodeservicesinternal.ImportDocumentRequest
			if json.NewDecoder(r.Body).Decode(&request) != nil || request.SourceBytes == nil {
				break
			}
			source, _ := base64.StdEncoding.DecodeString(*request.SourceBytes)
			write(nodeservicesinternal.ComputedDocumentState{
				BytesSha256: digest(source), StateHash: digest(source), StateHashVersion: 1,
				StateBytes: base64.StdEncoding.EncodeToString(source), StateVector: base64.StdEncoding.EncodeToString([]byte{1}),
				CompleteReferences: none, Warnings: []string{},
			})
			return
		case r.URL.Path == "/internal/v1/documents/export":
			var request nodeservicesinternal.ExportDocumentRequest
			if json.NewDecoder(r.Body).Decode(&request) != nil {
				break
			}
			state, _ := base64.StdEncoding.DecodeString(request.State.StateBytes)
			body, media := state, nodeservicesinternal.Textmarkdown
			if request.Format == "blocks" {
				body, media = blocks(string(state)), nodeservicesinternal.Applicationjson
			}
			write(nodeservicesinternal.ExportDocumentResult{
				Bytes: base64.StdEncoding.EncodeToString(body), SizeBytes: int64(len(body)), Sha256: digest(body),
				MediaType: media, CompleteReferences: none, Warnings: []string{},
			})
			return
		case strings.HasPrefix(r.URL.Path, "/internal/v1/documents/") && strings.HasSuffix(r.URL.Path, "/apply"):
			documentID := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/internal/v1/documents/"), "/apply")
			var request struct {
				ActorID     string `json:"actor_id"`
				ExpectedSeq *int64 `json:"expected_seq"`
				Change      struct {
					CurrentTitle string              `json:"current_title"`
					Operations   []map[string]string `json:"operations"`
				} `json:"change"`
			}
			if json.NewDecoder(r.Body).Decode(&request) != nil || len(request.Change.Operations) != 1 {
				break
			}
			var seq int64
			var current []byte
			if err := pool().QueryRow(r.Context(), `SELECT seq,state FROM document_bodies WHERE document_id=$1`,
				documentID).Scan(&seq, &current); err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			if request.ExpectedSeq != nil && *request.ExpectedSeq != seq {
				write(nodeservicesinternal.ConflictedDocumentChangeResult{Status: "conflicted", Reason: "stale_head"})
				return
			}
			operation := request.Change.Operations[0]
			state, title := []byte(operation["content"]), request.Change.CurrentTitle
			switch {
			case operation["command"] == "block_replace" && operation["start_block_id"] == "b1" && operation["end_block_id"] == "b3":
			case operation["command"] == "block_replace" || operation["command"] == "block_insert_after" || operation["command"] == "block_delete":
				// A canvas is its header and paragraphs, b1, b2, … as the export names them.
				parts := strings.SplitN(string(current), "```\n\n", 2)
				units := []string{parts[0] + "```"}
				if len(parts) == 2 {
					units = append(units, strings.Split(strings.TrimSpace(parts[1]), "\n\n")...)
				}
				find := func(id string) int {
					for index := range units {
						if "b"+string(rune('1'+index)) == id {
							return index
						}
					}
					return -1
				}
				from, to := find(operation["block_id"]), find(operation["block_id"])
				if operation["block_id"] == "" {
					from, to = find(operation["start_block_id"]), find(operation["end_block_id"])
				}
				if from < 0 || to < from {
					write(nodeservicesinternal.ConflictedDocumentChangeResult{Status: "conflicted", Reason: "missing_block"})
					return
				}
				added := []string{}
				if content := strings.TrimSpace(operation["content"]); strings.HasPrefix(content, "```") {
					added = []string{content}
				} else if content != "" {
					added = strings.Split(content, "\n\n")
				}
				next := append([]string{}, units[:from]...)
				switch operation["command"] {
				case "block_replace":
					next = append(append(next, added...), units[to+1:]...)
				case "block_insert_after":
					next = append(append(append(next, units[from]), added...), units[from+1:]...)
				default:
					next = append(next, units[to+1:]...)
				}
				state = []byte(strings.Join(next, "\n\n") + "\n")
			case operation["command"] == "file_insert_after":
				// The file goes after the last block, as its Markdown export writes it.
				state = []byte(strings.TrimRight(string(current), "\n") + "\n\n[" + operation["name"] + "](document-asset:" + operation["asset_id"] + ")\n")
			case operation["command"] == "set_title":
				state, title = current, operation["title"]
			case operation["command"] == "append":
				state = []byte(string(current) + "\n" + operation["content"] + "\n")
			case operation["command"] == "str_replace":
				if count := strings.Count(string(current), operation["pattern"]); count != 1 {
					reason := map[bool]string{true: "text_not_found", false: "ambiguous_text"}[count == 0]
					write(nodeservicesinternal.ConflictedDocumentChangeResult{
						Status: "conflicted", Reason: nodeservicesinternal.ConflictedDocumentChangeResultReason(reason),
					})
					return
				}
				state = []byte(strings.Replace(string(current), operation["pattern"], operation["content"], 1))
			default:
				http.Error(w, "unexpected canvas edit", http.StatusBadRequest)
				return
			}
			if err := pool().QueryRow(r.Context(), `UPDATE document_bodies SET seq=seq+1,state=$3,state_vector='\x02',
				last_editor_ids=array_append(last_editor_ids,$4::text) WHERE document_id=$1 AND seq=$2 RETURNING seq`,
				documentID, seq, state, request.ActorID).Scan(&seq); err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			computes.Add(1)
			replaced <- operation["content"]
			write(nodeservicesinternal.AppliedDocumentChangeResult{
				Status: "applied", Seq: seq, StateHash: digest(state), Title: title,
				CompleteReferences: none,
			})
			return
		}
		http.Error(w, "unexpected Document Runtime call", http.StatusInternalServerError)
	}))
	registerIntegrationServerCleanup(t, server)
	return server
}

// The live voice writes and changes an email on a Gmail canvas as the call's
// Agent, as the canvas Skill does, and never overwrites a revision it did
// not see.
func TestVoiceLiveWritesAndChangesAnEmailCanvasAsTheAgent(t *testing.T) {
	allowParallelIntegrationTest(t)
	var computes atomic.Int32
	replaced := make(chan string, 8)
	var bodies *pgxpool.Pool
	runtime := canvasRuntime(t, &computes, replaced, func() *pgxpool.Pool { return bodies })
	env, _, roomID, sessionID := newVoiceLiveRoom(t, func(cfg *config.Config) {
		cfg.RoomDocument.RuntimeURL = runtime.URL
	})
	bodies = env.pool
	call := func(callID, name string, arguments map[string]string) map[string]any {
		encoded, _ := json.Marshal(arguments)
		var result teamhubinternal.VoiceLiveToolResult
		decode(t, voiceRuntimeCall(t, env, http.MethodPost, "/internal/v1/voice/live-tool-calls", map[string]any{
			"voice_session_id": sessionID, "turn_id": "lt_email", "call_id": callID, "name": name, "arguments": string(encoded),
		}, http.StatusOK), &result)
		var output map[string]any
		if err := json.Unmarshal([]byte(result.Output), &output); err != nil {
			t.Fatalf("%s output=%s", callID, result.Output)
		}
		return output
	}
	canvasMessages := func() int {
		return countRows(t, env, `SELECT count(*) FROM messages WHERE room_id=$1 AND author_actor_id='actor_acme_official' AND segments::text LIKE '%"presentation": "canvas"%'`, roomID)
	}
	// A spoken name is not an address: nothing is written and the model asks.
	if output := call("email-0", "open_email_canvas", map[string]string{"to": "Amy", "subject": "Pickup", "body": "Can you pick me up?"}); output["error"] != "invalid_recipients" || canvasMessages() != 0 {
		t.Fatalf("name as recipient=%v", output)
	}
	email := map[string]string{"to": "amy@example.com", "subject": "Next Wed LA airport pickup", "body": "Hi Amy,\n\nCan you pick me up at LAX at 9 am next Wednesday?"}
	opened := call("email-1", "open_email_canvas", email)
	documentID, _ := opened["document_id"].(string)
	revisionID, _ := opened["revision_id"].(string)
	if opened["status"] != "opened" || documentID == "" || revisionID == "" {
		t.Fatalf("open canvas=%v", opened)
	}
	// The canvas is the Agent's Room Document, opened by its canvas message.
	if countRows(t, env, `SELECT count(*) FROM documents WHERE id=$1 AND title='Next Wed LA airport pickup' AND owner_actor_id='actor_acme_official'`, documentID) != 1 ||
		countRows(t, env, `SELECT count(*) FROM document_context_bindings WHERE document_id=$1 AND binding_kind='room' AND room_id=$2 AND status='active'`, documentID, roomID) != 1 ||
		countRows(t, env, `SELECT count(*) FROM messages WHERE room_id=$1 AND author_actor_id='actor_acme_official' AND segments @> jsonb_build_array(jsonb_build_object('type','document','document_id',$2::text,'presentation','canvas'))`, roomID, documentID) != 1 {
		t.Fatal("the canvas is not the Agent's Room Document opened by its canvas message")
	}
	if again := call("email-1", "open_email_canvas", email); again["document_id"] != documentID || canvasMessages() != 1 {
		t.Fatalf("retried open=%v messages=%d", again, canvasMessages())
	}
	// A provider session that starts over in this call is told which
	// Document the call works on, since its tool results are gone.
	var live teamhubinternal.VoiceLiveContext
	decode(t, voiceRuntimeCall(t, env, http.MethodGet, "/internal/v1/voice/sessions/"+sessionID+"/live-context", nil, http.StatusOK), &live)
	if !strings.Contains(live.Instructions, `"Next Wed LA airport pickup" document_id=`+documentID+", last: open_email_canvas → opened") {
		t.Fatalf("live context names no call Document: %q", live.Instructions[max(0, len(live.Instructions)-400):])
	}
	// A revision the live model did not see gets the latest text back instead.
	stale := call("edit-0", "edit_email_canvas", map[string]string{"document_id": documentID, "revision_id": "revision_unseen", "subject": "Changed"})
	if stale["error"] != "canvas_changed" || stale["revision_id"] != revisionID || stale["subject"] != "Next Wed LA airport pickup" ||
		!strings.Contains(stale["body"].(string), "Can you pick me up at LAX at 9 am next Wednesday?") || computes.Load() != 0 {
		t.Fatalf("stale edit=%v computes=%d", stale, computes.Load())
	}
	// A header change keeps every line it leaves out and replaces only the
	// header, so the body's blocks stay as they are.
	edit := map[string]string{"document_id": documentID, "revision_id": revisionID, "subject": "Next Wed barbecue pickup", "cc": "bob@example.org"}
	changed := call("edit-1", "edit_email_canvas", edit)
	next, _ := changed["revision_id"].(string)
	if changed["status"] != "changed" || next == "" || next == revisionID {
		t.Fatalf("edit=%v", changed)
	}
	if content := <-replaced; content != "```\ncanvas: gmail\nto: amy@example.com\ncc: bob@example.org\nsubject: Next Wed barbecue pickup\nstatus: editing\nlink:\nexternal_id:\n```\n" {
		t.Fatalf("replacement=%q", content)
	}
	// The canvas title follows the subject, so the model never renames it.
	<-replaced
	if countRows(t, env, `SELECT count(*) FROM documents WHERE id=$1 AND title='Next Wed barbecue pickup'`, documentID) != 1 {
		t.Fatal("the canvas title did not follow the subject")
	}
	// A retried change does it once; the old revision no longer applies.
	if again := call("edit-1", "edit_email_canvas", edit); again["revision_id"] != next || computes.Load() != 2 {
		t.Fatalf("retried edit=%v computes=%d", again, computes.Load())
	}
	if superseded := call("edit-2", "edit_email_canvas", edit); superseded["error"] != "canvas_changed" || superseded["revision_id"] != next || superseded["subject"] != "Next Wed barbecue pickup" {
		t.Fatalf("superseded edit=%v", superseded)
	}
	// A body change replaces the body's text and leaves the header.
	body := map[string]string{"document_id": documentID, "revision_id": next, "body": "Hi Amy,\n\nBarbecue is on me!"}
	rewritten := call("edit-3", "edit_email_canvas", body)
	if content := <-replaced; rewritten["status"] != "changed" || content != "Hi Amy,\n\nBarbecue is on me!\n" {
		t.Fatalf("body edit=%v replacement=%q", rewritten, content)
	}
	stateOf := func() string {
		t.Helper()
		var state []byte
		if err := bodies.QueryRow(t.Context(), `SELECT state FROM document_bodies WHERE document_id=$1`, documentID).Scan(&state); err != nil {
			t.Fatal(err)
		}
		return string(state)
	}
	setState := func(state string) string {
		t.Helper()
		if _, err := bodies.Exec(t.Context(), `UPDATE document_bodies SET seq=seq+1,state=$2 WHERE document_id=$1`, documentID, []byte(state)); err != nil {
			t.Fatal(err)
		}
		return call("read-"+state[len(state)-8:], "edit_email_canvas", map[string]string{"document_id": documentID, "revision_id": "revision_unseen", "to": "x"})["revision_id"].(string)
	}
	// An attached file after the text stays through recipient and body
	// changes, and the model sees it apart from the text.
	attachment := "[plan.pdf (application/pdf)](document-asset:document_asset_plan)"
	header := strings.SplitN(stateOf(), "```\n\n", 2)[0] + "```\n\n"
	revision := setState(header + "Hi Amy,\n\nBarbecue is on me!\n\n" + attachment + "\n")
	recipients := call("edit-4", "edit_email_canvas", map[string]string{"document_id": documentID, "revision_id": revision, "to": "carol@example.com"})
	<-replaced
	rewritten = call("edit-5", "edit_email_canvas", map[string]string{"document_id": documentID, "revision_id": recipients["revision_id"].(string),
		"body": "Hi Carol,\n\nSee you at the Saturday barbecue.\n\n" + attachment})
	<-replaced
	if state := stateOf(); recipients["status"] != "changed" || rewritten["status"] != "changed" ||
		!strings.Contains(state, "to: carol@example.com") || !strings.HasSuffix(state, "Hi Carol,\n\nSee you at the Saturday barbecue.\n\n"+attachment+"\n") {
		t.Fatalf("recipients=%v body=%v state=%q", recipients, rewritten, state)
	}
	stale = call("edit-6", "edit_email_canvas", map[string]string{"document_id": documentID, "revision_id": "revision_unseen", "subject": "x"})
	if attachments, _ := stale["attachments"].([]any); len(attachments) != 1 || strings.Contains(stale["body"].(string), "document-asset") {
		t.Fatalf("canvas as the model sees it=%v", stale)
	}
	// Text after an attached file (an append) goes too: the new text takes
	// the first text's place and the file stays attached after it.
	revision = setState(header + "Hi Carol,\n\n" + attachment + "\n\nMeeting notes……\n")
	middle := call("edit-7", "edit_email_canvas", map[string]string{"document_id": documentID, "revision_id": revision, "body": "Hi Carol,\n\nSee you at the Saturday barbecue."})
	<-replaced
	<-replaced
	if state := stateOf(); middle["status"] != "changed" || state != header+"Hi Carol,\n\nSee you at the Saturday barbecue.\n\n"+attachment+"\n" {
		t.Fatalf("body edit around a file=%v state=%q", middle, state)
	}
	// An image among the text is part of what the email shows: a text
	// rewrite would lose it.
	revision = setState(header + "Hi Carol,\n\n![chart](document-asset:document_asset_chart)\n\nSee you at the Saturday barbecue.\n")
	if image := call("edit-8", "edit_email_canvas", map[string]string{"document_id": documentID, "revision_id": revision, "body": "x"}); image["error"] != "canvas_has_media" {
		t.Fatalf("body edit over an image among the text=%v", image)
	}
	// A document in this app is copied into the canvas as an attachment at
	// its end, without a task; a retried call attaches it once.
	setState(header + "Hi Carol,\n\nSee you at the Saturday barbecue.\n")
	notes := call("doc-1", "create_document", map[string]string{"title": "Barbecue list", "content": "- Beef\n- Corn"})
	notesID, _ := notes["document_id"].(string)
	attach := map[string]string{"document_id": documentID, "file_document_id": notesID}
	attached := call("attach-1", "attach_email_file", attach)
	if attached["status"] != "attached" {
		t.Fatalf("attach=%v", attached)
	}
	<-replaced
	name, _ := attached["attached"].(string)
	if attachments, _ := attached["attachments"].([]any); attached["status"] != "attached" || name == "" || len(attachments) != 1 || attachments[0] != name ||
		!strings.HasPrefix(strings.TrimPrefix(stateOf(), header), "Hi Carol,\n\nSee you at the Saturday barbecue.\n\n["+name+"](document-asset:document_asset_") {
		t.Fatalf("attach=%v state=%q", attached, stateOf())
	}
	if again := call("attach-1", "attach_email_file", attach); again["revision_id"] != attached["revision_id"] ||
		countRows(t, env, `SELECT count(*) FROM document_assets WHERE document_id=$1`, documentID) != 1 {
		t.Fatalf("retried attach=%v", again)
	}
	if missing := call("attach-2", "attach_email_file", map[string]string{"document_id": documentID, "file_document_id": "document_missing"}); missing["error"] != "document_not_found" {
		t.Fatalf("attach of a missing document=%v", missing)
	}
	// The file is named after the document's title, not its stored name.
	if name != "Barbecue list.md" {
		t.Fatalf("attached name=%q", name)
	}
	// Two files attached at once both land: calls on one Document take turns.
	results := make([]map[string]any, 2)
	var wait sync.WaitGroup
	for index, title := range []string{"Route", "Budget"} {
		created := call("doc-"+title, "create_document", map[string]string{"title": title, "content": "- " + title})
		wait.Add(1)
		go func() {
			defer wait.Done()
			results[index] = call("attach-at-once-"+title, "attach_email_file", map[string]string{"document_id": documentID, "file_document_id": created["document_id"].(string)})
		}()
	}
	wait.Wait()
	if results[0]["status"] != "attached" || results[1]["status"] != "attached" {
		t.Fatalf("attachments at once=%v", results)
	}
	<-replaced
	<-replaced
	if strings.Count(stateOf(), "](document-asset:") != 3 {
		t.Fatalf("attachments at once=%v state=%q", results, stateOf())
	}
	// A task's output is a folder: without a file the model is told to list it.
	if folder := call("attach-task", "attach_email_file", map[string]string{"document_id": documentID, "task_id": "t1"}); folder["error"] != "file_required" {
		t.Fatalf("attach of a task without a file=%v", folder)
	}
}
