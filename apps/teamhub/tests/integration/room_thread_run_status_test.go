package integration_test

import (
	"encoding/json"
	"errors"
	"slices"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentruntimestate"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

// A Run whose sources are all one Thread shows in that Thread: its status
// stream, Draft and Stop live there, while navigation still lights the
// parent Room. A Run mixing the Room and its Thread stays in the Room, and
// deleting the Room also ends the Thread's status.
func TestRoomThreadRunShowsInItsThread(t *testing.T) {
	allowParallelIntegrationTest(t)
	env := newRuntimeStateTestEnv(t)
	ctx := t.Context()
	queries := store.New(env.pool)
	const parentID, threadID = testRuntimeInboxRoom, "room_thread_run_status"
	insertRuntimeStatusMessageFixture(t, env.pool, parentID, "message_thread_run_root", "thread root")
	createThreadRoomFixture(t, env.pool, parentID, threadID, "message_thread_run_root")
	var accountID string
	if err := env.pool.QueryRow(ctx, `SELECT account_id FROM actors WHERE id='actor_acme_alice'`).Scan(&accountID); err != nil {
		t.Fatal(err)
	}
	running := func() []string {
		t.Helper()
		ids, err := queries.ListRunningRoomIDsForTenantAccount(ctx, store.ListRunningRoomIDsForTenantAccountParams{TenantID: "tenant_acme", AccountID: accountID})
		if err != nil {
			t.Fatal(err)
		}
		return ids
	}
	// stopTarget reports whether Stop in roomID reaches runID, and the
	// Messages of that Room the Run holds.
	stopTarget := func(roomID, runID string) ([]string, bool) {
		t.Helper()
		row, err := queries.GetRoomRunForControl(ctx, store.GetRoomRunForControlParams{RoomID: roomID, TenantID: "tenant_acme", RunID: runID})
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, false
		}
		if err != nil {
			t.Fatal(err)
		}
		return row.MessageIds, true
	}
	streamRoom := func(runID string) string {
		t.Helper()
		return runStatusRoom(t, env.pool, runID)
	}

	const askID = "message_thread_run_ask"
	insertRuntimeStatusMessageFixture(t, env.pool, threadID, askID, "please answer in the Thread")

	const mixedSourceID = "message_thread_run_mixed_source"
	insertRuntimeStatusMessageFixture(t, env.pool, threadID, mixedSourceID, "thread follow-up")
	submit := func(inputID, sourceMessageID string, inboxIDs ...string) string {
		t.Helper()
		payload, err := json.Marshal(map[string]any{"messageId": inputID, "body": inputID, "sourceInboxIds": inboxIDs})
		if err != nil {
			t.Fatal(err)
		}
		submitted, err := env.service.SubmitTrustedTurn(ctx, agentruntimestate.SubmitTrustedTurnInput{ContextKey: env.contextKey, Epoch: env.epoch,
			Inputs: []agentruntimestate.RuntimeInput{{InputID: inputID, Payload: payload, SourceKind: "trusted_turn", SourceMessageID: sourceMessageID}},
		})
		if err != nil {
			t.Fatalf("submit %s: %v", inputID, err)
		}
		return submitted.RunID
	}
	threadRun := submit("thread-run-input", askID, "thread:"+threadID)
	mixedRun := submit("mixed-run-input", mixedSourceID, "room:"+parentID, "thread:"+threadID)
	if room := streamRoom(threadRun); room != threadID {
		t.Fatalf("Thread-only Run shows in %q, want the Thread", room)
	}
	if room := streamRoom(mixedRun); room != parentID {
		t.Fatalf("mixed Run shows in %q, want the parent Room", room)
	}
	if messages, found := stopTarget(threadID, threadRun); !found || !slices.Equal(messages, []string{askID}) {
		t.Fatalf("Thread Stop target=%v found=%v, want the Thread Run with its Message", messages, found)
	}
	if _, found := stopTarget(parentID, threadRun); found {
		t.Fatal("parent Room Stop reached the Thread Run")
	}
	// The mixed Run's only source Message is in the Thread, so the parent Room
	// reaches it without Messages of its own.
	if messages, found := stopTarget(parentID, mixedRun); !found || len(messages) != 0 {
		t.Fatalf("parent Stop target=%v found=%v, want the mixed Run", messages, found)
	}
	if _, found := stopTarget(threadID, mixedRun); found {
		t.Fatal("Thread Stop reached the mixed Run the parent Room shows")
	}
	if got := running(); len(got) != 0 {
		t.Fatalf("queued Runs lit %v, want none", got)
	}

	// Each Room shows its own Run statuses to the parent Room's members.
	statuses := func(roomID string) []string {
		t.Helper()
		rows, err := queries.ListVisibleRoomRunStatusesForAccount(ctx, store.ListVisibleRoomRunStatusesForAccountParams{AccountID: accountID, RoomID: roomID})
		if err != nil {
			t.Fatal(err)
		}
		runs := make([]string, 0, len(rows))
		for _, row := range rows {
			runs = append(runs, row.RunID)
		}
		return runs
	}
	if got := statuses(threadID); !slices.Equal(got, []string{threadRun}) {
		t.Fatalf("Thread statuses=%v, want the Thread Run", got)
	}
	if got := statuses(parentID); !slices.Equal(got, []string{mixedRun}) {
		t.Fatalf("parent statuses=%v, want the mixed Run", got)
	}

	// A steer keeps the Run in the Room it first showed in.
	claimed, err := env.service.ClaimLocalRun(ctx, agentruntimestate.ClaimLocalRunInput{ClaimID: "claim-thread-run", ContextKey: env.contextKey, Epoch: env.epoch})
	if err != nil || claimed.Run == nil || claimed.Run.RunID != threadRun {
		t.Fatalf("claim Thread Run: %+v err=%v", claimed, err)
	}
	if got := running(); !slices.Equal(got, []string{parentID}) {
		t.Fatalf("Thread Run lit %v, want the parent Room", got)
	}
	acceptTrustedSteerGroup(t, env, threadRun, "thread-run-steer", "steer-thread-run")
	if room := streamRoom(threadRun); room != threadID {
		t.Fatalf("steered Run moved to %q", room)
	}
}
