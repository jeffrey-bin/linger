package integration_test

import (
	"context"
	"net/http"
	"strconv"
	"testing"
	"time"
)

func TestRoomThreadCreateOrGet(t *testing.T) {
	allowParallelIntegrationTest(t)
	env := newRoomMembershipEnv(t)
	alice := env.login("alice", alicePassword)
	bob := seedPeerHuman(t, env)
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	parentID := createPrivateRoom(t, env, alice, "Thread Parent "+suffix, "thread-parent-"+suffix)
	rootID := createHumanMessage(t, env, alice, parentID, "Root for shared Thread "+suffix, "thread-root-"+suffix)

	status, _, body := env.request(bob, http.MethodPost, "/v0/rooms/"+parentID+"/messages/"+rootID+"/thread", nil, "thread-bob-"+suffix)
	if status != http.StatusNotFound {
		t.Fatalf("non-member create Thread status=%d body=%s", status, body)
	}

	created := requestMessageThread(t, env, alice, parentID, rootID, "thread-create-"+suffix)
	if created.status != http.StatusCreated {
		t.Fatalf("create Thread status=%d body=%s", created.status, created.body)
	}
	if created.room.Kind != "thread" || created.room.ParentRoomID != parentID || created.room.RootMessageID != rootID {
		t.Fatalf("created Thread room=%+v", created.room)
	}
	if got := countRows(t, env, `select count(*) from messages where room_id=$1`, created.room.ID); got != 0 {
		t.Fatalf("new Thread messages=%d want=0", got)
	}

	status, _, rooms := env.request(alice, http.MethodGet, "/v0/tenants/"+acmeTenant+"/rooms?limit=200", nil, "")
	if status != http.StatusOK || !containsJSONText(rooms, created.room.ID) {
		t.Fatalf("opened Thread room missing from list status=%d body=%s", status, rooms)
	}

	status, _, roomBody := env.request(alice, http.MethodGet, "/v0/rooms/"+created.room.ID, nil, "")
	if status != http.StatusOK || !containsJSONText(roomBody, `"kind":"thread"`) || !containsJSONText(roomBody, rootID) {
		t.Fatalf("get Thread room status=%d body=%s", status, roomBody)
	}

	replay := requestMessageThread(t, env, alice, parentID, rootID, "thread-replay-"+suffix)
	if replay.status != http.StatusOK {
		t.Fatalf("existing Thread status=%d body=%s", replay.status, replay.body)
	}
	if replay.room.ID != created.room.ID {
		t.Fatalf("shared Thread diverged first=%s second=%s", created.room.ID, replay.room.ID)
	}

	if memberStatus, memberBody := putRoomMember(t, env, alice, parentID, "actor_acme_bob", "member"); memberStatus != http.StatusOK {
		t.Fatalf("add Bob status=%d body=%s", memberStatus, memberBody)
	}
	shared := requestMessageThread(t, env, bob, parentID, rootID, "thread-bob-open-"+suffix)
	if shared.status != http.StatusOK || shared.room.ID != created.room.ID {
		t.Fatalf("member open shared Thread status=%d room=%s want=%s body=%s", shared.status, shared.room.ID, created.room.ID, shared.body)
	}

	status, _, membersBody := env.request(alice, http.MethodGet, "/v0/rooms/"+created.room.ID+"/members?limit=50", nil, "")
	if status != http.StatusOK {
		t.Fatalf("list Thread members status=%d body=%s", status, membersBody)
	}
	if !containsJSONText(membersBody, `"room_id":"`+created.room.ID+`"`) || containsJSONText(membersBody, `"room_id":"`+parentID+`"`) {
		t.Fatalf("Thread members must use the requested Room ID status=%d body=%s", status, membersBody)
	}
	if !containsJSONText(membersBody, "actor_acme_alice") || !containsJSONText(membersBody, "actor_acme_bob") {
		t.Fatalf("Thread members missing parent Humans body=%s", membersBody)
	}

	nestedRootID := createHumanMessage(t, env, alice, created.room.ID, "Nested root candidate "+suffix, "thread-nested-root-"+suffix)
	nested := requestMessageThread(t, env, alice, created.room.ID, nestedRootID, "thread-nested-"+suffix)
	if nested.status != http.StatusBadRequest || !containsJSONText(nested.body, "INVALID_THREAD_ROOT") {
		t.Fatalf("nested Thread status=%d body=%s", nested.status, nested.body)
	}
}

