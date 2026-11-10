package integration_test

import (
	"bufio"
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/config"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/realtime"
)

// Database commits own wake visibility. A Message transaction queues its Run
// and names the Context in one run.queued hint; the stream uses a separate
// LISTEN connection and no projection worker or polling.
func TestAgentRunWakesFollowCommitsAndReconnect(t *testing.T) {
	allowParallelIntegrationTest(t)
	artifactRoot := integrationArtifactRoot(t)
	env, alice := newTaskWorkerEnv(t)
	roomID := createPrivateRoom(t, env, alice, "Run wakes", "run-wake-room")
	if code, body := putRoomMember(t, env, alice, roomID, "actor_acme_official", "member"); code != http.StatusOK {
		t.Fatalf("add Agent: %d %s", code, body)
	}
	// Room admission materializes the Agent's Meta Context for this Room.
	metaContextKey := `["meta","` + testRuntimeAgentID + `","room","` + roomID + `"]`
	if got := countRows(t, env, `SELECT count(*) FROM agent_execution_contexts WHERE context_key=$1`, metaContextKey); got != 1 {
		t.Fatalf("Room Meta Context rows=%d want=1", got)
	}
	// Every Room Message notifies an all-actionable Agent.
	if _, err := env.pool.Exec(t.Context(), `UPDATE agent_registrations SET agent_type='anotherme',receives_all_messages=true,represented_human_actor_id=created_by_actor_id WHERE actor_id='actor_acme_official'`); err != nil {
		t.Fatal(err)
	}
	taskID := "task_run_wake"
	// The callback stream belongs to the generation's coordinator Context.
	seedTaskActivityParticipant(t, env, taskID, roomID, metaContextKey)
	if _, err := env.pool.Exec(t.Context(), `INSERT INTO task_meta_callbacks(task_id,tenant_id,generation,coordinator_actor_id,coordinator_context_key) VALUES($1,'tenant_acme',1,'actor_acme_official',$2)`, taskID, metaContextKey); err != nil {
		t.Fatal(err)
	}

	listener, err := pgx.Connect(t.Context(), env.databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close(context.Background()) })
	if _, err := listener.Exec(t.Context(), "LISTEN "+pgx.Identifier{realtime.ChannelName}.Sanitize()); err != nil {
		t.Fatal(err)
	}
	// writeMessage appends one plain Room Message inside tx.
	writeMessage := func(tx pgx.Tx, messageID string) {
		t.Helper()
		var sequence int64
		if err := tx.QueryRow(t.Context(), `UPDATE rooms SET next_room_seq=next_room_seq+1 WHERE id=$1 RETURNING next_room_seq`, roomID).Scan(&sequence); err != nil {
			t.Fatal(err)
		}
		if _, err := tx.Exec(t.Context(), `INSERT INTO messages(id,tenant_id,room_id,author_actor_id,body,segments)
			VALUES($1,'tenant_acme',$2,'actor_acme_alice','private room body','[{"type":"text","content":"private room body"}]')`, messageID, roomID); err != nil {
			t.Fatal(err)
		}
		if _, err := tx.Exec(t.Context(), `INSERT INTO room_events(event_id,tenant_id,room_id,room_seq,event_type,actor_id,resource_id,payload)
			VALUES($1,'tenant_acme',$2,$3,'message.created','actor_acme_alice',$4,'{}')`, messageID+"-event", roomID, sequence, messageID); err != nil {
			t.Fatal(err)
		}
	}
	write := func(tx pgx.Tx) {
		t.Helper()
		writeMessage(tx, "run_wake_message")
		for _, statement := range []string{
			// The Task worker delivers the private Meta stream; it wakes nothing.
			`INSERT INTO task_meta_messages(id,tenant_id,task_id,agent_actor_id,meta_seq,author_actor_id,body,segments) VALUES('meta_wake','tenant_acme','task_run_wake','actor_acme_official',1,'actor_acme_alice','private meta body','[]')`,
			`UPDATE task_meta_inboxes SET through_seq=1 WHERE task_id='task_run_wake'`,
			`INSERT INTO task_meta_callback_messages(id,tenant_id,task_id,generation,meta_seq,author_actor_id,body,segments) VALUES('callback_wake','tenant_acme','task_run_wake',1,1,'actor_acme_official','private callback body','[]')`,
			`UPDATE task_meta_callbacks SET through_seq=1 WHERE task_id='task_run_wake'`,
		} {
			if _, err := tx.Exec(t.Context(), statement); err != nil {
				t.Fatal(err)
			}
		}
	}
	assertNoWake := func() {
		t.Helper()
		ctx, cancel := context.WithTimeout(t.Context(), 80*time.Millisecond)
		defer cancel()
		for {
			notification, err := listener.WaitForNotification(ctx)
			if errors.Is(err, context.DeadlineExceeded) {
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			decoded, err := realtime.DecodeNotification([]byte(notification.Payload))
			if err != nil {
				t.Fatal(err)
			}
			if decoded.Topic == realtime.AgentInboxWakeTopic && decoded.Kind != "context.changed" {
				t.Fatalf("uncommitted run wake=%+v", decoded)
			}
		}
	}
	tx, err := env.pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	write(tx)
	assertNoWake()
	if err := tx.Rollback(t.Context()); err != nil {
		t.Fatal(err)
	}
	assertNoWake()
	tx, err = env.pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	write(tx)
	if err := tx.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
	// The Room Message queues a Run; the Task callback joins it or steers it.
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	for queued := false; !queued; {
		notification, err := listener.WaitForNotification(ctx)
		if err != nil {
			t.Fatalf("missing committed run wake: %v", err)
		}
		if strings.Contains(notification.Payload, "private") {
			t.Fatalf("message body leaked in wake: %s", notification.Payload)
		}
		decoded, err := realtime.DecodeNotification([]byte(notification.Payload))
		if err != nil {
			t.Fatal(err)
		}
		if decoded.Topic != realtime.AgentInboxWakeTopic || decoded.Kind == "context.changed" {
			continue
		}
		if decoded.ResourceID != metaContextKey || (decoded.Kind != realtime.RunQueuedKind && decoded.Kind != realtime.RunSteeredKind) {
			t.Fatalf("committed run wake=%+v", decoded)
		}
		queued = decoded.Kind == realtime.RunQueuedKind
	}
	for _, messageID := range []string{"run_wake_message", "callback_wake"} {
		if got := countRows(t, env, `SELECT count(*) FROM agent_runtime_inputs WHERE context_key=$1 AND source_message_id=$2`, metaContextKey, messageID); got != 1 {
			t.Fatalf("%s queued %d inputs", messageID, got)
		}
	}
	if got := countRows(t, env, `SELECT count(*) FROM agent_runtime_inputs WHERE source_message_id='meta_wake'`); got != 0 {
		t.Fatalf("private Meta stream queued %d inputs", got)
	}

	application, err := newIntegrationApp(t.Context(), config.ForTest(func(c *config.Config) {
		c.ArtifactStorageRoot = artifactRoot
		c.DatabaseURL = env.databaseURL
		c.TeamHubInternalToken = teamHubInternalToken
		c.NodeServicesInternalToken = nodeServicesInternalToken
		c.AgentRunTokenSecret = agentRunTokenSecret
		c.SSEHeartbeatInterval = time.Hour
		c.SSEQueueCapacity = 8
	}))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(application.Close)
	server := httptest.NewServer(application.Handler())
	registerIntegrationServerCleanup(t, server)
	streamURL := server.URL + "/v0/agent-runtime/wakes"
	for _, token := range []string{"", "wrong-service-token"} {
		request, _ := http.NewRequest(http.MethodGet, streamURL, nil)
		request.Header.Set("Authorization", "Bearer "+token)
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		_ = response.Body.Close()
		if response.StatusCode != http.StatusUnauthorized {
			t.Fatalf("unauthorized SSE status=%d", response.StatusCode)
		}
	}
	streamContext, stopStream := context.WithTimeout(t.Context(), 30*time.Second)
	defer stopStream()
	request, _ := http.NewRequestWithContext(streamContext, http.MethodGet, streamURL, nil)
	request.Header.Set("Authorization", "Bearer "+teamHubInternalToken)
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK || !strings.Contains(response.Header.Get("Content-Type"), "text/event-stream") {
		t.Fatalf("stream status=%d", response.StatusCode)
	}
	reader := bufio.NewReader(response.Body)
	if record := nextNamedSSE(t, reader); record.Event != "reconcile" || record.Data != "{}" {
		t.Fatalf("initial reconcile=%+v", record)
	}
	wakeStarted := time.Now()
	tx, err = env.pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	writeMessage(tx, "run_wake_stream_message")
	if err := tx.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
	for {
		record := nextNamedSSE(t, reader)
		if record.Event == "context.changed" {
			continue
		}
		if (record.Event != "run.queued" && record.Event != "run.steered") || !strings.Contains(record.Data, `"context_key":`+strconv.Quote(metaContextKey)) {
			t.Fatalf("run wake=%+v", record)
		}
		break
	}
	t.Logf("committed Message -> HTTP SSE elapsed=%s", time.Since(wakeStarted))
	terminateRealtimeListeners(t, env.pool)
	for {
		record := nextNamedSSE(t, reader)
		if record.Event == "context.changed" {
			continue
		}
		if record.Event != "reconcile" || record.Data != "{}" {
			t.Fatalf("LISTEN reconnect reconcile=%+v", record)
		}
		break
	}
}
