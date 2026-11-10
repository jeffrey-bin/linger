package integration_test

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"strings"
	"testing"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentauth"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentsendmessage"
	artifactstore "github.com/simplexai-labs/linger/apps/teamhub/internal/artifact"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
)

func verifyAtomicAgentMessageCommit(t *testing.T, env *testEnv, token, roomID string) {
	verifyAtomicAgentMessageThread(t, env, token, roomID)
	t.Helper()
	send := func(invocation string, extra map[string]any, segments []map[string]any, contents []string) (int, []byte) {
		uploads := []map[string]any{}
		for index, content := range contents {
			digest := sha256.Sum256([]byte(content))
			uploads = append(uploads, map[string]any{"upload_id": fmt.Sprintf("upload_%d", index), "filename": fmt.Sprintf("part-%d.txt", index), "representation_format": "plain_text", "media_type": "text/plain", "size_bytes": len(content), "sha256": hex.EncodeToString(digest[:])})
		}
		var buffer bytes.Buffer
		writer := multipart.NewWriter(&buffer)
		part, err := writer.CreateFormField("metadata")
		if err != nil {
			t.Fatal(err)
		}
		metadata := map[string]any{"invocation_id": "agent-invocation-sha256:" + strings.Repeat(invocation, 64), "inbox_id": "room:" + roomID, "segments": segments, "uploads": uploads}
		for key, value := range extra {
			metadata[key] = value
		}
		if err := json.NewEncoder(part).Encode(metadata); err != nil {
			t.Fatal(err)
		}
		for index, content := range contents {
			part, err := writer.CreateFormFile("file", fmt.Sprintf("upload_%d", index))
			if err != nil {
				t.Fatal(err)
			}
			_, _ = io.WriteString(part, content)
		}
		_ = writer.Close()
		req, err := http.NewRequest(http.MethodPost, env.server.URL+"/api/agent/v1/messages/commit", &buffer)
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Content-Type", writer.FormDataContentType())
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("X-Teamhub-Context-Kind", "room")
		req.Header.Set("X-Teamhub-Context-Id", roomID)
		response, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		body, err := io.ReadAll(response.Body)
		if err != nil {
			t.Fatal(err)
		}
		return response.StatusCode, body
	}
	request := func(invocation string, segments []map[string]any, contents []string) (int, []byte) {
		return send(invocation, nil, segments, contents)
	}
	counts := func() (documents, messages int) {
		if err := env.pool.QueryRow(t.Context(), `SELECT (SELECT count(*) FROM documents WHERE creator_actor_id='actor_acme_official'),(SELECT count(*) FROM messages WHERE room_id=$1 AND author_actor_id='actor_acme_official')`, roomID).Scan(&documents, &messages); err != nil {
			t.Fatal(err)
		}
		return
	}
	beforeDocs, beforeMessages := counts()
	segments := []map[string]any{{"type": "text", "content": "Review "}, {"type": "document", "upload_id": "upload_0"}, {"type": "document", "upload_id": "upload_1"}}
	code, body := request("a", segments, []string{"first", "second"})
	if code != http.StatusOK {
		t.Fatalf("atomic commit: %d %s", code, body)
	}
	var first map[string]any
	decode(t, body, &first)
	if first["duplicate_request"] != false || len(first["resources"].([]any)) != 2 {
		t.Fatalf("incomplete atomic receipt: %s", body)
	}
	afterDocs, afterMessages := counts()
	if afterDocs-beforeDocs != 2 || afterMessages-beforeMessages != 1 {
		t.Fatalf("expected two Documents and one message, got docs %d messages %d", afterDocs-beforeDocs, afterMessages-beforeMessages)
	}
	code, body = request("a", segments, []string{"first", "second"})
	if code != http.StatusOK {
		t.Fatalf("atomic replay: %d %s", code, body)
	}
	var replay map[string]any
	decode(t, body, &replay)
	if replay["duplicate_request"] != true || replay["message_id"] != first["message_id"] || fmt.Sprint(replay["resources"]) != fmt.Sprint(first["resources"]) {
		t.Fatalf("replay changed original identity/resources: %s", body)
	}
	code, body = request("a", segments, []string{"changed", "second"})
	if code != http.StatusConflict {
		t.Fatalf("different immutable bytes reused receipt: %d %s", code, body)
	}
	// The first new Document is already inserted when the second segment names
	// a Document that does not exist. All publication and collaboration facts
	// must roll back.
	code, body = request("b", []map[string]any{{"type": "document", "upload_id": "upload_0"}, {"type": "document", "document_id": "document_missing", "content": "missing"}}, []string{"rollback-first"})
	if code != http.StatusBadRequest {
		t.Fatalf("invalid later resource: %d %s", code, body)
	}
	finalDocs, finalMessages := counts()
	if finalDocs != afterDocs || finalMessages != afterMessages {
		t.Fatalf("partial publication escaped rollback: docs %d->%d messages %d->%d", afterDocs, finalDocs, afterMessages, finalMessages)
	}
	// The existing tree publisher's conflict and placement logic joins this same
	// transaction, and its usual standalone delivery is suppressed.
	tree := []map[string]any{{"type": "document", "mode": "tree", "root_name": "atomic-tree", "entries": []map[string]any{{"kind": "directory", "relative_path": "empty"}, {"kind": "file", "relative_path": "report.txt", "upload_id": "upload_0"}}}}
	code, body = request("c", tree, []string{"tree bytes"})
	if code != http.StatusOK {
		t.Fatalf("atomic tree: %d %s", code, body)
	}
	var treeResult map[string]any
	decode(t, body, &treeResult)
	resources := treeResult["resources"].([]any)
	resource := resources[0].(map[string]any)
	if resource["file_count"] != float64(1) || resource["directory_count"] != float64(2) || len(resource["documents"].([]any)) != 1 {
		t.Fatalf("tree manifest lost coverage: %s", body)
	}
	treeDocs, treeMessages := counts()
	if treeDocs-afterDocs != 1 || treeMessages-afterMessages != 1 {
		t.Fatalf("tree emitted extra delivery: docs %d messages %d", treeDocs-afterDocs, treeMessages-afterMessages)
	}
	code, body = request("8", tree, []string{"different tree bytes"})
	if code != http.StatusConflict || !bytes.Contains(body, []byte(`"code":"path_conflict"`)) {
		t.Fatalf("tree placement conflict lost business error: %d %s", code, body)
	}
	conflictDocs, conflictMessages := counts()
	if conflictDocs != treeDocs || conflictMessages != treeMessages {
		t.Fatal("tree conflict published partial state")
	}
	// A card title presents the Message as a light card (teamhub message card).
	// It belongs to the request identity, and only a clean one-line title is
	// accepted.
	card := []map[string]any{{"type": "text", "content": "Five competitors compared."}, {"type": "document", "upload_id": "upload_0"}}
	code, body = send("d", map[string]any{"card_title": "Competitor comparison"}, card, []string{"table"})
	if code != http.StatusOK {
		t.Fatalf("card commit: %d %s", code, body)
	}
	var cardResult map[string]any
	decode(t, body, &cardResult)
	if countRows(t, env, `SELECT count(*) FROM messages WHERE id=$1 AND card_title='Competitor comparison'
		AND message_kind='conversation'`, cardResult["message_id"]) != 1 {
		t.Fatalf("the card title was not kept: %s", body)
	}
	if code, body = send("d", map[string]any{"card_title": "Another title"}, card, []string{"table"}); code != http.StatusConflict {
		t.Fatalf("a different card title reused the receipt: %d %s", code, body)
	}
	if code, body = send("e", map[string]any{"card_title": " padded "}, card, []string{"table"}); code != http.StatusBadRequest {
		t.Fatalf("a padded card title was accepted: %d %s", code, body)
	}
	// A card kind marks a profile delivery on the Message and in
	// message.created; it is part of the request identity and needs a title.
	code, body = send("f", map[string]any{"card_title": "Alex", "card_kind": "profile"}, card, []string{"table"})
	if code != http.StatusOK {
		t.Fatalf("profile card commit: %d %s", code, body)
	}
	var profileResult struct {
		MessageID string `json:"message_id"`
	}
	decode(t, body, &profileResult)
	if countRows(t, env, `SELECT count(*) FROM messages m JOIN room_events event ON event.resource_id=m.id AND event.event_type='message.created'
		WHERE m.id=$1 AND m.card_kind='profile' AND event.payload->'message'->>'card_kind'='profile'`, profileResult.MessageID) != 1 {
		t.Fatalf("the card kind was not kept: %s", body)
	}
	code, _, body = env.request(env.login("alice", alicePassword), http.MethodGet, "/v0/rooms/"+roomID+"/messages", nil, "")
	if code != http.StatusOK {
		t.Fatalf("list messages: %d %s", code, body)
	}
	var listed struct {
		Items []struct {
			ID       string `json:"id"`
			CardKind string `json:"card_kind"`
		} `json:"items"`
	}
	decode(t, body, &listed)
	kinds := map[string]string{}
	for _, message := range listed.Items {
		kinds[message.ID] = message.CardKind
	}
	if kinds[profileResult.MessageID] != "profile" || kinds[cardResult["message_id"].(string)] != "" {
		t.Fatalf("listed card kinds=%v", kinds)
	}
	if code, body = send("f", map[string]any{"card_title": "Alex"}, card, []string{"table"}); code != http.StatusConflict {
		t.Fatalf("a replay without the card kind reused the receipt: %d %s", code, body)
	}
	if code, body = send("7", map[string]any{"card_kind": "profile"}, card, []string{"table"}); code != http.StatusBadRequest {
		t.Fatalf("a card kind without a title was accepted: %d %s", code, body)
	}
	if code, body = send("6", map[string]any{"card_title": "Alex", "card_kind": "report"}, card, []string{"table"}); code != http.StatusBadRequest {
		t.Fatalf("an unknown card kind was accepted: %d %s", code, body)
	}
}