func TestRoomThreadListVisibility(t *testing.T) {
	allowParallelIntegrationTest(t)
	env := newRoomMembershipEnv(t)
	alice := env.login("alice", alicePassword)
	bob := seedPeerHuman(t, env)
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	parentID := createPrivateRoom(t, env, alice, "Thread List "+suffix, "thread-list-parent-"+suffix)
	rootID := createHumanMessage(t, env, alice, parentID, "Root for list visibility "+suffix, "thread-list-root-"+suffix)
	created := requestMessageThread(t, env, alice, parentID, rootID, "thread-list-create-"+suffix)
	if created.status != http.StatusCreated {
		t.Fatalf("create Thread status=%d body=%s", created.status, created.body)
	}
	if listed := findRoomListItem(t, env, alice, created.room.ID); listed == nil || listed.Kind != "thread" || listed.ParentRoomID != parentID || listed.UnreadMessageCount != 0 {
		t.Fatalf("opener list item=%+v", listed)
	}

	if memberStatus, memberBody := putRoomMember(t, env, alice, parentID, "actor_acme_bob", "member"); memberStatus != http.StatusOK {
		t.Fatalf("add Bob status=%d body=%s", memberStatus, memberBody)
	}
	opened := requestMessageThread(t, env, bob, parentID, rootID, "thread-list-bob-open-"+suffix)
	if opened.status != http.StatusOK || opened.room.ID != created.room.ID {
		t.Fatalf("Bob open Thread status=%d room=%s body=%s", opened.status, opened.room.ID, opened.body)
	}
	if listed := findRoomListItem(t, env, bob, created.room.ID); listed == nil || listed.Kind != "thread" || listed.ParentRoomID != parentID || listed.UnreadMessageCount != 0 {
		t.Fatalf("viewer list item after open=%+v", listed)
	}

	beforeParent := roomListItemByID(t, env, alice, parentID)
	createHumanMessage(t, env, alice, created.room.ID, "Alice reply "+suffix, "thread-list-alice-reply-"+suffix)
	aliceItem := findRoomListItem(t, env, alice, created.room.ID)
	if aliceItem == nil || aliceItem.Kind != "thread" || aliceItem.ParentRoomID != parentID || aliceItem.UnreadMessageCount != 0 {
		t.Fatalf("author list item=%+v", aliceItem)
	}
	if listed := findRoomListItem(t, env, bob, created.room.ID); listed == nil || listed.UnreadMessageCount < 1 {
		t.Fatalf("Bob list item after Alice reply: %+v", listed)
	}
	afterParent := roomListItemByID(t, env, alice, parentID)
	if afterParent.UnreadMessageCount != beforeParent.UnreadMessageCount {
		t.Fatalf("parent unread_message_count=%d want=%d", afterParent.UnreadMessageCount, beforeParent.UnreadMessageCount)
	}

	createMentionMessage(t, env, alice, created.room.ID, "thread-list-bob-mention-"+suffix, "actor_acme_bob", "user")
	bobItem := findRoomListItem(t, env, bob, created.room.ID)
	if bobItem == nil || bobItem.Kind != "thread" || bobItem.UnreadMessageCount < 1 {
		t.Fatalf("mentioned Bob list item=%+v", bobItem)
	}
}

func findRoomListItem(t *testing.T, env *testEnv, client *http.Client, roomID string) *roomListItem {
	t.Helper()
	status, _, body := env.request(client, http.MethodGet, "/v0/tenants/"+acmeTenant+"/rooms?limit=200", nil, "")
	if status != http.StatusOK {
		t.Fatalf("list rooms status=%d body=%s", status, body)
	}
	var page struct {
		Items []roomListItem `json:"items"`
	}
	decode(t, body, &page)
	for _, item := range page.Items {
		if item.ID == roomID {
			found := item
			return &found
		}
	}
	return nil
}

type threadRoomResponse struct {
	status int
	body   []byte
	room   struct {
		ID            string `json:"id"`
		Kind          string `json:"kind"`
		ParentRoomID  string `json:"parent_room_id"`
		RootMessageID string `json:"root_message_id"`
	}
}

