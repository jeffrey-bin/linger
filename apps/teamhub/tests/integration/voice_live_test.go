package integration_test

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentruntimestate"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/config"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/reminder"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/taskexecution"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voicemedia"
	teamhubinternal "github.com/simplexai-labs/linger/contracts-go/teamhubinternal"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

const voiceLiveRuntimeToken = "voice-live-test-token"

// newVoiceLiveRoom opens Alice's chat_live session in a group Room whose reply
// Agent is her AnotherMe, after proving the Room is ineligible without one.
func newVoiceLiveRoom(t *testing.T, configure ...func(*config.Config)) (*testEnv, *http.Client, string, string) {
	t.Helper()
	providerAPI := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/protobuf")
		w.WriteHeader(http.StatusOK)
	}))
	registerIntegrationServerCleanup(t, providerAPI)
	media := &dictationTestMedia{}
	env, alice, _ := newHardwareVoiceCaptureEnvWithStorageAndLimitsAndConfig(t, 1<<20, 1<<30, func(cfg *config.Config) {
		cfg.Voice.RuntimeToken = voiceLiveRuntimeToken
		cfg.Voice.XaiAPIKey = "test-xai"
		for _, more := range configure {
			more(cfg)
		}
	}, withVoiceMedia(media))
	provider, err := voicemedia.NewLiveKitProvider(voicemedia.LiveKitConfig{APIURL: providerAPI.URL, PublicURL: providerAPI.URL, APIKey: "test", APISecret: "test"}, env.pool)
	if err != nil {
		t.Fatal(err)
	}
	service := voicemedia.New(env.pool, provider, nil)
	media.Plane = service
	roomID := env.createRoom(alice, acmeTenant, "Live voice", "voice-live-room")
	status, _, body := env.request(alice, http.MethodPost, "/v0/rooms/"+roomID+"/voice-sessions", map[string]any{"purpose": "chat_live"}, "voice-live-ineligible")
	if status != http.StatusConflict || !strings.Contains(string(body), "LIVE_UNAVAILABLE") {
		t.Fatalf("live without reply Agent=%d %s", status, body)
	}
	if _, err := env.pool.Exec(t.Context(), `UPDATE agent_registrations SET agent_type='anotherme',receives_all_messages=true,represented_human_actor_id='actor_acme_alice' WHERE actor_id='actor_acme_official'`); err != nil {
		t.Fatal(err)
	}
	if code, body := putRoomMember(t, env, alice, roomID, "actor_acme_official", "member"); code != http.StatusOK {
		t.Fatalf("add AnotherMe=%d %s", code, body)
	}
	status, _, body = env.request(alice, http.MethodGet, "/v0/tenants/"+acmeTenant+"/voice-media-policy", nil, "")
	var policy httpapi.VoiceMediaPolicy
	decode(t, body, &policy)
	if status != http.StatusOK || policy.LiveSupported == nil || !*policy.LiveSupported {
		t.Fatalf("live capability=%d %s", status, body)
	}
	status, _, body = env.request(alice, http.MethodPost, "/v0/rooms/"+roomID+"/voice-sessions", map[string]any{"purpose": "chat_live"}, "voice-live-session")
	var voice httpapi.VoiceSession
	decode(t, body, &voice)
	if status != http.StatusCreated || voice.Purpose != httpapi.ChatLive {
		t.Fatalf("create live=%d %s", status, body)
	}
	return env, alice, roomID, voice.Id
}

func voiceRuntimeCall(t *testing.T, env *testEnv, method, path string, payload any, want int) []byte {
	t.Helper()
	var reader io.Reader
	if payload != nil {
		encoded, _ := json.Marshal(payload)
		reader = bytes.NewReader(encoded)
	}
	request, err := http.NewRequestWithContext(t.Context(), method, env.server.URL+path, reader)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer "+voiceLiveRuntimeToken)
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(response.Body)
	_ = response.Body.Close()
	if response.StatusCode != want {
		t.Fatalf("%s %s=%d want %d: %s", method, path, response.StatusCode, want, body)
	}
	return body
}

