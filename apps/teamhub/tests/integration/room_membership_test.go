package integration_test

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/app"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/config"
)

const (
	// integrationSecretSeed is what spawned service processes derive their
	// credentials from; TeamHub test configs use the same derived values.
	integrationSecretSeed         = "integration-process-secret-seed-0123456789"
	acmeOfficialAgentManagementID = "agent-management-acme-official"
)

var (
	teamHubInternalToken      = config.ServiceCredential(integrationSecretSeed, "teamhub-internal")
	nodeServicesInternalToken = config.ServiceCredential(integrationSecretSeed, "node-services-internal")
	agentRunTokenSecret       = config.ServiceCredential(integrationSecretSeed, "agent-run-token")
)

func newRoomMembershipEnv(t *testing.T, appOptions ...appOption) *testEnv {
	t.Helper()
	const heartbeat = 50 * time.Millisecond
	databaseURL := newIntegrationDatabase(t)
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	artifactRoot := prepareTemplateAppCatalog(t, pool)
	appConfig := config.ForTest(func(c *config.Config) {
		c.DatabaseURL = databaseURL
		c.SessionTTL = time.Hour
		c.CookieName = "teamhub_session"
		c.SSEHeartbeatInterval = heartbeat
		c.TeamHubInternalToken = teamHubInternalToken
		c.NodeServicesInternalToken = nodeServicesInternalToken
		c.AgentRunTokenSecret = agentRunTokenSecret
		c.ArtifactStorageRoot = artifactRoot
		c.ArtifactMaxBytes = 50 << 20
	})
	appOptions = append([]appOption{skipping(app.SkillInstall)}, appOptions...)
	application, err := newTestApp(ctx, appConfig, appOptions...)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(application.Close)
	server := httptest.NewServer(application.Handler())
	registerIntegrationServerCleanup(t, server)
	env := &testEnv{t: t, databaseURL: databaseURL, pool: pool, server: server, artifactRoot: artifactRoot}
	return env
}

func createPrivateRoom(t *testing.T, env *testEnv, owner *http.Client, name, key string) string {
	t.Helper()
	status, _, body := env.request(owner, http.MethodPost, "/v0/tenants/"+acmeTenant+"/rooms", map[string]any{"name": name}, key)
	if status != http.StatusCreated {
		t.Fatalf("create room status=%d body=%s", status, body)
	}
	var room struct {
		ID string `json:"id"`
	}
	decode(t, body, &room)
	return room.ID
}

func putRoomMember(t *testing.T, env *testEnv, owner *http.Client, roomID, actorID, role string) (int, []byte) {
	t.Helper()
	status, _, body := env.request(owner, http.MethodPut, "/v0/rooms/"+roomID+"/members/"+actorID, map[string]any{"role": role}, "")
	return status, body
}

