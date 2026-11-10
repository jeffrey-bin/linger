package integration_test

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentcredential"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentregistry"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/app"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/collaboration"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/typedcard"
)

type agentCommandCaller struct {
	t       *testing.T
	env     *testEnv
	token   string
	context [2]string
}

func (c agentCommandCaller) in(kind, id string) agentCommandCaller {
	c.context = [2]string{kind, id}
	return c
}

func (c agentCommandCaller) post(path string, payload map[string]any) (int, []byte) {
	c.t.Helper()
	encoded, _ := json.Marshal(payload)
	req, _ := http.NewRequestWithContext(c.t.Context(), http.MethodPost, c.env.server.URL+"/api/agent/v1/"+path, bytes.NewReader(encoded))
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Content-Type", "application/json")
	if c.context[0] != "" {
		req.Header.Set("X-TeamHub-Context-Kind", c.context[0])
		req.Header.Set("X-TeamHub-Context-Id", c.context[1])
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		c.t.Fatal(err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		c.t.Fatal(err)
	}
	return resp.StatusCode, body
}

func agentInvocation(seed string) string {
	return fmt.Sprintf("agent-invocation-sha256:%064x", sha256.Sum256([]byte(seed)))
}

type agentChangeResult struct {
	Status        string `json:"status"`
	ActorID       string `json:"actor_id"`
	RoomID        string `json:"room_id"`
	MessageID     string `json:"message_id"`
	InteractionID string `json:"interaction_id"`
}

// decideAgentChange answers a card as the Sponsor and waits for the
// decision.run job to finish it.
func decideAgentChange(t *testing.T, env *testEnv, sponsor *http.Client, change agentChangeResult, payload map[string]any, want string) {
	t.Helper()
	var version int64
	if err := env.pool.QueryRow(t.Context(), `SELECT version FROM message_cards WHERE message_id=$1`, change.MessageID).Scan(&version); err != nil {
		t.Fatal(err)
	}
	request := map[string]any{"expected_version": version}
	for name, value := range payload {
		request[name] = value
	}
	status, _, body := env.request(sponsor, http.MethodPost, "/v0/decisions/"+change.InteractionID, request, "decide-"+change.InteractionID)
	if status != http.StatusOK {
		t.Fatalf("decision=%d %s", status, body)
	}
	for deadline := time.Now().Add(30 * time.Second); ; time.Sleep(20 * time.Millisecond) {
		var got string
		if err := env.pool.QueryRow(t.Context(), `SELECT status FROM decisions WHERE id=$1`, change.InteractionID).Scan(&got); err != nil {
			t.Fatal(err)
		}
		notified := countRows(t, env, `SELECT count(*) FROM messages WHERE card_context_message_id=$1 AND message_kind='agent_runtime'`, change.MessageID)
		if got == want && notified == 1 {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("card %s status=%s notices=%d want %s", change.InteractionID, got, notified, want)
		}
	}
}

// roomNotices counts the Room notices of one type in a Room; extra narrows
// them by the notice JSON it must contain.
func roomNotices(t *testing.T, env *testEnv, roomID, noticeType, extra string) int {
	t.Helper()
	if extra == "" {
		extra = "{}"
	}
	return countRows(t, env, `SELECT count(*) FROM messages WHERE room_id=$1 AND message_kind='room_notice'
		AND notice->>'type'=$2 AND notice @> $3::jsonb`, roomID, noticeType, extra)
}

func TestAgentCLIManagesSponsorAgents(t *testing.T) {
	allowParallelIntegrationTest(t)
	management := &recordingAgentManagement{}
	env, alice := newAgentProfileMcpEnv(t, management, starting(app.JobQueue))
	status, _, body := env.request(alice, http.MethodPost, "/v0/tenants/"+acmeTenant+"/agents", map[string]any{
		"name": "General Agent", "instructions": generalAgentUninitializedInstructionsFixture,
		"runtime": fixtureRuntime("gpt-5"),
	}, "register-agent-cli-caller")
	if status != http.StatusCreated {
		t.Fatalf("register=%d %s", status, body)
	}
	var caller tenantAgentUpdateView
	decode(t, body, &caller)
	roomID := createPrivateRoom(t, env, alice, "Agent team", "agent-cli-team-room")
	if status, body := putRoomMember(t, env, alice, roomID, caller.Actor.ID, "member"); status != http.StatusOK {
		t.Fatalf("membership=%d %s", status, body)
	}
	if got := roomNotices(t, env, roomID, "member_added", `{"member":{"id":"`+caller.Actor.ID+`"}}`); got != 1 {
		t.Fatalf("member notices=%d", got)
	}
	issued, err := agentcredential.New(env.pool).IssueManaged(t.Context(), caller.AgentManagementID, "agent CLI")
	if err != nil {
		t.Fatal(err)
	}
	agent := agentCommandCaller{t: t, env: env, token: issued.AccessToken}
	inRoom := agent.in("room", roomID)

	// Two concurrent first initializations: the loser finds an initialized
	// profile and needs the Sponsor's card instead of failing.
	results := make(chan asyncHTTPResult, 2)
	headers := http.Header{"Authorization": {"Bearer " + issued.AccessToken}, "X-Teamhub-Context-Kind": {"room"}, "X-Teamhub-Context-Id": {roomID}}
	for _, name := range []string{"Release Coordinator", "Review Lead"} {
		if err := startAsyncJSONRequestWithHeaders(results, name, env.server.Client(), http.MethodPost, env.server.URL+"/api/agent/v1/agents/updates", "",
			map[string]any{"invocation_id": agentInvocation(name), "name": name, "prompt": "Work as " + name + "."}, headers); err != nil {
			t.Fatal(err)
		}
	}
	var applied, pending int
	var raced agentChangeResult
	for range 2 {
		result := <-results
		if result.err != nil || result.status != http.StatusOK {
			t.Fatalf("initialization %s=%d %s %v", result.name, result.status, result.body, result.err)
		}
		var change agentChangeResult
		decode(t, result.body, &change)
		switch change.Status {
		case "applied":
			applied++
		case "confirmation_pending":
			pending++
			raced = change
		}
	}
	if applied != 1 || pending != 1 || raced.RoomID != roomID {
		t.Fatalf("initializations applied=%d pending=%d card=%+v", applied, pending, raced)
	}
	if len(management.notifiedSnapshot()) != 0 {
		t.Fatal("a profile change called Agent Service")
	}
	if got := countRows(t, env, `SELECT count(*) FROM agent_registrations WHERE actor_id=$1 AND configuration_revision=2 AND instructions<>$2`,
		caller.Actor.ID, generalAgentUninitializedInstructionsFixture); got != 1 {
		t.Fatalf("initialized registrations=%d", got)
	}
	// The Room sees the Agent set up its own identity, without the prompt.
	if got := countRows(t, env, `SELECT count(*) FROM messages WHERE room_id=$1 AND author_actor_id=$2 AND message_kind='room_notice'
		AND notice @> '{"type":"agent_profile_changed","initialized":true,"instructions_changed":true,"changes":[{"field":"name","before":"General Agent"}]}'
		AND notice::text NOT LIKE '%Work as%'`, roomID, caller.Actor.ID); got != 1 {
		t.Fatalf("initialization notices=%d", got)
	}

	// Changing an established identity, even one's own, waits for the Sponsor.
	status, body = inRoom.post("agents/updates", map[string]any{"invocation_id": agentInvocation("rename"), "name": "Planner"})
	var rename agentChangeResult
	decode(t, body, &rename)
	if status != http.StatusOK || rename.Status != "confirmation_pending" {
		t.Fatalf("rename=%d %s", status, body)
	}
	if replay, again := inRoom.post("agents/updates", map[string]any{"invocation_id": agentInvocation("rename"), "name": "Planner"}); replay != http.StatusOK || !bytes.Equal(again, body) {
		t.Fatalf("replay=%d %s want %s", replay, again, body)
	}
	decideAgentChange(t, env, alice, rename, map[string]any{"decision": "approve"}, "succeeded")
	if got := countRows(t, env, `SELECT count(*) FROM actors WHERE id=$1 AND display_name='Planner'`, caller.Actor.ID); got != 1 {
		t.Fatal("approved rename was not applied")
	}
	if got := roomNotices(t, env, roomID, "agent_profile_changed", `{"initialized":false,"instructions_changed":false,"changes":[{"field":"name","after":"Planner"}]}`); got != 1 {
		t.Fatalf("approved rename notices=%d", got)
	}
	// The card raced against initialization was opened at the old revision.
	decideAgentChange(t, env, alice, raced, map[string]any{"decision": "approve"}, "failed")
	if got := roomNotices(t, env, roomID, "agent_profile_changed", ""); got != 2 {
		t.Fatalf("a failed change posted a notice: %d", got)
	}
	// The Sponsor's own Web edit announces nothing.
	var revision int64
	if err := env.pool.QueryRow(t.Context(), `SELECT configuration_revision FROM agent_registrations WHERE actor_id=$1`, caller.Actor.ID).Scan(&revision); err != nil {
		t.Fatal(err)
	}
	status, _, body = env.request(alice, http.MethodPatch, "/v0/tenants/"+acmeTenant+"/agents/"+caller.Actor.ID,
		map[string]any{"expected_configuration_revision": revision, "description": "Plans the work."}, "web-description-edit")
	if status != http.StatusOK || roomNotices(t, env, roomID, "agent_profile_changed", "") != 2 {
		t.Fatalf("Web edit=%d %s", status, body)
	}

	// Inside a shared Room the new Agent is created and joins at once.
	status, body = inRoom.post("agents", map[string]any{"invocation_id": agentInvocation("create-writer"), "name": "Writer", "prompt": "Draft clear documents."})
	var writer agentChangeResult
	decode(t, body, &writer)
	if status != http.StatusOK || writer.Status != "applied" || writer.RoomID != roomID || writer.ActorID == "" {
		t.Fatalf("create in Room=%d %s", status, body)
	}
	if got := countRows(t, env, `SELECT count(*) FROM active_room_members WHERE room_id=$1 AND actor_id=$2`, roomID, writer.ActorID); got != 1 {
		t.Fatal("created Agent did not join the Room")
	}
	// One line says the caller created it and added it here; no separate join.
	if replay, again := inRoom.post("agents", map[string]any{"invocation_id": agentInvocation("create-writer"), "name": "Writer", "prompt": "Draft clear documents."}); replay != http.StatusOK || !bytes.Equal(again, body) {
		t.Fatalf("create replay=%d %s", replay, again)
	}
	if got := countRows(t, env, `SELECT count(*) FROM messages WHERE room_id=$1 AND author_actor_id=$2 AND message_kind='room_notice'
		AND notice @> jsonb_build_object('type','agent_created','agent',jsonb_build_object('id',$3::text)) AND NOT notice ? 'approved_by'`,
		roomID, caller.Actor.ID, writer.ActorID); got != 1 {
		t.Fatalf("creation notices=%d", got)
	}
	if got := roomNotices(t, env, roomID, "member_added", ""); got != 1 {
		t.Fatalf("member notices after creation=%d", got)
	}
	// Notices reach Humans with their structure and never mention or wake anyone.
	status, _, body = env.request(alice, http.MethodGet, "/v0/rooms/"+roomID+"/messages", nil, "")
	if status != http.StatusOK || !containsJSONText(body, `"message_kind":"room_notice"`) || !containsJSONText(body, `"type":"agent_created"`) {
		t.Fatalf("Human timeline=%d %s", status, body)
	}
	if got := countRows(t, env, `SELECT coalesce(sum(cardinality(message.mentioned_actor_ids)),0) FROM messages message
		WHERE message.room_id=$1 AND message.message_kind='room_notice'`, roomID); got != 0 {
		t.Fatalf("notice mentions=%d", got)
	}
	if got := countRows(t, env, `SELECT count(*) FROM agent_registrations created, agent_registrations source
		WHERE created.actor_id=$1 AND source.actor_id=$2 AND created.status='active' AND created.created_by_actor_id=source.created_by_actor_id
		AND created.runtime_model=source.runtime_model AND created.computer_id=source.computer_id`, writer.ActorID, caller.Actor.ID); got != 1 {
		t.Fatal("created Agent does not share the caller's Sponsor and Runtime")
	}
	status, body = inRoom.post("agents/get", map[string]any{"actor_id": writer.ActorID})
	if status != http.StatusOK || !containsJSONText(body, `"prompt":"Draft clear documents."`) {
		t.Fatalf("get=%d %s", status, body)
	}
	status, body = inRoom.post("available-agents", map[string]any{})
	if status != http.StatusOK || !containsJSONText(body, writer.ActorID) {
		t.Fatalf("list as a General Agent=%d %s", status, body)
	}

	// In the Sponsor's Direct Room nobody can join, so creation needs the card.
	status, _, body = env.request(alice, http.MethodPost, "/v0/tenants/"+acmeTenant+"/direct-rooms", map[string]any{"peer_actor_id": caller.Actor.ID}, "")
	var direct struct {
		ID string `json:"id"`
	}
	decode(t, body, &direct)
	if status != http.StatusOK && status != http.StatusCreated || direct.ID == "" {
		t.Fatalf("open Direct Room=%d %s", status, body)
	}
	directRoomID := direct.ID
	status, body = agent.in("room", directRoomID).post("agents", map[string]any{"invocation_id": agentInvocation("create-critic"), "name": "Critic", "prompt": "Challenge every claim."})
	var critic agentChangeResult
	decode(t, body, &critic)
	if status != http.StatusOK || critic.Status != "confirmation_pending" || critic.RoomID != directRoomID {
		t.Fatalf("create in Direct Room=%d %s", status, body)
	}
	decideAgentChange(t, env, alice, critic, map[string]any{"decision": "deny", "comment": "Not now"}, "denied")
	if got := countRows(t, env, `SELECT count(*) FROM actors WHERE display_name='Critic' AND tenant_id=$1`, acmeTenant); got != 0 {
		t.Fatal("a denied creation created an Agent")
	}
	// An approved creation is announced once in the card's Room, naming the approver.
	status, body = agent.in("room", directRoomID).post("agents", map[string]any{"invocation_id": agentInvocation("create-editor"), "name": "Editor", "prompt": "Edit for clarity."})
	var editor agentChangeResult
	decode(t, body, &editor)
	if status != http.StatusOK || editor.Status != "confirmation_pending" {
		t.Fatalf("create Editor=%d %s", status, body)
	}
	decideAgentChange(t, env, alice, editor, map[string]any{"decision": "approve"}, "succeeded")
	if got := roomNotices(t, env, directRoomID, "agent_created", `{"agent":{"display_name":"Editor"},"approved_by":{"id":"actor_acme_alice"}}`); got != 1 {
		t.Fatalf("approved creation notices=%d", got)
	}
	// The approved Agent opens with the Sponsor's direct Room, which lists it
	// in the sidebar; a rerun of the decision reopens that Room.
	var editorID string
	if err := env.pool.QueryRow(t.Context(), `SELECT id FROM actors WHERE tenant_id=$1 AND display_name='Editor' AND kind='agent'`, acmeTenant).Scan(&editorID); err != nil {
		t.Fatal(err)
	}
	editorRooms := func() int {
		return countRows(t, env, `SELECT count(*) FROM rooms room JOIN active_room_members member ON member.room_id=room.id AND member.actor_id=$2
			WHERE room.tenant_id=$1 AND room.direct_human_actor_id='actor_acme_alice' AND room.direct_agent_actor_id=$2`, acmeTenant, editorID)
	}
	if got := editorRooms(); got != 1 {
		t.Fatalf("approved Agent direct Rooms=%d want=1", got)
	}
	status, _, body = env.request(alice, http.MethodGet, "/v0/tenants/"+acmeTenant+"/rooms", nil, "")
	var listed struct {
		Items []struct {
			DirectPeer *struct {
				ID string `json:"id"`
			} `json:"direct_peer"`
		} `json:"items"`
	}
	decode(t, body, &listed)
	sidebar := 0
	for _, room := range listed.Items {
		if room.DirectPeer != nil && room.DirectPeer.ID == editorID {
			sidebar++
		}
	}
	if status != http.StatusOK || sidebar != 1 {
		t.Fatalf("Sponsor room list status=%d direct Editor Rooms=%d body=%s", status, sidebar, body)
	}
	claim := typedcard.ClaimedDecision{ID: editor.InteractionID}
	if err := env.pool.QueryRow(t.Context(), `SELECT kind, tenant_id, room_id, requested_by_actor_id, decider_actor_id, request FROM decisions WHERE id=$1`,
		editor.InteractionID).Scan(&claim.Kind, &claim.TenantID, &claim.RoomID, &claim.RequestedByActorID, &claim.DeciderActorID, &claim.Request); err != nil {
		t.Fatal(err)
	}
	logger := slog.New(slog.DiscardHandler)
	registry := agentregistry.New(env.pool, nil, collaboration.New(env.pool, nil, nil, nil, nil, logger), nil, logger)
	replayed, err := registry.RunAgentChangeDecision(t.Context(), claim)
	if err != nil || replayed.Status != "succeeded" || replayed.Data.(map[string]string)["actor_id"] != editorID {
		t.Fatalf("replayed decision=%+v err=%v", replayed, err)
	}
	if got := editorRooms(); got != 1 {
		t.Fatalf("direct Rooms after replay=%d want=1", got)
	}
}

func TestAgentCLIInvitesSponsorAgentsToRoom(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newAgentProfileMcpEnv(t, &recordingAgentManagement{}, starting(app.JobQueue))
	register := func(name string) tenantAgentUpdateView {
		status, _, body := env.request(alice, http.MethodPost, "/v0/tenants/"+acmeTenant+"/agents", map[string]any{
			"name": name, "instructions": "Work as " + name + ".", "runtime": fixtureRuntime("gpt-5"),
		}, "register-invite-"+name)
		if status != http.StatusCreated {
			t.Fatalf("register %s=%d %s", name, status, body)
		}
		var agent tenantAgentUpdateView
		decode(t, body, &agent)
		return agent
	}
	coordinator, researcher := register("Coordinator"), register("Researcher")
	roomID := createPrivateRoom(t, env, alice, "Launch", "agent-cli-invite-room")
	if status, body := putRoomMember(t, env, alice, roomID, coordinator.Actor.ID, "member"); status != http.StatusOK {
		t.Fatalf("membership=%d %s", status, body)
	}
	issued, err := agentcredential.New(env.pool).IssueManaged(t.Context(), coordinator.AgentManagementID, "agent CLI")
	if err != nil {
		t.Fatal(err)
	}
	agent := agentCommandCaller{t: t, env: env, token: issued.AccessToken}
	inRoom := agent.in("room", roomID)
	invite := func(scope agentCommandCaller, actorID string) (int, []byte) {
		return scope.post("room-members/add", map[string]any{"invocation_id": agentInvocation("invite-" + actorID), "actor_id": actorID})
	}

	// The Agent joins at once, announced as the caller's doing.
	status, body := invite(inRoom, researcher.Actor.ID)
	if status != http.StatusOK || !containsJSONText(body, `"added":true`) || !containsJSONText(body, `"room_id":"`+roomID+`"`) {
		t.Fatalf("invite=%d %s", status, body)
	}
	if got := countRows(t, env, `SELECT count(*) FROM active_room_members WHERE room_id=$1 AND actor_id=$2`, roomID, researcher.Actor.ID); got != 1 {
		t.Fatal("invited Agent did not join the Room")
	}
	invitedNotice := `SELECT count(*) FROM messages WHERE room_id=$1 AND author_actor_id=$2 AND message_kind='room_notice'
		AND notice @> jsonb_build_object('type','member_added','member',jsonb_build_object('id',$3::text))`
	if got := countRows(t, env, invitedNotice, roomID, coordinator.Actor.ID, researcher.Actor.ID); got != 1 {
		t.Fatalf("invite notices=%d", got)
	}
	// Inviting a member again changes and announces nothing.
	status, body = invite(inRoom, researcher.Actor.ID)
	if status != http.StatusOK || !containsJSONText(body, `"added":false`) {
		t.Fatalf("repeat invite=%d %s", status, body)
	}
	if got := countRows(t, env, invitedNotice, roomID, coordinator.Actor.ID, researcher.Actor.ID); got != 1 {
		t.Fatalf("repeat invite notices=%d", got)
	}

	// Only Agents, only from a Room Context, and never into a Direct Room.
	for _, actorID := range []string{"actor_acme_alice", "actor_missing"} {
		if status, body := invite(inRoom, actorID); status != http.StatusNotFound {
			t.Fatalf("invite %s=%d %s", actorID, status, body)
		}
	}
	if status, body := invite(agent, researcher.Actor.ID); status != http.StatusForbidden {
		t.Fatalf("invite without a Room=%d %s", status, body)
	}
	status, _, body = env.request(alice, http.MethodPost, "/v0/tenants/"+acmeTenant+"/direct-rooms", map[string]any{"peer_actor_id": coordinator.Actor.ID}, "")
	var direct struct {
		ID string `json:"id"`
	}
	decode(t, body, &direct)
	if status != http.StatusOK && status != http.StatusCreated || direct.ID == "" {
		t.Fatalf("open Direct Room=%d %s", status, body)
	}
	if status, body := invite(agent.in("room", direct.ID), researcher.Actor.ID); status != http.StatusConflict {
		t.Fatalf("invite into Direct Room=%d %s", status, body)
	}
}