func TestVoiceLiveTurnsAreWithheldFromAgentsAndRepliesSavedOnce(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice, roomID, sessionID := newVoiceLiveRoom(t)
	messagesPath := "/v0/rooms/" + roomID + "/messages"
	turn := func(turnID string) map[string]any {
		return map[string]any{
			"raw_message": "@official what is on today",
			"segments": []map[string]any{
				{"type": "reference", "content": "@official", "target": "actor_acme_official", "target_type": "agent"},
				{"type": "text", "content": " what is on today"},
			},
			"voice_live_turn": map[string]any{"voice_session_id": sessionID, "turn_id": turnID},
		}
	}
	key := "voice-live:" + sessionID + ":lt_1"
	status, _, body := env.request(alice, http.MethodPost, messagesPath, turn("lt_1"), key)
	var human httpapi.Message
	decode(t, body, &human)
	if status != http.StatusCreated {
		t.Fatalf("live turn=%d %s", status, body)
	}
	if status, headers, _ := env.request(alice, http.MethodPost, messagesPath, turn("lt_1"), key); status != http.StatusCreated || headers.Get("Idempotent-Replay") != "true" {
		t.Fatalf("live turn retry=%d", status)
	}
	if countRows(t, env, `SELECT count(*) FROM voice_live_turns WHERE voice_session_id=$1 AND turn_id='lt_1' AND human_message_id=$2`, sessionID, human.Id) != 1 ||
		countRows(t, env, `SELECT count(*) FROM room_agent_message_cancellations WHERE message_id=$1 AND agent_actor_id='actor_acme_official'`, human.Id) != 1 {
		t.Fatal("live turn was not recorded once and withheld from Room Agents")
	}
	for _, rejected := range []struct {
		client *http.Client
		turn   map[string]any
		key    string
		status int
	}{
		{alice, turn("lt_1"), "voice-live-other-key", http.StatusConflict},
		{alice, map[string]any{"raw_message": "x", "segments": []map[string]any{{"type": "text", "content": "x"}}, "voice_live_turn": map[string]any{"voice_session_id": "voice_session_missing", "turn_id": "lt_2"}}, "voice-live-missing", http.StatusConflict},
	} {
		if status, _, body := env.request(rejected.client, http.MethodPost, messagesPath, rejected.turn, rejected.key); status != rejected.status {
			t.Fatalf("invalid live marker=%d want %d %s", status, rejected.status, body)
		}
	}
	reply := func(eventID, turnID string, want int) teamhubinternal.VoiceLiveReplyReceipt {
		var receipt teamhubinternal.VoiceLiveReplyReceipt
		body := voiceRuntimeCall(t, env, http.MethodPost, "/internal/v1/voice/live-replies", map[string]any{
			"event_id": eventID, "voice_session_id": sessionID, "turn_id": turnID, "text": "There is a review at 3 pm.",
		}, want)
		if want == http.StatusAccepted {
			decode(t, body, &receipt)
		}
		return receipt
	}
	reply("reply-early", "lt_2", http.StatusConflict)
	first := reply("reply-1", "lt_1", http.StatusAccepted)
	again := reply("reply-1", "lt_1", http.StatusAccepted)
	if first.Status != teamhubinternal.VoiceLiveReplyReceiptStatusAccepted || again.Status != teamhubinternal.VoiceLiveReplyReceiptStatusReplayed ||
		first.MessageId == nil || again.MessageId == nil || *first.MessageId != *again.MessageId {
		t.Fatalf("reply receipts first=%+v again=%+v", first, again)
	}
	if countRows(t, env, `SELECT count(*) FROM messages WHERE room_id=$1 AND author_actor_id='actor_acme_official' AND message_kind='conversation'`, roomID) != 1 ||
		countRows(t, env, `SELECT count(*) FROM room_events WHERE resource_id=$1 AND event_type='message.created'`, *first.MessageId) != 1 ||
		countRows(t, env, `SELECT count(*) FROM room_agent_message_cancellations WHERE message_id=$1`, *first.MessageId) != 1 {
		t.Fatal("live reply was not saved exactly once as a withheld Agent Message")
	}
	// A sentence read after the live reply, such as a question to confirm, is
	// the same turn's next reply.
	if next := reply("reply-1:announce", "lt_1", http.StatusAccepted); next.MessageId == nil || *next.MessageId == *first.MessageId ||
		countRows(t, env, `SELECT count(*) FROM voice_live_replies WHERE turn_id='lt_1'`) != 2 {
		t.Fatalf("second reply of a turn=%+v", next)
	}
	var live teamhubinternal.VoiceLiveContext
	decode(t, voiceRuntimeCall(t, env, http.MethodGet, "/internal/v1/voice/sessions/"+sessionID+"/live-context", nil, http.StatusOK), &live)
	if live.RoomId != roomID || live.AgentName == "" || !strings.Contains(live.Instructions, live.AgentName) || len(live.Tools) == 0 ||
		len(live.History) != 3 || live.History[0].Role != teamhubinternal.VoiceLiveContextMessageRoleUser || !strings.Contains(live.History[1].Text, "There is a review at 3 pm.") {
		t.Fatalf("live context=%+v", live)
	}
	// Work the live model starts runs as its own delegated Task; the turn
	// itself stays the Human's words, withheld from Room Agents.
	tool := func(turnID, callID, name string, arguments map[string]any) map[string]any {
		encoded, _ := json.Marshal(arguments)
		var result teamhubinternal.VoiceLiveToolResult
		decode(t, voiceRuntimeCall(t, env, http.MethodPost, "/internal/v1/voice/live-tool-calls", map[string]any{
			"voice_session_id": sessionID, "turn_id": turnID, "call_id": callID, "name": name, "arguments": string(encoded),
		}, http.StatusOK), &result)
		var output map[string]any
		decode(t, []byte(result.Output), &output)
		return output
	}
	if started := tool("lt_5", "call_start", "start_task", map[string]any{"goal": "Compile the schedule for today and post it to the group", "surface": "workspace"}); started["status"] != "started" || started["task_id"] != "t1" {
		t.Fatalf("start_task=%v", started)
	}
	if second := tool("lt_5", "call_second", "start_task", map[string]any{"goal": "Look up the materials for the afternoon review", "surface": "workspace"}); second["task_id"] != "t2" {
		t.Fatalf("second start_task=%v", second)
	}
	if _, err := env.pool.Exec(t.Context(), `UPDATE local_computers SET status='offline' WHERE computer_id=(SELECT computer_id FROM agent_registrations WHERE actor_id='actor_acme_official')`); err != nil {
		t.Fatal(err)
	}
	if blocked := tool("lt_5", "call_desktop", "start_task", map[string]any{"goal": "Read WeChat", "surface": "desktop"}); blocked["error"] != "computer_offline" {
		t.Fatalf("desktop work without the user's computer=%v", blocked)
	}
	if countRows(t, env, `SELECT count(*) FROM voice_live_tasks task JOIN work_items item ON item.id=task.work_item_id
		WHERE task.voice_session_id=$1 AND item.kind='task' AND item.task_execution_status='running'
		AND item.description LIKE 'Compile the schedule for today and post it to the group%' AND item.description NOT LIKE '%NEEDS_USER%'`, sessionID) != 1 ||
		countRows(t, env, `SELECT count(DISTINCT work_item_id) FROM voice_live_tasks WHERE voice_session_id=$1`, sessionID) != 2 {
		t.Fatal("each live task did not start its own delegated Task")
	}
	// The Room hears each task start and its indicator lists both.
	if titles := roomBackgroundTaskTitles(t, env, alice, roomID); strings.Join(titles, "|") != "Compile the schedule for today and post it to the group|Look up the materials for the afternoon review" ||
		countRows(t, env, `SELECT count(*) FROM room_events WHERE room_id=$1 AND event_type='work_item.changed'
		AND resource_id IN (SELECT work_item_id FROM voice_live_tasks WHERE voice_session_id=$2)`, roomID, sessionID) != 2 {
		t.Fatalf("background tasks of the call's Room=%v", titles)
	}
	status, _, body = env.request(alice, http.MethodPost, messagesPath, turn("lt_5"), "voice-live:"+sessionID+":lt_5")
	var saved httpapi.Message
	decode(t, body, &saved)
	if status != http.StatusCreated ||
		countRows(t, env, `SELECT count(*) FROM room_agent_message_cancellations WHERE message_id=$1`, saved.Id) != 1 {
		t.Fatalf("a turn that started tasks must stay withheld from Room Agents: %d %s", status, body)
	}
	if replied := tool("lt_6", "call_reply", "reply_to_task", map[string]any{"task_id": "t1", "details": "Only tomorrow's"}); replied["status"] != "passed_on" {
		t.Fatalf("reply_to_task=%v", replied)
	}
	if missing := tool("lt_6", "call_missing", "reply_to_task", map[string]any{"task_id": "t9", "details": "x"}); missing["error"] != "task_not_found" {
		t.Fatalf("reply to a missing task=%v", missing)
	}
	var tasks teamhubinternal.VoiceLiveTaskList
	decode(t, voiceRuntimeCall(t, env, http.MethodGet, "/internal/v1/voice/sessions/"+sessionID+"/live-tasks", nil, http.StatusOK), &tasks)
	if len(tasks.Tasks) != 2 || tasks.Tasks[0].TaskId != "t1" || tasks.Tasks[0].State != teamhubinternal.VoiceLiveTaskStateWorking ||
		tasks.Tasks[1].Goal != "Look up the materials for the afternoon review" {
		t.Fatalf("live tasks=%+v", tasks)
	}
	if canceled := tool("lt_6", "call_cancel", "cancel_task", map[string]any{"task_id": "t2"}); canceled["status"] != "canceled" {
		t.Fatalf("cancel_task=%v", canceled)
	}
	decode(t, voiceRuntimeCall(t, env, http.MethodGet, "/internal/v1/voice/sessions/"+sessionID+"/live-tasks", nil, http.StatusOK), &tasks)
	if tasks.Tasks[1].State != teamhubinternal.VoiceLiveTaskStateCanceled || tasks.Tasks[0].State != teamhubinternal.VoiceLiveTaskStateWorking {
		t.Fatalf("canceling one task must leave the other running: %+v", tasks.Tasks)
	}
	// An app event worth telling now that waits for the call to end is told
	// during the call only while its app grant is still valid. Both stale
	// records below lack a grant and must not leak event contents.
	for _, wake := range []struct{ id, source, body string }{
		{"pwake_notify", "event", reminder.Prompt(reminder.EventData, nil) + "\nsource: slack\n<event>\nLisa asks about the quote\n</event>"},
		{"pwake_track", "event", reminder.Prompt(reminder.EventTrackOnly, nil) + "\nsource: slack\n<event>\nSmall talk in the group\n</event>"},
	} {
		if _, err := env.pool.Exec(t.Context(), `INSERT INTO proactive_pending_wakes(id,tenant_id,room_id,author_actor_id,agent_actor_id,body,source,connection_grant)
			VALUES($1,'tenant_acme',$2,'actor_acme_alice','actor_acme_official',$3,$4,'null')`, wake.id, roomID, wake.body, wake.source); err != nil {
			t.Fatal(err)
		}
	}
	decode(t, voiceRuntimeCall(t, env, http.MethodGet, "/internal/v1/voice/sessions/"+sessionID+"/live-tasks", nil, http.StatusOK), &tasks)
	if tasks.Alerts != nil && len(*tasks.Alerts) != 0 {
		t.Fatalf("live alerts=%+v", tasks.Alerts)
	}
	reply("reply-5", "lt_5", http.StatusAccepted)
	// The answer still playing when the Human exits is saved shortly after.
	for _, turnID := range []string{"lt_3", "lt_4"} {
		if status, _, body := env.request(alice, http.MethodPost, messagesPath, turn(turnID), "voice-live:"+sessionID+":"+turnID); status != http.StatusCreated {
			t.Fatalf("live turn %s=%d %s", turnID, status, body)
		}
	}
	if status, _, body := env.request(alice, http.MethodDelete, "/v0/voice-sessions/"+sessionID, nil, "voice-live-close"); status != http.StatusOK {
		t.Fatalf("close=%d %s", status, body)
	}
	reply("reply-3", "lt_3", http.StatusAccepted)
	if _, err := env.pool.Exec(t.Context(), `UPDATE voice_sessions SET closed_at=now()-interval '2 minutes' WHERE id=$1`, sessionID); err != nil {
		t.Fatal(err)
	}
	reply("reply-4", "lt_4", http.StatusNotFound)
}

