package integration_test

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"slices"
	"testing"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentmessages"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

func TestAgentMessageHistoryPreservesContextReferenceOrder(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, _, credential, roomID := newAgentCLIIdentity(t)
	// Human-selected positions are opposite both lexical ID order and the
	// history query's newest-first order. Neither may reorder the references.
	first, second, target := "history_context_z", "history_context_a", "history_context_target"
	insertHistoryFixture(t, env, roomID, first, "conversation", "First selected context")
	insertHistoryFixture(t, env, roomID, second, "conversation", "Second selected context")
	insertHistoryFixture(t, env, roomID, target, "conversation", "Request with ordered context")
	if _, err := env.pool.Exec(t.Context(), `
		UPDATE messages SET created_at=CASE id WHEN $1 THEN '2026-01-01T00:00:00Z'::timestamptz
			ELSE '2026-01-02T00:00:00Z'::timestamptz END WHERE id IN ($1,$2);
	`, first, second); err != nil {
		t.Fatal(err)
	}
	if _, err := env.pool.Exec(t.Context(), `UPDATE messages SET context_message_ids=ARRAY[$2::text,$3::text]
		WHERE id=$1 AND tenant_id=$4 AND room_id=$5`, target, first, second, acmeTenant, roomID); err != nil {
		t.Fatal(err)
	}
	beforeCursors := historyCursorSnapshot(t, env)
	// One HTTP request resolves a batch in caller order, including every direct
	// reference, while hiding why a requested identity is unavailable.
	code, _, body := taskWorkerJSONRequest(t, env, http.MethodPost, "/api/agent/v1/messages/read", credential.AccessToken, map[string]any{"message_ids": []string{target, "history_missing", second}})
	var batch agentmessages.ReadResult
	decode(t, body, &batch)
	if code != http.StatusOK || batch.Mode != "messages" || batch.Messages == nil || len(*batch.Messages) != 2 || (*batch.Messages)[0].MessageID != target || (*batch.Messages)[1].MessageID != second || batch.UnavailableMessageIDs == nil || !slices.Equal(*batch.UnavailableMessageIDs, []string{"history_missing"}) {
		t.Fatalf("batch order or coverage: %d %s", code, body)
	}
	expected := []string{first, second}
	if ids := (*batch.Messages)[0].ContextMessageIDs; !slices.Equal(ids, expected) {
		t.Errorf("context IDs reordered: got %v want %v", ids, expected)
	}
	if contexts := (*batch.Messages)[0].ContextMessages; len(contexts) != 2 || contexts[0].MessageID != first || contexts[1].MessageID != second {
		t.Fatalf("batch direct context order: %d %s", code, body)
	}
	for _, request := range []map[string]any{{"message_ids": []string{"history_missing"}}, {"message_ids": []string{"history_missing", "history_also_missing"}}} {
		code, _, body = taskWorkerJSONRequest(t, env, http.MethodPost, "/api/agent/v1/messages/read", credential.AccessToken, request)
		if code != http.StatusNotFound {
			t.Fatalf("all unavailable became empty success: %d %s", code, body)
		}
	}
	assertHistoryCursors(t, env, beforeCursors)
}