func requestMessageThread(t *testing.T, env *testEnv, client *http.Client, roomID, messageID, key string) threadRoomResponse {
	t.Helper()
	status, _, body := env.request(client, http.MethodPost, "/v0/rooms/"+roomID+"/messages/"+messageID+"/thread", nil, key)
	var parsed struct {
		Room struct {
			ID            string `json:"id"`
			Kind          string `json:"kind"`
			ParentRoomID  string `json:"parent_room_id"`
			RootMessageID string `json:"root_message_id"`
		} `json:"room"`
	}
	if status == http.StatusCreated || status == http.StatusOK {
		decode(t, body, &parsed)
	}
	return threadRoomResponse{status: status, body: body, room: parsed.Room}
}

func TestRoomThreadRepliesAndMentions(t *testing.T) {
	allowParallelIntegrationTest(t)
	env := newRoomMembershipEnv(t)
	alice := env.login("alice", alicePassword)
	seedPeerHumanActor(t, env.pool)
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	parentID := createPrivateRoom(t, env, alice, "Thread Replies "+suffix, "thread-replies-parent-"+suffix)
	if status, body := putRoomMember(t, env, alice, parentID, "actor_acme_official", "member"); status != http.StatusOK {
		t.Fatalf("add Agent status=%d body=%s", status, body)
	}
	rootID := createMentionMessage(t, env, alice, parentID, "thread-root-mention-"+suffix, "actor_acme_official", "agent")
	if got := countRows(t, env, `select cardinality(mentioned_actor_ids) from messages where id=$1`, rootID); got != 1 {
		t.Fatalf("parent mention rows=%d want=1", got)
	}

	created := requestMessageThread(t, env, alice, parentID, rootID, "thread-replies-create-"+suffix)
	if created.status != http.StatusCreated {
		t.Fatalf("create Thread status=%d body=%s", created.status, created.body)
	}
	if got := countRows(t, env, `select count(*) from messages where room_id=$1`, created.room.ID); got != 0 {
		t.Fatalf("new Thread messages=%d want=0", got)
	}

	status, _, parentMessage := env.request(alice, http.MethodGet, "/v0/rooms/"+parentID+"/messages/"+rootID, nil, "")
	if status != http.StatusOK || !containsJSONText(parentMessage, `"reply_count":0`) || !containsJSONText(parentMessage, created.room.ID) {
		t.Fatalf("parent Message thread summary before reply status=%d body=%s", status, parentMessage)
	}

	before := roomListItemByID(t, env, alice, parentID)
	var parentUpdatedAt time.Time
	if err := env.pool.QueryRow(context.Background(), `select updated_at from rooms where id=$1`, parentID).Scan(&parentUpdatedAt); err != nil {
		t.Fatal(err)
	}

	status, _, body := env.request(alice, http.MethodPost, "/v0/rooms/"+created.room.ID+"/messages", map[string]any{
		"raw_message": "@Bob should not join",
		"segments": []map[string]any{
			{"type": "reference", "content": "@Bob", "target": "actor_acme_bob", "target_type": "user"},
			{"type": "text", "content": " should not join"},
		},
	}, "thread-invalid-mention-"+suffix)
	if status != http.StatusBadRequest || !containsJSONText(body, "INVALID_MENTION") {
		t.Fatalf("out-of-parent mention status=%d body=%s", status, body)
	}
	if got := countRows(t, env, `select count(*) from room_members where room_id=$1 and actor_id='actor_acme_bob'`, parentID); got != 0 {
		t.Fatalf("Thread mention admitted Bob into parent members=%d", got)
	}
	if got := countRows(t, env, `select count(*) from room_members where room_id=$1`, created.room.ID); got != 0 {
		t.Fatalf("Thread room members=%d want=0", got)
	}

	replyID := createMentionMessage(t, env, alice, created.room.ID, "thread-agent-mention-"+suffix, "actor_acme_official", "agent")
	if got := countRows(t, env, `select count(*) from messages where id=$1 and room_id=$2 and 'actor_acme_official'=ANY(mentioned_actor_ids)`, replyID, created.room.ID); got != 1 {
		t.Fatalf("Thread Agent mention rows=%d want=1 room=%s", got, created.room.ID)
	}
	if got := countRows(t, env, `select count(*) from messages where room_id=$1 and message_kind<>'room_notice'`, parentID); got != 1 {
		t.Fatalf("parent timeline messages=%d want=1", got)
	}

	after := roomListItemByID(t, env, alice, parentID)
	if after.UnreadMessageCount != before.UnreadMessageCount {
		t.Fatalf("parent unread_message_count=%d want=%d", after.UnreadMessageCount, before.UnreadMessageCount)
	}
	if after.LatestMessage == nil || before.LatestMessage == nil || after.LatestMessage.ID != before.LatestMessage.ID {
		t.Fatalf("parent latest_message changed before=%+v after=%+v", before.LatestMessage, after.LatestMessage)
	}
	var parentUpdatedAfter time.Time
	if err := env.pool.QueryRow(context.Background(), `select updated_at from rooms where id=$1`, parentID).Scan(&parentUpdatedAfter); err != nil {
		t.Fatal(err)
	}
	if !parentUpdatedAfter.Equal(parentUpdatedAt) {
		t.Fatalf("parent updated_at changed %s -> %s", parentUpdatedAt, parentUpdatedAfter)
	}

	status, _, events := env.request(alice, http.MethodGet, "/v0/rooms/"+parentID+"/events?after=0", nil, "")
	if status != http.StatusOK || !containsJSONText(events, `"event_type":"message.thread_summary.updated"`) || !containsJSONText(events, `"reply_count":1`) {
		t.Fatalf("parent Thread summary event status=%d body=%s", status, events)
	}
	status, _, parentMessage = env.request(alice, http.MethodGet, "/v0/rooms/"+parentID+"/messages/"+rootID, nil, "")
	if status != http.StatusOK || !containsJSONText(parentMessage, `"reply_count":1`) {
		t.Fatalf("parent Message thread summary after reply status=%d body=%s", status, parentMessage)
	}
}

