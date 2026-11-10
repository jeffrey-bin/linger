package integration_test

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"strconv"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentruntimestate"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

func TestRoomDeletionRevokesAccessAndARepeatedDeleteFindsNoRoom(t *testing.T) {
	allowParallelIntegrationTest(t)
	env := newRoomMembershipEnv(t)
	alice := env.login("alice", alicePassword)
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	roomID := createPrivateRoom(t, env, alice, "Delete "+suffix, "delete-room-create-"+suffix)
	if status, body := putRoomMember(t, env, alice, roomID, "actor_acme_official", "member"); status != http.StatusOK {
		t.Fatalf("add member status=%d body=%s", status, body)
	}
	env.createMessage(alice, roomID, "Retained audit history", "delete-room-message-"+suffix)

	deletePath := "/v0/rooms/" + roomID
	status, _, body := env.request(alice, http.MethodDelete, deletePath, nil, "")
	if status != http.StatusNoContent || len(body) != 0 {
		t.Fatalf("delete status=%d body=%q", status, body)
	}
	status, _, body = env.request(alice, http.MethodDelete, deletePath, nil, "")
	if status != http.StatusNotFound {
		t.Fatalf("repeated delete status=%d body=%q", status, body)
	}

	if status, _, _ := env.request(alice, http.MethodGet, deletePath, nil, ""); status != http.StatusNotFound {
		t.Fatalf("deleted Room access status=%d want=404", status)
	}
	status, _, rooms := env.request(alice, http.MethodGet, "/v0/tenants/"+acmeTenant+"/rooms", nil, "")
	if status != http.StatusOK || bytes.Contains(rooms, []byte(roomID)) {
		t.Fatalf("Room list retained deleted Room status=%d body=%s", status, rooms)
	}
	if got := countRows(t, env, "select count(*) from rooms where id=$1 and deleted_at is not null and deleted_by_actor_id='actor_acme_alice'", roomID); got != 1 {
		t.Fatalf("deleted Room tombstones=%d want=1", got)
	}
	if got := countRows(t, env, "select count(*) from room_members where room_id=$1", roomID); got != 0 {
		t.Fatalf("current Room memberships=%d want=0", got)
	}
	if got := countRows(t, env, "select count(*) from messages where room_id=$1 and message_kind<>'room_notice'", roomID); got != 1 {
		t.Fatalf("retained messages=%d want=1", got)
	}
	if got := countRows(t, env, "select count(*) from room_events where room_id=$1 and event_type='room.deleted'", roomID); got != 1 {
		t.Fatalf("room.deleted events=%d want=1", got)
	}
}

func TestRoomDeletionTerminalizesAgentContextLeaseWithoutAffectingOtherRooms(t *testing.T) {
	allowParallelIntegrationTest(t)
	env := newRoomMembershipEnv(t)
	alice := env.login("alice", alicePassword)
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	deletedRoomID := createPrivateRoom(t, env, alice, "Delete Agent Context "+suffix, "delete-agent-context-"+suffix)
	activeRoomID := createPrivateRoom(t, env, alice, "Keep Agent Context "+suffix, "keep-agent-context-"+suffix)
	for _, roomID := range []string{deletedRoomID, activeRoomID} {
		if status, body := putRoomMember(t, env, alice, roomID, "actor_acme_official", "member"); status != http.StatusOK {
			t.Fatalf("add Agent to %s status=%d body=%s", roomID, status, body)
		}
	}
	service := agentruntimestate.New(env.pool)
	listed, err := service.ListContexts(t.Context(), testRuntimeAgentID)
	if err != nil {
		t.Fatalf("list Agent Contexts: %v", err)
	}
	claimedByRoom := make(map[string]agentruntimestate.Context)
	for _, contextRow := range listed {
		if contextRow.Ref.Kind == "meta" && contextRow.Ref.AgentID == testRuntimeAgentID && contextRow.Ref.RoomID != "" {
			claimedByRoom[contextRow.Ref.RoomID] = contextRow
		}
	}
	deletedContext := claimedByRoom[deletedRoomID]
	activeContext := claimedByRoom[activeRoomID]
	if deletedContext.ContextKey == "" || activeContext.ContextKey == "" {
		t.Fatalf("Room Contexts are missing: deleted=%+v active=%+v", deletedContext, activeContext)
	}

	status, _, body := env.request(alice, http.MethodDelete, "/v0/rooms/"+deletedRoomID, nil, "delete-agent-context-room-"+suffix)
	if status != http.StatusNoContent {
		t.Fatalf("delete Room status=%d body=%s", status, body)
	}
	terminal, err := service.GetContext(t.Context(), deletedContext.ContextKey)
	if err != nil || terminal.TargetResidency != "suspended" || terminal.TerminalReason != "room_deleted" {
		t.Fatalf("deleted Room Context not terminal: context=%+v err=%v", terminal, err)
	}

	unaffected, err := service.GetContext(t.Context(), activeContext.ContextKey)
	if err != nil || unaffected.TerminalReason != "" {
		t.Fatalf("unaffected Room Context became terminal: context=%+v err=%v", unaffected, err)
	}
}