func TestRoomMembershipControlsHistoryAndManagement(t *testing.T) {
	allowParallelIntegrationTest(t)
	env := newRoomMembershipEnv(t)
	alice := env.login("alice", alicePassword)
	bob := seedPeerHuman(t, env)
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	roomID := createPrivateRoom(t, env, alice, "Members "+suffix, "members-room-"+suffix)
	env.createMessage(alice, roomID, "before Bob joined", "members-history-"+suffix)

	for _, path := range []string{
		"/v0/rooms/" + roomID,
		"/v0/rooms/" + roomID + "/messages",
		"/v0/rooms/" + roomID + "/members",
		"/v0/rooms/" + roomID + "/events?after=0",
	} {
		status, _, _ := env.request(bob, http.MethodGet, path, nil, "")
		if status != http.StatusNotFound {
			t.Fatalf("non-member %s status=%d want=404", path, status)
		}
	}

	status, body := putRoomMember(t, env, alice, roomID, "actor_acme_bob", "member")
	if status != http.StatusOK {
		t.Fatalf("add Bob status=%d body=%s", status, body)
	}

	status, _, history := env.request(bob, http.MethodGet, "/v0/rooms/"+roomID+"/messages", nil, "")
	if status != http.StatusOK || !containsJSONText(history, "before Bob joined") {
		t.Fatalf("new member cannot read old history status=%d body=%s", status, history)
	}
	for _, path := range []string{
		"/v0/rooms/" + roomID + "/documents",
	} {
		status, _, body = env.request(bob, http.MethodGet, path, nil, "")
		if status != http.StatusOK {
			t.Fatalf("Room member cannot access %s status=%d body=%s", path, status, body)
		}
	}
	status, _, events := env.request(bob, http.MethodGet, "/v0/rooms/"+roomID+"/events?after=0", nil, "")
	if status != http.StatusOK || !containsJSONText(events, "room.created") || !containsJSONText(events, "room.member.added") {
		t.Fatalf("new member cannot replay old events status=%d body=%s", status, events)
	}
	env.createMessage(bob, roomID, "after Bob joined", "members-bob-message-"+suffix)

	status, body = putRoomMember(t, env, bob, roomID, "actor_acme_official", "member")
	if status != http.StatusOK {
		t.Fatalf("ordinary member Workspace Agent admission status=%d body=%s", status, body)
	}
	status, _, body = env.request(bob, http.MethodPatch, "/v0/rooms/"+roomID, map[string]any{"name": "forbidden"}, "member-room-update-"+suffix)
	if status != http.StatusForbidden {
		t.Fatalf("ordinary member updated Room status=%d body=%s", status, body)
	}
	status, body = putRoomMember(t, env, alice, roomID, "actor_acme_bob", "owner")
	if status != http.StatusOK {
		t.Fatalf("promote Bob status=%d body=%s", status, body)
	}
	status, body = putRoomMember(t, env, bob, roomID, "actor_acme_official", "member")
	if status != http.StatusOK {
		t.Fatalf("Workspace Agent admission replay status=%d body=%s", status, body)
	}
	status, body = putRoomMember(t, env, alice, roomID, "actor_acme_official", "member")
	if status != http.StatusOK {
		t.Fatalf("Agent Sponsor admission status=%d body=%s", status, body)
	}

	status, _, members := env.request(bob, http.MethodGet, "/v0/rooms/"+roomID+"/members?limit=200", nil, "")
	if status != http.StatusOK || !containsJSONText(members, "actor_acme_alice") || !containsJSONText(members, "actor_acme_official") {
		t.Fatalf("list members status=%d body=%s", status, members)
	}

	// Pagination must retain the same member order and scope as the full list.
	var full struct {
		Items []json.RawMessage `json:"items"`
	}
	decode(t, members, &full)
	cursor := ""
	for index, expected := range full.Items {
		status, _, pageBody := env.request(bob, http.MethodGet, "/v0/rooms/"+roomID+"/members?limit=1&cursor="+cursor, nil, "")
		var page struct {
			Items []json.RawMessage `json:"items"`
			Page  struct {
				HasMore    bool   `json:"has_more"`
				NextCursor string `json:"next_cursor"`
			} `json:"page"`
		}
		decode(t, pageBody, &page)
		if status != http.StatusOK || len(page.Items) != 1 || string(page.Items[0]) != string(expected) || page.Page.HasMore != (index < len(full.Items)-1) {
			t.Fatalf("member page %d status=%d body=%s want=%s", index, status, pageBody, expected)
		}
		cursor = page.Page.NextCursor
	}
	status, _, body = env.request(alice, http.MethodDelete, "/v0/rooms/"+roomID+"/members/actor_acme_bob", nil, "")
	if status != http.StatusNoContent {
		t.Fatalf("remove Bob status=%d body=%s", status, body)
	}
	status, _, _ = env.request(bob, http.MethodGet, "/v0/rooms/"+roomID+"/messages", nil, "")
	if status != http.StatusNotFound {
		t.Fatalf("removed member history status=%d want=404", status)
	}
	for _, path := range []string{
		"/v0/rooms/" + roomID + "/artifact-tree",
		"/v0/rooms/" + roomID + "/members",
	} {
		status, _, body = env.request(bob, http.MethodGet, path, nil, "")
		if status != http.StatusNotFound {
			t.Fatalf("removed member accessed %s status=%d body=%s", path, status, body)
		}
	}
	status, _, rooms := env.request(bob, http.MethodGet, "/v0/tenants/"+acmeTenant+"/rooms?limit=200", nil, "")
	if status != http.StatusOK || containsJSONText(rooms, roomID) {
		t.Fatalf("removed Room still listed status=%d body=%s", status, rooms)
	}
}

