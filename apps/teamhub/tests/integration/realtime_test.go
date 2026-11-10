package integration_test

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/config"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/realtime"
)

type sseRecord struct {
	ID, Event, Data string
}

// eventsStreamURL follows one Room from room_seq after on /v0/events.
func eventsStreamURL(serverURL, roomID string, after int64) string {
	return serverURL + "/v0/events?room=" + roomID + ":" + strconv.FormatInt(after, 10)
}

func TestRoomEventCatchupAndEventsStream(t *testing.T) {
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
	otherDevice := env.login("alice", alicePassword)
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	roomID := env.createRoom(alice, acmeTenant, "Realtime "+suffix, "sse-room-"+suffix)

	t.Run("after pagination returns a stable high water mark", func(t *testing.T) {
		for index := 1; index <= 3; index++ {
			env.createMessage(alice, roomID, fmt.Sprintf("history %d", index), fmt.Sprintf("sse-history-%s-%d", suffix, index))
		}
		status, _, body := env.request(otherDevice, http.MethodGet, "/v0/rooms/"+roomID+"/events?after=1&limit=2", nil, "")
		if status != http.StatusOK {
			t.Fatalf("event page status=%d body=%s", status, body)
		}
		var page struct {
			Items []struct {
				RoomSeq int64 `json:"room_seq"`
			} `json:"items"`
			LatestRoomSeq int64 `json:"latest_room_seq"`
			HasMore       bool  `json:"has_more"`
		}
		decode(t, body, &page)
		if len(page.Items) != 2 || page.Items[0].RoomSeq != 2 || page.Items[1].RoomSeq != 3 || page.LatestRoomSeq != 4 || !page.HasMore {
			t.Fatalf("unexpected event page: %+v", page)
		}
		status, _, body = env.request(otherDevice, http.MethodGet, "/v0/rooms/"+roomID+"/events?after=3&limit=2", nil, "")
		if status != http.StatusOK {
			t.Fatalf("event tail status=%d body=%s", status, body)
		}
		decode(t, body, &page)
		if len(page.Items) != 1 || page.Items[0].RoomSeq != 4 || page.HasMore {
			t.Fatalf("unexpected event tail: %+v", page)
		}
		t.Logf("SSE-02 environment=PostgreSQL fault=after-gap last_applied=1 authority_latest=%d duplicate_count=0", page.LatestRoomSeq)
	})

	t.Run("stream opens immediately and heartbeat carries no sequence", func(t *testing.T) {
		after := currentEventWatermark(t, env, otherDevice, "/v0/rooms/"+roomID+"/events", "latest_room_seq")
		response := openSSE(t, otherDevice, eventsStreamURL(server.URL, roomID, after), 2*time.Second)
		defer response.Body.Close()
		reader := bufio.NewReader(response.Body)
		connected := readSSERecord(t, reader)
		if connected.Data != ": connected" || connected.ID != "" || connected.Event != "" {
			t.Fatalf("unexpected connection comment: %+v", connected)
		}
		if resync := readSSERecord(t, reader); resync.Event != "stream.resync" || resync.ID != "" {
			t.Fatalf("unexpected first event: %+v", resync)
		}
		heartbeat := readSSERecord(t, reader)
		if heartbeat.Data != ": heartbeat" || heartbeat.ID != "" || heartbeat.Event != "" {
			t.Fatalf("unexpected heartbeat: %+v", heartbeat)
		}
		t.Logf("SSE-01 environment=httptest fault=idle last_applied=%d authority_latest=%d duplicate_count=0", after, after)
	})

	t.Run("two clients receive the same committed order", func(t *testing.T) {
		testDatabaseURL := newIntegrationDatabase(t)
		testPool, err := pgxpool.New(t.Context(), testDatabaseURL)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(testPool.Close)
		testApplication, err := newIntegrationApp(t.Context(), config.ForTest(func(c *config.Config) {
			c.ArtifactStorageRoot = artifactRoot
			c.DatabaseURL = testDatabaseURL
			c.SessionTTL = time.Hour
			c.CookieName = "teamhub_session"
			c.SSEHeartbeatInterval = 25 * time.Millisecond
			c.SSEQueueCapacity = 64
			c.SSEReplayBatchSize = 2
		}))
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(testApplication.Close)
		testServer := httptest.NewServer(testApplication.Handler())
		registerIntegrationServerCleanup(t, testServer)
		testEnv := &testEnv{t: t, databaseURL: testDatabaseURL, pool: testPool, server: testServer}
		testAlice := testEnv.login("alice", alicePassword)
		testOtherDevice := testEnv.login("alice", alicePassword)
		testSuffix := strconv.FormatInt(time.Now().UnixNano(), 36)
		testRoomID := testEnv.createRoom(testAlice, acmeTenant, "Two clients "+testSuffix, "sse-two-clients-"+testSuffix)
		roomAfter := currentEventWatermark(t, testEnv, testOtherDevice, "/v0/rooms/"+testRoomID+"/events", "latest_room_seq")
		firstResponse, firstContext := openSSEWithContext(t, testAlice, eventsStreamURL(testServer.URL, testRoomID, roomAfter), 3*time.Second)
		defer firstResponse.Body.Close()
		secondResponse, secondContext := openSSEWithContext(t, testOtherDevice, eventsStreamURL(testServer.URL, testRoomID, roomAfter), 3*time.Second)
		defer secondResponse.Body.Close()
		firstReader, secondReader := bufio.NewReader(firstResponse.Body), bufio.NewReader(secondResponse.Body)
		requireSSEReady(t, "alice", firstReader)
		requireSSEReady(t, "other device", secondReader)
		for index := 0; index < 2; index++ {
			testEnv.createMessage(testAlice, testRoomID, fmt.Sprintf("live %d", index), fmt.Sprintf("sse-live-%s-%d", testSuffix, index))
		}
		expectedSequences := []int64{roomAfter + 1, roomAfter + 2}
		type readResult struct {
			client  string
			records []sseRecord
			err     error
		}
		results := make(chan readResult, 2)
		go func() {
			records, readErr := readExpectedRoomEvents(firstContext, "alice", firstReader, expectedSequences)
			results <- readResult{client: "alice", records: records, err: readErr}
		}()
		go func() {
			records, readErr := readExpectedRoomEvents(secondContext, "other device", secondReader, expectedSequences)
			results <- readResult{client: "other device", records: records, err: readErr}
		}()
		byClient := make(map[string][]sseRecord, 2)
		for range 2 {
			result := <-results
			if result.err != nil {
				t.Fatal(result.err)
			}
			byClient[result.client] = result.records
		}
		for index, expected := range expectedSequences {
			first, second := byClient["alice"][index], byClient["other device"][index]
			if second.ID != first.ID || second.Data != first.Data {
				t.Fatalf("expected room_seq=%d alice=%+v otherDevice=%+v", expected, first, second)
			}
		}
		t.Logf("SSE-08 environment=isolated-single-process fault=two-subscribers last_applied=%d authority_latest=%d duplicate_count=0", roomAfter+2, roomAfter+2)
	})

	t.Run("reconnect and process restart replay committed events", func(t *testing.T) {
		roomAfter := currentEventWatermark(t, env, otherDevice, "/v0/rooms/"+roomID+"/events", "latest_room_seq")
		env.createMessage(alice, roomID, "during disconnect", "sse-reconnect-"+suffix)
		restarted, err := newIntegrationApp(ctx, config.ForTest(func(c *config.Config) {
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
		defer restarted.Close()
		restartedServer := httptest.NewServer(restarted.Handler())
		defer restartedServer.Close()
		response := openSSE(t, otherDevice, eventsStreamURL(restartedServer.URL, roomID, roomAfter), 2*time.Second)
		defer response.Body.Close()
		record := nextRoomEvent(t, bufio.NewReader(response.Body))
		if record.ID != strconv.FormatInt(roomAfter+1, 10) {
			t.Fatalf("restart replay id=%q want=%d", record.ID, roomAfter+1)
		}
		t.Logf("SSE-03 environment=new-App-same-PostgreSQL fault=process-restart last_applied=%d authority_latest=%d duplicate_count=0", roomAfter, roomAfter+1)
	})

	t.Run("replay and concurrent live writes have no gap", func(t *testing.T) {
		roomAfter := currentEventWatermark(t, env, otherDevice, "/v0/rooms/"+roomID+"/events", "latest_room_seq")
		for index := 0; index < 6; index++ {
			env.createMessage(alice, roomID, fmt.Sprintf("replay %d", index), fmt.Sprintf("sse-replay-%s-%d", suffix, index))
		}
		response := openSSE(t, otherDevice, eventsStreamURL(server.URL, roomID, roomAfter), 4*time.Second)
		defer response.Body.Close()
		reader := bufio.NewReader(response.Body)
		env.createMessage(alice, roomID, "replay boundary", "sse-boundary-"+suffix)
		for expected := roomAfter + 1; expected <= roomAfter+7; expected++ {
			record := nextRoomEvent(t, reader)
			if record.ID != strconv.FormatInt(expected, 10) {
				t.Fatalf("gap at %d: %+v", expected, record)
			}
		}
		t.Logf("SSE-04 environment=batch-size-2 fault=write-during-replay room_last_applied=%d duplicate_count=0", roomAfter+7)
	})

	t.Run("idempotent retry creates one event and catchup recovers it", func(t *testing.T) {
		roomAfter := currentEventWatermark(t, env, otherDevice, "/v0/rooms/"+roomID+"/events", "latest_room_seq")
		key := "sse-dedup-" + suffix
		payload := humanTextMessage("deliver once")
		status, _, body := env.request(alice, http.MethodPost, "/v0/rooms/"+roomID+"/messages", payload, key)
		if status != http.StatusCreated {
			t.Fatalf("first message status=%d body=%s", status, body)
		}
		status, headers, replayBody := env.request(alice, http.MethodPost, "/v0/rooms/"+roomID+"/messages", payload, key)
		if status != http.StatusCreated || headers.Get("Idempotent-Replay") != "true" || string(replayBody) != string(body) {
			t.Fatalf("retry status=%d replay=%q body_equal=%t", status, headers.Get("Idempotent-Replay"), string(replayBody) == string(body))
		}
		status, _, eventsBody := env.request(otherDevice, http.MethodGet, "/v0/rooms/"+roomID+"/events?after="+strconv.FormatInt(roomAfter, 10), nil, "")
		if status != http.StatusOK {
			t.Fatalf("catchup status=%d body=%s", status, eventsBody)
		}
		var page struct {
			Items []struct {
				EventID string `json:"event_id"`
				RoomSeq int64  `json:"room_seq"`
			} `json:"items"`
			LatestRoomSeq int64 `json:"latest_room_seq"`
		}
		decode(t, eventsBody, &page)
		if len(page.Items) != 1 || page.Items[0].RoomSeq != roomAfter+1 || page.LatestRoomSeq != roomAfter+1 {
			t.Fatalf("unexpected deduplicated catchup: %+v", page)
		}
		t.Logf("SSE-05/SSE-07 environment=bounded-broker-plus-PostgreSQL fault=retry-or-disconnect room_last_applied=%d authority_latest=%d duplicate_count=0", roomAfter, roomAfter+1)
	})

	t.Run("retired routes are absent", func(t *testing.T) {
		for _, route := range []string{"/v0/me/events", "/v0/me/events/stream", "/v0/me/deliveries", "/v0/me/deliveries/stream", "/v0/rooms/" + roomID + "/events/stream"} {
			if code, _, body := env.request(otherDevice, http.MethodGet, route, nil, ""); code != http.StatusNotFound {
				t.Fatalf("retired route %s status=%d body=%s", route, code, body)
			}
		}
	})
}

func TestRealtimeWakeCrossesAppInstances(t *testing.T) {
	allowParallelIntegrationTest(t)
	artifactRoot := integrationArtifactRoot(t)
	databaseURL := newIntegrationDatabase(t)
	pool, err := pgxpool.New(context.Background(), databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	appConfig := config.ForTest(func(c *config.Config) {
		c.ArtifactStorageRoot = artifactRoot
		c.DatabaseURL = databaseURL
		c.SessionTTL = time.Hour
		c.CookieName = "teamhub_session"
		c.SSEHeartbeatInterval = 50 * time.Millisecond
		c.SSEQueueCapacity = 8
		c.SSEReplayBatchSize = 10
		c.TeamHubInternalToken = teamHubInternalToken
		c.NodeServicesInternalToken = nodeServicesInternalToken
		c.AgentRunTokenSecret = agentRunTokenSecret
	})
	writerApp, err := newIntegrationApp(context.Background(), appConfig)
	if err != nil {
		t.Fatal(err)
	}
	defer writerApp.Close()
	readerApp, err := newIntegrationApp(context.Background(), appConfig)
	if err != nil {
		t.Fatal(err)
	}
	defer readerApp.Close()
	writerServer := httptest.NewServer(writerApp.Handler())
	defer writerServer.Close()
	readerServer := httptest.NewServer(readerApp.Handler())
	defer readerServer.Close()

	env := &testEnv{t: t, databaseURL: databaseURL, pool: pool, server: writerServer}
	alice := env.login("alice", alicePassword)
	otherDevice := env.login("alice", alicePassword)
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	roomID := env.createRoom(alice, acmeTenant, "Multi Pod "+suffix, "multi-pod-room-"+suffix)
	if status, body := putRoomMember(t, env, alice, roomID, "actor_acme_official", "member"); status != http.StatusOK {
		t.Fatalf("add Agent status=%d body=%s", status, body)
	}
	roomAfter := currentEventWatermark(t, env, otherDevice, "/v0/rooms/"+roomID+"/events", "latest_room_seq")

	eventsResponse := openSSE(t, otherDevice, eventsStreamURL(readerServer.URL, roomID, roomAfter), 30*time.Second)
	defer eventsResponse.Body.Close()
	eventsReader := bufio.NewReader(eventsResponse.Body)
	if connected := readSSERecord(t, eventsReader); connected.Data != ": connected" {
		t.Fatalf("events connected=%+v", connected)
	}
	env.createMessage(alice, roomID, "cross pod", "multi-pod-message-"+suffix)
	if record := nextRoomEvent(t, eventsReader); record.ID != strconv.FormatInt(roomAfter+1, 10) {
		t.Fatalf("cross-instance Room Event=%+v", record)
	}
}

func TestRealtimeNotificationFollowsTransactionCommit(t *testing.T) {
	allowParallelIntegrationTest(t)
	artifactRoot := integrationArtifactRoot(t)
	databaseURL := newIntegrationDatabase(t)
	pool, err := pgxpool.New(context.Background(), databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	application, err := newIntegrationApp(context.Background(), config.ForTest(func(c *config.Config) {
		c.ArtifactStorageRoot = artifactRoot
		c.DatabaseURL = databaseURL
		c.SessionTTL = time.Hour
		c.CookieName = "teamhub_session"
		c.SSEHeartbeatInterval = time.Hour
		c.SSEQueueCapacity = 8
		c.SSEReplayBatchSize = 10
	}))
	if err != nil {
		t.Fatal(err)
	}
	defer application.Close()
	server := httptest.NewServer(application.Handler())
	defer server.Close()
	env := &testEnv{t: t, databaseURL: databaseURL, pool: pool, server: server}
	alice := env.login("alice", alicePassword)
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	roomID := env.createRoom(alice, acmeTenant, "Notify Transaction "+suffix, "notify-room-"+suffix)
	if status, body := putRoomMember(t, env, alice, roomID, "actor_acme_official", "member"); status != http.StatusOK {
		t.Fatalf("add Agent status=%d body=%s", status, body)
	}

	insertRoomEvent := func(tx pgx.Tx, eventID string) {
		t.Helper()
		var roomSequence int64
		if err := tx.QueryRow(context.Background(), `
			UPDATE rooms SET next_room_seq=next_room_seq+1 WHERE id=$1
			RETURNING next_room_seq`, roomID).Scan(&roomSequence); err != nil {
			t.Fatal(err)
		}
		if _, err := tx.Exec(context.Background(), `
			INSERT INTO room_events(
				event_id,tenant_id,room_id,room_seq,event_type,actor_id,resource_id,payload
			) VALUES ($1,$2,$3,$4,'message.created','actor_acme_alice',$5,$6::jsonb)`,
			eventID, acmeTenant, roomID, roomSequence, "resource_"+eventID,
			`{"kind":"message.created"}`); err != nil {
			t.Fatal(err)
		}
	}
	rollbackListener, err := pgx.Connect(context.Background(), databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := rollbackListener.Exec(context.Background(), "LISTEN "+pgx.Identifier{realtime.ChannelName}.Sanitize()); err != nil {
		t.Fatal(err)
	}
	rollbackTx, err := pool.Begin(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	insertRoomEvent(rollbackTx, "event_rollback_"+suffix)
	if err := rollbackTx.Rollback(context.Background()); err != nil {
		t.Fatal(err)
	}
	rollbackContext, cancelRollback := context.WithTimeout(context.Background(), 100*time.Millisecond)
	for {
		notification, notificationErr := rollbackListener.WaitForNotification(rollbackContext)
		if errors.Is(notificationErr, context.DeadlineExceeded) {
			break
		}
		if notificationErr != nil {
			t.Fatalf("wait for rollback boundary: %v", notificationErr)
		}
		decoded, decodeErr := realtime.DecodeNotification([]byte(notification.Payload))
		if decodeErr != nil {
			t.Fatalf("decode rollback-boundary notification: %v", decodeErr)
		}
		if decoded.Topic == "room:"+roomID {
			t.Fatalf("rolled-back Room notification=%+v", decoded)
		}
	}
	cancelRollback()
	_ = rollbackListener.Close(context.Background())

	commitListener, err := pgx.Connect(context.Background(), databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer commitListener.Close(context.Background())
	if _, err := commitListener.Exec(context.Background(), "LISTEN "+pgx.Identifier{realtime.ChannelName}.Sanitize()); err != nil {
		t.Fatal(err)
	}
	commitTx, err := pool.Begin(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	eventID := "event_commit_" + suffix
	insertRoomEvent(commitTx, eventID)
	if err := commitTx.Commit(context.Background()); err != nil {
		t.Fatal(err)
	}
	commitContext, cancelCommit := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancelCommit()
	seenRoomEvent := false
	for !seenRoomEvent {
		notification, err := commitListener.WaitForNotification(commitContext)
		if err != nil {
			t.Fatalf("wait for committed notification: %v", err)
		}
		decoded, err := realtime.DecodeNotification([]byte(notification.Payload))
		if err != nil {
			t.Fatalf("decode notification: %v", err)
		}
		if decoded.Topic == "room:"+roomID && decoded.Kind == "room.event" {
			if decoded.ResourceID != eventID || decoded.Sequence < 1 || decoded.Revision != 0 {
				t.Fatalf("Room notification=%+v", decoded)
			}
			seenRoomEvent = true
		}
	}
}

// A Human message wakes each subscriber once per committed row that carries a
// notification and nothing more: handlers no longer publish in process.
func TestHumanMessageWakesOncePerCommittedRow(t *testing.T) {
	allowParallelIntegrationTest(t)
	artifactRoot := integrationArtifactRoot(t)
	databaseURL := newIntegrationDatabase(t)
	pool, err := pgxpool.New(context.Background(), databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	broker := realtime.NewBroker(64)
	application, err := newIntegrationApp(context.Background(), config.ForTest(func(c *config.Config) {
		c.ArtifactStorageRoot = artifactRoot
		c.DatabaseURL = databaseURL
		c.SessionTTL = time.Hour
		c.CookieName = "teamhub_session"
		c.SSEHeartbeatInterval = time.Hour
		c.SSEQueueCapacity = 64
		c.SSEReplayBatchSize = 10
	}), withRealtimeBroker(broker))
	if err != nil {
		t.Fatal(err)
	}
	defer application.Close()
	server := httptest.NewServer(application.Handler())
	defer server.Close()
	env := &testEnv{t: t, databaseURL: databaseURL, pool: pool, server: server}
	alice := env.login("alice", alicePassword)
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	roomID := env.createRoom(alice, acmeTenant, "Wake count "+suffix, "wake-count-room-"+suffix)
	var roomAfter int64
	if err := pool.QueryRow(t.Context(), `SELECT next_room_seq FROM rooms WHERE id=$1`, roomID).Scan(&roomAfter); err != nil {
		t.Fatal(err)
	}
	roomWakes := broker.Subscribe("room:" + roomID)
	defer roomWakes.Close()
	tenantWakes := broker.Subscribe("tenant:" + acmeTenant)
	defer tenantWakes.Close()
	// Notifications of the setup writes may still be on their way.
	for drained := false; !drained; {
		select {
		case <-roomWakes.Events():
		case <-tenantWakes.Events():
		case <-time.After(300 * time.Millisecond):
			drained = true
		}
	}

	env.createMessage(alice, roomID, "wake count", "wake-count-message-"+suffix)
	var roomRows int
	if err := pool.QueryRow(t.Context(), `SELECT count(*) FROM room_events WHERE room_id=$1 AND room_seq>$2`,
		roomID, roomAfter).Scan(&roomRows); err != nil {
		t.Fatal(err)
	}
	if roomRows == 0 {
		t.Fatal("message committed no Room Event")
	}
	roomCount := 0
	// Wait for every expected wake, then a little longer for any duplicate.
	settle := time.After(5 * time.Second)
	for roomCount < roomRows {
		select {
		case <-roomWakes.Events():
			roomCount++
		case event := <-tenantWakes.Events():
			t.Fatalf("a plain message published a Tenant hint %+v", event)
		case <-settle:
			t.Fatalf("Room wakes=%d/%d", roomCount, roomRows)
		}
	}
	select {
	case event := <-roomWakes.Events():
		t.Fatalf("extra Room wake %+v after %d committed events", event, roomRows)
	case event := <-tenantWakes.Events():
		t.Fatalf("a plain message published a Tenant hint %+v", event)
	case <-time.After(300 * time.Millisecond):
	}
	t.Logf("one Human message: %d Room wakes, no Tenant hint", roomCount)
}

func TestRealtimeListenerReconnectReconcilesActiveStreams(t *testing.T) {
	allowParallelIntegrationTest(t)
	artifactRoot := integrationArtifactRoot(t)
	databaseURL := newIntegrationDatabase(t)
	pool, err := pgxpool.New(context.Background(), databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	appConfig := config.ForTest(func(c *config.Config) {
		c.ArtifactStorageRoot = artifactRoot
		c.DatabaseURL = databaseURL
		c.SessionTTL = time.Hour
		c.CookieName = "teamhub_session"
		c.SSEHeartbeatInterval = time.Hour
		c.SSEQueueCapacity = 8
		c.SSEReplayBatchSize = 10
		c.TeamHubInternalToken = teamHubInternalToken
		c.NodeServicesInternalToken = nodeServicesInternalToken
		c.AgentRunTokenSecret = agentRunTokenSecret
	})
	writerApp, err := newIntegrationApp(context.Background(), appConfig)
	if err != nil {
		t.Fatal(err)
	}
	defer writerApp.Close()
	readerApp, err := newIntegrationApp(context.Background(), appConfig)
	if err != nil {
		t.Fatal(err)
	}
	defer readerApp.Close()
	writerServer := httptest.NewServer(writerApp.Handler())
	defer writerServer.Close()
	readerServer := httptest.NewServer(readerApp.Handler())
	defer readerServer.Close()
	env := &testEnv{t: t, databaseURL: databaseURL, pool: pool, server: writerServer}
	alice := env.login("alice", alicePassword)
	otherDevice := env.login("alice", alicePassword)
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	roomID := env.createRoom(alice, acmeTenant, "Reconnect "+suffix, "reconnect-room-"+suffix)
	if status, body := putRoomMember(t, env, alice, roomID, "actor_acme_official", "member"); status != http.StatusOK {
		t.Fatalf("add Agent status=%d body=%s", status, body)
	}
	roomAfter := currentEventWatermark(t, env, otherDevice, "/v0/rooms/"+roomID+"/events", "latest_room_seq")
	eventsResponse := openSSE(t, otherDevice, eventsStreamURL(readerServer.URL, roomID, roomAfter), 3*time.Second)
	defer eventsResponse.Body.Close()
	eventsReader := bufio.NewReader(eventsResponse.Body)
	if connected := readSSERecord(t, eventsReader); connected.Data != ": connected" {
		t.Fatalf("events connected=%+v", connected)
	}
	// The writer's Listener drops too; the reader's stream is what must recover.
	terminateRealtimeListeners(t, pool)
	waitForListenerState(t, readerServer.URL, false, time.Second)
	env.createMessage(alice, roomID, "written while Listener was disconnected", "reconnect-message-"+suffix)
	if record := nextRoomEvent(t, eventsReader); record.ID != strconv.FormatInt(roomAfter+1, 10) {
		t.Fatalf("reconciled Room Event=%+v", record)
	}
	waitForListenerState(t, readerServer.URL, true, 2*time.Second)
}

// terminateRealtimeListeners disconnects the realtime Listener of every App on
// the test's database; each Listener's session carries the same fixed name.
func terminateRealtimeListeners(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	var terminated int
	if err := pool.QueryRow(t.Context(), `
		SELECT count(*) FILTER (WHERE pg_terminate_backend(pid))
		FROM pg_stat_activity
		WHERE datname=current_database() AND application_name=$1`, realtime.ListenerApplicationName).Scan(&terminated); err != nil {
		t.Fatal(err)
	}
	if terminated == 0 {
		t.Fatal("no realtime Listener backend was terminated")
	}
}

// waitForListenerState waits for /healthz to report the Listener: 200 with
// connected=true, or 503 REALTIME_LISTENER_DISCONNECTED while it reconnects,
// because commit notifications are the only realtime wake path.
func waitForListenerState(t *testing.T, serverURL string, connected bool, timeout time.Duration) {
	t.Helper()
	client := &http.Client{Timeout: 250 * time.Millisecond}
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		response, err := client.Get(serverURL + "/healthz")
		if err == nil {
			var body struct {
				Error struct {
					Code string `json:"code"`
				} `json:"error"`
				RealtimeListener struct {
					Connected bool `json:"connected"`
				} `json:"realtime_listener"`
			}
			decodeErr := json.NewDecoder(response.Body).Decode(&body)
			_ = response.Body.Close()
			healthy := response.StatusCode == http.StatusOK && body.RealtimeListener.Connected
			disconnected := response.StatusCode == http.StatusServiceUnavailable && body.Error.Code == "REALTIME_LISTENER_DISCONNECTED"
			if decodeErr == nil && (connected && healthy || !connected && disconnected) {
				return
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("realtime Listener connected did not become %t", connected)
}

func TestSSEClosesWhenSessionExpires(t *testing.T) {
	allowParallelIntegrationTest(t)
	artifactRoot := integrationArtifactRoot(t)
	databaseURL := newIntegrationDatabase(t)
	application, err := newIntegrationApp(context.Background(), config.ForTest(func(c *config.Config) {
		c.ArtifactStorageRoot = artifactRoot
		c.DatabaseURL = databaseURL
		c.SessionTTL = 1200 * time.Millisecond
		c.CookieName = "teamhub_session"
		c.SSEHeartbeatInterval = 20 * time.Millisecond
		c.SSEQueueCapacity = 4
		c.SSEReplayBatchSize = 10
	}))
	if err != nil {
		t.Fatal(err)
	}
	defer application.Close()
	server := httptest.NewServer(application.Handler())
	defer server.Close()
	pool, err := pgxpool.New(context.Background(), databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	env := &testEnv{t: t, databaseURL: databaseURL, pool: pool, server: server}
	alice := env.login("alice", alicePassword)
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	roomID := env.createRoom(alice, acmeTenant, "Expiry "+suffix, "sse-expiry-room-"+suffix)
	response := openSSE(t, alice, eventsStreamURL(server.URL, roomID, 0), 3*time.Second)
	defer response.Body.Close()
	reader := bufio.NewReader(response.Body)
	for {
		record := readSSERecord(t, reader)
		if record.Event != "session.expired" {
			continue
		}
		var payload struct {
			Code string `json:"code"`
		}
		if err := json.Unmarshal([]byte(record.Data), &payload); err != nil {
			t.Fatal(err)
		}
		if payload.Code != "SESSION_EXPIRED" {
			t.Fatalf("payload=%s", record.Data)
		}
		break
	}
	status, _, _ := env.request(alice, http.MethodGet, "/v0/me", nil, "")
	if status != http.StatusUnauthorized {
		t.Fatalf("expired reconnect status=%d want=401", status)
	}
	t.Log("SSE-06 environment=short-session fault=expiry last_applied=1 authority_latest=1 duplicate_count=0")
}

func TestSSEClosesWhenSessionIsRevoked(t *testing.T) {
	allowParallelIntegrationTest(t)
	artifactRoot := integrationArtifactRoot(t)
	databaseURL := newIntegrationDatabase(t)
	application, err := newIntegrationApp(context.Background(), config.ForTest(func(c *config.Config) {
		c.ArtifactStorageRoot = artifactRoot
		c.DatabaseURL = databaseURL
		c.SessionTTL = time.Hour
		c.CookieName = "teamhub_session"
		c.SSEHeartbeatInterval = 20 * time.Millisecond
		c.SSEQueueCapacity = 4
		c.SSEReplayBatchSize = 10
	}))
	if err != nil {
		t.Fatal(err)
	}
	defer application.Close()
	server := httptest.NewServer(application.Handler())
	defer server.Close()
	pool, err := pgxpool.New(context.Background(), databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	env := &testEnv{t: t, databaseURL: databaseURL, pool: pool, server: server}
	alice := env.login("alice", alicePassword)
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	roomID := env.createRoom(alice, acmeTenant, "Revocation "+suffix, "sse-revoke-room-"+suffix)
	response := openSSE(t, alice, eventsStreamURL(server.URL, roomID, 0), 3*time.Second)
	defer response.Body.Close()

	cookie := sessionCookie(t, alice, server.URL)
	rawToken, err := hex.DecodeString(cookie.Value)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(rawToken)
	if _, err := pool.Exec(context.Background(), "update auth_sessions set revoked_at=now(), revoked_reason='logout' where token_hash=$1", digest[:]); err != nil {
		t.Fatal(err)
	}
	reader := bufio.NewReader(response.Body)
	for {
		record := readSSERecord(t, reader)
		if record.Event == "session.expired" {
			break
		}
	}
	status, _, _ := env.request(alice, http.MethodGet, "/v0/me", nil, "")
	if status != http.StatusUnauthorized {
		t.Fatalf("revoked reconnect status=%d want=401", status)
	}
	t.Log("SSE-06 environment=PostgreSQL fault=session-revocation last_applied=1 authority_latest=1 duplicate_count=0")
}

func TestSSEClosesDuringApplicationShutdown(t *testing.T) {
	allowParallelIntegrationTest(t)
	artifactRoot := integrationArtifactRoot(t)
	databaseURL := newIntegrationDatabase(t)
	application, err := newIntegrationApp(context.Background(), config.ForTest(func(c *config.Config) {
		c.ArtifactStorageRoot = artifactRoot
		c.DatabaseURL = databaseURL
		c.SessionTTL = time.Hour
		c.CookieName = "teamhub_session"
		c.SSEHeartbeatInterval = time.Hour
		c.SSEQueueCapacity = 4
		c.SSEReplayBatchSize = 10
	}))
	if err != nil {
		t.Fatal(err)
	}
	defer application.Close()
	server := httptest.NewServer(application.Handler())
	defer server.Close()
	pool, err := pgxpool.New(context.Background(), databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	env := &testEnv{t: t, databaseURL: databaseURL, pool: pool, server: server}
	alice := env.login("alice", alicePassword)
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	roomID := env.createRoom(alice, acmeTenant, "Shutdown "+suffix, "sse-shutdown-room-"+suffix)
	response := openSSE(t, alice, eventsStreamURL(server.URL, roomID, 0), 3*time.Second)
	defer response.Body.Close()
	reader := bufio.NewReader(response.Body)
	connected := readSSERecord(t, reader)
	if connected.Data != ": connected" {
		t.Fatalf("unexpected connection comment: %+v", connected)
	}

	application.StopStreams()
	// The replay from cursor 0 may still be buffered; the stream then ends.
	if _, err := io.ReadAll(reader); err != nil {
		t.Fatalf("stream read after shutdown error=%v want EOF", err)
	}
}

func openSSE(t *testing.T, client *http.Client, url string, timeout time.Duration) *http.Response {
	t.Helper()
	response, _ := openSSEWithContext(t, client, url, timeout)
	return response
}

func openSSEWithContext(t *testing.T, client *http.Client, url string, timeout time.Duration) (*http.Response, context.Context) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	t.Cleanup(cancel)
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusOK {
		if closeErr := response.Body.Close(); closeErr != nil {
			t.Errorf("close SSE error response: %v", closeErr)
		}
		t.Fatalf("SSE status=%d", response.StatusCode)
	}
	return response, ctx
}

// nextRoomEvent reads the next room.event of a /v0/events stream; ID carries
// its room_seq.
func nextRoomEvent(t *testing.T, reader *bufio.Reader) sseRecord {
	t.Helper()
	record, err := nextRoomEventResult(reader)
	if err != nil {
		t.Fatal(err)
	}
	return record
}

func nextRoomEventResult(reader *bufio.Reader) (sseRecord, error) {
	for {
		record, err := readSSERecordResult(reader)
		if err != nil {
			return sseRecord{}, fmt.Errorf("read SSE: %w", err)
		}
		if record.Event != "room.event" {
			continue
		}
		var event struct {
			RoomSeq int64 `json:"room_seq"`
		}
		if err := json.Unmarshal([]byte(record.Data), &event); err != nil {
			return sseRecord{}, fmt.Errorf("decode room.event %s: %w", record.Data, err)
		}
		if record.ID != "" {
			return sseRecord{}, fmt.Errorf("room.event carries SSE id %q", record.ID)
		}
		record.ID = strconv.FormatInt(event.RoomSeq, 10)
		return record, nil
	}
}

// awaitInvalidation reads a /v0/events stream until the hint for resource
// and id arrives.
func awaitInvalidation(t *testing.T, reader *bufio.Reader, resource, id string) eventsStreamHint {
	t.Helper()
	for {
		record := nextSSEEvent(t, reader, "resource.invalidated")
		var hint eventsStreamHint
		decode(t, []byte(record.Data), &hint)
		if hint.Resource == resource && hint.ID == id {
			return hint
		}
	}
}

func requireSSEReady(t *testing.T, client string, reader *bufio.Reader) {
	t.Helper()
	connected, err := readSSERecordResult(reader)
	if err != nil {
		t.Fatalf("client=%s wait for connected: %v", client, err)
	}
	if connected.Data != ": connected" || connected.ID != "" || connected.Event != "" {
		t.Fatalf("client=%s unexpected connection comment: %+v", client, connected)
	}
	// stream.resync(connected) follows the replay, so the stream is live.
	for {
		record, err := readSSERecordResult(reader)
		if err != nil {
			t.Fatalf("client=%s wait for stream.resync: %v", client, err)
		}
		if record.Event == "stream.resync" {
			return
		}
	}
}

func readExpectedRoomEvents(ctx context.Context, client string, reader *bufio.Reader, expectedSequences []int64) ([]sseRecord, error) {
	records := make([]sseRecord, 0, len(expectedSequences))
	for _, expected := range expectedSequences {
		record, err := nextRoomEventResult(reader)
		if err != nil {
			return nil, fmt.Errorf("client=%s expected_room_seq=%d: %w (context cause: %w)", client, expected, err, context.Cause(ctx))
		}
		if record.ID != strconv.FormatInt(expected, 10) {
			return nil, fmt.Errorf("client=%s room_seq=%s want=%d (context cause: %w)", client, record.ID, expected, context.Cause(ctx))
		}
		records = append(records, record)
	}
	return records, nil
}

func nextSSEEvent(t *testing.T, reader *bufio.Reader, eventName string) sseRecord {
	t.Helper()
	for {
		record := readSSERecord(t, reader)
		if record.Event == eventName {
			return record
		}
	}
}

func readSSERecord(t *testing.T, reader *bufio.Reader) sseRecord {
	t.Helper()
	record, err := readSSERecordResult(reader)
	if err != nil {
		t.Fatalf("read SSE: %v", err)
	}
	return record
}

func readSSERecordResult(reader *bufio.Reader) (sseRecord, error) {
	record := sseRecord{}
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			return sseRecord{}, err
		}
		line = strings.TrimSuffix(strings.TrimSuffix(line, "\n"), "\r")
		if line == "" {
			return record, nil
		}
		if strings.HasPrefix(line, ":") {
			record.Data = line
			continue
		}
		name, value, found := strings.Cut(line, ":")
		if !found {
			continue
		}
		value = strings.TrimPrefix(value, " ")
		switch name {
		case "id":
			record.ID = value
		case "event":
			record.Event = value
		case "data":
			record.Data = value
		}
	}
}