func TestVoiceLiveToolCallsReplayByCallIDAndStopAfterMembershipRevocation(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, _, roomID, sessionID := newVoiceLiveRoom(t)
	// The user hears a confirmation prompt in one turn and says yes in a later one.
	toolTurn := func(callID string) string {
		switch callID {
		case "call-0", "call-1":
			return "lt_prompt"
		case "call-6", "call-7", "call-8", "call-9":
			return "lt_" + callID
		}
		return "lt_tool"
	}
	call := func(callID, name, arguments string, want int) string {
		var result teamhubinternal.VoiceLiveToolResult
		body := voiceRuntimeCall(t, env, http.MethodPost, "/internal/v1/voice/live-tool-calls", map[string]any{
			"voice_session_id": sessionID, "turn_id": toolTurn(callID), "call_id": callID, "name": name, "arguments": arguments,
		}, want)
		if want != http.StatusOK {
			return ""
		}
		decode(t, body, &result)
		if result.CallId != callID {
			t.Fatalf("tool result call ID=%s", result.CallId)
		}
		return result.Output
	}
	humanMessages := func() int {
		return countRows(t, env, `SELECT count(*) FROM messages WHERE room_id=$1 AND author_actor_id='actor_acme_alice'`, roomID)
	}
	before := humanMessages()
	// A send confirmed before the user heard the prompt naming its Room is not sent.
	if output := call("call-0", "send_message", `{"text":"Meeting moved to four","confirmed":true}`, http.StatusOK); !strings.Contains(output, "needs_confirmation") ||
		!strings.Contains(output, "in \u201cLive voice\u201d") || humanMessages() != before {
		t.Fatalf("unprompted confirmed send=%s", output)
	}
	if output := call("call-1", "send_message", `{"text":"Meeting moved to four"}`, http.StatusOK); !strings.Contains(output, "needs_confirmation") || humanMessages() != before {
		t.Fatalf("unconfirmed send=%s", output)
	}
	sent := call("call-2", "send_message", `{"text":"Meeting moved to four","confirmed":true}`, http.StatusOK)
	if !strings.Contains(sent, `"status":"sent"`) || call("call-2", "send_message", `{"text":"Meeting moved to four","confirmed":true}`, http.StatusOK) != sent ||
		!strings.Contains(call("call-3", "send_message", `{"confirmed":true,"text":"Meeting moved to four"}`, http.StatusOK), `"status":"sent"`) || humanMessages() != before+1 {
		t.Fatalf("confirmed send was not executed exactly once: %s", sent)
	}
	if output := call("call-4", "search_messages", `{"query":"four"}`, http.StatusOK); !strings.Contains(output, "Meeting moved to four") {
		t.Fatalf("search=%s", output)
	}
	// A confirmation is used once: another yes in a later turn is asked again.
	if output := call("call-6", "send_message", `{"text":"Meeting moved to four","confirmed":true}`, http.StatusOK); !strings.Contains(output, "needs_confirmation") || humanMessages() != before+1 {
		t.Fatalf("reused confirmation=%s", output)
	}
	// A yes long after the question does not count.
	call("call-7", "send_message", `{"text":"Meeting moved to five"}`, http.StatusOK)
	if _, err := env.pool.Exec(t.Context(), `UPDATE voice_live_confirmations SET created_at=now()-interval '11 minutes' WHERE voice_session_id=$1 AND used_at IS NULL`, sessionID); err != nil {
		t.Fatal(err)
	}
	if output := call("call-8", "send_message", `{"text":"Meeting moved to five","confirmed":true}`, http.StatusOK); !strings.Contains(output, "needs_confirmation") || humanMessages() != before+1 {
		t.Fatalf("stale confirmation=%s", output)
	}
	if output := call("call-9", "send_message", `{"text":"Meeting moved to five","confirmed":true}`, http.StatusOK); !strings.Contains(output, `"status":"sent"`) || humanMessages() != before+2 {
		t.Fatalf("fresh confirmation=%s", output)
	}
	if output := call("call-5", "open_safe", `{}`, http.StatusOK); output != `{"error":"unknown_tool"}` {
		t.Fatalf("unknown tool=%s", output)
	}
	if countRows(t, env, `SELECT count(*) FROM voice_live_tool_calls WHERE voice_session_id=$1`, sessionID) != 10 {
		t.Fatal("tool calls were not stored once per call ID")
	}
	if _, err := env.pool.Exec(t.Context(), `DELETE FROM room_members WHERE room_id=$1 AND actor_id='actor_acme_alice'`, roomID); err != nil {
		t.Fatal(err)
	}
	call("call-6", "search_messages", `{"query":"four"}`, http.StatusNotFound)
	voiceRuntimeCall(t, env, http.MethodGet, "/internal/v1/voice/sessions/"+sessionID+"/live-context", nil, http.StatusNotFound)
	voiceRuntimeCall(t, env, http.MethodPost, "/internal/v1/voice/live-replies", map[string]any{
		"event_id": "reply-revoked", "voice_session_id": sessionID, "turn_id": "lt_tool", "text": "Sure",
	}, http.StatusNotFound)
}