func TestRoomMemberCanAddTenantHumanButCannotMutateRolesOrInactiveAgents(t *testing.T) {
	allowParallelIntegrationTest(t)
	env := newRoomMembershipEnv(t)
	alice := env.login("alice", alicePassword)
	bob := seedPeerHuman(t, env)
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	roomID := createPrivateRoom(t, env, alice, "Member admission "+suffix, "member-admission-room-"+suffix)
	if status, body := putRoomMember(t, env, alice, roomID, "actor_acme_bob", "member"); status != http.StatusOK {
		t.Fatalf("add Bob status=%d body=%s", status, body)
	}

	accountID := "account_member_target_" + suffix
	humanActorID := "actor_member_target_" + suffix
	if _, err := env.pool.Exec(context.Background(), `insert into accounts(id,email,password_hash) values($1,$2,'not-used')`, accountID, "member-target-"+suffix+"@example.com"); err != nil {
		t.Fatal(err)
	}
	if _, err := env.pool.Exec(context.Background(), `
		insert into actors(id,tenant_id,kind,display_name,account_id)
		values($1,$2,'human','Member Target',$3)`, humanActorID, acmeTenant, accountID); err != nil {
		t.Fatal(err)
	}
	if status, body := putRoomMember(t, env, bob, roomID, humanActorID, "member"); status != http.StatusOK {
		t.Fatalf("ordinary member Human admission status=%d body=%s", status, body)
	}
	if status, body := putRoomMember(t, env, bob, roomID, humanActorID, "owner"); status != http.StatusForbidden || !containsJSONText(body, "ROOM_OWNER_REQUIRED") {
		t.Fatalf("ordinary member role mutation status=%d body=%s", status, body)
	}

	inactiveActorID := "actor_member_inactive_" + suffix
	if _, err := env.pool.Exec(context.Background(), `
		insert into actors(id,tenant_id,kind,display_name,handle)
		values($1,$2,'agent','Inactive Sponsored Agent',$3)`,
		inactiveActorID, acmeTenant, "@"+inactiveActorID); err != nil {
		t.Fatal(err)
	}
	if _, err := env.pool.Exec(context.Background(), `
		insert into agent_registrations(
			actor_id,tenant_id,agent_management_id,status,instructions,runtime_model,created_by_actor_id,
			computer_id,local_runtime_type,workspace_grant_id
		) values($1,$2,'management-'||$1,'revoked','Not active.','openai/gpt-5.4','actor_acme_bob','computer_fixture','codex','grant_files')`,
		inactiveActorID, acmeTenant); err != nil {
		t.Fatal(err)
	}
	if status, body := putRoomMember(t, env, bob, roomID, inactiveActorID, "member"); status != http.StatusConflict || !containsJSONText(body, "AGENT_NOT_REGISTERED") {
		t.Fatalf("inactive sponsored Agent admission status=%d body=%s", status, body)
	}
	for name, query := range map[string]string{
		"membership": "select count(*) from room_members where room_id=$1 and actor_id=$2",
		"event":      "select count(*) from room_events where room_id=$1 and resource_id=$2",
	} {
		if got := countRows(t, env, query, roomID, inactiveActorID); got != 0 {
			t.Fatalf("inactive Agent admission created %s rows=%d want=0", name, got)
		}
	}
}

func TestAddingHumanAlsoAddsActiveAnotherMe(t *testing.T) {
	allowParallelIntegrationTest(t)
	env := newRoomMembershipEnv(t)
	alice := env.login("alice", alicePassword)
	seedPeerHuman(t, env)
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	roomID := createPrivateRoom(t, env, alice, "AnotherMe admission "+suffix, "anotherme-admission-room-"+suffix)
	agentActorID := "actor_bob_anotherme_" + suffix

	if _, err := env.pool.Exec(context.Background(), `
		INSERT INTO actors(id,tenant_id,kind,display_name,handle)
		VALUES($1,$2,'agent','Bob AnotherMe',$3)`,
		agentActorID, acmeTenant, "@"+agentActorID); err != nil {
		t.Fatal(err)
	}
	if _, err := env.pool.Exec(context.Background(), `
		INSERT INTO agent_registrations(
			actor_id,tenant_id,agent_management_id,status,instructions,runtime_model,
			created_by_actor_id,visibility_scope,agent_type,represented_human_actor_id,
			computer_id,local_runtime_type,workspace_grant_id
		) VALUES($1,$2,$3,'active','Delegate safely','openai/gpt-5.4',
			'actor_acme_bob','sponsor','anotherme','actor_acme_bob','computer_fixture','codex','grant_files')`,
		agentActorID, acmeTenant, "management-"+agentActorID); err != nil {
		t.Fatal(err)
	}

	if status, body := putRoomMember(t, env, alice, roomID, "actor_acme_bob", "member"); status != http.StatusOK {
		t.Fatalf("add Bob status=%d body=%s", status, body)
	}
	for _, actorID := range []string{"actor_acme_bob", agentActorID} {
		if got := countRows(t, env, `SELECT count(*) FROM active_room_members WHERE room_id=$1 AND actor_id=$2`, roomID, actorID); got != 1 {
			t.Fatalf("active Room membership actor=%s rows=%d want=1", actorID, got)
		}
		if got := countRows(t, env, `SELECT count(*) FROM room_events WHERE room_id=$1 AND resource_id=$2 AND event_type='room.member.added'`, roomID, actorID); got != 1 {
			t.Fatalf("Room member event actor=%s rows=%d want=1", actorID, got)
		}
	}
}

