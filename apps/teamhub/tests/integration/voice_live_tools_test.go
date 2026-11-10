package integration_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/composio"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/config"
	teamhubinternal "github.com/simplexai-labs/linger/contracts-go/teamhubinternal"
)

// liveToolCaller calls one live tool the way Voice Runtime does and decodes
// its output.
func liveToolCaller(t *testing.T, env *testEnv, sessionID string) func(turnID, callID, name string, arguments map[string]any) map[string]any {
	return func(turnID, callID, name string, arguments map[string]any) map[string]any {
		t.Helper()
		encoded, _ := json.Marshal(arguments)
		var result teamhubinternal.VoiceLiveToolResult
		decode(t, voiceRuntimeCall(t, env, http.MethodPost, "/internal/v1/voice/live-tool-calls", map[string]any{
			"voice_session_id": sessionID, "turn_id": turnID, "call_id": callID, "name": name, "arguments": string(encoded),
		}, http.StatusOK), &result)
		var output map[string]any
		if err := json.Unmarshal([]byte(result.Output), &output); err != nil {
			t.Fatalf("%s output=%s", callID, result.Output)
		}
		return output
	}
}

// The live voice sets up a one-time reminder only after the user said yes in
// a later turn, lists it with its ID, pauses it, and deletes it after another yes.
func TestVoiceLiveSetsUpAndChangesRoutinesAfterConfirmation(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, _, roomID, sessionID := newVoiceLiveRoom(t)
	call := liveToolCaller(t, env, sessionID)
	reminder := map[string]any{
		"name": "Call Mom", "instruction": "Reminder: call Mom", "kind": "once",
		"run_at": time.Now().Add(2 * time.Hour).Format(time.RFC3339), "timezone": "Asia/Shanghai",
	}
	if bad := call("lt_bad", "routine-0", "create_routine", map[string]any{"name": "x", "instruction": "y", "kind": "once"}); bad["error"] != "invalid_schedule" {
		t.Fatalf("no time=%v", bad)
	}
	asked := call("lt_ask", "routine-1", "create_routine", reminder)
	if asked["status"] != "needs_confirmation" || !strings.Contains(asked["summary"].(string), "post this reminder") {
		t.Fatalf("ask=%v", asked)
	}
	reminder["confirmed"] = true
	if early := call("lt_ask", "routine-2", "create_routine", reminder); early["status"] != "awaiting_answer" {
		t.Fatalf("same-turn yes=%v", early)
	}
	created := call("lt_yes", "routine-3", "create_routine", reminder)
	routineID, _ := created["routine_id"].(string)
	if created["status"] != "created" || routineID == "" || created["next_run"] == nil {
		t.Fatalf("create=%v", created)
	}
	// The same yes again in that turn is the same Routine.
	if again := call("lt_yes", "routine-4", "create_routine", reminder); again["routine_id"] != routineID {
		t.Fatalf("replayed yes=%v", again)
	}
	if got := countRows(t, env, `SELECT count(*) FROM room_reminders WHERE room_id=$1 AND created_by_actor_id='actor_acme_official' AND mention_actor_id IS NULL`, roomID); got != 1 {
		t.Fatalf("routines=%d", got)
	}
	listed := call("lt_list", "routine-5", "list_routines", map[string]any{})
	routines, _ := listed["routines"].([]any)
	if len(routines) != 1 || routines[0].(map[string]any)["routine_id"] != routineID || !strings.HasPrefix(routines[0].(map[string]any)["schedule"].(string), "once at ") {
		t.Fatalf("list=%v", listed)
	}
	if paused := call("lt_pause", "routine-6", "change_routine", map[string]any{"routine_id": routineID, "action": "pause"}); paused["status"] != "paused" {
		t.Fatalf("pause=%v", paused)
	}
	if got := countRows(t, env, `SELECT count(*) FROM room_reminders WHERE id=$1 AND NOT enabled`, routineID); got != 1 {
		t.Fatal("routine still enabled")
	}
	if ask := call("lt_delete", "routine-7", "change_routine", map[string]any{"routine_id": routineID, "action": "delete"}); ask["status"] != "needs_confirmation" {
		t.Fatalf("delete ask=%v", ask)
	}
	if deleted := call("lt_delete_yes", "routine-8", "change_routine", map[string]any{"routine_id": routineID, "action": "delete", "confirmed": true}); deleted["status"] != "deleted" {
		t.Fatalf("delete=%v", deleted)
	}
	if got := countRows(t, env, `SELECT count(*) FROM room_reminders WHERE id=$1`, routineID); got != 0 {
		t.Fatal("routine not deleted")
	}
	if missing := call("lt_missing", "routine-9", "change_routine", map[string]any{"routine_id": routineID, "action": "run"}); missing["error"] != "routine_not_found" {
		t.Fatalf("missing=%v", missing)
	}
}

