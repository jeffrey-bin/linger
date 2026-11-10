package integration_test

import (
	"bytes"
	"context"
	"encoding/hex"
	"net/http"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentcredential"
)

func TestUnifiedDocumentMessageAttachmentUploadIsSingleWrite(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newRoomDocumentRealtimeEnv(t)
	suffix := hex.EncodeToString([]byte(time.Now().UTC().Format("150405.000000")))
	agentActorID := "actor_document_attachment_" + suffix
	agentManagementID := "agent_document_attachment_" + suffix
	if _, err := env.pool.Exec(t.Context(), `INSERT INTO actors(
		id,tenant_id,kind,display_name,handle
	) VALUES($1,$2,'agent','Document Attachment Agent',$3)`, agentActorID, acmeTenant,
		"document-attachment-"+suffix); err != nil {
		t.Fatal(err)
	}
	if _, err := env.pool.Exec(t.Context(), `INSERT INTO agent_registrations(
			actor_id,tenant_id,agent_management_id,status,instructions,runtime_model,
			created_by_actor_id,visibility_scope,agent_type,
			computer_id,local_runtime_type,workspace_grant_id
		) VALUES($1,$2,$3,'active','Review attached Documents.','test-model',
			'actor_acme_alice','sponsor','general','computer_fixture','codex','grant_files')`, agentActorID, acmeTenant,
		agentManagementID); err != nil {
		t.Fatal(err)
	}
	roomID := env.createRoom(alice, acmeTenant, "Document attachment "+suffix, "document-attachment-room-"+suffix)
	if status, body := putRoomMember(t, env, alice, roomID, agentActorID, "member"); status != http.StatusOK {
		t.Fatalf("add Agent status=%d body=%s", status, body)
	}
	otherRoomID := env.createRoom(alice, acmeTenant, "Other attachment "+suffix, "document-attachment-other-"+suffix)
	upload := uploadMessageAttachment(t, alice, env.server.URL, roomID, "document-attachment-upload-"+suffix, "report.txt", []byte("immutable Document attachment"))

	payload := map[string]any{
		"raw_message":           "Review",
		"segments":              []map[string]any{{"type": "text", "content": "Review"}},
		"attachment_upload_ids": []string{upload.ID},
	}
	status, _, body := env.request(alice, http.MethodPost, "/v0/rooms/"+roomID+"/messages", payload, "document-attachment-message-"+suffix)
	if status != http.StatusCreated {
		t.Fatalf("create Message with Document attachment status=%d body=%s", status, body)
	}
	var message struct {
		ID          string           `json:"id"`
		RawMessage  string           `json:"raw_message"`
		Segments    []map[string]any `json:"segments"`
		Attachments []struct {
			ID                string `json:"id"`
			DocumentID        string `json:"document_id"`
			DocumentVersionID string `json:"document_version_id"`
			Filename          string `json:"filename"`
			Available         bool   `json:"available"`
		} `json:"attachments"`
	}
	decode(t, body, &message)
	if len(message.Attachments) != 1 || message.Attachments[0].DocumentID == "" ||
		message.Attachments[0].DocumentVersionID == "" || message.Attachments[0].Filename != "report.txt" ||
		!message.Attachments[0].Available || bytes.Contains(body, []byte("artifact_id")) ||
		bytes.Contains(body, []byte("artifact_version_id")) {
		t.Fatalf("Message attachment did not expose only Document identity: %s", body)
	}
	if message.RawMessage != "Review\nreport.txt" || len(message.Segments) != 3 ||
		message.Segments[2]["document_id"] != message.Attachments[0].DocumentID ||
		message.Segments[2]["type"] != "document" || message.Segments[2]["presentation"] != "card" ||
		message.Segments[2]["document_version_id"] != nil {
		t.Fatalf("Message did not deliver the uploaded Document as a card: %s", body)
	}
	var persistedDocumentID, persistedVersionID string
	if err := env.pool.QueryRow(context.Background(), `SELECT attachment->>'document_id',attachment->>'document_version_id'
		FROM messages CROSS JOIN LATERAL jsonb_array_elements(attachments) attachment WHERE id=$1`, message.ID).
		Scan(&persistedDocumentID, &persistedVersionID); err != nil {
		t.Fatal(err)
	}
	if persistedDocumentID != message.Attachments[0].DocumentID ||
		persistedVersionID != message.Attachments[0].DocumentVersionID {
		t.Fatalf("Message attachment persistence document=%q version=%q", persistedDocumentID, persistedVersionID)
	}
	var ownerPlacements, roomBindings int
	if err := env.pool.QueryRow(context.Background(), `SELECT
		(SELECT count(*) FROM document_placements
		 WHERE document_id=$1 AND scope_kind='personal'
		   AND owner_human_actor_id='actor_acme_alice' AND parent_id IS NULL),
		(SELECT count(*) FROM document_context_bindings
		 WHERE document_id=$1 AND binding_kind='room' AND room_id=$2 AND status='active')`,
		message.Attachments[0].DocumentID, roomID).Scan(&ownerPlacements, &roomBindings); err != nil {
		t.Fatal(err)
	}
	if ownerPlacements != 1 || roomBindings != 1 {
		t.Fatalf("attachment placement/binding=%d/%d", ownerPlacements, roomBindings)
	}
	if !agentCanReadDocument(t, env, agentManagementID, message.Attachments[0].DocumentID) {
		t.Fatal("Room member Agent cannot read the attachment")
	}

	rejectedUpload := uploadMessageAttachment(t, alice, env.server.URL, roomID, "document-attachment-rejected-upload-"+suffix, "hidden.txt", []byte("hidden"))
	beforeMessages := countRows(t, env, `SELECT count(*) FROM messages`)
	beforeDocuments := countRows(t, env, `SELECT count(*) FROM documents`)
	status, _, body = env.request(alice, http.MethodPost, "/v0/rooms/"+otherRoomID+"/messages", map[string]any{
		"raw_message": "Hidden", "segments": []map[string]any{{"type": "text", "content": "Hidden"}},
		"attachment_upload_ids": []string{rejectedUpload.ID},
	}, "document-attachment-rejected-message-"+suffix)
	if status != http.StatusConflict {
		t.Fatalf("cross-Room attachment status=%d body=%s", status, body)
	}
	if countRows(t, env, `SELECT count(*) FROM messages`) != beforeMessages ||
		countRows(t, env, `SELECT count(*) FROM documents`) != beforeDocuments {
		t.Fatal("rejected attachment created a partial Message or Document")
	}
}