func TestVoiceLiveCreateRoomRunsAsTheHumanAfterConfirmation(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, _, _, sessionID := newVoiceLiveRoom(t)
	// The spoken member is a second Human.
	seedPeerHumanActor(t, env.pool)
	call := func(callID, turnID, arguments string) string {
		var result teamhubinternal.VoiceLiveToolResult
		body := voiceRuntimeCall(t, env, http.MethodPost, "/internal/v1/voice/live-tool-calls", map[string]any{
			"voice_session_id": sessionID, "turn_id": turnID, "call_id": callID, "name": "create_room", "arguments": arguments,
		}, http.StatusOK)
		decode(t, body, &result)
		return result.Output
	}
	rooms := func() int {
		return countRows(t, env, `SELECT count(*) FROM rooms WHERE name='Room made by voice'`)
	}
	if output := call("room-1", "lt_room_ask", `{"name":"Room made by voice","members":["bob"]}`); !strings.Contains(output, "needs_confirmation") ||
		!strings.Contains(output, "bob") || rooms() != 0 {
		t.Fatalf("unconfirmed create=%s rooms=%d", output, rooms())
	}
	if output := call("room-2", "lt_room", `{"name":"Room made by voice","members":["Nobody by that name"],"confirmed":true}`); !strings.Contains(output, "member_not_found") || rooms() != 0 {
		t.Fatalf("unknown member=%s", output)
	}
	created := call("room-3", "lt_room", `{"name":"Room made by voice","members":["bob"],"confirmed":true}`)
	var result struct {
		Status, RoomID, Room string
	}
	if err := json.Unmarshal([]byte(created), &struct {
		Status *string `json:"status"`
		RoomID *string `json:"room_id"`
		Room   *string `json:"room"`
	}{&result.Status, &result.RoomID, &result.Room}); err != nil || result.Status != "created" || result.Room != "Room made by voice" || result.RoomID == "" {
		t.Fatalf("confirmed create=%s", created)
	}
	// A retried confirmation in the same turn is the same Room.
	if again := call("room-4", "lt_room", `{"name":"Room made by voice","members":["bob"],"confirmed":true}`); !strings.Contains(again, result.RoomID) || rooms() != 1 {
		t.Fatalf("retried create=%s rooms=%d", again, rooms())
	}
	if countRows(t, env, `SELECT count(*) FROM active_room_members WHERE room_id=$1 AND actor_id IN ('actor_acme_alice','actor_acme_bob')`, result.RoomID) != 2 {
		t.Fatal("creator and spoken member were not both admitted")
	}
	call("room-5a", "lt_room_ask_again", `{"name":"Room made by voice"}`)
	if output := call("room-5", "lt_room_again", `{"name":"Room made by voice","confirmed":true}`); !strings.Contains(output, "room_name_taken") || rooms() != 1 {
		t.Fatalf("duplicate name=%s", output)
	}
}

func TestVoiceLiveDeletesOnlyAPastPocketNoteAfterConfirmation(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, _, _, sessionID := newVoiceLiveRoom(t)
	if _, err := env.pool.Exec(t.Context(), `INSERT INTO pocket_notes(tenant_id,owner_actor_id,note_date,body) VALUES('tenant_acme','actor_acme_alice','2026-01-01','Buy milk')`); err != nil {
		t.Fatal(err)
	}
	call := func(callID, arguments string) string {
		var result teamhubinternal.VoiceLiveToolResult
		body := voiceRuntimeCall(t, env, http.MethodPost, "/internal/v1/voice/live-tool-calls", map[string]any{
			"voice_session_id": sessionID, "turn_id": "lt_delete_" + callID, "call_id": callID, "name": "delete_pocket_note", "arguments": arguments,
		}, http.StatusOK)
		decode(t, body, &result)
		return result.Output
	}
	hidden := func() int {
		return countRows(t, env, `SELECT count(*) FROM pocket_notes WHERE owner_actor_id='actor_acme_alice' AND note_date='2026-01-01' AND hidden_at IS NOT NULL`)
	}
	if output := call("note-1", `{"date":"2026-01-01"}`); !strings.Contains(output, "needs_confirmation") || !strings.Contains(output, "Buy milk") || hidden() != 0 {
		t.Fatalf("unconfirmed delete=%s hidden=%d", output, hidden())
	}
	if output := call("note-2", `{"date":"2026-01-02","confirmed":true}`); !strings.Contains(output, "not_found") {
		t.Fatalf("missing day=%s", output)
	}
	if output := call("note-3", `{"date":"2999-01-01","confirmed":true}`); !strings.Contains(output, "today_not_deletable") {
		t.Fatalf("future day=%s", output)
	}
	if output := call("note-4", `{"date":"2026-01-01","confirmed":true}`); !strings.Contains(output, `"deleted"`) || hidden() != 1 {
		t.Fatalf("confirmed delete=%s hidden=%d", output, hidden())
	}
	// A deleted day reads as missing.
	if output := call("note-5", `{"date":"2026-01-01","confirmed":true}`); !strings.Contains(output, "not_found") {
		t.Fatalf("deleted day=%s", output)
	}
}