// The live voice creates a document as the call's Agent and opens it beside
// the chat; it can be edited by voice right after.
func TestVoiceLiveCreatesADocumentAndOpensIt(t *testing.T) {
	allowParallelIntegrationTest(t)
	var computes atomic.Int32
	replaced := make(chan string, 16)
	var bodies *pgxpool.Pool
	runtime := canvasRuntime(t, &computes, replaced, func() *pgxpool.Pool { return bodies })
	env, _, roomID, sessionID := newVoiceLiveRoom(t, func(cfg *config.Config) {
		cfg.RoomDocument.RuntimeURL = runtime.URL
	})
	bodies = env.pool
	call := liveToolCaller(t, env, sessionID)
	created := call("lt_doc", "doc-1", "create_document", map[string]any{"title": " Q4 launch plan ", "content": "- Launch on December 10\n- Ray Zhao owns the canary"})
	documentID, _ := created["document_id"].(string)
	if created["status"] != "created" || documentID == "" || created["revision_id"] == "" {
		t.Fatalf("create=%v", created)
	}
	if countRows(t, env, `SELECT count(*) FROM documents WHERE id=$1 AND title='Q4 launch plan' AND owner_actor_id='actor_acme_official'`, documentID) != 1 ||
		countRows(t, env, `SELECT count(*) FROM messages WHERE room_id=$1 AND author_actor_id='actor_acme_official' AND segments @> jsonb_build_array(jsonb_build_object('type','document','document_id',$2::text,'presentation','canvas'))`, roomID, documentID) != 1 {
		t.Fatal("document not created and opened")
	}
	if renamed := call("lt_rename", "doc-2", "rename_document", map[string]any{"document_id": documentID, "title": "Q4 launch plan v2"}); renamed["status"] != "renamed" {
		t.Fatalf("rename=%v", renamed)
	}
	if empty := call("lt_bad", "doc-3", "create_document", map[string]any{"title": " "}); empty["error"] != "invalid_arguments" {
		t.Fatalf("no title=%v", empty)
	}
}

