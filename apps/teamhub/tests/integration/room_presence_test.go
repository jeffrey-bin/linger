package integration_test

import (
	"context"
	"errors"
	"net/http"
	"slices"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/realtime"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

// Presence hints follow the Inbox receive predicate and reach only idle Meta
// Contexts of active Agents. They are throttled and never persisted.
func TestRoomPresencePreparesActiveAgentContexts(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newTaskWorkerEnv(t)
	roomID := createPrivateRoom(t, env, alice, "Presence", "presence-room")
	const firstActorID, secondActorID = "actor-agent-presence-a", "actor-agent-presence-b"
	for _, agentID := range []string{"agent-presence-a", "agent-presence-b"} {
		insertRuntimeRegistrationFixture(t, env.pool, agentID, "active")
		if status, body := putRoomMember(t, env, alice, roomID, "actor-"+agentID, "member"); status != http.StatusOK {
			t.Fatalf("add Agent status=%d body=%s", status, body)
		}
	}
	prepared := listenContextPrepares(t, env)
	presence := func(room string) int {
		t.Helper()
		status, _, _ := env.request(alice, http.MethodPost, "/v0/rooms/"+room+"/presence", nil, "")
		return status
	}

	if status := presence("room_missing"); status != http.StatusNotFound {
		t.Fatalf("unknown Room status=%d", status)
	}
	firstKey := roomMetaContextKey(t, env, firstActorID, roomID)
	secondKey := roomMetaContextKey(t, env, secondActorID, roomID)
	if status := presence(roomID); status != http.StatusNoContent {
		t.Fatalf("presence status=%d", status)
	}
	want := []string{firstKey, secondKey}
	slices.Sort(want)
	got := prepared()
	slices.Sort(got)
	if !slices.Equal(got, want) {
		t.Fatalf("prepared=%v want %v", got, want)
	}
	if status := presence(roomID); status != http.StatusNoContent {
		t.Fatalf("throttled presence status=%d", status)
	}
	if keys := prepared(); len(keys) != 0 {
		t.Fatalf("throttled presence prepared %v", keys)
	}
	// The query narrows candidates by registration status; the unknown key
	// stands in for any non-Meta or terminal Context it must drop.
	queries := store.New(env.pool)
	candidates := []string{firstKey, secondKey, "context_missing_for_presence"}
	narrowed, err := queries.ListPresencePreparableContextKeys(t.Context(), candidates)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(narrowed, want) {
		t.Fatalf("narrowed=%v want %v", narrowed, want)
	}
	if _, err := env.pool.Exec(t.Context(), `UPDATE agent_registrations SET status='revoked' WHERE actor_id=$1`, secondActorID); err != nil {
		t.Fatal(err)
	}
	narrowed, err = queries.ListPresencePreparableContextKeys(t.Context(), candidates)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(narrowed, []string{firstKey}) {
		t.Fatalf("narrowed after Agent revoked=%v want [%s]", narrowed, firstKey)
	}
}

// A new Agent member added while someone is present in the Room is prepared
// at once; existing members and repeated identical PUTs get no prepare.
// A NotifyContextPrepare failure is only logged, and the 200 status is written
// independently; the shared pool offers no way to force one without a seam.
func TestRoomPresencePreparesNewlyAddedAgent(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newTaskWorkerEnv(t)
	roomID := createPrivateRoom(t, env, alice, "Presence add", "presence-add-room")
	insertRuntimeRegistrationFixture(t, env.pool, "agent-presence-existing", "active")
	if status, body := putRoomMember(t, env, alice, roomID, "actor-agent-presence-existing", "member"); status != http.StatusOK {
		t.Fatalf("add Agent status=%d body=%s", status, body)
	}
	prepared := listenContextPrepares(t, env)
	if status, _, _ := env.request(alice, http.MethodPost, "/v0/rooms/"+roomID+"/presence", nil, ""); status != http.StatusNoContent {
		t.Fatalf("presence status=%d", status)
	}
	prepared()
	const addedActorID = "actor-agent-presence-added"
	insertRuntimeRegistrationFixture(t, env.pool, "agent-presence-added", "active")
	if status, body := putRoomMember(t, env, alice, roomID, addedActorID, "member"); status != http.StatusOK {
		t.Fatalf("add Agent status=%d body=%s", status, body)
	}
	addedKey := roomMetaContextKey(t, env, addedActorID, roomID)
	if got := prepared(); !slices.Equal(got, []string{addedKey}) {
		t.Fatalf("prepared=%v want [%s]", got, addedKey)
	}
	if status, body := putRoomMember(t, env, alice, roomID, addedActorID, "member"); status != http.StatusOK {
		t.Fatalf("repeat add status=%d body=%s", status, body)
	}
	if got := prepared(); len(got) != 0 {
		t.Fatalf("repeat add prepared %v", got)
	}
}

func TestRoomPresenceSkipsAddWithoutPresence(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newTaskWorkerEnv(t)
	roomID := createPrivateRoom(t, env, alice, "No presence", "no-presence-room")
	prepared := listenContextPrepares(t, env)
	insertRuntimeRegistrationFixture(t, env.pool, "agent-no-presence", "active")
	if status, body := putRoomMember(t, env, alice, roomID, "actor-agent-no-presence", "member"); status != http.StatusOK {
		t.Fatalf("add Agent status=%d body=%s", status, body)
	}
	if got := prepared(); len(got) != 0 {
		t.Fatalf("add without presence prepared %v", got)
	}
}

func roomMetaContextKey(t *testing.T, env *testEnv, actorID, roomID string) string {
	t.Helper()
	var key string
	if err := env.pool.QueryRow(t.Context(), `SELECT context_key FROM agent_execution_contexts WHERE agent_actor_id=$1 AND context_kind='meta' AND room_id=$2`, actorID, roomID).Scan(&key); err != nil {
		t.Fatal(err)
	}
	return key
}

// listenContextPrepares returns a drain of context.prepare resource IDs
// published since the previous call.
func listenContextPrepares(t *testing.T, env *testEnv) func() []string {
	t.Helper()
	listener, err := pgx.Connect(t.Context(), env.databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close(context.Background()) })
	if _, err := listener.Exec(t.Context(), "LISTEN "+pgx.Identifier{realtime.ChannelName}.Sanitize()); err != nil {
		t.Fatal(err)
	}
	return func() []string {
		t.Helper()
		keys := []string{}
		for {
			ctx, cancel := context.WithTimeout(t.Context(), 200*time.Millisecond)
			notification, err := listener.WaitForNotification(ctx)
			cancel()
			if errors.Is(err, context.DeadlineExceeded) {
				return keys
			}
			if err != nil {
				t.Fatal(err)
			}
			decoded, err := realtime.DecodeNotification([]byte(notification.Payload))
			if err != nil {
				t.Fatal(err)
			}
			if decoded.Kind == realtime.ContextPrepareKind {
				keys = append(keys, decoded.ResourceID)
			}
		}
	}
}