func TestAgentMessageHistoryRechecksAuthority(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice, credential, roomID := newAgentCLIIdentity(t)
	reader := agentmessages.Reader{TenantID: acmeTenant, ActorID: "actor_acme_official"}
	service := agentmessages.New(env.pool)
	beforeCursors := historyCursorSnapshot(t, env)
	ids := []string{"history_conversation", "history_runtime", "history_terminal"}
	for index, kind := range []string{"conversation", "agent_runtime", "task_terminal_notice"} {
		insertHistoryFixture(t, env, roomID, ids[index], kind, "History "+kind)
	}
	// Scope selection is only a default. Resource authorization comes from the
	// credential Actor and the database; history does not require a live Run.
	code, _, body := taskWorkerJSONRequest(t, env, http.MethodPost, "/api/agent/v1/messages/read", credential.AccessToken,
		map[string]any{"inbox_id": "room:" + roomID, "limit": 1})
	var page agentmessages.ReadResult
	decode(t, body, &page)
	if code != http.StatusOK || page.Messages == nil || len(*page.Messages) != 1 || !page.HasMore || page.NextCursor == "" {
		t.Fatalf("first history page: %d %s", code, body)
	}
	seen := map[string]bool{(*page.Messages)[0].MessageID: true}
	for page.HasMore {
		cursor := page.NextCursor
		page = agentmessages.ReadResult{}
		code, _, body = taskWorkerJSONRequest(t, env, http.MethodPost, "/api/agent/v1/messages/read", credential.AccessToken,
			map[string]any{"inbox_id": "room:" + roomID, "cursor": cursor, "limit": 1})
		decode(t, body, &page)
		if code != http.StatusOK || page.Messages == nil || len(*page.Messages) != 1 || seen[(*page.Messages)[0].MessageID] {
			t.Fatalf("history pagination duplicated or lost a message: %d %s", code, body)
		}
		seen[(*page.Messages)[0].MessageID] = true
	}
	for _, id := range ids {
		if !seen[id] {
			t.Fatalf("history omitted explicit message kind %s", id)
		}
	}
	assertHistoryCursors(t, env, beforeCursors)

	if _, err := env.pool.Exec(t.Context(), `UPDATE messages SET context_message_ids=ARRAY[$2::text] WHERE id=$1 AND tenant_id=$3 AND room_id=$4`, ids[1], ids[0], acmeTenant, roomID); err != nil {
		t.Fatal(err)
	}
	readOne := func(messageID string) (int, []byte, agentmessages.ReadMessage) {
		t.Helper()
		code, _, body := taskWorkerJSONRequest(t, env, http.MethodPost, "/api/agent/v1/messages/read", credential.AccessToken, map[string]any{"message_ids": []string{messageID}})
		var result agentmessages.ReadResult
		decode(t, body, &result)
		if code != http.StatusOK || result.Messages == nil || len(*result.Messages) != 1 {
			return code, body, agentmessages.ReadMessage{}
		}
		return code, body, (*result.Messages)[0]
	}
	code, body, single := readOne(ids[1])
	if code != http.StatusOK || len(single.ContextMessages) != 1 || single.ContextMessages[0].MessageID != ids[0] {
		t.Fatalf("message contexts unavailable: %d %s", code, body)
	}
	code, _, body = taskWorkerJSONRequest(t, env, http.MethodPost, "/api/agent/v1/messages/search", credential.AccessToken, map[string]any{"query": "History conversation"})
	if code != http.StatusOK || !bytes.Contains(body, []byte(ids[0])) {
		t.Fatalf("history search omitted a readable message: %d %s", code, body)
	}
	assertHistoryCursors(t, env, beforeCursors)

	// Parent members can read Threads without being listed as participants.
	insertHistoryFixture(t, env, roomID, "history_thread_root", "conversation", "Thread root")
	code, _, body = env.request(alice, http.MethodPost, "/v0/rooms/"+roomID+"/messages/history_thread_root/thread", map[string]any{}, "history-thread")
	if code != http.StatusCreated && code != http.StatusOK {
		t.Fatalf("create Thread: %d %s", code, body)
	}
	var thread struct {
		Room struct {
			ID string `json:"id"`
		} `json:"room"`
	}
	decode(t, body, &thread)
	insertHistoryFixture(t, env, thread.Room.ID, "history_thread_reply", "conversation", "Thread history")
	beforeCursors = historyCursorSnapshot(t, env)
	code, _, body = taskWorkerJSONRequest(t, env, http.MethodPost, "/api/agent/v1/messages/read", credential.AccessToken, map[string]any{"thread_id": thread.Room.ID, "limit": 1})
	var unified agentmessages.ReadResult
	decode(t, body, &unified)
	if code != http.StatusOK || unified.Root == nil || unified.Root.MessageID != "history_thread_root" || unified.Messages == nil || len(*unified.Messages) != 1 || (*unified.Messages)[0].ThreadID != thread.Room.ID || unified.Root.ThreadID != thread.Room.ID {
		t.Fatalf("Thread ID unified read: %d %s", code, body)
	}
	code, _, body = taskWorkerJSONRequest(t, env, http.MethodPost, "/api/agent/v1/messages/read", credential.AccessToken, map[string]any{"thread_id": "history_thread_reply"})
	if code != http.StatusNotFound {
		t.Fatalf("message ID guessed as Thread ID: %d %s", code, body)
	}
	if countRows(t, env, `SELECT count(*) FROM thread_room_list_actors WHERE thread_room_id=$1 AND actor_id='actor_acme_official'`, thread.Room.ID) != 0 {
		t.Fatal("history read enrolled a Thread participant")
	}
	assertHistoryCursors(t, env, beforeCursors)

	privateRoom := createPrivateRoom(t, env, alice, "Private history", "private-history")
	insertHistoryFixture(t, env, privateRoom, "history_forbidden", "conversation", "Secret history")
	for _, request := range []struct {
		endpoint string
		input    map[string]any
	}{
		{"read", map[string]any{"message_ids": []string{"history_forbidden"}}},
		{"read", map[string]any{"inbox_id": "room:" + privateRoom}},
		{"search", map[string]any{"query": "Secret", "inbox_ids": []string{"room:" + privateRoom}}},
	} {
		code, _, body = taskWorkerJSONRequest(t, env, http.MethodPost, "/api/agent/v1/messages/"+request.endpoint, credential.AccessToken, request.input)
		if code != http.StatusNotFound {
			t.Fatalf("unauthorized history %s: %d %s", request.endpoint, code, body)
		}
	}

	code, _, body = taskWorkerJSONRequest(t, env, http.MethodPost, "/api/agent/v1/messages/read", credential.AccessToken, map[string]any{"message_ids": []string{"history_forbidden", "history_runtime", "history_thread_root", "history_conversation"}})
	decode(t, body, &unified)
	if code != http.StatusOK || unified.Messages == nil || len(*unified.Messages) != 3 || unified.UnavailableMessageIDs == nil || !slices.Equal(*unified.UnavailableMessageIDs, []string{"history_forbidden"}) {
		t.Fatalf("mixed-authority batch: %d %s", code, body)
	}

	// Unbound Tasks still expose their own private Meta messages, but have no
	// synthetic public Task message stream.
	task := createManagedTaskFixture(t, env, roomID, "history-unbound")
	beforeCursors = historyCursorSnapshot(t, env)
	metaID := "meta:actor_acme_official:" + task.ID
	meta, err := service.Read(t.Context(), reader, agentmessages.ReadInput{InboxID: metaID})
	if err != nil || meta.Messages == nil || len(*meta.Messages) != 1 {
		t.Fatalf("unbound private Meta history: %+v err=%v", meta, err)
	}
	if _, err = service.Read(t.Context(), agentmessages.Reader{TenantID: acmeTenant, ActorID: "actor_acme_alice"}, agentmessages.ReadInput{InboxID: metaID}); !errors.Is(err, agentmessages.ErrNotFound) {
		t.Fatalf("Human read private Meta: %v", err)
	}
	if _, err = service.Read(t.Context(), reader, agentmessages.ReadInput{InboxID: "task:" + task.ID}); !errors.Is(err, agentmessages.ErrNotFound) {
		t.Fatalf("unbound Task invented public Inbox: %v", err)
	}
	assertHistoryCursors(t, env, beforeCursors)

	if code, body := putRoomMember(t, env, alice, privateRoom, reader.ActorID, "member"); code != http.StatusOK {
		t.Fatalf("add Work Room reader: %d %s", code, body)
	}
	createTaskWorkRoomLink(t, env, task.ID, privateRoom)
	aliasPage, err := service.Search(t.Context(), reader, agentmessages.SearchInput{Query: "Secret", InboxIDs: []string{"room:" + privateRoom}})
	if err != nil || len(aliasPage.Messages) != 1 || aliasPage.Messages[0].MessageID != "history_forbidden" {
		t.Fatalf("Work Room alias search failed: %+v err=%v", aliasPage, err)
	}

	var head int64
	if err = env.pool.QueryRow(t.Context(), `SELECT next_room_seq FROM rooms WHERE id=$1`, roomID).Scan(&head); err != nil {
		t.Fatal(err)
	}
	queries := store.New(env.pool)
	if err = queries.SetRoomParticipation(t.Context(), store.SetRoomParticipationParams{RoomID: roomID, ActorID: reader.ActorID, RoomSeq: head, HasLeft: true}); err != nil {
		t.Fatal(err)
	}
	if err = queries.SetThreadParticipationReadStates(t.Context(), store.SetThreadParticipationReadStatesParams{RoomID: roomID, ActorID: reader.ActorID, HasLeft: true}); err != nil {
		t.Fatal(err)
	}
	insertHistoryFixture(t, env, roomID, "history_after_leave", "conversation", "After leave")
	insertHistoryFixture(t, env, thread.Room.ID, "history_thread_after_leave", "conversation", "Thread after leave")
	for _, inboxID := range []string{"room:" + roomID, "thread:" + thread.Room.ID} {
		frozen, err := service.Read(t.Context(), reader, agentmessages.ReadInput{InboxID: inboxID})
		if err != nil || frozen.Messages == nil || len(*frozen.Messages) == 0 {
			t.Fatalf("left Actor lost scoped frozen history %s: %+v err=%v", inboxID, frozen, err)
		}
		for _, message := range *frozen.Messages {
			if message.MessageID == "history_after_leave" || message.MessageID == "history_thread_after_leave" {
				t.Fatalf("left Actor read future scoped message: %+v", message)
			}
		}
	}
	for _, id := range []string{"history_after_leave", "history_thread_after_leave"} {
		if _, err = service.Read(t.Context(), reader, agentmessages.ReadInput{MessageIDs: []string{id}}); !errors.Is(err, agentmessages.ErrNotFound) {
			t.Fatalf("left Actor read future message %s: %v", id, err)
		}
	}
	if _, err = service.Read(t.Context(), reader, agentmessages.ReadInput{MessageIDs: []string{"history_runtime"}}); err != nil {
		t.Fatalf("left Actor lost frozen Room history: %v", err)
	}
	if _, err = service.Read(t.Context(), reader, agentmessages.ReadInput{MessageIDs: []string{"history_thread_reply"}}); err != nil {
		t.Fatalf("left Actor lost frozen Thread history: %v", err)
	}
	code, _, body = env.request(alice, http.MethodDelete, "/v0/rooms/"+roomID+"/members/"+reader.ActorID, nil, "")
	if code != http.StatusNoContent {
		t.Fatalf("revoke member: %d %s", code, body)
	}
	if _, err = service.Read(t.Context(), reader, agentmessages.ReadInput{MessageIDs: []string{"history_runtime"}}); !errors.Is(err, agentmessages.ErrNotFound) {
		t.Fatalf("removed Actor read Room history: %v", err)
	}
}