func TestRoomThreadFollowUpLeavesTheHostAgentUnmentioned(t *testing.T) {
	allowParallelIntegrationTest(t)
	env := newRoomMembershipEnv(t)
	alice := env.login("alice", alicePassword)
	bob := seedPeerHuman(t, env)
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	parentID := createPrivateRoom(t, env, alice, "Thread Host "+suffix, "thread-host-parent-"+suffix)
	if status, body := putRoomMember(t, env, alice, parentID, "actor_acme_official", "member"); status != http.StatusOK {
		t.Fatalf("add Agent status=%d body=%s", status, body)
	}
	rootID := seedAgentMessage(t, env, parentID, "actor_acme_official", "Host root "+suffix)
	created := requestMessageThread(t, env, alice, parentID, rootID, "thread-host-create-"+suffix)
	if created.status != http.StatusCreated {
		t.Fatalf("create Thread status=%d body=%s", created.status, created.body)
	}

	if status, body := putRoomMember(t, env, alice, parentID, "actor_acme_bob", "member"); status != http.StatusOK {
		t.Fatalf("add parent member status=%d body=%s", status, body)
	}
	replyID := createHumanMessage(t, env, alice, created.room.ID, "How is this going "+suffix, "thread-host-followup-"+suffix)
	if got := countRows(t, env, `select cardinality(mentioned_actor_ids) from messages where id=$1`, replyID); got != 0 {
		t.Fatalf("unmentioned follow-up mention rows=%d want=0", got)
	}
	// Parent members replay the Thread's Room Events, the reply included.
	for name, client := range map[string]*http.Client{"Alice": alice, "Bob": bob} {
		status, _, events := env.request(client, http.MethodGet, "/v0/rooms/"+created.room.ID+"/events?after=0&limit=200", nil, "")
		if status != http.StatusOK || !containsJSONText(events, replyID) {
			t.Fatalf("Thread reply hidden from parent member %s status=%d body=%s", name, status, events)
		}
	}
	status, _, body := env.request(alice, http.MethodDelete, "/v0/rooms/"+parentID+"/members/actor_acme_bob", nil, "")
	if status != http.StatusNoContent {
		t.Fatalf("remove parent member status=%d body=%s", status, body)
	}
	if status, _, events := env.request(bob, http.MethodGet, "/v0/rooms/"+created.room.ID+"/events?after=0&limit=200", nil, ""); status == http.StatusOK && containsJSONText(events, replyID) {
		t.Fatalf("Thread reply visible after parent membership removal status=%d body=%s", status, events)
	}
	status, _, replyBody := env.request(alice, http.MethodGet, "/v0/rooms/"+created.room.ID+"/messages/"+replyID, nil, "")
	if status != http.StatusOK || !containsJSONText(replyBody, `"raw_message":"How is this going `+suffix+`"`) {
		t.Fatalf("follow-up was not stored as the Human sent it status=%d body=%s", status, replyBody)
	}
	if got := countRows(t, env, `
		select count(*) from (
		  select membership.room_id, actor.id
		  from active_room_members membership
		  join rooms room on room.id=membership.room_id
		  join actors actor on actor.id=membership.actor_id
		  where membership.tenant_id=$1 and room.deleted_at is null
		  union
		  select thread.id, actor.id
		  from rooms thread
		  join messages root on root.id=thread.root_message_id and root.room_id=thread.parent_room_id
		  join actors actor on actor.id=root.author_actor_id and actor.kind='agent'
		  join active_room_members parent_membership
		    on parent_membership.room_id=thread.parent_room_id
		   and parent_membership.actor_id=actor.id
		  where thread.tenant_id=$1 and thread.deleted_at is null
		) projected
		where room_id=$2 and id='actor_acme_official'`, acmeTenant, created.room.ID); got != 1 {
		t.Fatalf("thread projection members for host Agent=%d want=1", got)
	}

	humanRootID := createHumanMessage(t, env, alice, parentID, "Human root "+suffix, "thread-human-root-"+suffix)
	humanThread := requestMessageThread(t, env, alice, parentID, humanRootID, "thread-human-create-"+suffix)
	humanReplyID := createHumanMessage(t, env, alice, humanThread.room.ID, "No host here "+suffix, "thread-human-followup-"+suffix)
	if got := countRows(t, env, `select cardinality(mentioned_actor_ids) from messages where id=$1`, humanReplyID); got != 0 {
		t.Fatalf("human-root Thread follow-up mentions=%d want=0", got)
	}
}