func TestUnifiedDocumentRoomMessageReferenceAdmission(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newRoomDocumentRealtimeEnv(t)
	suffix := hex.EncodeToString([]byte(time.Now().UTC().Format("150405.000000")))
	roomID := env.createRoom(alice, acmeTenant, "Document references "+suffix, "document-reference-room-"+suffix)
	otherRoomID := env.createRoom(alice, acmeTenant, "Other references "+suffix, "document-reference-other-"+suffix)

	status, _, body := env.request(alice, http.MethodPost, "/v0/rooms/"+roomID+"/documents", map[string]any{}, "document-reference-create-"+suffix)
	if status != http.StatusCreated {
		t.Fatalf("create Document status=%d body=%s", status, body)
	}
	var created struct {
		ID string `json:"id"`
	}
	decode(t, body, &created)
	var baselineBindings int
	if err := env.pool.QueryRow(context.Background(), `SELECT count(*) FROM document_context_bindings
		WHERE document_id=$1`, created.ID).Scan(&baselineBindings); err != nil {
		t.Fatal(err)
	}

	status, _, body = env.request(alice, http.MethodGet, "/v0/rooms/"+roomID+"/documents?limit=10", nil, "")
	if status != http.StatusOK {
		t.Fatalf("list Room Documents status=%d body=%s", status, body)
	}
	var page struct {
		Items []struct {
			ID string `json:"id"`
		} `json:"items"`
		Page struct {
			HasMore bool `json:"has_more"`
		} `json:"page"`
	}
	decode(t, body, &page)
	if len(page.Items) != 1 || page.Items[0].ID != created.ID || page.Page.HasMore {
		t.Fatalf("Room Document candidates=%+v body=%s", page, body)
	}
	status, _, ownerTree := env.request(alice, http.MethodGet, "/v0/tenants/"+acmeTenant+"/me/document-tree", nil, "")
	if status != http.StatusOK || !bytes.Contains(ownerTree, []byte(created.ID)) {
		t.Fatalf("Alice personal tree status=%d body=%s", status, ownerTree)
	}

	status, _, body = env.request(alice, http.MethodGet, "/v0/rooms/"+otherRoomID+"/documents", nil, "")
	if status != http.StatusOK {
		t.Fatalf("list empty Room Documents status=%d body=%s", status, body)
	}
	decode(t, body, &page)
	if len(page.Items) != 0 || page.Page.HasMore {
		t.Fatalf("empty Room leaked Document candidates=%+v body=%s", page, body)
	}

	token := "@Untitled"
	payload := map[string]any{
		"raw_message": token,
		"segments": []map[string]any{{
			"type": "document", "content": token, "document_id": created.ID,
		}},
	}
	status, _, body = env.request(alice, http.MethodPost, "/v0/rooms/"+roomID+"/messages", payload, "document-reference-message-"+suffix)
	if status != http.StatusCreated {
		t.Fatalf("create Document reference Message status=%d body=%s", status, body)
	}
	var message struct {
		ID       string           `json:"id"`
		Segments []map[string]any `json:"segments"`
	}
	decode(t, body, &message)
	if len(message.Segments) != 1 || message.Segments[0]["type"] != "document" ||
		message.Segments[0]["document_id"] != created.ID {
		t.Fatalf("Document reference Message=%+v body=%s", message, body)
	}
	before := countRows(t, env, `SELECT count(*) FROM messages`)
	status, _, body = env.request(alice, http.MethodPost, "/v0/rooms/"+otherRoomID+"/messages", payload, "document-reference-cross-context-"+suffix)
	if status != http.StatusCreated {
		t.Fatalf("cross-Context Document reference status=%d body=%s", status, body)
	}
	decode(t, body, &message)
	after := countRows(t, env, `SELECT count(*) FROM messages`)
	if after != before+1 {
		t.Fatalf("cross-Context Document reference did not create Message before=%d after=%d", before, after)
	}

	var bindings int
	if err := env.pool.QueryRow(context.Background(), `SELECT count(*) FROM document_context_bindings
		WHERE document_id=$1`, created.ID).Scan(&bindings); err != nil {
		t.Fatal(err)
	}
	if bindings != baselineBindings+1 {
		t.Fatalf("cross-Context Document reference did not create one Binding bindings=%d→%d",
			baselineBindings, bindings)
	}
	assertRole := func(targetRoomID, expectedRole string) {
		t.Helper()
		var role string
		if err := env.pool.QueryRow(t.Context(), `SELECT role FROM document_context_bindings
			WHERE document_id=$1 AND room_id=$2 AND status='active'`, created.ID, targetRoomID).Scan(&role); err != nil {
			t.Fatal(err)
		}
		if role != expectedRole {
			t.Fatalf("Room %s binding role=%s want %s", targetRoomID, role, expectedRole)
		}
	}
	assertRole(roomID, "editor")
	assertRole(otherRoomID, "manager")
}

