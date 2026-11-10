package integration_test

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentauth"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentcreationapproval"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentcredential"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentsendmessage"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/messagecreation"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/typedcard"
)

func TestAgentCreationApprovalPostgreSQLVerticalSlice(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newAgentRunEnv(t, "http://127.0.0.1:1")
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	if _, err := env.pool.Exec(t.Context(), `
		UPDATE agent_registrations
		SET agent_type='anotherme',receives_all_messages=true,represented_human_actor_id='actor_acme_alice'
		WHERE actor_id='actor_acme_official' AND tenant_id=$1`, acmeTenant); err != nil {
		t.Fatal(err)
	}
	originRoomID := createPrivateRoom(t, env, alice, "MCP Creation "+suffix, "mcp-creation-room-"+suffix)
	if status, body := putRoomMember(t, env, alice, originRoomID, "actor_acme_official", "member"); status != http.StatusOK {
		t.Fatalf("add Creation Agent status=%d body=%s", status, body)
	}
	discussionAgentActorID := "actor_mcp_discussion_agent_" + suffix
	discussionAgentManagementID := "agent-management-mcp-discussion-" + suffix
	if _, err := env.pool.Exec(t.Context(), `
		INSERT INTO actors(id,tenant_id,kind,display_name,handle)
		VALUES($1,$2,'agent','Discussion Worker',$3)`,
		discussionAgentActorID, acmeTenant, "@discussion-worker-"+suffix); err != nil {
		t.Fatal(err)
	}
	if _, err := env.pool.Exec(t.Context(), `
		INSERT INTO agent_registrations(
			actor_id,tenant_id,agent_management_id,status,description,instructions,runtime_model,
			created_by_actor_id,visibility_scope,agent_type,
			computer_id,local_runtime_type,workspace_grant_id
		) VALUES($1,$2,$3,'active','Researches evidence.','Execute discussed Tasks.','gpt-5',
			'actor_acme_alice','sponsor','general','computer_fixture','codex','grant_files')`,
		discussionAgentActorID, acmeTenant, discussionAgentManagementID); err != nil {
		t.Fatal(err)
	}
	workspaceAgentActorID := "actor_mcp_workspace_agent_" + suffix
	inactiveAgentActorID := "actor_mcp_inactive_agent_" + suffix
	if _, err := env.pool.Exec(t.Context(), `
		INSERT INTO actors(id,tenant_id,kind,display_name,handle) VALUES
			($1,$3,'agent','Workspace Worker',$4),
			($2,$3,'agent','Inactive Worker',$5)`,
		workspaceAgentActorID, inactiveAgentActorID, acmeTenant,
		"@workspace-worker-"+suffix, "@inactive-worker-"+suffix); err != nil {
		t.Fatal(err)
	}
	if _, err := env.pool.Exec(t.Context(), `
		INSERT INTO agent_registrations(
			actor_id,tenant_id,agent_management_id,status,description,instructions,runtime_model,
			created_by_actor_id,visibility_scope,agent_type,
			computer_id,local_runtime_type,workspace_grant_id
		) VALUES
			($1,$3,$4,'active','Visible across the workspace.','Work safely.','gpt-5','actor_acme_alice','workspace','general','computer_fixture','codex','grant_files'),
			($2,$3,$5,'revoked','Not active yet.','Work safely.','gpt-5','actor_acme_alice','sponsor','general','computer_fixture','codex','grant_files')`,
		workspaceAgentActorID, inactiveAgentActorID, acmeTenant,
		"agent-management-mcp-workspace-"+suffix, "agent-management-mcp-inactive-"+suffix); err != nil {
		t.Fatal(err)
	}
	if status, body := putRoomMember(t, env, alice, originRoomID, discussionAgentActorID, "member"); status != http.StatusOK {
		t.Fatalf("add discussion Agent status=%d body=%s", status, body)
	}
	contexts := agentauth.New(env.pool)
	issued, err := agentcredential.New(env.pool).IssueManaged(t.Context(), acmeOfficialAgentManagementID, "creation approval")
	if err != nil {
		t.Fatal(err)
	}
	token := issued.AccessToken

	service := agentcreationapproval.New(env.pool, contexts, typedcard.New(env.pool))
	available, err := service.ListAvailableAgents(
		t.Context(), token, "", 100,
	)
	if err != nil {
		t.Fatalf("list Sponsor-authorized Agents: %v", err)
	}
	availableByID := make(map[string]agentcreationapproval.AvailableAgent, len(available.Agents))
	for _, agent := range available.Agents {
		availableByID[agent.ActorID] = agent
	}
	if availableByID[discussionAgentActorID].Name != "Discussion Worker" ||
		availableByID[workspaceAgentActorID].Name != "Workspace Worker" {
		t.Fatalf("available Agents=%+v", available.Agents)
	}
	for _, forbiddenActorID := range []string{
		inactiveAgentActorID, "actor_acme_official",
	} {
		if _, found := availableByID[forbiddenActorID]; found {
			t.Fatalf("unauthorized Agent %s was listed: %+v", forbiddenActorID, available.Agents)
		}
	}

	status, _, roomArtifactBody := requestUnifiedDocumentMultipart(
		t, env, alice, "/v0/rooms/"+originRoomID+"/documents/uploads",
		"mcp-creation-room-artifact-"+suffix,
		map[string]string{
			"filename": "room-brief-v1.txt", "representation_format": "plain_text", "media_type": "text/plain",
		},
		"room-brief-v1.txt", []byte("frozen Room brief v1\n"),
	)
	if status != http.StatusCreated {
		t.Fatalf("upload Room Creation artifact status=%d body=%s", status, roomArtifactBody)
	}
	var roomArtifact uploadedDocumentRef
	decode(t, roomArtifactBody, &roomArtifact)
	if roomArtifact.ID == "" || roomArtifact.CurrentVersion.ID == "" {
		t.Fatalf("Room Creation artifact=%+v", roomArtifact)
	}
	nativeArtifactID := "document_mcp_room_native_" + suffix
	nativeRevisionID := "document_revision_mcp_room_native_" + suffix
	nativeArtifactTitle := "Room native brief " + suffix
	nativeArtifactStatements := []struct {
		query string
		args  []any
	}{
		{
			query: `INSERT INTO documents(
				id,tenant_id,title,format,native_representation_format,owner_actor_id,owner_actor_kind,
				creator_actor_id,creator_actor_kind,status
			) VALUES($1,'tenant_acme',$2,'blocknote','markdown','actor_acme_alice','human',
				'actor_acme_alice','human','active')`,
			args: []any{nativeArtifactID, nativeArtifactTitle},
		},
		{
			query: `INSERT INTO document_revisions(
				id,tenant_id,document_id,persisted_seq,state_vector,full_state_fingerprint,
				state_bytes,state_bytes_sha256,asset_manifest,created_by_actor_id
			) VALUES($1,'tenant_acme',$2,0,'\x00',repeat('d',64),'\x00',
				'6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d',
				'[]'::jsonb,'actor_acme_alice')`,
			args: []any{nativeRevisionID, nativeArtifactID},
		},
		{
			query: `INSERT INTO document_bodies(document_id,seq,state,state_vector,asset_ids,thread_ids,last_editor_ids) SELECT draft.document_id,draft.persisted_seq::bigint,revision.state_bytes,draft.state_vector::bytea,ARRAY(SELECT asset->>'asset_id' FROM jsonb_array_elements(revision.asset_manifest) asset ORDER BY 1),revision.thread_manifest,ARRAY[draft.last_content_actor_id]::text[] FROM (VALUES ($1,'tenant_acme',$2,0,'\x00',repeat('d',64),$3,'actor_acme_alice')) AS draft(document_id,tenant_id,title,persisted_seq,state_vector,full_state_fingerprint,current_revision_id,last_content_actor_id) JOIN document_revisions revision ON revision.id=draft.current_revision_id`,
			args:  []any{nativeArtifactID, nativeArtifactTitle, nativeRevisionID},
		},
		{
			query: `INSERT INTO document_context_bindings(
				id,tenant_id,document_id,binding_kind,room_id,status,role
			) VALUES($1,'tenant_acme',$2,'room',$3,'active','manager')`,
			args: []any{"document_binding_mcp_room_native_" + suffix, nativeArtifactID, originRoomID},
		},
	}
	for _, statement := range nativeArtifactStatements {
		if _, err := env.pool.Exec(t.Context(), statement.query, statement.args...); err != nil {
			t.Fatalf("seed native Room Creation artifact: %v", err)
		}
	}

	roomName := "Approved MCP Room " + suffix
	roomInput := agentcreationapproval.Input{
		RequestKind: "room_creation",
		RoomCaller: &agentcreationapproval.RoomCallerInput{
			Name: roomName, MemberIDs: []string{"actor_acme_official"},
			Artifacts:              []string{nativeArtifactID, roomArtifact.ID},
			InitialMessageSegments: []messagecreation.Segment{{Type: "text", Content: "Start the approved Room."}},
		},
		RoomEffective: &agentcreationapproval.RoomEffectivePayload{
			Name: roomName, MemberIDs: []string{"actor_acme_official"},
			Artifacts:              []string{nativeArtifactID, roomArtifact.ID},
			InitialMessageSegments: []messagecreation.Segment{{Type: "text", Content: "Start the approved Room."}},
		},
		SourceInboxIDs: []string{"room:" + originRoomID},
		InvocationID:   mcpCreationInvocationID(suffix + ":room"),
	}
	// The requesting Meta sends its Room Context, as its CLI configuration does.
	pendingRoom, err := service.Submit(agentauth.WithTarget(t.Context(), "room", originRoomID), token, roomInput)
	if err != nil {
		t.Fatalf("submit Room Creation approval: %v", err)
	}
	assertMcpCreationPendingFacts(t, env, pendingRoom, "room_creation", originRoomID)
	var frozenRoomSnapshotJSON []byte
	if err := env.pool.QueryRow(t.Context(), `
		SELECT request->'fulfillment_snapshot' FROM decisions WHERE id=$1
	`, pendingRoom.CreationApprovalRequestID).Scan(&frozenRoomSnapshotJSON); err != nil {
		t.Fatal(err)
	}
	var frozenRoomSnapshot typedcard.RoomCreationSnapshot
	if err := json.Unmarshal(frozenRoomSnapshotJSON, &frozenRoomSnapshot); err != nil {
		t.Fatal(err)
	}
	if len(frozenRoomSnapshot.Artifacts) != 2 ||
		frozenRoomSnapshot.Artifacts[0].DocumentID != nativeArtifactID ||
		frozenRoomSnapshot.Artifacts[0].DocumentRevisionID != nativeRevisionID ||
		frozenRoomSnapshot.Artifacts[0].DocumentVersionID != "" ||
		frozenRoomSnapshot.Artifacts[1].DocumentID != roomArtifact.ID ||
		frozenRoomSnapshot.Artifacts[1].DocumentVersionID != roomArtifact.CurrentVersion.ID ||
		frozenRoomSnapshot.Artifacts[1].DocumentRevisionID != "" ||
		len(frozenRoomSnapshot.InitialMessageSegments) != 5 ||
		frozenRoomSnapshot.InitialMessageSegments[2].Type != "document" ||
		frozenRoomSnapshot.InitialMessageSegments[2].DocumentID != nativeArtifactID ||
		frozenRoomSnapshot.InitialMessageSegments[4].Type != "document" ||
		frozenRoomSnapshot.InitialMessageSegments[4].DocumentID != roomArtifact.ID {
		t.Fatalf("frozen Room Creation snapshot=%+v", frozenRoomSnapshot)
	}
	status, _, replacementBody := requestUnifiedDocumentVersionUpload(
		t, env, alice, roomArtifact.ID, "mcp-creation-room-artifact-v2-"+suffix,
		map[string]string{
			"expected_current_version_id": roomArtifact.CurrentVersion.ID,
			"filename":                    "room-brief-v2.txt", "representation_format": "plain_text", "media_type": "text/plain",
		},
		"room-brief-v2.txt", []byte("newer Room brief v2\n"),
	)
	if status != http.StatusCreated {
		t.Fatalf("replace Room Creation artifact status=%d body=%s", status, replacementBody)
	}
	var replacementVersion struct {
		ID string `json:"id"`
	}
	decode(t, replacementBody, &replacementVersion)
	if replacementVersion.ID == "" || replacementVersion.ID == roomArtifact.CurrentVersion.ID {
		t.Fatalf("replacement Room Creation Version=%+v", replacementVersion)
	}

	roomsBeforeRoomApproval := countRows(t, env, `SELECT count(*) FROM rooms WHERE tenant_id=$1`, acmeTenant)
	status, _, body := env.request(alice, http.MethodPost,
		"/v0/decisions/"+pendingRoom.CreationApprovalRequestID,
		map[string]any{"decision": "approve", "expected_version": int64(1)}, "")
	if status != http.StatusOK {
		t.Fatalf("approve Room Creation status=%d body=%s", status, body)
	}
	var createdRoomID string
	if err := env.pool.QueryRow(t.Context(), `
		SELECT room.id FROM decisions request
		JOIN rooms room ON room.id=request.result->'data'->>'created_room_id' AND room.tenant_id=request.tenant_id
		WHERE request.id=$1 AND request.status='succeeded' AND room.name=$2
	`, pendingRoom.CreationApprovalRequestID, roomName).Scan(&createdRoomID); err != nil {
		t.Fatalf("load approved Room Creation: %v", err)
	}
	if got := countRows(t, env, `SELECT count(*) FROM rooms WHERE tenant_id=$1`, acmeTenant); got != roomsBeforeRoomApproval+1 {
		t.Fatalf("approved Room count=%d want=%d", got, roomsBeforeRoomApproval+1)
	}
	var initialMessageID string
	var initialSegmentsJSON []byte
	if err := env.pool.QueryRow(t.Context(), `
		SELECT id,segments FROM messages
		WHERE room_id=$1 AND author_actor_id='actor_acme_official' AND message_kind='conversation'
	`, createdRoomID).Scan(&initialMessageID, &initialSegmentsJSON); err != nil {
		t.Fatal(err)
	}
	var initialSegments []messagecreation.Segment
	if err := json.Unmarshal(initialSegmentsJSON, &initialSegments); err != nil {
		t.Fatal(err)
	}
	if len(initialSegments) != 5 || initialSegments[0].Content != "Start the approved Room." ||
		initialSegments[1].Type != "text" || initialSegments[1].Content != "\n" ||
		initialSegments[2].Type != "document" || initialSegments[2].Content != nativeArtifactTitle ||
		initialSegments[2].DocumentID != nativeArtifactID || initialSegments[2].DocumentVersionID != "" ||
		initialSegments[2].Presentation != "card" ||
		initialSegments[3].Type != "text" || initialSegments[3].Content != "\n" ||
		initialSegments[4].Type != "document" || initialSegments[4].Content != "room-brief-v1.txt" ||
		initialSegments[4].DocumentID != roomArtifact.ID || initialSegments[4].DocumentVersionID != "" ||
		initialSegments[4].Presentation != "card" {
		t.Fatalf("approved Room initial segments=%+v", initialSegments)
	}
	var attachedDocumentID, attachedVersionID, fileBindingRole, nativeBindingRole string
	if err := env.pool.QueryRow(t.Context(), `SELECT
		(SELECT attachments->0->>'document_id' FROM messages WHERE id=$1),
		(SELECT attachments->0->>'document_version_id' FROM messages WHERE id=$1),
		(SELECT role FROM document_context_bindings
		 WHERE room_id=$2 AND document_id=$3 AND binding_kind='room' AND status='active'),
		(SELECT role FROM document_context_bindings
		 WHERE room_id=$2 AND document_id=$4 AND binding_kind='room' AND status='active')
	`, initialMessageID, createdRoomID, roomArtifact.ID, nativeArtifactID).Scan(
		&attachedDocumentID, &attachedVersionID, &fileBindingRole, &nativeBindingRole,
	); err != nil {
		t.Fatal(err)
	}
	if attachedDocumentID != roomArtifact.ID || attachedVersionID != roomArtifact.CurrentVersion.ID ||
		fileBindingRole != "manager" || nativeBindingRole != "manager" {
		t.Fatalf("approved Room artifact document=%s version=%s file binding=%s native binding=%s",
			attachedDocumentID, attachedVersionID, fileBindingRole, nativeBindingRole)
	}
	var runtimeMessageID, runtimeMessageBody string
	var runtimeSegmentsJSON []byte
	if err := env.pool.QueryRow(t.Context(), `
		SELECT id,body,segments FROM messages
		WHERE room_id=$1 AND message_kind='agent_runtime' AND card_context_message_id=$2
	`, originRoomID, pendingRoom.MessageID).Scan(
		&runtimeMessageID, &runtimeMessageBody, &runtimeSegmentsJSON,
	); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(runtimeMessageBody, `"creation_approval_request_id":"`+pendingRoom.CreationApprovalRequestID+`"`) ||
		!strings.Contains(runtimeMessageBody, `"created_room_id":"`+createdRoomID+`"`) {
		t.Fatalf("Room Creation runtime body=%q", runtimeMessageBody)
	}
	if !strings.Contains(runtimeMessageBody, `"created_room_inbox_id":"room:`+createdRoomID+`"`) ||
		!strings.Contains(runtimeMessageBody, `"created_room_name":"`+roomName+`"`) ||
		!strings.Contains(runtimeMessageBody, `"skipped_artifacts":[]`) ||
		!strings.Contains(runtimeMessageBody, `<room-communication-pattern>`) {
		t.Fatalf("Room approval address/delivery missing: %s", runtimeMessageBody)
	}
	if got := countRows(t, env, `SELECT count(*) FROM messages WHERE room_id=$1
		AND card_context_message_id=$2 AND message_kind='conversation'
		AND body LIKE '%'||$3||'%' AND body LIKE '%'||$4||'%'`, originRoomID, pendingRoom.MessageID, roomName, createdRoomID); got != 1 {
		t.Fatal("visible Room result must include the name and ID fallback")
	}
	_, sendErr := newAgentSendService(t, env.pool, contexts).Send(
		agentauth.WithTarget(t.Context(), "room", originRoomID), token,
		agentSendInput("room:"+createdRoomID, mcpCreationInvocationID(suffix+":cross-room-send"),
			agentsendmessage.PreparedSegment{Type: "text", Content: "Must be forbidden."}))
	if !errors.Is(sendErr, agentsendmessage.ErrForbidden) {
		t.Fatalf("cross-room send error=%v want Forbidden", sendErr)
	}
	var deliveryPayload struct {
		Delivered []struct {
			typedcard.RoomCreationArtifactSnapshot
			Reason string `json:"reason"`
		} `json:"delivered_artifacts"`
	}
	payloadText := strings.SplitN(strings.SplitN(runtimeMessageBody, "result=", 2)[1], "\n", 2)[0]
	if err := json.Unmarshal([]byte(payloadText), &deliveryPayload); err != nil {
		t.Fatal(err)
	}
	if len(deliveryPayload.Delivered) != len(frozenRoomSnapshot.Artifacts) {
		t.Fatalf("delivered=%+v", deliveryPayload)
	}
	for i, artifact := range deliveryPayload.Delivered {
		if artifact.RoomCreationArtifactSnapshot != frozenRoomSnapshot.Artifacts[i] || artifact.Reason != "delivered" {
			t.Fatalf("delivered=%+v", deliveryPayload)
		}
	}
	var runtimeSegments []messagecreation.Segment
	if err := json.Unmarshal(runtimeSegmentsJSON, &runtimeSegments); err != nil {
		t.Fatal(err)
	}
	if len(runtimeSegments) != 2 || runtimeSegments[0].Type != "reference" ||
		runtimeSegments[0].Target != "actor_acme_official" || runtimeSegments[0].TargetType != "agent" {
		t.Fatalf("Room Creation runtime segments=%+v", runtimeSegments)
	}
	if got := countRows(t, env, `
		SELECT count(*) FROM messages
		WHERE id=$1 AND 'actor_acme_official'=ANY(mentioned_actor_ids)
	`, runtimeMessageID); got != 1 {
		t.Fatalf("Room Creation runtime mentions=%d want=1", got)
	}
	if got := countRows(t, env, `
		SELECT count(*) FROM messages
		WHERE room_id=$1 AND card_context_message_id=$2 AND message_kind='conversation'
	`, originRoomID, pendingRoom.MessageID); got != 1 {
		t.Fatalf("Room Creation visible result messages=%d want=1", got)
	}
	assertHumanVisibleMessageIDs(t, env, alice, originRoomID, runtimeMessageID, false)
	assertRoomCreationHandoff(t, env, createdRoomID, originRoomID, pendingRoom, "",
		[]string{nativeArtifactID, roomArtifact.ID})

	// A repeated decision carries a stale card version.
	status, _, repeatedDecisionBody := env.request(alice, http.MethodPost,
		"/v0/decisions/"+pendingRoom.CreationApprovalRequestID,
		map[string]any{"decision": "approve", "expected_version": int64(1)}, "")
	if status != http.StatusConflict {
		t.Fatalf("repeated Room decision status=%d body=%s", status, repeatedDecisionBody)
	}
	if got := countRows(t, env, `SELECT count(*) FROM rooms WHERE tenant_id=$1`, acmeTenant); got != roomsBeforeRoomApproval+1 {
		t.Fatalf("repeated Room decision duplicated Room: got=%d want=%d", got, roomsBeforeRoomApproval+1)
	}
	if got := countRows(t, env, `
		SELECT count(*) FROM messages
		WHERE room_id=$1 AND message_kind='agent_runtime' AND card_context_message_id=$2
	`, originRoomID, pendingRoom.MessageID); got != 1 {
		t.Fatalf("Room decision replay runtime messages=%d want=1", got)
	}
	if got := countRows(t, env, `SELECT jsonb_array_length(attachments) FROM messages WHERE id=$1`, initialMessageID); got != 1 {
		t.Fatalf("Room decision replay attachments=%d want=1", got)
	}
	assertRoomCreationHandoff(t, env, createdRoomID, originRoomID, pendingRoom, "",
		[]string{nativeArtifactID, roomArtifact.ID})

	status, _, revokedArtifactBody := requestUnifiedDocumentMultipart(
		t, env, alice, "/v0/rooms/"+originRoomID+"/documents/uploads",
		"mcp-creation-revoked-artifact-"+suffix,
		map[string]string{
			"filename": "revoked-brief.txt", "representation_format": "plain_text", "media_type": "text/plain",
		},
		"revoked-brief.txt", []byte("revoke before approval\n"),
	)
	if status != http.StatusCreated {
		t.Fatalf("upload revoked Room artifact status=%d body=%s", status, revokedArtifactBody)
	}
	var revokedArtifact uploadedDocumentRef
	decode(t, revokedArtifactBody, &revokedArtifact)
	revokedRoomName := "Revoked Artifact MCP Room " + suffix
	revokedCaller := *roomInput.RoomCaller
	revokedCaller.Name = revokedRoomName
	revokedCaller.Artifacts = []string{revokedArtifact.ID}
	revokedEffective := *roomInput.RoomEffective
	revokedEffective.Name = revokedRoomName
	revokedEffective.Artifacts = []string{revokedArtifact.ID}
	revokedRoomInput := roomInput
	revokedRoomInput.RoomCaller = &revokedCaller
	revokedRoomInput.RoomEffective = &revokedEffective
	revokedRoomInput.InvocationID = mcpCreationInvocationID(suffix + ":room-revoked-artifact")
	pendingRevokedRoom, err := service.Submit(agentauth.WithTarget(t.Context(), "room", originRoomID), token, revokedRoomInput)
	if err != nil {
		t.Fatalf("submit revoked-artifact Room Creation approval: %v", err)
	}
	status, _, body = env.request(
		alice, http.MethodDelete, "/v0/documents/"+revokedArtifact.ID, nil,
		"mcp-creation-trash-artifact-"+suffix,
	)
	if status != http.StatusNoContent {
		t.Fatalf("trash pending Room artifact status=%d body=%s", status, body)
	}
	roomsBeforeRevokedApproval := countRows(t, env, `SELECT count(*) FROM rooms WHERE tenant_id=$1`, acmeTenant)
	status, _, body = env.request(alice, http.MethodPost,
		"/v0/decisions/"+pendingRevokedRoom.CreationApprovalRequestID,
		map[string]any{"decision": "approve", "expected_version": int64(1)},
		"mcp-creation-revoked-room-decision-"+suffix)
	if status != http.StatusOK {
		t.Fatalf("approve deleted-artifact Room status=%d body=%s", status, body)
	}
	if got := countRows(t, env, `SELECT count(*) FROM rooms WHERE tenant_id=$1`, acmeTenant); got != roomsBeforeRevokedApproval+1 {
		t.Fatalf("deleted-artifact approval Rooms=%d want=%d", got, roomsBeforeRevokedApproval+1)
	}
	var skippedRoomID, skippedRuntimeBody string
	if err := env.pool.QueryRow(t.Context(), `SELECT request.result->'data'->>'created_room_id',message.body
		FROM decisions request JOIN messages message
		ON message.card_context_message_id=request.message_id AND message.message_kind='agent_runtime'
		WHERE request.id=$1 AND request.status='succeeded'`, pendingRevokedRoom.CreationApprovalRequestID).Scan(&skippedRoomID, &skippedRuntimeBody); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(skippedRuntimeBody, `"skipped_artifacts":[{"document_id":"`+revokedArtifact.ID+`","reason":"document_unavailable"}]`) ||
		!strings.Contains(skippedRuntimeBody, `"delivered_artifacts":[]`) {
		t.Fatalf("skipped runtime=%s", skippedRuntimeBody)
	}
	if got := countRows(t, env, `SELECT count(*) FROM document_context_bindings WHERE room_id=$1 AND document_id=$2`, skippedRoomID, revokedArtifact.ID); got != 0 {
		t.Fatalf("skipped bindings=%d", got)
	}
	if got := countRows(t, env, `SELECT count(*) FROM messages WHERE room_id=$1 AND (segments::text LIKE '%'||$2||'%' OR attachments @> jsonb_build_array(jsonb_build_object('document_id',$2::text)))`, skippedRoomID, revokedArtifact.ID); got != 0 {
		t.Fatalf("skipped artifact messages=%d", got)
	}
	assertRoomCreationHandoff(t, env, skippedRoomID, originRoomID, pendingRevokedRoom, "", nil, revokedArtifact.ID)

	// Frozen Versions/Revisions and approval snapshots are immutable. Exercise
	// unavailable or mismatched historical content at the Document guard itself.
	for _, contentCase := range []struct{ documentID, versionID, revisionID, tenantID, reason string }{
		{roomArtifact.ID, revokedArtifact.CurrentVersion.ID, "", acmeTenant, "frozen_content_unavailable"},
		{nativeArtifactID, "", "revision_missing", acmeTenant, "frozen_content_unavailable"},
	} {
		tx, err := env.pool.Begin(t.Context())
		if err != nil {
			t.Fatal(err)
		}
		_, reason, reviewErr := document.LockRoomCreationArtifactInTransaction(t.Context(), tx,
			"account_alice", contentCase.tenantID, contentCase.documentID, contentCase.versionID, contentCase.revisionID)
		_ = tx.Rollback(t.Context())
		if reviewErr != nil || reason != contentCase.reason {
			t.Fatalf("content review reason=%q want=%q err=%v", reason, contentCase.reason, reviewErr)
		}
	}
	assertRoomCreationApprovalAccessTransactions(t, env, alice, service, token, roomInput,
		roomArtifact.ID, nativeArtifactID)
	t.Run("handoff carries the frozen description as purpose", func(t *testing.T) {
		purpose := "Plan the launch with the approved brief."
		caller, effective := *roomInput.RoomCaller, *roomInput.RoomEffective
		caller.Name, effective.Name = "Purpose MCP Room "+suffix, "Purpose MCP Room "+suffix
		caller.Description, effective.Description = &purpose, &purpose
		input := roomInput
		input.RoomCaller, input.RoomEffective = &caller, &effective
		input.InvocationID = mcpCreationInvocationID(suffix + ":room-purpose")
		pending, err := service.Submit(agentauth.WithTarget(t.Context(), "room", originRoomID), token, input)
		if err != nil {
			t.Fatal(err)
		}
		httpStatus, _, response := env.request(alice, http.MethodPost,
			"/v0/decisions/"+pending.CreationApprovalRequestID,
			map[string]any{"decision": "approve", "expected_version": 1}, "purpose-room-"+suffix)
		if httpStatus != http.StatusOK {
			t.Fatalf("purpose approval status=%d body=%s", httpStatus, response)
		}
		var purposeRoomID string
		if err := env.pool.QueryRow(t.Context(), `SELECT result->'data'->>'created_room_id' FROM decisions WHERE id=$1 AND status='succeeded'`,
			pending.CreationApprovalRequestID).Scan(&purposeRoomID); err != nil {
			t.Fatal(err)
		}
		assertRoomCreationHandoff(t, env, purposeRoomID, originRoomID, pending, purpose,
			[]string{nativeArtifactID, roomArtifact.ID})
	})
	t.Run("denial creates no Room or document delivery", func(t *testing.T) {
		input := roomInput
		input.InvocationID = mcpCreationInvocationID(suffix + ":room-denied")
		pending, err := service.Submit(agentauth.WithTarget(t.Context(), "room", originRoomID), token, input)
		if err != nil {
			t.Fatal(err)
		}
		roomCount := countRows(t, env, `SELECT count(*) FROM rooms WHERE tenant_id=$1`, acmeTenant)
		bindingCount := countRows(t, env, `SELECT count(*) FROM document_context_bindings WHERE tenant_id=$1`, acmeTenant)
		httpStatus, _, response := env.request(alice, http.MethodPost,
			"/v0/decisions/"+pending.CreationApprovalRequestID,
			map[string]any{"decision": "deny", "expected_version": 1, "comment": "Use the existing Room."}, "deny-room-"+suffix)
		if httpStatus != http.StatusOK {
			t.Fatalf("deny status=%d body=%s", httpStatus, response)
		}
		if countRows(t, env, `SELECT count(*) FROM rooms WHERE tenant_id=$1`, acmeTenant) != roomCount || countRows(t, env, `SELECT count(*) FROM document_context_bindings WHERE tenant_id=$1`, acmeTenant) != bindingCount {
			t.Fatal("denial created Room or Binding")
		}
		if got := countRows(t, env, `SELECT count(*) FROM decisions WHERE id=$1 AND status='denied' AND result IS NULL`, pending.CreationApprovalRequestID); got != 1 {
			t.Fatal("denial result invalid")
		}
		if got := countRows(t, env, `SELECT count(*) FROM messages WHERE card_context_message_id=$1 AND message_kind='agent_runtime'`, pending.MessageID); got != 0 {
			t.Fatal("denial sent approval notification")
		}
		handoffDigest := sha256.Sum256([]byte("room-creation-handoff:" + pending.CreationApprovalRequestID))
		if got := countRows(t, env, `SELECT count(*) FROM messages WHERE id=$1`, fmt.Sprintf("message_%x", handoffDigest[:16])); got != 0 {
			t.Fatal("denial sent a Room Creation handoff")
		}
	})

}