func historyCursorSnapshot(t *testing.T, env *testEnv) string {
	t.Helper()
	var snapshot string
	if err := env.pool.QueryRow(t.Context(), `SELECT COALESCE(jsonb_agg(to_jsonb(c) ORDER BY context_key,inbox_id),'[]')::text FROM agent_context_inbox_cursors c`).Scan(&snapshot); err != nil {
		t.Fatal(err)
	}
	return snapshot
}

func assertHistoryCursors(t *testing.T, env *testEnv, before string) {
	t.Helper()
	if after := historyCursorSnapshot(t, env); after != before {
		t.Fatalf("history changed reception cursors: %s -> %s", before, after)
	}
}

func insertHistoryFixture(t *testing.T, env *testEnv, roomID, id, kind, body string) {
	t.Helper()
	tx, err := env.pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(t.Context())
	queries := store.New(tx)
	segments, _ := json.Marshal([]map[string]string{{"type": "text", "content": body}})
	if _, err = queries.CreateMessage(t.Context(), store.CreateMessageParams{ID: id, TenantID: acmeTenant, RoomID: roomID, AuthorActorID: "actor_acme_alice", Body: body, Segments: segments, MessageKind: kind}); err != nil {
		t.Fatal(err)
	}
	sequence, err := queries.AllocateRoomSeq(t.Context(), roomID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = queries.CreateRoomEvent(t.Context(), store.CreateRoomEventParams{EventID: "event_" + id, TenantID: acmeTenant, RoomID: roomID, RoomSeq: sequence, EventType: "message.created", ActorID: "actor_acme_alice", ResourceID: id, Payload: json.RawMessage(`{}`)}); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
}