func verifyAtomicAgentMessageThread(t *testing.T, env *testEnv, token, roomID string) {
	t.Helper()
	ctx := t.Context()
	objects, err := artifactstore.NewLocalStore(env.artifactRoot, 50<<20)
	if err != nil {
		t.Fatal(err)
	}
	service := agentsendmessage.New(env.pool, agentauth.New(env.pool), document.NewWithObjectStore(env.pool, objects), objects)
	insertHistoryFixture(t, env, roomID, "atomic_thread_root", "conversation", "Atomic Thread root")
	if _, err := env.pool.Exec(ctx, `UPDATE messages SET author_actor_id='actor_acme_official' WHERE id='atomic_thread_root'`); err != nil {
		t.Fatal(err)
	}
	code, _, body := env.request(env.login("alice", alicePassword), http.MethodPost, "/v0/rooms/"+roomID+"/messages/atomic_thread_root/thread", map[string]any{}, "atomic-thread")
	if code != http.StatusCreated && code != http.StatusOK {
		t.Fatalf("create atomic Thread: %d %s", code, body)
	}
	var thread struct {
		Room struct {
			ID string `json:"id"`
		} `json:"room"`
	}
	decode(t, body, &thread)
	data := []byte("Thread bytes")
	object, err := objects.Put(ctx, bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	threadInput := agentsendmessage.Input{InboxID: "thread:" + thread.Room.ID, InvocationID: "agent-invocation-sha256:" + strings.Repeat("9", 64), Atomic: &agentsendmessage.AtomicInput{Segments: []agentsendmessage.PreparedSegment{{Type: "document", UploadID: "upload_0", Mode: "file"}}, Uploads: []agentsendmessage.PreparedUpload{{UploadID: "upload_0", Filename: "thread.txt", RepresentationFormat: "plain_text", MediaType: "text/plain", SizeBytes: int64(len(data)), SHA256: hex.EncodeToString(object.SHA256[:]), ObjectKey: object.Key}}}}
	threadResult, err := service.Send(agentauth.WithTarget(ctx, "room", roomID), token, threadInput)
	if err != nil || len(threadResult.Resources) != 1 {
		t.Fatalf("Thread resource transaction: %+v %v", threadResult, err)
	}
	if count := countRows(t, env, `SELECT count(*) FROM messages WHERE id=$1 AND room_id=$2`, threadResult.MessageID, thread.Room.ID); count != 1 {
		t.Fatalf("Thread message delivered outside actual Thread")
	}
	if count := countRows(t, env, `SELECT count(*) FROM document_context_bindings WHERE document_id=$1 AND room_id=$2 AND status='active'`, threadResult.Resources[0].DocumentID, roomID); count != 1 {
		t.Fatalf("Thread resource missing parent Room authority")
	}
}