func createMentionMessage(t *testing.T, env *testEnv, client *http.Client, roomID, key, targetID, targetType string) string {
	t.Helper()
	label := "@official"
	if targetType == "user" {
		label = "@Bob"
	}
	status, _, body := env.request(client, http.MethodPost, "/v0/rooms/"+roomID+"/messages", map[string]any{
		"raw_message": label + " in Thread",
		"segments": []map[string]any{
			{"type": "reference", "content": label, "target": targetID, "target_type": targetType},
			{"type": "text", "content": " in Thread"},
		},
	}, key)
	if status != http.StatusCreated {
		t.Fatalf("create mention message status=%d body=%s", status, body)
	}
	var message struct {
		ID string `json:"id"`
	}
	decode(t, body, &message)
	if message.ID == "" {
		t.Fatalf("create mention message missing id body=%s", body)
	}
	return message.ID
}

func TestRoomParentAgentThreadHistory(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newAgentRunEnv(t, "http://127.0.0.1:1")
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	parentID := createPrivateRoom(t, env, alice, "Parent Thread History "+suffix, "parent-thread-history-room-"+suffix)
	if status, body := putRoomMember(t, env, alice, parentID, "actor_acme_official", "member"); status != http.StatusOK {
		t.Fatalf("add Agent status=%d body=%s", status, body)
	}
	rootID := createHumanMessage(t, env, alice, parentID, "Root with history "+suffix, "parent-thread-history-root-"+suffix)
	thread := requestMessageThread(t, env, alice, parentID, rootID, "parent-thread-history-create-"+suffix)
	if thread.status != http.StatusCreated {
		t.Fatalf("create Thread status=%d body=%s", thread.status, thread.body)
	}
	createHumanMessage(t, env, alice, thread.room.ID, "Thread reply "+suffix, "parent-thread-history-reply-"+suffix)
	createMentionMessage(t, env, alice, parentID, "parent-thread-history-trigger-"+suffix, "actor_acme_official", "agent")
	seedRunningLocalRun(t, env, acmeOfficialAgentManagementID, parentID, "parent-thread-history-run-"+suffix)
	if status, _, body := env.request(alice, http.MethodDelete, "/v0/rooms/"+parentID, nil, "parent-thread-history-delete-"+suffix); status != http.StatusNoContent {
		t.Fatalf("delete Room with a running Local Run status=%d body=%s", status, body)
	}
}