// The live voice creates an Agent of the user only after a yes in a later
// turn; in a group Room the Agent joins it, and a repeated yes is one Agent.
func TestVoiceLiveCreatesAnAgentAfterConfirmation(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, _, roomID, sessionID := newVoiceLiveRoom(t)
	// The new Agent runs where the call's Agent does: Alice's computer, which
	// must still offer its workspace.
	if _, err := env.pool.Exec(t.Context(), `
INSERT INTO local_computers(computer_id,display_name,status,owner_tenant_id,owner_actor_id,runtime_inventory,workspace_grants,runtime_diagnostics,last_seen_at)
SELECT r.computer_id,'Alice Mac','online',r.tenant_id,'actor_acme_alice','["codex"]',
       jsonb_build_array(jsonb_build_object('grant_id',r.workspace_grant_id,'tenant_id',r.tenant_id,'scope','owner','label','Workspace','mode','workspace-write')),
       jsonb_build_array(jsonb_build_object('type','codex','status','ready','protocol','app-server','checked_at',to_jsonb(now()),
           'models',jsonb_build_array(jsonb_build_object('id',r.runtime_model,'label','Model',
               'allowed_reasoning_effort',jsonb_build_array('low','medium','high','xhigh'),'default_reasoning_effort','high')))),
       now()
FROM agent_registrations r WHERE r.actor_id='actor_acme_official' AND r.created_by_actor_id='actor_acme_alice'`); err != nil {
		t.Fatal(err)
	}
	call := liveToolCaller(t, env, sessionID)
	agent := map[string]any{"name": "Weekly Report Helper", "description": "Compile my weekly report every Friday", "prompt": "Every Friday, compile the user's weekly report from this week's messages and documents."}
	asked := call("lt_ask", "agent-1", "create_agent", agent)
	if asked["status"] != "needs_confirmation" || !strings.Contains(asked["summary"].(string), "Weekly Report Helper") || !strings.Contains(asked["summary"].(string), "add it to this room") {
		t.Fatalf("ask=%v", asked)
	}
	agent["confirmed"] = true
	created := call("lt_yes", "agent-2", "create_agent", agent)
	actorID, _ := created["actor_id"].(string)
	if created["status"] != "created" || actorID == "" || created["joined_room"] != true {
		t.Fatalf("create=%v", created)
	}
	if again := call("lt_yes", "agent-3", "create_agent", agent); again["actor_id"] != actorID {
		t.Fatalf("replayed yes=%v", again)
	}
	if countRows(t, env, `SELECT count(*) FROM agent_registrations WHERE actor_id=$1 AND agent_type='general' AND created_by_actor_id='actor_acme_alice'`, actorID) != 1 ||
		countRows(t, env, `SELECT count(*) FROM actors WHERE display_name='Weekly Report Helper' AND tenant_id='tenant_acme'`) != 1 ||
		countRows(t, env, `SELECT count(*) FROM active_room_members WHERE room_id=$1 AND actor_id=$2`, roomID, actorID) != 1 {
		t.Fatal("Agent not created into the Room")
	}
	if bad := call("lt_bad", "agent-4", "create_agent", map[string]any{"name": "x", "prompt": " "}); bad["error"] != "invalid_agent" {
		t.Fatalf("no prompt=%v", bad)
	}
}

// liveSlack is the Slack behind the fake Composio.
type liveSlack struct {
	mu       sync.Mutex
	posts    []map[string]any
	searches []string
	// calls counts each tool executed, and each tool version fetched as
	// "GET <slug>".
	calls map[string]int
	// slowSend holds a message this long before Slack takes it.
	slowSend time.Duration
}