func TestRoomDeletionKeepsRunStatusEvents(t *testing.T) {
	allowParallelIntegrationTest(t)
	env := newRoomMembershipEnv(t)
	alice := env.login("alice", alicePassword)
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	roomID := createPrivateRoom(t, env, alice, "Delete Run status "+suffix, "delete-run-status-create-"+suffix)
	if status, body := putRoomMember(t, env, alice, roomID, "actor_acme_official", "member"); status != http.StatusOK {
		t.Fatalf("add Agent status=%d body=%s", status, body)
	}
	var contextKey string
	if err := env.pool.QueryRow(t.Context(), `
		SELECT context_key
		FROM agent_execution_contexts
		WHERE room_id=$1 AND agent_actor_id='actor_acme_official'`, roomID).Scan(&contextKey); err != nil {
		t.Fatalf("read Room Agent Runtime Context: %v", err)
	}
	runID := "run-delete-status-" + suffix
	if _, err := env.pool.Exec(t.Context(), `
		INSERT INTO agent_local_runs(run_id,context_key,status,terminal,finished_at,status_room_id)
		VALUES($1,$2,'succeeded','{"type":"succeeded"}'::jsonb,clock_timestamp(),$3)
	`, runID, contextKey, roomID); err != nil {
		t.Fatalf("seed terminal Local Run: %v", err)
	}
	if _, err := env.pool.Exec(t.Context(), `
		INSERT INTO agent_runtime_status_events(local_run_id,event_ordinal,segment_id,command_id,event_type,payload)
		VALUES($1,1,$2,$3,'status.changed','{"type":"status.changed","status":"working"}'::jsonb)
	`, runID, "segment-delete-status-"+suffix, "event-delete-status-"+suffix); err != nil {
		t.Fatalf("seed Run status event: %v", err)
	}
	status, _, body := env.request(alice, http.MethodDelete, "/v0/rooms/"+roomID, nil, "delete-run-status-"+suffix)
	if status != http.StatusNoContent {
		t.Fatalf("delete Room status=%d body=%s", status, body)
	}
	if got := countRows(t, env, "SELECT count(*) FROM agent_runtime_status_events WHERE local_run_id=$1", runID); got != 1 {
		t.Fatalf("retained Run status events=%d want=1", got)
	}
	if status, _, body := env.request(alice, http.MethodGet, "/v0/rooms/"+roomID+"/run-statuses", nil, ""); status != http.StatusNotFound {
		t.Fatalf("deleted Room Run statuses status=%d body=%s", status, body)
	}
}

func TestRoomMutationFenceRechecksActiveStateAfterWaitingForDeletion(t *testing.T) {
	allowParallelIntegrationTest(t)
	env := newRoomMembershipEnv(t)
	alice := env.login("alice", alicePassword)
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	roomID := createPrivateRoom(t, env, alice, "Delete during mutation gate "+suffix, "delete-gate-room-"+suffix)

	deletionTx, err := env.pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	deletionCommitted := false
	t.Cleanup(func() {
		if !deletionCommitted {
			_ = deletionTx.Rollback(context.Background())
		}
	})
	if _, err := deletionTx.Exec(t.Context(), `
		select pg_advisory_xact_lock(hashtextextended('room-mutation|' || $1,0))
	`, roomID); err != nil {
		t.Fatal(err)
	}
	if _, err := deletionTx.Exec(t.Context(), `
		update rooms
		set deletion_started_at=clock_timestamp(),
		    deletion_started_by_actor_id='actor_acme_alice',
		    updated_at=clock_timestamp()
		where id=$1
	`, roomID); err != nil {
		t.Fatal(err)
	}

	gateResult := make(chan error, 1)
	go func() {
		mutationTx, beginErr := env.pool.Begin(context.Background())
		if beginErr != nil {
			gateResult <- beginErr
			return
		}
		defer mutationTx.Rollback(context.Background())
		_, gateErr := store.New(mutationTx).LockActiveRoomForMutation(context.Background(), roomID)
		gateResult <- gateErr
	}()
	waitForBlockedQuery(t, env, "pg_advisory_xact_lock_shared")
	if err := deletionTx.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
	deletionCommitted = true

	select {
	case err := <-gateResult:
		if !errors.Is(err, pgx.ErrNoRows) {
			t.Fatalf("mutation gate after deletion error=%v want pgx.ErrNoRows", err)
		}
	case <-time.After(30 * time.Second):
		t.Fatal("mutation gate did not resume after Room deletion committed")
	}
}

