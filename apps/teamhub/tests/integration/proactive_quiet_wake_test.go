package integration_test

import (
	"errors"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/messagecreation"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/proactive"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/reminder"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

// TestProactiveWindowsAndQuietWakes covers the AnotherMe direct Room review:
// a Room seen first starts after its history, a window opens at twenty new
// ordinary messages and is judged once; queued wakes wait for three quiet
// minutes, then go out in order as hidden messages spoken by the Human, and
// wake-answer exclusions are covered by TestProactiveRecordsOnlyAnotherMesWakeAnswers.
func TestProactiveWindowsAndQuietWakes(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, pool := newConnectedAnotherMeEnv(t, nil)
	roomID := anotherMeRoomID(t, pool, "actor_acme_alice")
	var managementID, agentID string
	if err := pool.QueryRow(t.Context(), `SELECT agent_management_id, actor_id FROM agent_registrations
		WHERE represented_human_actor_id='actor_acme_alice' AND agent_type='anotherme'`).Scan(&managementID, &agentID); err != nil {
		t.Fatal(err)
	}
	service := proactive.New(pool, nil, nil)
	ctx := t.Context()

	if _, err := service.NextWindow(ctx, "agent_not_anotherme", roomID); !errors.Is(err, proactive.ErrNotAnotherMeRoom) {
		t.Fatalf("foreign Agent read the window: %v", err)
	}
	postConversation(t, pool, "actor_acme_alice", roomID, "old message")
	if window, err := service.NextWindow(ctx, managementID, roomID); err != nil || window != nil {
		t.Fatalf("first sight must start after history: %+v %v", window, err)
	}
	for i := range proactive.WindowSize - 1 {
		author := "actor_acme_alice"
		if i%2 == 1 {
			author = agentID
		}
		postConversation(t, pool, author, roomID, "message "+strconv.Itoa(i))
	}
	if window, err := service.NextWindow(ctx, managementID, roomID); err != nil || window != nil {
		t.Fatalf("nineteen messages opened a window: %+v %v", window, err)
	}
	postConversation(t, pool, "actor_acme_alice", roomID, "tomorrow remind me to submit the report")
	window, err := service.NextWindow(ctx, managementID, roomID)
	if err != nil || window == nil || len(window.Messages) != proactive.WindowSize ||
		window.Messages[19].Text != "tomorrow remind me to submit the report" || window.Messages[1].Author != "agent" || window.Guideline.Version != proactive.DefaultGuideline().Version {
		t.Fatalf("window=%+v err=%v", window, err)
	}
	if err := service.FinishWindow(ctx, managementID, roomID, window.JudgedCount); err != nil {
		t.Fatal(err)
	}
	if err := service.FinishWindow(ctx, managementID, roomID, window.JudgedCount); !errors.Is(err, proactive.ErrWindowMoved) {
		t.Fatalf("a window was judged twice: %v", err)
	}
	if next, err := service.NextWindow(ctx, managementID, roomID); err != nil || next != nil {
		t.Fatalf("judged window reopened: %+v %v", next, err)
	}

	for _, body := range []string{"[Proactive review] first item", "[Proactive review] second item"} {
		if err := service.QueueWake(ctx, managementID, roomID, body); err != nil {
			t.Fatal(err)
		}
	}
	first := pendingWakeID(t, pool, roomID)
	if wait, err := reminder.Deliver(ctx, pool, first, time.Now(), reminder.Window); err != nil || wait <= 0 || pendingWakeID(t, pool, roomID) != first {
		t.Fatalf("a wake interrupted the conversation: wait=%v err=%v", wait, err)
	}
	later := time.Now().Add(reminder.Window + time.Minute)
	if wait, err := reminder.Deliver(ctx, pool, first, later, reminder.Window); err != nil || wait != 0 {
		t.Fatalf("quiet Room did not deliver: wait=%v err=%v", wait, err)
	}
	// Messages of one delivery share a timestamp; the Room sequence is the order people see.
	rows, err := pool.Query(ctx, `SELECT m.body FROM messages m
		JOIN room_events e ON e.room_id=m.room_id AND e.resource_id=m.id AND e.event_type='message.created'
		WHERE m.room_id=$1 AND m.message_kind='agent_runtime'
		AND m.author_actor_id='actor_acme_alice' AND m.body LIKE '%[Proactive review]%' ORDER BY e.room_seq`, roomID)
	if err != nil {
		t.Fatal(err)
	}
	var delivered []string
	for rows.Next() {
		var body string
		if err := rows.Scan(&body); err != nil {
			t.Fatal(err)
		}
		delivered = append(delivered, body)
	}
	if rows.Err() != nil || len(delivered) != 2 || !strings.Contains(delivered[0], "first item") || !strings.Contains(delivered[1], "second item") {
		t.Fatalf("delivered=%q", delivered)
	}
	if countRows(t, env, `SELECT count(*) FROM messages m
		WHERE m.room_id=$1 AND m.message_kind='agent_runtime' AND $2=ANY(m.mentioned_actor_ids)`, roomID, agentID) < 2 {
		t.Fatal("hidden wakes do not mention AnotherMe")
	}

}

// The first wake has no prior wake answer to exclude. A recent ordinary Agent
// reply must keep the Room busy even when the Human last spoke long ago.
func TestFirstQuietWakeWaitsForOrdinaryAgentReply(t *testing.T) {
	allowParallelIntegrationTest(t)
	_, pool := newConnectedAnotherMeEnv(t, nil)
	ctx := t.Context()
	roomID := anotherMeRoomID(t, pool, "actor_acme_alice")
	var managementID, agentID string
	if err := pool.QueryRow(ctx, `SELECT agent_management_id, actor_id FROM agent_registrations
		WHERE represented_human_actor_id='actor_acme_alice' AND agent_type='anotherme'`).Scan(&managementID, &agentID); err != nil {
		t.Fatal(err)
	}
	postConversation(t, pool, "actor_acme_alice", roomID, "please investigate")
	postConversation(t, pool, agentID, roomID, "investigation finished")
	now := time.Now().UTC().Truncate(time.Microsecond)
	if _, err := pool.Exec(ctx, `UPDATE messages SET created_at=$2 WHERE room_id=$1`, roomID, now.Add(-10*time.Minute)); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE messages SET created_at=$2 WHERE room_id=$1 AND author_actor_id=$3`, roomID, now.Add(-time.Minute), agentID); err != nil {
		t.Fatal(err)
	}
	if err := proactive.New(pool, nil, nil).QueueWake(ctx, managementID, roomID, "[Proactive review] first reminder"); err != nil {
		t.Fatal(err)
	}
	id := pendingWakeID(t, pool, roomID)
	if wait, err := reminder.Deliver(ctx, pool, id, now, reminder.Window); err != nil || wait != 2*time.Minute {
		t.Fatalf("ordinary Agent reply must hold first wake for two more minutes: wait=%v err=%v", wait, err)
	}
	if pendingWakeID(t, pool, roomID) != id {
		t.Fatal("first wake was delivered before the Room became quiet")
	}
	if wait, err := reminder.Deliver(ctx, pool, id, now.Add(2*time.Minute), reminder.Window); err != nil || wait != 0 {
		t.Fatalf("quiet Room did not release its first wake: wait=%v err=%v", wait, err)
	}
}

func pendingWakeID(t *testing.T, pool *pgxpool.Pool, roomID string) string {
	t.Helper()
	var id string
	if err := pool.QueryRow(t.Context(), `SELECT id FROM proactive_pending_wakes
		WHERE room_id=$1 AND delivered_at IS NULL ORDER BY created_at, id LIMIT 1`, roomID).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

func postConversation(t *testing.T, pool *pgxpool.Pool, actorID, roomID, body string) {
	t.Helper()
	queries := store.New(pool)
	author, err := queries.GetActor(t.Context(), store.GetActorParams{ID: actorID, TenantID: acmeTenant})
	if err != nil {
		t.Fatal(err)
	}
	content, err := messagecreation.Normalize([]messagecreation.Segment{{Type: "text", Content: body}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := messagecreation.Create(t.Context(), queries, messagecreation.Draft{
		TenantID: acmeTenant, RoomID: roomID, Author: author, Content: content,
	}); err != nil {
		t.Fatal(err)
	}
}