func (s *liveSlack) serve(w http.ResponseWriter, r *http.Request) bool {
	write := func(data map[string]any) {
		_ = json.NewEncoder(w).Encode(composio.ToolExecution{Successful: true, Data: data})
	}
	if slug := strings.TrimPrefix(r.URL.Path, "/api/v3/tools/"); slug != r.URL.Path && r.Method == http.MethodGet {
		s.count("GET " + slug)
		_ = json.NewEncoder(w).Encode(map[string]any{"slug": slug, "version": r.URL.Query().Get("version"), "toolkit": map[string]string{"slug": "slack"}})
		return true
	}
	var request struct {
		Arguments map[string]any `json:"arguments"`
	}
	if r.Method != http.MethodPost || !strings.HasPrefix(r.URL.Path, "/api/v3.1/tools/execute/") || json.NewDecoder(r.Body).Decode(&request) != nil {
		return false
	}
	slug := strings.TrimPrefix(r.URL.Path, "/api/v3.1/tools/execute/")
	s.count(slug)
	s.mu.Lock()
	slow := s.slowSend
	s.mu.Unlock()
	if slug == "SLACK_SEND_MESSAGE" && slow > 0 {
		select {
		case <-time.After(slow):
		case <-r.Context().Done():
			return true
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	message := func(channel, ts, user, body string) map[string]any {
		return map[string]any{"channel": map[string]any{"id": channel, "name": channel}, "ts": ts, "user": user, "username": user, "text": body}
	}
	switch strings.TrimPrefix(r.URL.Path, "/api/v3.1/tools/execute/") {
	case "SLACK_TEST_AUTH":
		write(map[string]any{"ok": true, "user_id": "U_ALICE"})
	case "SLACK_SEARCH_MESSAGES":
		query, _ := request.Arguments["query"].(string)
		s.searches = append(s.searches, query)
		matches := []any{message("C_DESIGN", "1762230100.000100", "U_LISA", "<@U_ALICE> when will the icons be ready?")}
		if strings.HasPrefix(query, "is:dm") {
			matches = []any{message("D_LISA", "1762230000.000100", "U_LISA", "Can the quote be ready this afternoon?"), message("D_LISA", "1762230200.000100", "U_ALICE", "Sure")}
		}
		write(map[string]any{"messages": map[string]any{"matches": matches}})
	case "SLACK_FIND_CHANNELS":
		write(map[string]any{"channels": []any{map[string]any{"id": "C_DESIGN", "name": "design"}}})
	case "SLACK_FIND_USER_BY_EMAIL_ADDRESS":
		write(map[string]any{"user": map[string]any{"id": "U_LISA", "profile": map[string]any{"email": request.Arguments["email"]}}})
	case "SLACK_OPEN_DM":
		users, _ := request.Arguments["users"].(string)
		write(map[string]any{"channel": map[string]any{"id": "D_" + strings.TrimPrefix(users, "U_")}})
	case "SLACK_SEND_MESSAGE":
		s.posts = append(s.posts, request.Arguments)
		write(map[string]any{"ok": true, "channel": request.Arguments["channel"], "ts": "1762230300.000100"})
	default:
		return false
	}
	return true
}

func (s *liveSlack) count(call string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.calls == nil {
		s.calls = map[string]int{}
	}
	s.calls[call]++
}

func (s *liveSlack) called(call string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.calls[call]
}

func (s *liveSlack) snapshot() ([]map[string]any, []string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]map[string]any(nil), s.posts...), append([]string(nil), s.searches...)
}

