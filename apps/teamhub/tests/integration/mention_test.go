package integration_test

import (
	"bufio"
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"slices"
	"strconv"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/config"
)

func TestMentionsRoomSummariesAndEventsStream(t *testing.T) {
	allowParallelIntegrationTest(t)
	artifactRoot := integrationArtifactRoot(t)
	databaseURL := newIntegrationDatabase(t)
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	application, err := newIntegrationApp(ctx, config.ForTest(func(c *config.Config) {
		c.ArtifactStorageRoot = artifactRoot
		c.DatabaseURL = databaseURL
		c.SessionTTL = time.Hour
		c.CookieName = "teamhub_session"
		c.SSEHeartbeatInterval = 25 * time.Millisecond
		c.SSEQueueCapacity = 8
		c.SSEReplayBatchSize = 2
	}))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(application.Close)
	server := httptest.NewServer(application.Handler())
	registerIntegrationServerCleanup(t, server)
	env := &testEnv{t: t, databaseURL: databaseURL, pool: pool, server: server}
	alice := env.login("alice", alicePassword)
	// A Human mention needs a second Human in the Room.
	bob := seedPeerHuman(t, env)
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	roomID := env.createRoom(alice, acmeTenant, "Mentions "+suffix, "mentions-room-"+suffix)
	for _, actorID := range []string{"actor_acme_official", "actor_acme_bob"} {
		if status, body := putRoomMember(t, env, alice, roomID, actorID, "member"); status != http.StatusOK {
			t.Fatalf("add member %s status=%d body=%s", actorID, status, body)
		}
	}

	bobBefore := currentEventWatermark(t, env, bob, "/v0/rooms/"+roomID+"/events", "latest_room_seq")
	rawMessage := "@Bob please check with @official together"
	payload := map[string]any{
		"raw_message": rawMessage,
		"segments": []map[string]any{
			{"type": "reference", "content": "@Bob", "target": "actor_acme_bob", "target_type": "user"},
			{"type": "text", "content": " please check with "},
			{"type": "reference", "content": "@official", "target": "actor_acme_official", "target_type": "agent"},
			{"type": "text", "content": " together"},
		},
	}
	status, _, body := env.request(alice, http.MethodPost, "/v0/rooms/"+roomID+"/messages", payload, "mention-message-"+suffix)
	if status != http.StatusCreated {
		t.Fatalf("create mention message status=%d body=%s", status, body)
	}
	var message struct {
		ID string `json:"id"`
	}
	decode(t, body, &message)
	var messageSeq int64
	if err := pool.QueryRow(ctx, `
		select room_seq from room_events
		where room_id=$1 and event_type='message.created' and resource_id=$2`, roomID, message.ID).Scan(&messageSeq); err != nil {
		t.Fatal(err)
	}
	var mentions int
	if err := pool.QueryRow(ctx, `select cardinality(mentioned_actor_ids) from messages where id=$1`, message.ID).Scan(&mentions); err != nil {
		t.Fatal(err)
	}
	if mentions != 2 {
		t.Fatalf("mention rows=%d want=2", mentions)
	}
	status, headers, replayBody := env.request(alice, http.MethodPost, "/v0/rooms/"+roomID+"/messages", payload, "mention-message-"+suffix)
	if status != http.StatusCreated || headers.Get("Idempotent-Replay") != "true" || string(replayBody) != string(body) {
		t.Fatalf("mention replay status=%d replay=%q body_equal=%t", status, headers.Get("Idempotent-Replay"), string(replayBody) == string(body))
	}
	if got := currentEventWatermark(t, env, bob, "/v0/rooms/"+roomID+"/events", "latest_room_seq"); got != messageSeq {
		t.Fatalf("idempotent replay advanced room_seq=%d want=%d", got, messageSeq)
	}

	for index, invalid := range []map[string]any{
		{"raw_message": "@Bob", "segments": []map[string]any{{"type": "reference", "content": "@Bob", "target": "actor_acme_bob", "target_type": "agent"}}},
		{"raw_message": "@official", "segments": []map[string]any{{"type": "reference", "content": "@official", "target": "actor_acme_official", "target_type": "user"}}},
		{"raw_message": "@missing", "segments": []map[string]any{{"type": "reference", "content": "@missing", "target": "actor_missing", "target_type": "user"}}},
	} {
		status, _, invalidBody := env.request(alice, http.MethodPost, "/v0/rooms/"+roomID+"/messages", invalid, fmt.Sprintf("invalid-mention-%s-%d", suffix, index))
		if status != http.StatusBadRequest {
			t.Fatalf("invalid mention %d status=%d body=%s", index, status, invalidBody)
		}
	}

	bobRoom := roomListItemByID(t, env, bob, roomID)
	if bobRoom.LatestMessage == nil || bobRoom.LatestMessage.ID != message.ID || bobRoom.LatestMessage.RoomSeq != messageSeq || bobRoom.LatestMessage.RawMessage != rawMessage {
		t.Fatalf("Bob latest message=%+v", bobRoom.LatestMessage)
	}
	if bobRoom.UnreadMessageCount != 1 || bobRoom.UnreadMentionCount != 1 || bobRoom.ReadThroughRoomSeq >= messageSeq {
		t.Fatalf("Bob attention=%+v", bobRoom)
	}
	aliceRoom := roomListItemByID(t, env, alice, roomID)
	if aliceRoom.UnreadMessageCount != 0 || aliceRoom.UnreadMentionCount != 0 || aliceRoom.ReadThroughRoomSeq != messageSeq {
		t.Fatalf("Alice attention=%+v", aliceRoom)
	}

	response := openSSE(t, bob, eventsStreamURL(server.URL, roomID, bobBefore), 2*time.Second)
	defer response.Body.Close()
	reader := bufio.NewReader(response.Body)
	if record := nextRoomEvent(t, reader); record.ID != strconv.FormatInt(messageSeq, 10) {
		t.Fatalf("replayed Message event=%+v want room_seq=%d", record, messageSeq)
	}

	// Advancing the read cursor publishes nothing; other tabs see it on their
	// next Room list read.
	status, _, readBody := env.request(bob, http.MethodPut, "/v0/rooms/"+roomID+"/read-state", map[string]any{"through_room_seq": messageSeq}, "")
	if status != http.StatusOK {
		t.Fatalf("mark read status=%d body=%s", status, readBody)
	}
	bobRoom = roomListItemByID(t, env, bob, roomID)
	if bobRoom.ReadThroughRoomSeq != messageSeq || bobRoom.UnreadMessageCount != 0 || bobRoom.UnreadMentionCount != 0 {
		t.Fatalf("Bob cleared attention=%+v", bobRoom)
	}
	status, _, _ = env.request(bob, http.MethodPut, "/v0/rooms/"+roomID+"/read-state", map[string]any{"through_room_seq": 0}, "")
	if status != http.StatusOK || roomListItemByID(t, env, bob, roomID).ReadThroughRoomSeq != messageSeq {
		t.Fatal("stale read cursor regressed")
	}
	status, _, _ = env.request(bob, http.MethodPut, "/v0/rooms/"+roomID+"/read-state", map[string]any{"through_room_seq": messageSeq + 100}, "")
	if status != http.StatusBadRequest {
		t.Fatalf("future read cursor status=%d want=400", status)
	}
	assertRoomPinLifecycle(t, env, alice, bob, roomID)
	assertRoomMemberPreview(t, env, alice, roomID, message.ID, suffix)
}