func TestRoomMembershipPreservesAnOwnerAndInvalidatesTheRemovedMembersRoom(t *testing.T) {
	allowParallelIntegrationTest(t)
	env := newRoomMembershipEnv(t)
	alice := env.login("alice", alicePassword)
	bob := seedPeerHuman(t, env)
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	roomID := createPrivateRoom(t, env, alice, "Revocation "+suffix, "revocation-room-"+suffix)
	if status, body := putRoomMember(t, env, alice, roomID, "actor_acme_bob", "member"); status != http.StatusOK {
		t.Fatalf("add Bob status=%d body=%s", status, body)
	}

	status, body := putRoomMember(t, env, alice, roomID, "actor_acme_alice", "member")
	if status != http.StatusConflict {
		t.Fatalf("downgrade last owner status=%d body=%s", status, body)
	}
	status, _, body = env.request(alice, http.MethodDelete, "/v0/rooms/"+roomID+"/members/actor_acme_alice", nil, "")
	if status != http.StatusConflict {
		t.Fatalf("remove last owner status=%d body=%s", status, body)
	}

	after := currentEventWatermark(t, env, bob, "/v0/rooms/"+roomID+"/events", "latest_room_seq")
	response := openSSE(t, bob, eventsStreamURL(env.server.URL, roomID, after), 5*time.Second)
	defer response.Body.Close()
	reader := bufio.NewReader(response.Body)
	requireSSEReady(t, "bob", reader)
	status, _, body = env.request(alice, http.MethodDelete, "/v0/rooms/"+roomID+"/members/actor_acme_bob", nil, "")
	if status != http.StatusNoContent {
		t.Fatalf("remove Bob status=%d body=%s", status, body)
	}
	// The Room is no longer readable for Bob: his stream drops the cursor
	// and tells him to refetch the Room.
	awaitInvalidation(t, reader, "room", roomID)
	status, _, body = env.request(bob, http.MethodGet, "/v0/rooms/"+roomID, nil, "")
	if status != http.StatusNotFound {
		t.Fatalf("removed member room status=%d body=%s", status, body)
	}
}

func containsJSONText(body []byte, text string) bool {
	return len(body) > 0 && string(body) != "null" && strings.Contains(string(body), text)
}

func TestConcurrentMemberRemovalDoesNotAllowLaterRoomWrites(t *testing.T) {
	allowParallelIntegrationTest(t)
	env := newRoomMembershipEnv(t)
	alice := env.login("alice", alicePassword)
	bob := seedPeerHuman(t, env)
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	roomID := createPrivateRoom(t, env, alice, "Concurrent removal "+suffix, "concurrent-removal-room-"+suffix)
	if status, body := putRoomMember(t, env, alice, roomID, "actor_acme_bob", "member"); status != http.StatusOK {
		t.Fatalf("add Bob status=%d body=%s", status, body)
	}

	results := make(chan asyncHTTPResult, 17)
	for index := 0; index < 16; index++ {
		if err := startAsyncJSONRequest(results, fmt.Sprintf("message-%d", index), bob, http.MethodPost, env.server.URL+"/v0/rooms/"+roomID+"/messages", fmt.Sprintf("concurrent-message-%s-%d", suffix, index), humanTextMessage(fmt.Sprintf("race %d", index))); err != nil {
			t.Fatal(err)
		}
	}
	if err := startAsyncJSONRequest(results, "remove", alice, http.MethodDelete, env.server.URL+"/v0/rooms/"+roomID+"/members/actor_acme_bob", "", nil); err != nil {
		t.Fatal(err)
	}
	for index := 0; index < 17; index++ {
		result := <-results
		if result.err != nil {
			t.Fatal(result.err)
		}
		if result.name == "remove" && result.status != http.StatusNoContent {
			t.Fatalf("remove status=%d body=%s", result.status, result.body)
		}
		if result.name != "remove" && result.status != http.StatusCreated && result.status != http.StatusNotFound {
			t.Fatalf("%s status=%d body=%s", result.name, result.status, result.body)
		}
	}
	var laterMessages int
	if err := env.pool.QueryRow(context.Background(), `
		select count(*)
		from room_events message_event
		where message_event.room_id=$1 and message_event.event_type='message.created'
		  and message_event.actor_id='actor_acme_bob'
		  and message_event.room_seq>(
		    select removed.room_seq from room_events removed
		    where removed.room_id=$1 and removed.event_type='room.member.removed'
		      and removed.resource_id='actor_acme_bob'
		    order by removed.room_seq desc limit 1
		  )`, roomID).Scan(&laterMessages); err != nil {
		t.Fatal(err)
	}
	if laterMessages != 0 {
		t.Fatalf("messages committed after member removal: %d", laterMessages)
	}
}