// A Task the Room's Meta delegated runs outside Room Runs, yet every scope of
// list_tasks lists it while it is still going.
func TestVoiceLiveProgressListsTheRoomsBackgroundTasks(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, _, roomID, sessionID := newVoiceLiveRoom(t)
	call := func(callID, arguments string) string {
		var result teamhubinternal.VoiceLiveToolResult
		decode(t, voiceRuntimeCall(t, env, http.MethodPost, "/internal/v1/voice/live-tool-calls", map[string]any{
			"voice_session_id": sessionID, "turn_id": "lt_tasks", "call_id": callID, "name": "list_tasks", "arguments": arguments,
		}, http.StatusOK), &result)
		return result.Output
	}
	if none := call("tasks-none", `{"scope":"room"}`); !strings.Contains(none, `"background_tasks":[]`) {
		t.Fatalf("no background Task=%s", none)
	}
	createFixtureDelegatedTask(t, env, roomID, "voice-live")
	for _, scope := range []struct{ callID, arguments string }{{"tasks-mine", `{}`}, {"tasks-room", `{"scope":"room"}`}} {
		output := call(scope.callID, scope.arguments)
		if !strings.Contains(output, `"background_tasks":[{`) || !strings.Contains(output, "Acceptance file release voice-live") ||
			!strings.Contains(output, `"state":"running"`) || !strings.Contains(output, `"running_for":`) {
			t.Fatalf("%s background Tasks=%s", scope.arguments, output)
		}
	}
}