// The Room list previews the first nine current members in join order,
// Agents included, and a Thread previews its parent Room's members.
func assertRoomMemberPreview(t *testing.T, env *testEnv, owner *http.Client, roomID, rootMessageID, suffix string) {
	t.Helper()
	joined := func() []string {
		rows, err := env.pool.Query(t.Context(), `select actor_id from active_room_members
			where room_id=$1 order by joined_at,actor_id limit 9`, roomID)
		if err != nil {
			t.Fatal(err)
		}
		defer rows.Close()
		var ids []string
		for rows.Next() {
			var id string
			if err := rows.Scan(&id); err != nil {
				t.Fatal(err)
			}
			ids = append(ids, id)
		}
		return ids
	}
	previewIDs := func(item roomListItem) []string {
		ids := make([]string, 0, len(item.MemberPreview))
		for _, member := range item.MemberPreview {
			ids = append(ids, member.ID)
		}
		return ids
	}
	listed := roomListItemByID(t, env, owner, roomID)
	if got, want := previewIDs(listed), joined(); !slices.Equal(got, want) {
		t.Fatalf("member preview=%v want join order %v", got, want)
	}
	if !slices.ContainsFunc(listed.MemberPreview, func(member roomListActor) bool {
		return member.ID == "actor_acme_official" && member.Kind == "agent" && member.DisplayName != ""
	}) {
		t.Fatalf("member preview omits the Agent: %+v", listed.MemberPreview)
	}
	// Ten later joiners: the preview keeps the first nine and ignores the rest.
	for index := range 10 {
		actorID := fmt.Sprintf("actor_preview_%s_%02d", suffix, index)
		if _, err := env.pool.Exec(t.Context(), `insert into actors(id,tenant_id,kind,display_name,handle)
			values($1,'tenant_acme','agent',$2,$3)`, actorID, "Preview "+strconv.Itoa(index), "preview-"+suffix+"-"+strconv.Itoa(index)); err != nil {
			t.Fatal(err)
		}
		if _, err := env.pool.Exec(t.Context(), `insert into room_members(room_id,tenant_id,actor_id,role,added_by_actor_id,joined_at)
			values($1,'tenant_acme',$2,'member','actor_acme_alice',now()+make_interval(secs => $3))`, roomID, actorID, index+1); err != nil {
			t.Fatal(err)
		}
	}
	capped := previewIDs(roomListItemByID(t, env, owner, roomID))
	if want := joined(); len(capped) != 9 || !slices.Equal(capped, want) {
		t.Fatalf("capped member preview=%v want first nine %v", capped, want)
	}
	thread := requestMessageThread(t, env, owner, roomID, rootMessageID, "member-preview-thread-"+suffix)
	if thread.status != http.StatusCreated && thread.status != http.StatusOK {
		t.Fatalf("open Thread status=%d body=%s", thread.status, thread.body)
	}
	if got := previewIDs(roomListItemByID(t, env, owner, thread.room.ID)); !slices.Equal(got, capped) {
		t.Fatalf("Thread member preview=%v want parent %v", got, capped)
	}
}