// The live voice finds what came to the user on Slack, and sends a Slack
// message to a channel or a colleague found by email only after a yes in a
// later turn.
func TestVoiceLiveReadsTheSlackInboxAndSendsAfterConfirmation(t *testing.T) {
	allowParallelIntegrationTest(t)
	composioFake := newFakeComposio(t)
	slack := &liveSlack{}
	composioFake.setIntercept(slack.serve)
	env, _, _, sessionID := newVoiceLiveRoom(t, composioFake.configure)
	composioFake.seedAccount(t, env.pool, "ca_live_slack", "account_alice", "slack", composio.ConnectionActive)
	if _, err := env.pool.Exec(t.Context(), `
 INSERT INTO external_connections(id,account_id,provider,upstream_connection_id,status,revision,remote_principal_key,identity_label,toolkit_slug,auth_config_id,auto_reminders) VALUES('connection_live_slack','account_alice','slack','ca_live_slack','active',1,'slack:T1:U_ALICE','alice@acme.slack','slack','ac_slack',false);
 INSERT INTO external_connection_agent_grants(id,connection_id,tenant_id,agent_actor_id,represented_human_actor_id,status) VALUES('grant_live_slack','connection_live_slack','tenant_acme','actor_acme_official','actor_acme_alice','active');
 INSERT INTO accounts(id,email,password_hash) VALUES('account_live_lisa','lisa@acme.test','x');
 INSERT INTO actors(id,tenant_id,kind,display_name,account_id) VALUES('actor_live_lisa','tenant_acme','human','Lisa Wang','account_live_lisa')`); err != nil {
		t.Fatal(err)
	}
	call := liveToolCaller(t, env, sessionID)

	// What came lately: direct messages and mentions, without the user's own.
	inbox := call("lt_inbox", "slack-1", "slack_inbox", map[string]any{})
	messages, _ := inbox["messages"].([]any)
	if len(messages) != 2 || messages[0].(map[string]any)["kind"] != "mention" || messages[1].(map[string]any)["kind"] != "dm" || messages[1].(map[string]any)["author_id"] != "U_LISA" {
		t.Fatalf("inbox=%v", inbox)
	}
	if _, searches := slack.snapshot(); len(searches) != 2 || !strings.Contains(strings.Join(searches, "|"), "<@U_ALICE> after:") {
		t.Fatalf("searches=%v", searches)
	}
	// From one colleague, found by name and then on Slack by email.
	call("lt_inbox_lisa", "slack-2", "slack_inbox", map[string]any{"person": "lisa"})
	if _, searches := slack.snapshot(); len(searches) != 4 || !strings.HasSuffix(searches[3], " from:<@U_LISA>") {
		t.Fatalf("person searches=%v", searches)
	}
	if missing := call("lt_inbox_bob", "slack-3", "slack_inbox", map[string]any{"person": "Bob"}); missing["error"] != "person_not_found" {
		t.Fatalf("unknown person=%v", missing)
	}

	// A channel message waits for the user's yes in their next turn.
	post := map[string]any{"channel": "#design", "text": "When will the new icons be ready?"}
	if asked := call("lt_ask", "send-1", "send_slack", post); asked["status"] != "needs_confirmation" || !strings.Contains(asked["summary"].(string), "#design") {
		t.Fatalf("ask=%v", asked)
	}
	post["confirmed"] = true
	if early := call("lt_ask", "send-2", "send_slack", post); early["status"] != "awaiting_answer" {
		t.Fatalf("same-turn yes=%v", early)
	}
	if posts, _ := slack.snapshot(); len(posts) != 0 {
		t.Fatalf("posted before the yes: %v", posts)
	}
	if sent := call("lt_yes", "send-3", "send_slack", post); sent["status"] != "sent" {
		t.Fatalf("send=%v", sent)
	}
	// A direct message to a colleague goes to their Slack DM.
	direct := map[string]any{"person": "Lisa", "text": "I will send you the quote this afternoon", "thread_ts": ""}
	if asked := call("lt_dm", "send-4", "send_slack", direct); asked["status"] != "needs_confirmation" || !strings.Contains(asked["summary"].(string), "Lisa Wang (direct message)") {
		t.Fatalf("dm ask=%v", asked)
	}
	direct["confirmed"] = true
	if sent := call("lt_dm_yes", "send-5", "send_slack", direct); sent["status"] != "sent" {
		t.Fatalf("dm send=%v", sent)
	}
	posts, _ := slack.snapshot()
	if len(posts) != 2 || posts[0]["channel"] != "C_DESIGN" || posts[0]["markdown_text"] != "When will the new icons be ready?" || posts[1]["channel"] != "D_LISA" {
		t.Fatalf("posts=%v", posts)
	}
	if two := call("lt_bad", "send-6", "send_slack", map[string]any{"channel": "#design", "person": "Lisa", "text": "x"}); two["error"] != "invalid_arguments" {
		t.Fatalf("two targets=%v", two)
	}
	// The user's own DM: the user is the one the connection was identified
	// as, and the DM is opened once, not again for the confirmed send.
	if _, err := env.pool.Exec(t.Context(), `UPDATE external_connections SET remote_user_id='U_ALICE' WHERE id='connection_live_slack'`); err != nil {
		t.Fatal(err)
	}
	identified, opened := slack.called("SLACK_TEST_AUTH"), slack.called("SLACK_OPEN_DM")
	self := map[string]any{"to_self": true, "text": "See you tomorrow night"}
	if asked := call("lt_self", "send-7", "send_slack", self); asked["status"] != "needs_confirmation" || !strings.Contains(asked["summary"].(string), "themself (direct message)") {
		t.Fatalf("self ask=%v", asked)
	}
	self["confirmed"] = true
	if sent := call("lt_self_yes", "send-8", "send_slack", self); sent["status"] != "sent" {
		t.Fatalf("self send=%v", sent)
	}
	if posts, _ := slack.snapshot(); len(posts) != 3 || posts[2]["channel"] != "D_ALICE" || posts[2]["markdown_text"] != "See you tomorrow night" {
		t.Fatalf("self posts=%v", posts)
	}
	if slack.called("SLACK_TEST_AUTH") != identified || slack.called("SLACK_OPEN_DM") != opened+1 {
		t.Fatalf("calls=%v", slack.calls)
	}
	// Each pinned tool version is fetched once, however often it runs.
	if fetched := slack.called("GET SLACK_SEND_MESSAGE"); fetched != 1 {
		t.Fatalf("SLACK_SEND_MESSAGE fetched %d times", fetched)
	}
	// A send the user said yes to runs to its end when Slack is slow and the
	// live voice stops waiting, instead of being cut off as it goes out.
	slow := map[string]any{"to_self": true, "text": "Deliver it even if slow"}
	if asked := call("lt_slow", "send-9", "send_slack", slow); asked["status"] != "needs_confirmation" {
		t.Fatalf("slow ask=%v", asked)
	}
	slack.mu.Lock()
	slack.slowSend = 1500 * time.Millisecond
	slack.mu.Unlock()
	slow["confirmed"] = true
	encoded, _ := json.Marshal(slow)
	payload, _ := json.Marshal(map[string]any{"voice_session_id": sessionID, "turn_id": "lt_slow_yes", "call_id": "send-10", "name": "send_slack", "arguments": string(encoded)})
	waiting, stop := context.WithTimeout(t.Context(), 500*time.Millisecond)
	defer stop()
	request, _ := http.NewRequestWithContext(waiting, http.MethodPost, env.server.URL+"/internal/v1/voice/live-tool-calls", bytes.NewReader(payload))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer "+voiceLiveRuntimeToken)
	if response, err := http.DefaultClient.Do(request); err == nil {
		_ = response.Body.Close()
		t.Fatal("the slow send answered before the live voice stopped waiting")
	}
	deadline := time.Now().Add(5 * time.Second)
	for posts, _ := slack.snapshot(); len(posts) != 4; posts, _ = slack.snapshot() {
		if time.Now().After(deadline) {
			t.Fatalf("the confirmed send was cut off: posts=%v", posts)
		}
		time.Sleep(50 * time.Millisecond)
	}
	if posts, _ := slack.snapshot(); posts[3]["markdown_text"] != "Deliver it even if slow" {
		t.Fatalf("slow post=%v", posts[3])
	}
}

