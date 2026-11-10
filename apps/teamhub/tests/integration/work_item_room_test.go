package integration_test

import (
	"bytes"
	"context"
	"net/http"
	"strconv"
	"testing"
	"time"
)

func TestWorkItemOriginAndWorkRoomLinks(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newWorkItemAgentEnv(t)
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	originRoomID := createPrivateRoom(t, env, alice, "Origin "+suffix, "origin-room-"+suffix)
	item := createLinkedWorkItem(t, env, alice, suffix, originRoomID)
	if item.OriginRoomID == nil || *item.OriginRoomID != originRoomID {
		t.Fatalf("origin link missing from Work Item: %+v", item)
	}
	if got := countRows(t, env, `
		select count(*) from work_item_room_links
		where work_item_id=$1 and link_type='origin' and origin_message_id is null
	`, item.ID); got != 1 {
		t.Fatalf("ordinary Work Item origin links without Message=%d want=1", got)
	}
	status, _, listBody := env.request(alice, http.MethodGet, "/v0/tenants/"+acmeTenant+"/work-items?origin_room_id="+originRoomID, nil, "")
	if status != http.StatusOK || !bytes.Contains(listBody, []byte(item.ID)) {
		t.Fatalf("origin Room reverse filter status=%d body=%s", status, listBody)
	}

	roomID := createWorkRoomFixture(t, env, alice, item.ID, "Issue room "+suffix, "actor_acme_official")

	status, _, itemBody := env.request(alice, http.MethodGet, "/v0/work-items/"+item.ID, nil, "")
	if status != http.StatusOK {
		t.Fatalf("get linked Work Item status=%d body=%s", status, itemBody)
	}
	decode(t, itemBody, &item)
	if item.WorkRoomID == nil || *item.WorkRoomID != roomID {
		t.Fatalf("Work Item projection has Work Room %v want=%s", item.WorkRoomID, roomID)
	}
	status, _, listBody = env.request(alice, http.MethodGet, "/v0/tenants/"+acmeTenant+"/work-items?work_room_id="+roomID, nil, "")
	if status != http.StatusOK || !bytes.Contains(listBody, []byte(item.ID)) {
		t.Fatalf("Work Room reverse filter status=%d body=%s", status, listBody)
	}

	agentBase := "/v0/agents/" + acmeOfficialAgentManagementID
	status, _, _ = agentWorkItemRequest(t, env, http.MethodGet, agentBase+"/work-items/"+item.ID, teamHubInternalToken, "", nil)
	if status != http.StatusNotFound {
		t.Fatalf("Room membership leaked Agent Work Item access: status=%d want=404", status)
	}
	status, _, agentCreatedBody := agentWorkItemRequest(t, env, http.MethodPost, agentBase+"/work-items", teamHubInternalToken, "agent-origin-"+suffix, map[string]any{
		"kind": "issue", "title": "Agent linked issue " + suffix, "origin_room_id": roomID,
	})
	if status != http.StatusCreated {
		t.Fatalf("Room member Agent create with Origin status=%d body=%s", status, agentCreatedBody)
	}
	var agentCreated workItemResponse
	decode(t, agentCreatedBody, &agentCreated)
	if agentCreated.OriginRoomID == nil || *agentCreated.OriginRoomID != roomID {
		t.Fatalf("Agent-created Work Item lost Origin Room: %+v", agentCreated)
	}

	linkedFromWorkRoom := createLinkedWorkItem(t, env, alice, suffix+"-next", roomID)
	if linkedFromWorkRoom.OriginRoomID == nil || *linkedFromWorkRoom.OriginRoomID != roomID {
		t.Fatalf("Work Room could not become another Work Item Origin: %+v", linkedFromWorkRoom)
	}
	beforeMembers := countRows(t, env, "select count(*) from room_members where room_id=$1", roomID)
	item = transitionWorkItem(t, env, alice, item.ID, item.Version, "in_progress", "", "work-room-start-"+suffix)
	item = transitionWorkItem(t, env, alice, item.ID, item.Version, "resolved", "completed", "work-room-resolve-"+suffix)
	status, _, archivedBody := env.request(alice, http.MethodPost, "/v0/work-items/"+item.ID+"/archive", map[string]any{
		"expected_version": item.Version,
	}, "work-room-archive-"+suffix)
	if status != http.StatusOK {
		t.Fatalf("archive linked Work Item status=%d body=%s", status, archivedBody)
	}
	if got := countRows(t, env, "select count(*) from room_members where room_id=$1", roomID); got != beforeMembers {
		t.Fatalf("Work Item lifecycle changed Room membership: before=%d after=%d", beforeMembers, got)
	}
	status, _, _ = env.request(alice, http.MethodGet, "/v0/rooms/"+roomID, nil, "")
	if status != http.StatusOK {
		t.Fatalf("Work Item lifecycle removed Work Room: status=%d", status)
	}

}

