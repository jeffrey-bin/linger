package integration_test

import (
	"encoding/json"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentruntimestate"
)

func TestQueuedRunShowsItsStatusAndCancellationStopsIt(t *testing.T) {
	allowParallelIntegrationTest(t)
	env := newRuntimeStateTestEnv(t)
	const roomID = "room_queued_status"
	const messageID = "message_queued_status"
	insertRuntimeStatusAuthorityFixture(t, env.pool, roomID, messageID)
	env = useRuntimeRoomContext(t, env, roomID)
	input := runtimeInput("queued-status-input", "trusted_turn", "room:"+roomID, "wait")
	input.SourceMessageID = messageID
	submitted, err := env.service.SubmitTrustedTurn(t.Context(), agentruntimestate.SubmitTrustedTurnInput{ContextKey: env.contextKey, Epoch: env.epoch, Inputs: []agentruntimestate.RuntimeInput{input}})
	if err != nil {
		t.Fatal(err)
	}
	// The queued Run shows in its Room before any provider claims it.
	if room := runStatusRoom(t, env.pool, submitted.RunID); room != roomID {
		t.Fatalf("queued Run status Room=%q want %q", room, roomID)
	}
	if status, ordinal := lastRunStatusAnnouncement(t, env.pool, roomID, submitted.RunID); status != "active" || ordinal != 1 {
		t.Fatalf("queued announcement status=%s ordinal=%d", status, ordinal)
	}
	canceled, err := env.service.CancelLocalRun(t.Context(), agentruntimestate.CancelLocalRunInput{ContextKey: env.contextKey, Epoch: env.epoch, RunID: submitted.RunID})
	if err != nil || canceled.Status != "canceled" {
		t.Fatalf("cancel: %+v %v", canceled, err)
	}
	if eventType, payload := lastRunStatusEvent(t, env.pool, submitted.RunID); eventType != "status.changed" || payload["status"] != "stopped" || payload["outcome"] != "canceled" {
		t.Fatalf("canceled Run last event=%s %v", eventType, payload)
	}
	if status, ordinal := lastRunStatusAnnouncement(t, env.pool, roomID, submitted.RunID); status != "aborted" || ordinal != 2 {
		t.Fatalf("canceled announcement status=%s ordinal=%d", status, ordinal)
	}
}

// runStatusRoom returns the Room that shows the Run's status, or "".
func runStatusRoom(t *testing.T, pool *pgxpool.Pool, runID string) string {
	t.Helper()
	var roomID *string
	if err := pool.QueryRow(t.Context(), `SELECT status_room_id FROM agent_local_runs WHERE run_id=$1`, runID).Scan(&roomID); err != nil {
		t.Fatal(err)
	}
	if roomID == nil {
		return ""
	}
	return *roomID
}

// lastRunStatusEvent returns the type and payload of the Run's last event.
func lastRunStatusEvent(t *testing.T, pool *pgxpool.Pool, runID string) (string, map[string]any) {
	t.Helper()
	var eventType string
	var raw []byte
	if err := pool.QueryRow(t.Context(), `
		SELECT event_type,payload FROM agent_runtime_status_events
		WHERE local_run_id=$1 ORDER BY event_ordinal DESC LIMIT 1`, runID).Scan(&eventType, &raw); err != nil {
		t.Fatal(err)
	}
	var payload map[string]any
	if err := json.Unmarshal(raw, &payload); err != nil {
		t.Fatal(err)
	}
	return eventType, payload
}

// lastRunStatusAnnouncement returns the public status and event ordinal of the
// Run's latest agent_run.status_changed Room Event.
func lastRunStatusAnnouncement(t *testing.T, pool *pgxpool.Pool, roomID, runID string) (string, int64) {
	t.Helper()
	var status string
	var ordinal int64
	if err := pool.QueryRow(t.Context(), `
		SELECT payload->'run'->>'status',(payload->'run'->>'event_ordinal')::bigint
		FROM room_events
		WHERE room_id=$1 AND event_type='agent_run.status_changed' AND resource_id=$2
		ORDER BY room_seq DESC LIMIT 1`, roomID, runID).Scan(&status, &ordinal); err != nil {
		t.Fatal(err)
	}
	return status, ordinal
}