// The live voice answers an approval card a task of the user waits on, as its
// Approve button does, only after a yes in a later turn to exactly that answer.
func TestVoiceLiveAnswersATaskApprovalAfterConfirmation(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, _, roomID, sessionID := newVoiceLiveRoom(t)
	call := liveToolCaller(t, env, sessionID)
	started := call("lt_start", "task-1", "start_task", map[string]any{"goal": "Send the quote to Lisa", "surface": "workspace"})
	if started["status"] != "started" {
		t.Fatalf("start=%v", started)
	}
	var taskID string
	if err := env.pool.QueryRow(t.Context(), `SELECT work_item_id FROM voice_live_tasks WHERE voice_session_id=$1`, sessionID).Scan(&taskID); err != nil {
		t.Fatal(err)
	}
	for _, statement := range []string{
		`INSERT INTO messages(id,tenant_id,room_id,author_actor_id,body,segments) VALUES('message_live_approval','tenant_acme',$1,'actor_acme_official','Approve?','[{"type":"text","content":"Approve?"}]')`,
		`INSERT INTO message_cards(message_id,tenant_id,room_id,decision_owner_actor_id,card_type,intent) VALUES('message_live_approval','tenant_acme',$1,'actor_acme_alice','personal_notice','decision_requested')`,
		`INSERT INTO decisions(id,tenant_id,room_id,message_id,kind,requested_by_actor_id,decider_actor_id,alter_ego_task_id,request,view,expires_at)
		 VALUES('decision_live_approval','tenant_acme',$1,'message_live_approval','runtime_permission','actor_acme_official','actor_acme_alice',$2,
		   jsonb_build_object('context_key','live-approval','action_digest','sha256:'||repeat('a',64),'runtime','{}'::jsonb),
		   '{"kind":"code","title":"Send the quote","rationale":"Lisa asked for it"}',clock_timestamp()+interval '10 minutes')`,
	} {
		args := []any{roomID}
		if strings.Contains(statement, "INSERT INTO decisions") {
			args = append(args, taskID)
		}
		if _, err := env.pool.Exec(t.Context(), statement, args...); err != nil {
			t.Fatal(err)
		}
	}
	listed := call("lt_list", "list-1", "list_tasks", map[string]any{})
	tasks, _ := listed["tasks"].([]any)
	if len(tasks) != 1 {
		t.Fatalf("list=%v", listed)
	}
	approvals, _ := tasks[0].(map[string]any)["approvals"].([]any)
	if len(approvals) != 1 || approvals[0].(map[string]any)["approval_id"] != "decision_live_approval" || approvals[0].(map[string]any)["title"] != "Send the quote" {
		t.Fatalf("approvals=%v", tasks[0])
	}

	approve := map[string]any{"approval_id": "decision_live_approval", "decision": "approve"}
	if asked := call("lt_ask", "approve-1", "decide_approval", approve); asked["status"] != "needs_confirmation" || !strings.Contains(asked["summary"].(string), "Approve for task t1: Send the quote") {
		t.Fatalf("ask=%v", asked)
	}
	approve["confirmed"] = true
	if early := call("lt_ask", "approve-2", "decide_approval", approve); early["status"] != "awaiting_answer" {
		t.Fatalf("same-turn yes=%v", early)
	}
	if countRows(t, env, `SELECT count(*) FROM decisions WHERE id='decision_live_approval' AND status='pending'`) != 1 {
		t.Fatal("answered before the yes")
	}
	if approved := call("lt_yes", "approve-3", "decide_approval", approve); approved["status"] != "approved" || approved["task_id"] != "t1" {
		t.Fatalf("approve=%v", approved)
	}
	if countRows(t, env, `SELECT count(*) FROM decisions WHERE id='decision_live_approval' AND status='approved' AND decided_by_actor_id='actor_acme_alice'`) != 1 {
		t.Fatal("the card was not approved as the user")
	}
	if again := call("lt_again", "approve-4", "decide_approval", approve); again["error"] != "approval_not_found" {
		t.Fatalf("answered twice=%v", again)
	}
	if bad := call("lt_bad", "approve-5", "decide_approval", map[string]any{"approval_id": "decision_live_approval", "decision": "maybe"}); bad["error"] != "invalid_arguments" {
		t.Fatalf("bad decision=%v", bad)
	}
}

