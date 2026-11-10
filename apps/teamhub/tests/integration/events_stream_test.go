package integration_test

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/config"
)

type eventsStreamRoomEvent struct {
	EventID   string `json:"event_id"`
	RoomID    string `json:"room_id"`
	RoomSeq   int64  `json:"room_seq"`
	EventType string `json:"event_type"`
}

type eventsStreamHint struct {
	TenantID string `json:"tenant_id"`
	Resource string `json:"resource"`
	ID       string `json:"id"`
	RoomSeq  int64  `json:"room_seq"`
}

func newEventsStreamEnv(t *testing.T, heartbeat time.Duration) (*testEnv, *pgxpool.Pool) {
	t.Helper()
	artifactRoot := integrationArtifactRoot(t)
	databaseURL := newIntegrationDatabase(t)
	pool, err := pgxpool.New(t.Context(), databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	application, err := newIntegrationApp(t.Context(), config.ForTest(func(c *config.Config) {
		c.ArtifactStorageRoot = artifactRoot
		c.DatabaseURL = databaseURL
		c.SessionTTL = time.Hour
		c.CookieName = "teamhub_session"
		c.SSEHeartbeatInterval = heartbeat
		c.SSEQueueCapacity = 64
		c.SSEReplayBatchSize = 2
	}))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(application.Close)
	server := httptest.NewServer(application.Handler())
	registerIntegrationServerCleanup(t, server)
	return &testEnv{t: t, databaseURL: databaseURL, pool: pool, server: server}, pool
}

func nextEventsStreamRoomEvent(t *testing.T, reader *bufio.Reader) eventsStreamRoomEvent {
	t.Helper()
	record := nextSSEEvent(t, reader, "room.event")
	var event eventsStreamRoomEvent
	if err := json.Unmarshal([]byte(record.Data), &event); err != nil {
		t.Fatalf("decode room.event %s: %v", record.Data, err)
	}
	return event
}

func TestEventsStreamReplaysCursorRoomsAndForwardsHints(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, _ := newEventsStreamEnv(t, time.Hour)
	alice := env.login("alice", alicePassword)
	otherDevice := env.login("alice", alicePassword)
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	activeRoomID := env.createRoom(alice, acmeTenant, "Events active "+suffix, "events-active-"+suffix)
	otherRoomID := env.createRoom(alice, acmeTenant, "Events other "+suffix, "events-other-"+suffix)
	after := currentEventWatermark(t, env, otherDevice, "/v0/rooms/"+activeRoomID+"/events", "latest_room_seq")
	for index := range 3 {
		env.createMessage(alice, activeRoomID, fmt.Sprintf("before %d", index), fmt.Sprintf("events-before-%s-%d", suffix, index))
	}

	t.Run("invalid cursors are rejected", func(t *testing.T) {
		for _, query := range []string{"room=" + activeRoomID, "room=" + activeRoomID + ":-1", "room=a:b:1"} {
			status, _, body := env.request(otherDevice, http.MethodGet, "/v0/events?"+query, nil, "")
			if status != http.StatusBadRequest {
				t.Fatalf("%s status=%d body=%s", query, status, body)
			}
		}
	})

	response := openSSE(t, otherDevice, env.server.URL+"/v0/events?room="+activeRoomID+":"+strconv.FormatInt(after, 10), 10*time.Second)
	defer response.Body.Close()
	reader := bufio.NewReader(response.Body)
	for expected := after + 1; expected <= after+3; expected++ {
		if event := nextEventsStreamRoomEvent(t, reader); event.RoomID != activeRoomID || event.RoomSeq != expected {
			t.Fatalf("replay event=%+v want room_seq=%d", event, expected)
		}
	}
	if resync := nextSSEEvent(t, reader, "stream.resync"); resync.Data != `{"reason":"connected"}` {
		t.Fatalf("resync=%+v", resync)
	}

	env.createMessage(alice, activeRoomID, "live", "events-live-"+suffix)
	if event := nextEventsStreamRoomEvent(t, reader); event.RoomID != activeRoomID || event.RoomSeq != after+4 {
		t.Fatalf("live event=%+v want room_seq=%d", event, after+4)
	}

	// A Room without a cursor only invalidates.
	env.createMessage(alice, otherRoomID, "elsewhere", "events-other-message-"+suffix)
	for {
		record := readSSERecord(t, reader)
		if record.Event == "room.event" {
			var event eventsStreamRoomEvent
			decode(t, []byte(record.Data), &event)
			if event.RoomID == otherRoomID {
				t.Fatalf("a Room without a cursor streamed its event: %s", record.Data)
			}
			continue
		}
		if record.Event != "resource.invalidated" {
			continue
		}
		var hint eventsStreamHint
		decode(t, []byte(record.Data), &hint)
		if hint.Resource == "room" && hint.ID == otherRoomID {
			if hint.TenantID != acmeTenant || hint.RoomSeq < 1 {
				t.Fatalf("Room hint=%+v", hint)
			}
			break
		}
	}
}

// room_seq is allocated under the Room row lock held until commit, so a
// transaction that commits later always takes the higher room_seq and a
// stream that already passed the earlier one cannot skip it.
func TestEventsStreamDeliversConcurrentLateCommitsInOrder(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, pool := newEventsStreamEnv(t, time.Hour)
	alice := env.login("alice", alicePassword)
	otherDevice := env.login("alice", alicePassword)
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	roomID := env.createRoom(alice, acmeTenant, "Late commit "+suffix, "events-late-"+suffix)
	after := currentEventWatermark(t, env, otherDevice, "/v0/rooms/"+roomID+"/events", "latest_room_seq")
	response := openSSE(t, otherDevice, env.server.URL+"/v0/events?room="+roomID+":"+strconv.FormatInt(after, 10), 15*time.Second)
	defer response.Body.Close()
	reader := bufio.NewReader(response.Body)
	nextSSEEvent(t, reader, "stream.resync")

	insertEvent := func(ctx context.Context, tx pgx.Tx, eventID string) (int64, error) {
		var roomSeq int64
		if err := tx.QueryRow(ctx, `UPDATE rooms SET next_room_seq=next_room_seq+1 WHERE id=$1 RETURNING next_room_seq`, roomID).Scan(&roomSeq); err != nil {
			return 0, err
		}
		_, err := tx.Exec(ctx, `INSERT INTO room_events(event_id,tenant_id,room_id,room_seq,event_type,actor_id,resource_id,payload)
			VALUES ($1,$2,$3,$4,'message.created','actor_acme_alice',$5,'{"kind":"message.created"}'::jsonb)`,
			eventID, acmeTenant, roomID, roomSeq, "resource_"+eventID)
		return roomSeq, err
	}
	first, err := pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer first.Rollback(context.Background())
	firstSeq, err := insertEvent(t.Context(), first, "event_late_first_"+suffix)
	if err != nil {
		t.Fatal(err)
	}
	type allocation struct {
		seq int64
		err error
	}
	second := make(chan allocation, 1)
	go func() {
		tx, err := pool.Begin(context.Background())
		if err != nil {
			second <- allocation{err: err}
			return
		}
		defer tx.Rollback(context.Background())
		seq, err := insertEvent(context.Background(), tx, "event_late_second_"+suffix)
		if err == nil {
			err = tx.Commit(context.Background())
		}
		second <- allocation{seq: seq, err: err}
	}()
	select {
	case result := <-second:
		t.Fatalf("second transaction allocated room_seq=%d err=%v before the first committed", result.seq, result.err)
	case <-time.After(300 * time.Millisecond):
	}
	if err := first.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
	result := <-second
	if result.err != nil {
		t.Fatal(result.err)
	}
	if firstSeq != after+1 || result.seq != firstSeq+1 {
		t.Fatalf("first=%d second=%d after=%d", firstSeq, result.seq, after)
	}
	for _, expected := range []int64{firstSeq, result.seq} {
		event := nextEventsStreamRoomEvent(t, reader)
		if event.RoomSeq != expected {
			t.Fatalf("event=%+v want room_seq=%d", event, expected)
		}
	}
}

func TestEventsStreamDropsCursorOfAnUnreadableRoom(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, _ := newEventsStreamEnv(t, time.Hour)
	alice := env.login("alice", alicePassword)
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	roomID := "room_missing_" + suffix
	response := openSSE(t, alice, env.server.URL+"/v0/events?room="+roomID+":0", 5*time.Second)
	defer response.Body.Close()
	reader := bufio.NewReader(response.Body)
	for {
		record, err := readSSERecordResult(reader)
		if err != nil {
			t.Fatalf("read: %v", err)
		}
		switch record.Event {
		case "room.event", "resource.invalidated":
			// The cursor names no Room the Human can read, so nothing reaches it.
			t.Fatalf("unreadable Room record=%+v", record)
		case "stream.resync":
			return
		}
	}
}