func TestRoomDeletionRejectsManagedWorkRooms(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newWorkItemAgentEnv(t)
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	item := createLinkedWorkItem(t, env, alice, "delete-managed-"+suffix, "")
	roomID := createWorkRoomFixture(t, env, alice, item.ID, "Managed Room "+suffix)
	status, _, body := env.request(alice, http.MethodDelete, "/v0/rooms/"+roomID, nil, "delete-managed-room-"+suffix)
	if status != http.StatusConflict || !containsJSONText(body, "ROOM_IS_MANAGED") {
		t.Fatalf("delete Work Room status=%d body=%s", status, body)
	}
	if got := countRows(t, env, "select count(*) from rooms where id=$1 and deleted_at is null", roomID); got != 1 {
		t.Fatalf("managed Room active rows=%d want=1", got)
	}
}

func TestRoomDeletionWaitsForPendingCardDecision(t *testing.T) {
	allowParallelIntegrationTest(t)
	env := newRoomMembershipEnv(t)
	alice := env.login("alice", alicePassword)
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	roomID := createPrivateRoom(t, env, alice, "Delete pending approval "+suffix, "delete-pending-approval-room-"+suffix)
	if status, body := putRoomMember(t, env, alice, roomID, "actor_acme_official", "member"); status != http.StatusOK {
		t.Fatalf("add Agent status=%d body=%s", status, body)
	}
	requestID := createPendingRoomCreationApproval(t, env, roomID, suffix)

	deletePath := "/v0/rooms/" + roomID
	status, _, body := env.request(alice, http.MethodDelete, deletePath, nil, "delete-pending-approval-"+suffix)
	if status != http.StatusConflict || !containsJSONText(body, "PENDING_CARD_DECISION") {
		t.Fatalf("delete Room with a pending approval status=%d body=%s", status, body)
	}
	denyRoomCreationApproval(t, env, alice, requestID, suffix)
	status, _, body = env.request(alice, http.MethodDelete, deletePath, nil, "delete-decided-approval-"+suffix)
	if status != http.StatusNoContent {
		t.Fatalf("delete Room after the decision status=%d body=%s", status, body)
	}
}

func TestRoomDeletionRevokesEveryMembershipInOneTransaction(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newRoomDocumentRealtimeEnv(t)
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	roomID := createPrivateRoom(t, env, alice, "Delete runtime "+suffix, "delete-runtime-room-create-"+suffix)
	if status, body := putRoomMember(t, env, alice, roomID, "actor_acme_official", "member"); status != http.StatusOK {
		t.Fatalf("add Agent status=%d body=%s", status, body)
	}
	service := agentruntimestate.New(env.pool)
	listed, err := service.ListContexts(t.Context(), testRuntimeAgentID)
	if err != nil {
		t.Fatalf("list Agent Contexts: %v", err)
	}
	var deletedContext agentruntimestate.Context
	for _, contextRow := range listed {
		if contextRow.Ref.Kind == "meta" && contextRow.Ref.AgentID == testRuntimeAgentID && contextRow.Ref.RoomID == roomID {
			deletedContext = contextRow
			break
		}
	}
	if deletedContext.ContextKey == "" {
		t.Fatalf("Room Context is missing: %+v", deletedContext)
	}

	status, _, body := env.request(alice, http.MethodDelete, "/v0/rooms/"+roomID, nil, "")
	if status != http.StatusNoContent {
		t.Fatalf("delete Runtime-backed Room status=%d body=%s", status, body)
	}
	terminal, err := service.GetContext(t.Context(), deletedContext.ContextKey)
	if err != nil || terminal.TargetResidency != "suspended" || terminal.TerminalReason != "room_deleted" {
		t.Fatalf("deleted Room Context not terminal: context=%+v err=%v", terminal, err)
	}
	// Every membership is revoked and room.deleted committed in the request.
	if got := countRows(t, env, "select count(*) from room_members where room_id=$1", roomID); got != 0 {
		t.Fatalf("memberships retained after deletion=%d want=0", got)
	}
	if got := countRows(t, env, "select count(*) from rooms where id=$1 and deleted_at is not null", roomID); got != 1 {
		t.Fatalf("finalized Rooms=%d want=1", got)
	}
	if got := countRows(t, env, `select count(*) from room_events deleted where deleted.room_id=$1 and deleted.event_type='room.deleted' and deleted.room_seq=(select next_room_seq from rooms where id=$1)`, roomID); got != 1 {
		t.Fatalf("room.deleted is not the final Room Event: count=%d", got)
	}
	status, _, body = env.request(alice, http.MethodDelete, "/v0/rooms/"+roomID, nil, "")
	if status != http.StatusNotFound {
		t.Fatalf("repeated delete status=%d body=%s", status, body)
	}
}