func assertMcpCreationPendingFacts(
	t *testing.T,
	env *testEnv,
	result agentcreationapproval.Result,
	requestKind, roomID string,
) {
	t.Helper()
	if got := countRows(t, env, `
		SELECT count(*)
		FROM decisions request
		JOIN message_cards card ON card.message_id=request.message_id
		WHERE request.id=$1 AND request.message_id=$2 AND request.room_id=$3
		  AND request.kind=$4 AND request.status='pending'
		  AND card.version=1 AND card.work_item_id IS NULL
		  -- The request owns its idempotency; no receipt pins the credential.
		  AND NOT EXISTS (SELECT 1 FROM command_replays receipt WHERE receipt.resource_id=request.id)
	`, result.CreationApprovalRequestID, result.MessageID, roomID, requestKind); got != 1 {
		t.Fatalf("pending %s request/card rows=%d want=1", requestKind, got)
	}
}

// assertRoomCreationHandoff checks the single Agent handoff appended to an
// approved Room: derived ID, no cross-Room card context, one Mention for the
// requesting Agent, request facts, and only delivered Document references.
func assertRoomCreationHandoff(
	t *testing.T,
	env *testEnv,
	roomID, originRoomID string,
	pending agentcreationapproval.Result,
	wantPurpose string,
	wantDocumentIDs []string,
	forbidden ...string,
) {
	t.Helper()
	if got := countRows(t, env, `SELECT count(*) FROM messages WHERE room_id=$1 AND message_kind='agent_runtime'`, roomID); got != 1 {
		t.Fatalf("Room Creation handoff messages=%d want=1", got)
	}
	var id, body string
	var segments []byte
	var cardContextEmpty bool
	if err := env.pool.QueryRow(t.Context(), `
		SELECT id,body,segments,card_context_message_id IS NULL FROM messages
		WHERE room_id=$1 AND message_kind='agent_runtime'
	`, roomID).Scan(&id, &body, &segments, &cardContextEmpty); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256([]byte("room-creation-handoff:" + pending.CreationApprovalRequestID))
	if want := fmt.Sprintf("message_%x", digest[:16]); id != want {
		t.Fatalf("handoff ID=%s want request-derived %s", id, want)
	}
	if !cardContextEmpty {
		t.Fatal("handoff must not set a cross-Room card_context")
	}
	// The initial message is authored by the requesting Agent itself, so the
	// handoff Mention is the only actionable input that wakes its new Context.
	if got := countRows(t, env, `SELECT count(*) FROM messages WHERE room_id=$1 AND 'actor_acme_official'=ANY(mentioned_actor_ids)`, roomID); got != 1 {
		t.Fatalf("handoff Agent mentions in new Room=%d want=1", got)
	}
	if got := countRows(t, env, `SELECT count(*) FROM messages WHERE id=$1 AND 'actor_acme_official'=ANY(mentioned_actor_ids)`, id); got != 1 {
		t.Fatalf("handoff mention rows=%d want=1", got)
	}
	if got := countRows(t, env, `
		SELECT count(*) FROM room_events handoff
		JOIN messages initial ON initial.room_id=handoff.room_id AND initial.message_kind='conversation'
		JOIN room_events initial_event ON initial_event.resource_id=initial.id AND initial_event.event_type='message.created'
		WHERE handoff.room_id=$1 AND handoff.resource_id=$2 AND handoff.event_type='message.created'
		  AND handoff.room_seq>initial_event.room_seq
	`, roomID, id); got != 1 {
		t.Fatalf("handoff events after the initial message=%d want=1", got)
	}
	if got := countRows(t, env, `
		SELECT count(*) FROM messages handoff JOIN messages origin
		  ON origin.room_id=$2 AND origin.tenant_id=handoff.tenant_id AND length(origin.body)>0
		WHERE handoff.id=$1 AND strpos(handoff.body, origin.body)>0
	`, id, originRoomID); got != 0 {
		t.Fatalf("handoff copied %d origin Room message bodies: %s", got, body)
	}
	payloadText := strings.SplitN(strings.SplitN(body, "Room creation handoff=", 2)[1], "\n", 2)[0]
	var payload struct {
		Kind          string                                   `json:"kind"`
		RequestID     string                                   `json:"creation_approval_request_id"`
		CardMessageID string                                   `json:"approval_card_message_id"`
		OriginRoomID  string                                   `json:"origin_room_id"`
		OriginInboxID string                                   `json:"origin_room_inbox_id"`
		RoomInboxID   string                                   `json:"room_inbox_id"`
		Purpose       *string                                  `json:"purpose"`
		Delivered     []typedcard.RoomCreationArtifactSnapshot `json:"delivered_artifacts"`
		Decision      string                                   `json:"decision"`
		DecidedBy     string                                   `json:"decided_by"`
		DecidedAt     string                                   `json:"decided_at"`
	}
	if err := json.Unmarshal([]byte(payloadText), &payload); err != nil {
		t.Fatalf("handoff payload %q: %v", payloadText, err)
	}
	if payload.Kind != "room_creation_handoff" || payload.RequestID != pending.CreationApprovalRequestID ||
		payload.CardMessageID != pending.MessageID || payload.OriginRoomID != originRoomID ||
		payload.OriginInboxID != "room:"+originRoomID || payload.RoomInboxID != "room:"+roomID {
		t.Fatalf("handoff payload=%+v", payload)
	}
	// Decision facts must equal the persisted decision, not a separately sampled clock.
	var requestStatus, decidedBy string
	var decidedAt time.Time
	if err := env.pool.QueryRow(t.Context(), `
		SELECT status,decided_by_actor_id,decided_at FROM decisions WHERE id=$1
	`, pending.CreationApprovalRequestID).Scan(&requestStatus, &decidedBy, &decidedAt); err != nil {
		t.Fatal(err)
	}
	payloadDecidedAt, err := time.Parse(time.RFC3339Nano, payload.DecidedAt)
	if err != nil || !strings.HasSuffix(payload.DecidedAt, "Z") {
		t.Fatalf("handoff decided_at=%q must be RFC3339 UTC: %v", payload.DecidedAt, err)
	}
	if requestStatus != "succeeded" || payload.Decision != "approved" || payload.DecidedBy != decidedBy ||
		!payloadDecidedAt.Equal(decidedAt) {
		t.Fatalf("handoff decision=%q decided_by=%q decided_at=%s want %q %q %s",
			payload.Decision, payload.DecidedBy, payload.DecidedAt, requestStatus, decidedBy, decidedAt.UTC().Format(time.RFC3339Nano))
	}
	if wantPurpose == "" {
		if payload.Purpose != nil || strings.Contains(payloadText, `"purpose"`) {
			t.Fatalf("handoff without description must omit purpose: %s", payloadText)
		}
	} else if payload.Purpose == nil || *payload.Purpose != wantPurpose {
		t.Fatalf("handoff purpose=%v want %q", payload.Purpose, wantPurpose)
	}
	if len(payload.Delivered) != len(wantDocumentIDs) {
		t.Fatalf("handoff delivered=%+v want %v", payload.Delivered, wantDocumentIDs)
	}
	for i, documentID := range wantDocumentIDs {
		if payload.Delivered[i].DocumentID != documentID {
			t.Fatalf("handoff delivered=%+v want %v", payload.Delivered, wantDocumentIDs)
		}
	}
	for _, content := range []string{body, string(segments)} {
		for _, needle := range append([]string{"skipped"}, forbidden...) {
			if strings.Contains(content, needle) {
				t.Fatalf("handoff contains %q: %s", needle, content)
			}
		}
	}
}

func mcpCreationInvocationID(label string) string {
	digest := sha256.Sum256([]byte("MCP Creation JSON-RPC invocation:" + label))
	return fmt.Sprintf("agent-invocation-sha256:%x", digest[:])
}