func TestVoiceLiveKeepsOutOfATaskWorkingRoomUnasked(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, _, roomID, sessionID := newVoiceLiveRoom(t)
	call := liveToolCaller(t, env, sessionID)
	if started := call("lt_start", "task-1", "start_task", map[string]any{"goal": "Make a slide deck", "surface": "workspace"}); started["status"] != "started" {
		t.Fatalf("start=%v", started)
	}
	var workRoomID string
	if err := env.pool.QueryRow(t.Context(), `SELECT link.room_id FROM voice_live_tasks task
		JOIN work_item_room_links link ON link.work_item_id=task.work_item_id AND link.link_type='work'
		WHERE task.voice_session_id=$1`, sessionID).Scan(&workRoomID); err != nil {
		t.Fatal(err)
	}
	// Its results are in the user's room: the working room is not opened unasked.
	for index, target := range []string{workRoomID, "/t/tenant_acme/rooms/" + workRoomID + "/chat"} {
		refused := call("lt_open", fmt.Sprintf("open-task-%d", index), "page_action", map[string]any{"action": "open_room", "target": target})
		if refused["status"] != "task_room" {
			t.Fatalf("task room %q=%v", target, refused)
		}
	}
	asked := call("lt_open", "open-task-asked", "page_action", map[string]any{"action": "open_room", "target": workRoomID, "confirmed": true})
	own := call("lt_open", "open-own", "page_action", map[string]any{"action": "open_room", "target": roomID})
	if asked["status"] != "admitted" || own["status"] != "admitted" {
		t.Fatalf("asked=%v own=%v", asked, own)
	}
}