// Deleting a Room keeps its Documents, and the Agent keeps its Human's access
// to them, so a reply that arrives after the deletion still lands.
func TestRoomDeletionKeepsAgentCommentsOnTheRoomsDocuments(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newRoomDocumentRealtimeEnv(t)
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	roomID := createPrivateRoom(t, env, alice, "Delete concurrent comment "+suffix, "delete-comment-room-"+suffix)
	if status, body := putRoomMember(t, env, alice, roomID, "actor_acme_official", "member"); status != http.StatusOK {
		t.Fatalf("add Agent status=%d body=%s", status, body)
	}
	status, _, body := env.request(alice, http.MethodPost, "/v0/rooms/"+roomID+"/documents", map[string]any{}, "delete-comment-document-"+suffix)
	if status != http.StatusCreated {
		t.Fatalf("create Document status=%d body=%s", status, body)
	}
	var createdDocument roomDocumentResponse
	decode(t, body, &createdDocument)
	status, _, body = env.request(alice, http.MethodPost, "/v0/documents/"+createdDocument.ID+"/comment-threads", map[string]any{
		"anchor": map[string]any{
			"quoted_text": "delete race", "block_id": "block_delete_race",
			"context_before": "before", "context_after": "after",
		},
		"initial_comment": map[string]any{
			"segments": []map[string]any{{"type": "text", "content": "Initial comment"}},
		},
	}, "delete-comment-thread-"+suffix)
	if status != http.StatusCreated {
		t.Fatalf("create Comment Thread status=%d body=%s", status, body)
	}
	var thread roomDocumentCommentThreadResponse
	decode(t, body, &thread)

	status, _, body = env.request(alice, http.MethodDelete, "/v0/rooms/"+roomID, nil, "")
	if status != http.StatusNoContent {
		t.Fatalf("delete Room status=%d body=%s", status, body)
	}

	comments := document.NewCommentService(env.pool, nil)
	if _, err := comments.ReplyForAgent(t.Context(), document.AgentReplyInput{
		AgentManagementID: acmeOfficialAgentManagementID, ThreadID: thread.ID,
		IdempotencyKey: "delete-comment-reply-" + suffix, ParentCommentID: &thread.Comments[0].ID,
		Segments: []document.Segment{{Type: "text", Content: "Late Agent reply"}},
	}); err != nil {
		t.Fatalf("late Agent Comment error=%v", err)
	}
	if got := countRows(t, env, "select count(*) from room_document_comments where thread_id=$1", thread.ID); got != 2 {
		t.Fatalf("Comment rows after the late reply=%d want=2", got)
	}

	status, _, body = env.request(alice, http.MethodDelete, "/v0/rooms/"+roomID, nil, "")
	if status != http.StatusNotFound {
		t.Fatalf("repeated concurrent delete status=%d body=%s", status, body)
	}
	if got := countRows(t, env, `select count(*) from room_events deleted where deleted.room_id=$1 and deleted.event_type='room.deleted' and deleted.room_seq=(select next_room_seq from rooms where id=$1)`, roomID); got != 1 {
		t.Fatalf("late Room Events remain after room.deleted: count=%d", got)
	}
}