// A pin belongs to one Human, keeps its first time across repeats, and
// clears on unpin; the Room list reports it beside the read state.
func assertRoomPinLifecycle(t *testing.T, env *testEnv, owner, pinner *http.Client, roomID string) {
	t.Helper()
	pin := func(pinned bool) (int, *time.Time) {
		status, _, body := env.request(pinner, http.MethodPut, "/v0/rooms/"+roomID+"/pin", map[string]any{"pinned": pinned}, "")
		if status != http.StatusOK {
			return status, nil
		}
		var state struct {
			RoomID   string     `json:"room_id"`
			PinnedAt *time.Time `json:"pinned_at"`
		}
		decode(t, body, &state)
		if state.RoomID != roomID {
			t.Fatalf("pin state room=%q want=%q", state.RoomID, roomID)
		}
		return status, state.PinnedAt
	}
	status, first := pin(true)
	if status != http.StatusOK || first == nil {
		t.Fatalf("pin status=%d pinned_at=%v", status, first)
	}
	if _, again := pin(true); again == nil || !again.Equal(*first) {
		t.Fatalf("repeated pin moved pinned_at from %v to %v", first, again)
	}
	if listed := roomListItemByID(t, env, pinner, roomID).PinnedAt; listed == nil || !listed.Equal(*first) {
		t.Fatalf("listed pinned_at=%v want=%v", listed, first)
	}
	if other := roomListItemByID(t, env, owner, roomID).PinnedAt; other != nil {
		t.Fatalf("pin leaked to another Human: %v", other)
	}
	if _, cleared := pin(false); cleared != nil {
		t.Fatalf("unpin kept pinned_at=%v", cleared)
	}
	if listed := roomListItemByID(t, env, pinner, roomID).PinnedAt; listed != nil {
		t.Fatalf("listed pinned_at after unpin=%v", listed)
	}
	status, _, _ = env.request(pinner, http.MethodPut, "/v0/rooms/room-missing-pin/pin", map[string]any{"pinned": true}, "")
	if status != http.StatusNotFound {
		t.Fatalf("unknown Room pin status=%d want=404", status)
	}
	status, _, _ = env.request(pinner, http.MethodPut, "/v0/rooms/"+roomID+"/pin", map[string]any{"pinned": "yes"}, "")
	if status != http.StatusBadRequest {
		t.Fatalf("invalid pin body status=%d want=400", status)
	}
	// A body that leaves `pinned` out, or null, is rejected rather than read as
	// "unpin", so a pinned Room stays pinned.
	status, _, _ = env.request(pinner, http.MethodPut, "/v0/rooms/"+roomID+"/pin", map[string]any{"pinned": true}, "")
	if status != http.StatusOK {
		t.Fatalf("re-pin status=%d", status)
	}
	for _, body := range []map[string]any{{}, {"pinned": nil}} {
		status, _, response := env.request(pinner, http.MethodPut, "/v0/rooms/"+roomID+"/pin", body, "")
		if status != http.StatusBadRequest || !containsJSONText(response, "INVALID_REQUEST") {
			t.Fatalf("pin body %v status=%d body=%s want=400", body, status, response)
		}
	}
	if listed := roomListItemByID(t, env, pinner, roomID).PinnedAt; listed == nil {
		t.Fatal("a rejected pin body unpinned the Room")
	}
	status, _, _ = env.request(pinner, http.MethodPut, "/v0/rooms/"+roomID+"/pin", map[string]any{"pinned": false}, "")
	if status != http.StatusOK {
		t.Fatalf("final unpin status=%d", status)
	}
}

