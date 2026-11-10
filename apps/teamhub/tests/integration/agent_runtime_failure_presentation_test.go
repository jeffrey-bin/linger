package integration_test

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentruntimestate"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

func TestAgentRuntimeStartupFailurePersistsPublicPresentation(t *testing.T) {
	allowParallelIntegrationTest(t)
	env := newRuntimeStateTestEnv(t)
	const roomID = "room_startup_failure"
	insertRuntimeRoomMembership(t, env.pool, roomID)
	env = useRuntimeRoomContext(t, env, roomID)
	messageID := createAgentMentionRequest(t, env.pool, roomID, "actor_acme_alice")
	submitted := acceptPresentationInboxMessage(t, env, roomID, messageID)
	if _, err := env.service.ClaimLocalRun(t.Context(), agentruntimestate.ClaimLocalRunInput{
		ClaimID: "claim-startup-failure", ContextKey: env.contextKey, Epoch: env.epoch,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := env.service.OpenRuntimeStatus(t.Context(), agentruntimestate.OpenStatusInput{ContextKey: env.contextKey, Epoch: env.epoch,
		LocalRunID: submitted.RunID, InitialSourceIDs: []string{"room:" + roomID},
	}); err != nil {
		t.Fatal(err)
	}
	// The provider failed before any working event; the failure must still be
	// the visible terminal event. A Message transaction queues the Run without
	// a queued event, so the failure can be the Run's only event.
	terminal := json.RawMessage(`{"type":"failed","error":"private native failure","failure":{"code":"session_not_found","runtime_type":"codex","runtime_version":"0.153.4"}}`)
	finish := agentruntimestate.FinishLocalRunInput{ContextKey: env.contextKey, Epoch: env.epoch,
		RunID: submitted.RunID, Terminal: terminal,
	}
	for range 2 {
		if _, err := env.service.FinishLocalRun(t.Context(), finish); err != nil {
			t.Fatal(err)
		}
	}
	var raw []byte
	var eventCount int
	if err := env.pool.QueryRow(t.Context(), `SELECT payload, (SELECT count(*) FROM agent_runtime_status_events WHERE local_run_id=$1)
   FROM agent_runtime_status_events WHERE local_run_id=$1 ORDER BY event_ordinal DESC LIMIT 1`, submitted.RunID).Scan(&raw, &eventCount); err != nil {
		t.Fatal(err)
	}
	var event struct {
		Status  string                                 `json:"status"`
		Outcome string                                 `json:"outcome"`
		Failure agentruntimestate.PublicRuntimeFailure `json:"failure"`
	}
	if err := json.Unmarshal(raw, &event); err != nil {
		t.Fatal(err)
	}
	if eventCount != 1 || event.Status != "stopped" || event.Outcome != "failed" || event.Failure.Code != "session_not_found" || event.Failure.RuntimeVersion != "0.153.4" || strings.Contains(string(raw), "private") {
		t.Fatalf("unexpected public failure: events=%d payload=%s", eventCount, raw)
	}
	var accountID string
	if err := env.pool.QueryRow(t.Context(), `SELECT account_id FROM actors WHERE id='actor_acme_alice'`).Scan(&accountID); err != nil {
		t.Fatal(err)
	}
	query := store.New(env.pool)
	runs, err := query.ListRuntimePresentationRunsForAccountByRoom(t.Context(), store.ListRuntimePresentationRunsForAccountByRoomParams{
		AccountID: accountID, RoomID: roomID, MessageIds: []string{messageID},
	})
	if err != nil || len(runs) != 1 || runs[0].Status != "failed" {
		t.Fatalf("reload failure by original input: count=%d err=%v", len(runs), err)
	}
	// The canonical accepted Inbox input has a synthetic notification ID;
	// public reload resolves its actual invocation Message without rewriting it.
	runs, err = query.ListRuntimePresentationRunsForAccountByRoom(t.Context(), store.ListRuntimePresentationRunsForAccountByRoomParams{
		AccountID: accountID, RoomID: roomID, MessageIds: []string{messageID},
	})
	if err != nil || len(runs) != 1 {
		t.Fatalf("reload failure by accepted inbox message: count=%d err=%v", len(runs), err)
	}
	unrelated, err := query.ListRuntimePresentationRunsForAccountByRoom(t.Context(), store.ListRuntimePresentationRunsForAccountByRoomParams{
		AccountID: accountID, RoomID: roomID, MessageIds: []string{"unrelated-message"},
	})
	if err != nil || len(unrelated) != 0 {
		t.Fatalf("unrelated input matched failed run: count=%d err=%v", len(unrelated), err)
	}
	t.Run("exact Run recovery retains the terminal Run and enforces Room visibility", func(t *testing.T) {
		rows, err := query.ListRuntimePresentationRunsForAccountByRoom(t.Context(), store.ListRuntimePresentationRunsForAccountByRoomParams{
			AccountID: accountID, RoomID: roomID, RunID: submitted.RunID,
		})
		if err != nil || len(rows) != 1 || rows[0].RunID != submitted.RunID || rows[0].Status != "failed" {
			t.Fatalf("terminal Run recovery: rows=%+v err=%v", rows, err)
		}
		current, err := query.GetRoomRunStatusForAccount(t.Context(), store.GetRoomRunStatusForAccountParams{
			AccountID: accountID, RoomID: roomID, RunID: submitted.RunID,
		})
		if err != nil || current.Status != "failed" || current.EventOrdinal != 1 {
			t.Fatalf("Run status: %+v err=%v", current, err)
		}
		visible, err := query.ListVisibleRoomRunStatusesForAccount(t.Context(), store.ListVisibleRoomRunStatusesForAccountParams{AccountID: accountID, RoomID: roomID})
		if err != nil || len(visible) != 1 || visible[0].RunID != submitted.RunID {
			t.Fatalf("failed Run left the visible statuses: %+v err=%v", visible, err)
		}
		for _, target := range []store.ListRuntimePresentationRunsForAccountByRoomParams{
			{AccountID: accountID, RoomID: roomID, RunID: "different-run"},
			{AccountID: accountID, RoomID: "unrelated-room", RunID: submitted.RunID},
			{AccountID: "unrelated-account", RoomID: roomID, RunID: submitted.RunID},
		} {
			rows, err := query.ListRuntimePresentationRunsForAccountByRoom(t.Context(), target)
			if err != nil || len(rows) != 0 {
				t.Fatalf("Run status crossed visibility: %+v rows=%+v err=%v", target, rows, err)
			}
		}
	})
}

// acceptPresentationInboxMessage returns the Run TeamHub queued for env's
// Context when messageID committed, and checks the Message provenance it froze.
func acceptPresentationInboxMessage(t *testing.T, env runtimeStateTestEnv, roomID, messageID string) queuedRuntimeInboxInput {
	t.Helper()
	inboxID := "room:" + roomID
	queued := queuedRuntimeInbox(t, env.pool, env.contextKey, messageID)
	if queued.RunID == "" {
		t.Fatalf("Message %s queued no Run: %+v", messageID, queued)
	}
	var canonical bool
	if err := env.pool.QueryRow(t.Context(), `SELECT source_kind='inbox' AND source_message_id=$3 AND source_inbox_id=$4
 AND payload#>>'{acceptedNotification,cursorEncoding}'='room_event_v1'
 AND payload->'invocationMessageIds'=jsonb_build_array($3::text)
 AND payload#>>'{acceptedNotification,messages,0,id}'=$3
 FROM agent_runtime_inputs WHERE context_key=$1 AND input_id=$2`, env.contextKey, queued.InputID, messageID, inboxID).Scan(&canonical); err != nil {
		t.Fatal(err)
	}
	if !canonical {
		t.Fatal("presentation lost canonical input source and invocation Message provenance")
	}
	return queued
}