func TestRoomDeletionAfterDocumentTrashFinalizesInOneRequest(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newRoomDocumentRealtimeEnv(t)
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	roomID := createPrivateRoom(t, env, alice, "Delete after archive "+suffix, "delete-archive-room-"+suffix)
	status, _, body := env.request(alice, http.MethodPost, "/v0/rooms/"+roomID+"/documents", map[string]any{}, "delete-archive-document-"+suffix)
	if status != http.StatusCreated {
		t.Fatalf("create Document status=%d body=%s", status, body)
	}
	var document roomDocumentResponse
	decode(t, body, &document)
	status, _, body = env.request(alice, http.MethodDelete, "/v0/documents/"+document.ID, nil, "delete-document-"+suffix)
	if status != http.StatusNoContent {
		t.Fatalf("trash Document status=%d body=%s", status, body)
	}
	status, _, body = env.request(alice, http.MethodDelete, "/v0/rooms/"+roomID, nil, "")
	if status != http.StatusNoContent {
		t.Fatalf("delete Room after trash status=%d body=%s", status, body)
	}

	if got := countRows(t, env, "select count(*) from rooms where id=$1 and deleted_at is not null", roomID); got != 1 {
		t.Fatalf("finalized Rooms=%d want=1", got)
	}
	if got := countRows(t, env, "select count(*) from documents where id=$1 and status='trashed'", document.ID); got != 1 {
		t.Fatalf("trashed Documents=%d want=1", got)
	}
	if got := countRows(t, env, "select count(*) from document_events where document_id=$1 and event_type='document.trashed'", document.ID); got != 1 {
		t.Fatalf("Document trash events=%d want=1", got)
	}
	status, _, body = env.request(alice, http.MethodDelete, "/v0/rooms/"+roomID, nil, "")
	if status != http.StatusNotFound {
		t.Fatalf("repeated archive/delete status=%d body=%s", status, body)
	}
	if got := countRows(t, env, `select count(*) from room_events deleted where deleted.room_id=$1 and deleted.event_type='room.deleted' and deleted.room_seq=(select next_room_seq from rooms where id=$1)`, roomID); got != 1 {
		t.Fatalf("room.deleted is not the final Room Event: count=%d", got)
	}
}

func TestRoomDeletionRetiresADirectRoomOnlyAfterItsPeerAgentIsGone(t *testing.T) {
	allowParallelIntegrationTest(t)
	agentManagement := &recordingAgentManagement{}
	env, alice := newAgentRegistrationEnv(t, agentManagement)
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	seedOwnedFixtureComputer(t, env.pool, "computer_fixture_alice", acmeTenant, "actor_acme_alice")
	status, _, body := env.request(alice, http.MethodPost, "/v0/tenants/"+acmeTenant+"/agents", map[string]any{
		"name": "Direct peer " + suffix, "instructions": "Answer directly.",
		"runtime": fixtureRuntimeOn("computer_fixture_alice", "gpt-5"), "visibility_scope": "workspace",
	}, "direct-retire-agent-"+suffix)
	if status != http.StatusCreated {
		t.Fatalf("create Agent status=%d body=%s", status, body)
	}
	var agent struct {
		Actor struct {
			ID string `json:"id"`
		} `json:"actor"`
	}
	decode(t, body, &agent)

	status, _, body = env.request(alice, http.MethodPost, "/v0/tenants/"+acmeTenant+"/direct-rooms", map[string]any{
		"peer_actor_id": agent.Actor.ID,
	}, "")
	if status != http.StatusCreated && status != http.StatusOK {
		t.Fatalf("open Direct Room status=%d body=%s", status, body)
	}
	var direct struct {
		ID string `json:"id"`
	}
	decode(t, body, &direct)

	// While the peer can still reply the Room stays immutable.
	status, _, body = env.request(alice, http.MethodDelete, "/v0/rooms/"+direct.ID, nil, "direct-delete-live-"+suffix)
	if status != http.StatusConflict || !containsJSONText(body, "DIRECT_ROOM_IMMUTABLE") {
		t.Fatalf("delete live Direct Room status=%d body=%s", status, body)
	}
	if got := countRows(t, env, "select count(*) from rooms where id=$1 and deletion_started_at is null", direct.ID); got != 1 {
		t.Fatalf("live Direct Room deletion started rows=%d want=1 unstarted", got)
	}

	status, _, body = env.request(alice, http.MethodDelete, "/v0/tenants/"+acmeTenant+"/agents/"+agent.Actor.ID, nil, "")
	if status != http.StatusNoContent {
		t.Fatalf("retire Agent status=%d body=%s", status, body)
	}

	// Deleting the Agent removes its Sponsor's DM.
	if got := countRows(t, env, "select count(*) from rooms where id=$1 and deleted_at is not null", direct.ID); got != 1 {
		t.Fatalf("peerless Direct Room deleted rows=%d want=1", got)
	}
}