func TestFirstMentionAtomicallyAdmitsEligibleTenantActors(t *testing.T) {
	allowParallelIntegrationTest(t)
	env := newRoomMembershipEnv(t)
	alice := env.login("alice", alicePassword)
	seedPeerHumanActor(t, env.pool)
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	roomID := createPrivateRoom(t, env, alice, "First mention "+suffix, "first-mention-room-"+suffix)
	rawMessage := "@Bob pair with @official"
	payload := map[string]any{
		"raw_message": rawMessage,
		"segments": []map[string]any{
			{"type": "reference", "content": "@Bob", "target": "actor_acme_bob", "target_type": "user"},
			{"type": "text", "content": " pair with "},
			{"type": "reference", "content": "@official", "target": "actor_acme_official", "target_type": "agent"},
		},
	}
	status, _, body := env.request(alice, http.MethodPost, "/v0/rooms/"+roomID+"/messages", payload, "first-mention-message-"+suffix)
	if status != http.StatusCreated {
		t.Fatalf("first Mention status=%d body=%s", status, body)
	}
	var message struct {
		ID string `json:"id"`
	}
	decode(t, body, &message)

	for _, actorID := range []string{"actor_acme_bob", "actor_acme_official"} {
		if got := countRows(t, env, "select count(*) from active_room_members where room_id=$1 and actor_id=$2", roomID, actorID); got != 1 {
			t.Fatalf("active membership for %s=%d want=1", actorID, got)
		}
	}
	if got := countRows(t, env, "select cardinality(mentioned_actor_ids) from messages where id=$1", message.ID); got != 2 {
		t.Fatalf("mention count=%d want=2", got)
	}
	var agentJoinedSeq, messageSeq int64
	if err := env.pool.QueryRow(context.Background(), `
		select room_seq from room_events
		where room_id=$1 and event_type='room.member.added' and resource_id='actor_acme_official'`, roomID).Scan(&agentJoinedSeq); err != nil {
		t.Fatal(err)
	}
	if err := env.pool.QueryRow(context.Background(), `
		select room_seq from room_events
		where room_id=$1 and event_type='message.created' and resource_id=$2`, roomID, message.ID).Scan(&messageSeq); err != nil {
		t.Fatal(err)
	}
	if agentJoinedSeq >= messageSeq {
		t.Fatalf("Agent joined room_seq=%d must precede message room_seq=%d", agentJoinedSeq, messageSeq)
	}
	// Each admitted member gets a Room notice by the sender, before the Message.
	if got := countRows(t, env, `select count(*) from messages where room_id=$1 and message_kind='room_notice'
		and author_actor_id='actor_acme_alice' and notice->>'type'='member_added'`, roomID); got != 2 {
		t.Fatalf("member notices=%d want=2", got)
	}
	var noticeSeq int64
	if err := env.pool.QueryRow(context.Background(), `
		select event.room_seq from room_events event join messages notice on notice.id=event.resource_id
		where event.room_id=$1 and event.event_type='message.created' and notice.message_kind='room_notice'
		  and notice.notice->'member'->>'id'='actor_acme_official'`, roomID).Scan(&noticeSeq); err != nil {
		t.Fatal(err)
	}
	if noticeSeq <= agentJoinedSeq || noticeSeq >= messageSeq {
		t.Fatalf("notice room_seq=%d must fall between join %d and message %d", noticeSeq, agentJoinedSeq, messageSeq)
	}
}