func TestVoiceLiveProgressAndTodayRecallReadOnlyWhatTheHumanCanSee(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice, roomID, sessionID := newVoiceLiveRoom(t)
	post := func(key string, payload map[string]any) {
		if status, _, body := env.request(alice, http.MethodPost, "/v0/rooms/"+roomID+"/messages", payload, key); status != http.StatusCreated {
			t.Fatalf("message=%d %s", status, body)
		}
	}
	// A turn the live model answers itself is withheld from Agents and is not a request.
	post("voice-progress-chat", map[string]any{
		"raw_message": "Feeling good today", "segments": []map[string]any{{"type": "text", "content": "Feeling good today"}},
		"voice_live_turn": map[string]any{"voice_session_id": sessionID, "turn_id": "lt_chat"},
	})
	post("voice-progress-handoff", map[string]any{
		"raw_message": "@official write an email to Lulu",
		"segments": []map[string]any{
			{"type": "reference", "content": "@official", "target": "actor_acme_official", "target_type": "agent"},
			{"type": "text", "content": " write an email to Lulu"},
		},
	})
	ensured, err := agentruntimestate.New(env.pool).EnsureContext(t.Context(), agentruntimestate.EnsureContextInput{
		TargetResidency: "active",
		Ref:             agentruntimestate.ContextRef{Kind: "meta", AgentID: acmeOfficialAgentManagementID, RoomID: roomID},
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, statement := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO agent_local_runs(run_id,context_key,status,started_at,status_room_id)
			VALUES('run-voice-progress',$1,'running',clock_timestamp(),$2)`, []any{ensured.Context.ContextKey, roomID}},
		{`INSERT INTO agent_runtime_status_events(local_run_id,event_ordinal,segment_id,command_id,event_type,payload)
			VALUES('run-voice-progress',1,'segment-voice-progress','voice-progress-1','status.changed','{"type":"status.changed","status":"working"}'),
			      ('run-voice-progress',2,'segment-voice-progress','voice-progress-2','status.changed','{"type":"status.changed","status":"thinking","title":"Verifying the email address of Lulu"}')`, nil},
	} {
		if _, err := env.pool.Exec(t.Context(), statement.sql, statement.args...); err != nil {
			t.Fatal(err)
		}
	}
	call := func(callID, arguments string) string {
		var result teamhubinternal.VoiceLiveToolResult
		decode(t, voiceRuntimeCall(t, env, http.MethodPost, "/internal/v1/voice/live-tool-calls", map[string]any{
			"voice_session_id": sessionID, "turn_id": "lt_progress", "call_id": callID, "name": "list_tasks", "arguments": arguments,
		}, http.StatusOK), &result)
		return result.Output
	}
	// Only work started with start_task is a task of this call; typed messages are not.
	if mine := call("progress-mine", `{}`); !strings.Contains(mine, `"tasks":[]`) || strings.Contains(mine, "Feeling good") {
		t.Fatalf("my tasks=%s", mine)
	}
	if room := call("progress-room", `{"scope":"room"}`); !strings.Contains(room, `"working_agents":[{`) || !strings.Contains(room, "Verifying the email address of Lulu") ||
		!strings.Contains(room, `"now":"thinking"`) {
		t.Fatalf("room=%s", room)
	}
	if invalid := call("progress-invalid", `{"scope":"everything"}`); invalid != `{"error":"invalid_arguments"}` {
		t.Fatalf("invalid scope=%s", invalid)
	}
	// Another Room is reported to its members only.
	travel := env.createRoom(alice, acmeTenant, "Travel plan", "voice-progress-travel")
	if other := call("progress-other", `{"room_id":"`+travel+`"}`); other != `{"background_tasks":[],"recent_finished":[],"working_agents":[]}` {
		t.Fatalf("other Room=%s", other)
	}
	if denied := call("progress-foreign", `{"room_id":"room_missing"}`); denied != `{"error":"room_not_found"}` {
		t.Fatalf("foreign Room=%s", denied)
	}
	// Today's Messages are read directly, even when Memory is unavailable.
	// The live model dates a question about today.
	today := time.Now().In(time.Local).Format("2006-01-02")
	var recall teamhubinternal.VoiceLiveToolResult
	decode(t, voiceRuntimeCall(t, env, http.MethodPost, "/internal/v1/voice/live-tool-calls", map[string]any{
		"voice_session_id": sessionID, "turn_id": "lt_today", "call_id": "recall-today", "name": "recall_memory",
		"arguments": `{"query":"Summarize what I did today","event_from":"` + today + `","event_to":"` + today + `"}`,
	}, http.StatusOK), &recall)
	if !strings.Contains(recall.Output, `"today":{`) || !strings.Contains(recall.Output, "write an email to Lulu") {
		t.Fatalf("today recall=%s", recall.Output)
	}
	// read_document reads the Document shared last in the Room, and only one the Human can read.
	read := func(callID, arguments string) string {
		var result teamhubinternal.VoiceLiveToolResult
		decode(t, voiceRuntimeCall(t, env, http.MethodPost, "/internal/v1/voice/live-tool-calls", map[string]any{
			"voice_session_id": sessionID, "turn_id": "lt_read", "call_id": callID, "name": "read_document", "arguments": arguments,
		}, http.StatusOK), &result)
		return result.Output
	}
	if none := read("read-none", `{}`); none != `{"error":"document_not_found"}` {
		t.Fatalf("no shared Document=%s", none)
	}
	draft := uploadSearchDocument(t, env, alice, "voice-read-draft", "lulu-draft.txt")
	if _, err := env.pool.Exec(t.Context(), `INSERT INTO document_texts(document_id,tenant_id,source_kind,source_id,status,markdown,markdown_sha256,search_text)
		SELECT id,tenant_id,'file_version',current_version_id,'ready','Hi Lulu, come over next week',repeat('e',64),'Hi Lulu, come over next week' FROM documents WHERE id=$1
		ON CONFLICT (document_id) DO UPDATE SET source_kind=excluded.source_kind,source_id=excluded.source_id,
		  status='ready',markdown=excluded.markdown,markdown_sha256=excluded.markdown_sha256,search_text=excluded.search_text`, draft); err != nil {
		t.Fatal(err)
	}
	post("voice-read-share", map[string]any{
		"raw_message": "lulu-draft.txt",
		"segments":    []map[string]any{{"type": "document", "document_id": draft, "content": "lulu-draft.txt", "presentation": "card"}},
	})
	if latest := read("read-latest", `{}`); !strings.Contains(latest, "Hi Lulu, come over next week") || !strings.Contains(latest, `"truncated":false`) ||
		strings.Contains(latest, `"images"`) {
		t.Fatalf("latest Document=%s", latest)
	}
	// A file in the chat, such as a report a task delivered, is read too.
	report := uploadSearchDocument(t, env, alice, "voice-read-report", "report.md")
	if _, err := env.pool.Exec(t.Context(), `INSERT INTO document_texts(document_id,tenant_id,source_kind,source_id,status,markdown,markdown_sha256,search_text)
		SELECT id,tenant_id,'file_version',current_version_id,'ready','Anthropic news brief: IPO outlook and compute',repeat('f',64),'Anthropic news brief: IPO outlook and compute' FROM documents WHERE id=$1
		ON CONFLICT (document_id) DO UPDATE SET source_kind=excluded.source_kind,source_id=excluded.source_id,
		  status='ready',markdown=excluded.markdown,markdown_sha256=excluded.markdown_sha256,search_text=excluded.search_text`, report); err != nil {
		t.Fatal(err)
	}
	var reportVersion string
	if err := env.pool.QueryRow(t.Context(), `SELECT current_version_id FROM documents WHERE id=$1`, report).Scan(&reportVersion); err != nil {
		t.Fatal(err)
	}
	post("voice-read-file", map[string]any{
		"raw_message": "report.md",
		"segments":    []map[string]any{{"type": "file", "content": "report.md", "document_id": report, "document_version_id": reportVersion}},
	})
	if file := read("read-file", `{}`); !strings.Contains(file, "Anthropic news brief") {
		t.Fatalf("chat file=%s", file)
	}
	if denied := read("read-hidden", `{"document_id":"document_missing"}`); denied != `{"error":"document_not_found"}` {
		t.Fatalf("hidden Document=%s", denied)
	}
}

func TestVoiceLiveTasksReportResultsAndWhatTheyWaitFor(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice, _, sessionID := newVoiceLiveRoom(t)
	tool := func(turnID, callID, name string, arguments map[string]any) map[string]any {
		encoded, _ := json.Marshal(arguments)
		var result teamhubinternal.VoiceLiveToolResult
		decode(t, voiceRuntimeCall(t, env, http.MethodPost, "/internal/v1/voice/live-tool-calls", map[string]any{
			"voice_session_id": sessionID, "turn_id": turnID, "call_id": callID, "name": name, "arguments": string(encoded),
		}, http.StatusOK), &result)
		var output map[string]any
		decode(t, []byte(result.Output), &output)
		return output
	}
	// Irreversible work starts only from a confirmation given in a later turn,
	// once, and does exactly what was confirmed.
	pending := tool("lt_x", "x1", "start_task", map[string]any{"goal": "Delete the old hiring document", "surface": "workspace", "irreversible": true})
	confirmationID, _ := pending["confirmation_id"].(string)
	if pending["status"] != "needs_confirmation" || confirmationID == "" ||
		countRows(t, env, `SELECT count(*) FROM voice_live_tasks WHERE voice_session_id=$1`, sessionID) != 0 {
		t.Fatalf("unconfirmed irreversible task=%v", pending)
	}
	if early := tool("lt_x", "x2", "start_task", map[string]any{"goal": "Delete the old hiring document", "surface": "workspace", "irreversible": true, "confirmation_id": confirmationID}); early["error"] != "confirmation_invalid" {
		t.Fatalf("same-turn confirmation=%v", early)
	}
	if confirmed := tool("lt_y", "y1", "start_task", map[string]any{"goal": "Delete all documents", "surface": "workspace", "irreversible": true, "confirmation_id": confirmationID}); confirmed["status"] != "started" ||
		countRows(t, env, `SELECT count(*) FROM voice_live_tasks WHERE voice_session_id=$1 AND goal='Delete the old hiring document'`, sessionID) != 1 {
		t.Fatalf("confirmed task=%v", confirmed)
	}
	if again := tool("lt_z", "z1", "start_task", map[string]any{"goal": "Delete the old hiring document", "surface": "workspace", "irreversible": true, "confirmation_id": confirmationID}); again["error"] != "confirmation_invalid" {
		t.Fatalf("reused confirmation=%v", again)
	}
	if _, err := env.pool.Exec(t.Context(), `DELETE FROM voice_live_tasks WHERE voice_session_id=$1`, sessionID); err != nil {
		t.Fatal(err)
	}
	first := tool("lt_a", "a1", "start_task", map[string]any{"goal": "Compare noise-canceling headphones on JD", "surface": "workspace"})
	// The same goal handed off again moments later is the same task.
	if repeat := tool("lt_b", "b1", "start_task", map[string]any{"goal": "Compare noise-canceling headphones on JD", "surface": "workspace"}); repeat["task_id"] != first["task_id"] {
		t.Fatalf("repeated start=%v first=%v", repeat, first)
	}
	second := tool("lt_a", "a2", "start_task", map[string]any{"goal": "Search Xiaohongshu for campsites", "surface": "workspace"})
	workItem := func(taskID any) string {
		ordinal, _ := strings.CutPrefix(taskID.(string), "t")
		var id string
		if err := env.pool.QueryRow(t.Context(), `SELECT work_item_id FROM voice_live_tasks WHERE room_id=(SELECT room_id FROM voice_sessions WHERE id=$1) AND ordinal=$2::int`, sessionID, ordinal).Scan(&id); err != nil {
			t.Fatal(err)
		}
		return id
	}
	// A Task's turn ends with its report to its coordinator: a result, or
	// what it needs from the user, as for a Meta.
	finish := func(taskID, reply string) {
		var title string
		var generation int64
		if err := env.pool.QueryRow(t.Context(), `SELECT title,task_execution_generation FROM work_items WHERE id=$1`, taskID).Scan(&title, &generation); err != nil {
			t.Fatal(err)
		}
		tx, err := env.pool.Begin(t.Context())
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(t.Context())
		body := reply
		segments, _ := json.Marshal([]map[string]string{{"type": "text", "content": body}})
		if _, err := taskexecution.AppendMetaCallback(t.Context(), store.New(tx), taskexecution.MetaCallbackAppendInput{
			TaskID: taskID, TenantID: acmeTenant, Generation: generation, AuthorActorID: "actor_acme_official",
			Body: body, Segments: segments,
		}); err != nil {
			t.Fatal(err)
		}
		if _, err := tx.Exec(t.Context(), `UPDATE work_items SET task_execution_status='idle' WHERE id=$1`, taskID); err != nil {
			t.Fatal(err)
		}
		if err := tx.Commit(t.Context()); err != nil {
			t.Fatal(err)
		}
	}
	// Voice Tasks keep their coordinator and remain visible in the owner task list.
	// They do not add an origin link or an extra task card to the call Room.
	if countRows(t, env, `SELECT count(*) FROM work_item_room_links link JOIN voice_live_tasks task ON task.work_item_id=link.work_item_id
		WHERE task.voice_session_id=$1 AND link.link_type='origin'`, sessionID) != 0 ||
		countRows(t, env, `SELECT count(*) FROM task_execution_generations generation JOIN voice_live_tasks task ON task.work_item_id=generation.task_id
		WHERE task.voice_session_id=$1 AND generation.coordinator_actor_id IS NULL`, sessionID) != 0 {
		t.Fatal("a voice Task is linked to the Room or has no coordinating Meta")
	}
	status, _, body := env.request(alice, http.MethodGet, "/v0/tenants/tenant_acme/work-items?scope=personal", nil, "")
	if status != http.StatusOK || !strings.Contains(string(body), "Compare noise-canceling headphones on JD") {
		t.Fatalf("voice Task missing from owner work items: %d %s", status, body)
	}
	finish(workItem(first["task_id"]), "Sony at 1899 is the best fit, added to the cart.")
	finish(workItem(second["task_id"]), "Xiaohongshu needs a new login: scan with the Xiaohongshu app.")
	var tasks teamhubinternal.VoiceLiveTaskList
	decode(t, voiceRuntimeCall(t, env, http.MethodGet, "/internal/v1/voice/sessions/"+sessionID+"/live-tasks", nil, http.StatusOK), &tasks)
	// The live voice reads the AlterEgo's own words and decides what the user
	// needs, as a Meta does.
	if len(tasks.Tasks) != 2 || !tasks.Tasks[0].StartedInThisCall ||
		tasks.Tasks[0].State != teamhubinternal.VoiceLiveTaskStateReported || len(tasks.Tasks[0].Replies) != 1 || tasks.Tasks[0].Replies[0].Text != "Sony at 1899 is the best fit, added to the cart." ||
		tasks.Tasks[1].State != teamhubinternal.VoiceLiveTaskStateReported || tasks.Tasks[1].Replies[0].Text != "Xiaohongshu needs a new login: scan with the Xiaohongshu app." {
		t.Fatalf("live tasks=%+v", tasks.Tasks)
	}
	waiting := workItem(second["task_id"])
	if _, err := env.pool.Exec(t.Context(), `UPDATE work_items SET task_execution_status='waiting_for_approval' WHERE id=$1`, waiting); err != nil {
		t.Fatal(err)
	}
	if _, err := env.pool.Exec(t.Context(), `UPDATE work_items SET task_execution_updated_at=now()-interval '25 hours' WHERE id=ANY($1)`,
		[]string{workItem(first["task_id"]), waiting}); err != nil {
		t.Fatal(err)
	}
	if _, err := env.pool.Exec(t.Context(), `UPDATE voice_live_tasks SET voice_session_id=NULL WHERE voice_session_id=$1`, sessionID); err != nil {
		t.Fatal(err)
	}
	// Unpublished reports survive the age cutoff and the original call.
	decode(t, voiceRuntimeCall(t, env, http.MethodGet, "/internal/v1/voice/sessions/"+sessionID+"/live-tasks", nil, http.StatusOK), &tasks)
	if len(tasks.Tasks) != 2 || tasks.Tasks[1].TaskId != second["task_id"] || tasks.Tasks[1].State != teamhubinternal.VoiceLiveTaskStateWaitingForApproval ||
		tasks.Tasks[0].StartedInThisCall || tasks.Tasks[1].StartedInThisCall {
		t.Fatalf("later call tasks=%+v", tasks.Tasks)
	}
	// Another call of the user's that started after the reports told them,
	// heard in full or cut off; the calls after it do not tell them again.
	if _, err := env.pool.Exec(t.Context(), `INSERT INTO voice_sessions SELECT (jsonb_populate_record(NULL::voice_sessions, to_jsonb(voice) ||
		jsonb_build_object('id','voice_session_told','status','closed','closed_at',clock_timestamp(),'created_at',clock_timestamp(),
		'provider_room_name','told-room','participant_identity','told-participant'))).* FROM voice_sessions voice WHERE id=$1`, sessionID); err != nil {
		t.Fatal(err)
	}
	decode(t, voiceRuntimeCall(t, env, http.MethodGet, "/internal/v1/voice/sessions/"+sessionID+"/live-tasks", nil, http.StatusOK), &tasks)
	if len(tasks.Tasks) != 1 || tasks.Tasks[0].TaskId != second["task_id"] || len(tasks.Tasks[0].Replies) != 1 || !*tasks.Tasks[0].Replies[0].Delivered {
		t.Fatalf("told reports still news: %+v", tasks.Tasks)
	}
	if _, err := env.pool.Exec(t.Context(), `DELETE FROM voice_sessions WHERE id='voice_session_told'`); err != nil {
		t.Fatal(err)
	}
	// Publication is a durable receipt, independent of the worker's tool call ID.
	var reportID string
	if err := env.pool.QueryRow(t.Context(), `SELECT id FROM task_meta_callback_messages WHERE task_id=$1 ORDER BY meta_seq DESC LIMIT 1`, workItem(first["task_id"])).Scan(&reportID); err != nil {
		t.Fatal(err)
	}
	publish := func(callID string) string {
		t.Helper()
		args, _ := json.Marshal(map[string]any{"task_id": first["task_id"], "report_id": reportID, "title": "Comparison ready", "text": "Sony at 1899 is the best fit, added to the cart.", "files": []string{}})
		var result teamhubinternal.VoiceLiveToolResult
		decode(t, voiceRuntimeCall(t, env, http.MethodPost, "/internal/v1/voice/live-tool-calls", map[string]any{"voice_session_id": sessionID, "turn_id": "lt_publish", "call_id": callID, "name": "publish_task_result", "arguments": string(args)}, http.StatusOK), &result)
		return result.Output
	}
	published := publish("publish-first")
	if !strings.Contains(published, `"status":"delivered"`) || publish("publish-again") != published {
		t.Fatalf("publication did not deduplicate: %s", published)
	}
	if countRows(t, env, `SELECT count(*) FROM voice_live_report_deliveries WHERE report_id=$1`, reportID) != 1 || countRows(t, env, `SELECT count(*) FROM task_meta_callback_messages WHERE id=$1 AND non_actionable`, reportID) != 1 {
		t.Fatal("publication receipt or callback acknowledgement missing")
	}
	decode(t, voiceRuntimeCall(t, env, http.MethodGet, "/internal/v1/voice/sessions/"+sessionID+"/live-tasks", nil, http.StatusOK), &tasks)
	if len(tasks.Tasks) != 1 || tasks.Tasks[0].TaskId != second["task_id"] {
		t.Fatalf("delivered old report still pending: %+v", tasks.Tasks)
	}
}

// In a Room shared with others, a voice task lives in the user's direct Room
// with the Agent: only that Room's Meta coordinates it after the call.
func TestVoiceLiveTasksOfASharedRoomStayPrivate(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice, roomID, sessionID := newVoiceLiveRoom(t)
	seedPeerHumanActor(t, env.pool)
	if code, body := putRoomMember(t, env, alice, roomID, "actor_acme_bob", "member"); code != http.StatusOK {
		t.Fatalf("add bob=%d %s", code, body)
	}
	encoded, _ := json.Marshal(map[string]any{"goal": "Check my expense reimbursement status", "surface": "workspace"})
	var result teamhubinternal.VoiceLiveToolResult
	decode(t, voiceRuntimeCall(t, env, http.MethodPost, "/internal/v1/voice/live-tool-calls", map[string]any{
		"voice_session_id": sessionID, "turn_id": "lt_private", "call_id": "private-1", "name": "start_task", "arguments": string(encoded),
	}, http.StatusOK), &result)
	if !strings.Contains(result.Output, `"started"`) {
		t.Fatalf("start=%s", result.Output)
	}
	var taskID, homeRoomID string
	if err := env.pool.QueryRow(t.Context(), `SELECT work_item_id,home_room_id FROM voice_live_tasks WHERE voice_session_id=$1`, sessionID).Scan(&taskID, &homeRoomID); err != nil {
		t.Fatal(err)
	}
	if homeRoomID == roomID || countRows(t, env, `SELECT count(*) FROM active_room_members member JOIN actors actor ON actor.id=member.actor_id
		WHERE member.room_id=$1 AND (actor.kind='human' AND member.actor_id<>'actor_acme_alice' OR member.actor_id='actor_acme_bob')`, homeRoomID) != 0 {
		t.Fatalf("home Room %s of a shared call Room %s is not private", homeRoomID, roomID)
	}
	queries := store.New(env.pool)
	coordinated := func(room string) int {
		rows, err := queries.ListDelegatedTasksForCoordinator(t.Context(), store.ListDelegatedTasksForCoordinatorParams{
			AgentActorID: "actor_acme_official", OriginRoomID: room, TenantID: acmeTenant,
		})
		if err != nil {
			t.Fatal(err)
		}
		return len(rows)
	}
	if coordinated(roomID) != 0 || coordinated(homeRoomID) != 1 {
		t.Fatalf("coordinated from shared Room=%d, from direct Room=%d", coordinated(roomID), coordinated(homeRoomID))
	}
	if shared, home := roomBackgroundTaskTitles(t, env, alice, roomID), roomBackgroundTaskTitles(t, env, alice, homeRoomID); len(shared) != 0 || len(home) != 1 {
		t.Fatalf("background tasks of the shared Room=%v, of the direct Room=%v", shared, home)
	}
}

// roomBackgroundTaskTitles reads the Room's indicator of running Tasks.
func roomBackgroundTaskTitles(t *testing.T, env *testEnv, client *http.Client, roomID string) []string {
	t.Helper()
	code, _, body := env.request(client, http.MethodGet, "/v0/rooms/"+roomID+"/background-tasks", nil, "")
	var list struct {
		Items []struct{ Title string } `json:"items"`
	}
	if code != http.StatusOK || json.Unmarshal(body, &list) != nil {
		t.Fatalf("background tasks=%d %s", code, body)
	}
	titles := []string{}
	for _, item := range list.Items {
		titles = append(titles, item.Title)
	}
	return titles
}

// A live call hears the moment one of its Room's voice tasks changes.
func TestVoiceLiveTaskChangesAreHintedAtOnce(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, _, _, sessionID := newVoiceLiveRoom(t)
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, env.server.URL+"/internal/v1/voice/sessions/"+sessionID+"/live-task-events", nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Authorization", "Bearer "+voiceLiveRuntimeToken)
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK || !strings.HasPrefix(response.Header.Get("Content-Type"), "text/event-stream") {
		t.Fatalf("stream=%d %s", response.StatusCode, response.Header.Get("Content-Type"))
	}
	lines := bufio.NewScanner(response.Body)
	if !lines.Scan() || lines.Text() != ": connected" {
		t.Fatalf("first line=%q", lines.Text())
	}
	encoded, _ := json.Marshal(map[string]any{"goal": "Check the reimbursement status", "surface": "workspace"})
	voiceRuntimeCall(t, env, http.MethodPost, "/internal/v1/voice/live-tool-calls", map[string]any{
		"voice_session_id": sessionID, "turn_id": "lt_hint", "call_id": "hint-1", "name": "start_task", "arguments": string(encoded),
	}, http.StatusOK)
	encoded, _ = json.Marshal(map[string]any{"task_id": "t1"})
	voiceRuntimeCall(t, env, http.MethodPost, "/internal/v1/voice/live-tool-calls", map[string]any{
		"voice_session_id": sessionID, "turn_id": "lt_hint", "call_id": "hint-2", "name": "cancel_task", "arguments": string(encoded),
	}, http.StatusOK)
	for lines.Scan() {
		if lines.Text() == "event: changed" {
			return
		}
	}
	t.Fatalf("no change hint: %v", lines.Err())
}