func TestWorkItemOriginLinkDoesNotCommitAfterRoomDeletion(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newWorkItemAgentEnv(t)
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	roomID := createPrivateRoom(t, env, alice, "Origin deleted during Work Item create "+suffix, "origin-delete-room-"+suffix)

	blocker, err := env.pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = blocker.Rollback(context.Background()) })
	// Hold the lock the number allocation takes, without blocking foreign-key
	// checks against the Account row.
	if _, err := blocker.Exec(t.Context(), `
		select work_item_last_number from accounts where id='account_alice' for no key update
	`); err != nil {
		t.Fatal(err)
	}

	createResults := make(chan asyncHTTPResult, 1)
	createKey := "origin-delete-work-item-" + suffix
	if err := startAsyncJSONRequest(createResults, "create", alice, http.MethodPost,
		env.server.URL+"/v0/tenants/"+acmeTenant+"/work-items", createKey, map[string]any{
			"kind": "issue", "title": "Must not retain deleted origin " + suffix, "origin_room_id": roomID,
		}); err != nil {
		t.Fatal(err)
	}
	waitForBlockedQuery(t, env, "work_item_last_number")

	deletionTx, err := env.pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := deletionTx.Exec(t.Context(), `
		select pg_advisory_xact_lock(hashtextextended('room-mutation|' || $1,0))
	`, roomID); err != nil {
		_ = deletionTx.Rollback(t.Context())
		t.Fatal(err)
	}
	if _, err := deletionTx.Exec(t.Context(), `
		update rooms
		set deletion_started_at=clock_timestamp(),
		    deletion_started_by_actor_id='actor_acme_alice',
		    updated_at=clock_timestamp()
		where id=$1
	`, roomID); err != nil {
		_ = deletionTx.Rollback(t.Context())
		t.Fatal(err)
	}
	if err := deletionTx.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
	if err := blocker.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}

	created := receiveWithin(t, createResults, 30*time.Second)
	if created.err != nil || created.status != http.StatusNotFound {
		t.Fatalf("concurrent Work Item create result=%+v body=%s", created, created.body)
	}
	if got := countRows(t, env, `
		select count(*) from work_item_room_links where room_id=$1 and link_type='origin'
	`, roomID); got != 0 {
		t.Fatalf("origin links committed after Room deletion=%d want=0", got)
	}
}

func TestWorkItemOriginRoomKeepsIndependentWorkItems(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newWorkItemAgentEnv(t)
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	firstRoomID := createPrivateRoom(t, env, alice, "First origin "+suffix, "first-origin-"+suffix)

	first := createLinkedWorkItem(t, env, alice, suffix+"-one", firstRoomID)
	second := createLinkedWorkItem(t, env, alice, suffix+"-two", firstRoomID)
	if first.ID == second.ID || countRows(t, env, "select count(*) from work_item_room_links where room_id=$1 and link_type='origin'", firstRoomID) != 2 {
		t.Fatal("one Origin Room did not retain two independent Work Items")
	}
}