func TestFirstMentionAdmissionRollsBackWhenMessageFails(t *testing.T) {
	allowParallelIntegrationTest(t)
	env := newRoomMembershipEnv(t)
	alice := env.login("alice", alicePassword)
	seedPeerHumanActor(t, env.pool)
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	roomID := createPrivateRoom(t, env, alice, "Mention rollback "+suffix, "mention-rollback-room-"+suffix)
	payload := map[string]any{
		"raw_message": "@Bob missing.txt",
		"segments": []map[string]any{
			{"type": "reference", "content": "@Bob", "target": "actor_acme_bob", "target_type": "user"},
			{"type": "text", "content": " "},
			{"type": "file", "content": "missing.txt", "document_id": "document_missing", "document_version_id": "document_version_missing"},
		},
	}
	status, _, body := env.request(alice, http.MethodPost, "/v0/rooms/"+roomID+"/messages", payload, "mention-rollback-message-"+suffix)
	if status != http.StatusBadRequest {
		t.Fatalf("invalid Message status=%d body=%s", status, body)
	}
	for name, query := range map[string]string{
		"membership":   "select count(*) from room_members where room_id=$1 and actor_id='actor_acme_bob'",
		"member event": "select count(*) from room_events where room_id=$1 and event_type='room.member.added' and resource_id='actor_acme_bob'",
		"message":      "select count(*) from messages where room_id=$1 and body='@Bob missing.txt'",
	} {
		if got := countRows(t, env, query, roomID); got != 0 {
			t.Fatalf("failed Message left %s rows=%d want=0", name, got)
		}
	}
}

type roomListItem struct {
	ID                 string          `json:"id"`
	Kind               string          `json:"kind"`
	ParentRoomID       string          `json:"parent_room_id"`
	LatestRoomSeq      int64           `json:"latest_room_seq"`
	ReadThroughRoomSeq int64           `json:"read_through_room_seq"`
	UnreadMessageCount int64           `json:"unread_message_count"`
	UnreadMentionCount int64           `json:"unread_mention_count"`
	PinnedAt           *time.Time      `json:"pinned_at"`
	MemberPreview      []roomListActor `json:"member_preview"`
	LatestMessage      *struct {
		ID         string `json:"id"`
		RoomSeq    int64  `json:"room_seq"`
		RawMessage string `json:"raw_message"`
	} `json:"latest_message"`
}

type roomListActor struct {
	ID          string `json:"id"`
	Kind        string `json:"kind"`
	DisplayName string `json:"display_name"`
}

func roomListItemByID(t *testing.T, env *testEnv, client *http.Client, roomID string) roomListItem {
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
			return item
		}
	}
	t.Fatalf("room %s missing from list", roomID)
	return roomListItem{}
}