func TestUnifiedDocumentAgentRoomMessageReferenceAdmission(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newRoomDocumentRealtimeEnv(t)
	suffix := hex.EncodeToString([]byte(time.Now().UTC().Format("150405.000000")))
	roomID := env.createRoom(alice, acmeTenant, "Agent Document references "+suffix, "agent-document-reference-room-"+suffix)
	otherRoomID := env.createRoom(alice, acmeTenant, "Agent other references "+suffix, "agent-document-reference-other-"+suffix)
	for _, candidate := range []string{roomID, otherRoomID} {
		if status, body := putRoomMember(t, env, alice, candidate, "actor_acme_official", "member"); status != http.StatusOK {
			t.Fatalf("add Agent to Room %s status=%d body=%s", candidate, status, body)
		}
	}

	status, _, body := env.request(alice, http.MethodPost, "/v0/rooms/"+roomID+"/documents", map[string]any{}, "agent-document-reference-create-"+suffix)
	if status != http.StatusCreated {
		t.Fatalf("create Document status=%d body=%s", status, body)
	}
	var created struct {
		ID string `json:"id"`
	}
	decode(t, body, &created)
	issued, err := agentcredential.New(env.pool).IssueManaged(t.Context(), acmeOfficialAgentManagementID, "Document reference CLI")
	if err != nil {
		t.Fatal(err)
	}
	reference := func(targetRoomID, operation string) map[string]any {
		return map[string]any{
			"invocation_id": "agent-invocation-sha256:" + semanticDigest([]byte(operation)), "inbox_id": "room:" + targetRoomID,
			"segments": []map[string]any{
				{"type": "text", "content": "Review "},
				{"type": "document", "content": "@Untitled", "document_id": created.ID},
			},
		}
	}
	status, body = commitAgentMessage(t, env, issued.AccessToken, "room", roomID, reference(roomID, "agent-document-reference-message-"+suffix))
	if status != http.StatusOK {
		t.Fatalf("create Agent Document reference Message status=%d body=%s", status, body)
	}
	var receipt struct {
		MessageID string `json:"message_id"`
	}
	decode(t, body, &receipt)
	status, _, body = env.request(alice, http.MethodGet, "/v0/rooms/"+roomID+"/messages/"+receipt.MessageID, nil, "")
	if status != http.StatusOK {
		t.Fatalf("read Agent Document reference Message status=%d body=%s", status, body)
	}
	var message struct {
		Segments []map[string]any `json:"segments"`
	}
	decode(t, body, &message)
	if len(message.Segments) != 2 || message.Segments[1]["type"] != "document" ||
		message.Segments[1]["document_id"] != created.ID {
		t.Fatalf("Agent Document reference Message=%+v body=%s", message, body)
	}

	before := countRows(t, env, `SELECT count(*) FROM messages`)
	status, body = commitAgentMessage(t, env, issued.AccessToken, "room", otherRoomID, reference(otherRoomID, "agent-document-reference-cross-context-"+suffix))
	if status != http.StatusBadRequest {
		t.Fatalf("cross-Context Agent Document reference status=%d body=%s", status, body)
	}
	if after := countRows(t, env, `SELECT count(*) FROM messages`); after != before {
		t.Fatalf("rejected Agent Document reference changed Message count before=%d after=%d", before, after)
	}
}
