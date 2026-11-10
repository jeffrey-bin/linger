package integration_test

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"slices"
	"testing"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentruntimestate"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/realtime"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

// A Run whose final reply is out stops showing as working everywhere at once:
// the Room list and the Run status read the same server fact, and the flip
// tells every browser to refetch. New work after the reply, a reply that says more
// follows, or an input newer than the reply makes it working again.
func TestRunStopsWorkingOnceItReplied(t *testing.T) {
	allowParallelIntegrationTest(t)
	env := newRuntimeStateTestEnv(t)
	ctx := t.Context()
	queries := store.New(env.pool)
	const roomID = "room_run_replied"
	const askID = "message_run_replied_ask"
	insertRuntimeStatusAuthorityFixture(t, env.pool, roomID, askID)
	env = useRuntimeRoomContext(t, env, roomID)
	var accountID string
	if err := env.pool.QueryRow(ctx, `SELECT account_id FROM actors WHERE id='actor_acme_alice'`).Scan(&accountID); err != nil {
		t.Fatal(err)
	}

	input := runtimeInput("run-replied-input", "trusted_turn", "room:"+roomID, "weather tomorrow")
	input.SourceMessageID = askID
	submitted, err := env.service.SubmitTrustedTurn(ctx, agentruntimestate.SubmitTrustedTurnInput{ContextKey: env.contextKey, Epoch: env.epoch,
		Inputs: []agentruntimestate.RuntimeInput{input},
	})
	if err != nil {
		t.Fatalf("submit: %v", err)
	}
	runID := submitted.RunID
	if claimed, err := env.service.ClaimLocalRun(ctx, agentruntimestate.ClaimLocalRunInput{
		ClaimID: "claim-run-replied", ContextKey: env.contextKey, Epoch: env.epoch,
	}); err != nil || claimed.Run == nil {
		t.Fatalf("claim: %+v err=%v", claimed, err)
	}
	if opened, err := env.service.OpenRuntimeStatus(ctx, agentruntimestate.OpenStatusInput{ContextKey: env.contextKey, Epoch: env.epoch,
		LocalRunID: runID, InitialSourceIDs: []string{"room:" + roomID},
	}); err != nil || !opened.Opened {
		t.Fatalf("open status: %+v err=%v", opened, err)
	}
	offer := func(commandID string, event map[string]any) {
		t.Helper()
		payload, err := json.Marshal(event)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := env.service.OfferRuntimePresentationEvents(ctx, agentruntimestate.OfferPresentationEventsInput{
			LocalRunID: runID, Events: []agentruntimestate.OfferedPresentationEvent{{CommandID: commandID, Event: payload}},
		}); err != nil {
			t.Fatalf("offer %s: %v", commandID, err)
		}
	}
	reply := func(messageID string, continues bool) {
		t.Helper()
		insertRuntimeRunMessageFixture(t, env.pool, roomID, messageID, runID, "answer")
		invocation := sha256.Sum256([]byte(messageID))
		recordRuntimePresentationOutput(t, env.pool, agentruntimestate.PresentationOutput{
			LocalRunID: runID, TenantID: "tenant_acme", RoomID: roomID, AgentActorID: "actor_acme_official",
			InvocationID: "agent-invocation-sha256:" + hex.EncodeToString(invocation[:]),
			OutputID:     messageID, OutputKind: "message", Surface: "room_timeline", MessageID: messageID, Continues: continues,
		})
	}
	working := func(want bool) {
		t.Helper()
		rooms, err := queries.ListRunningRoomIDsForTenantAccount(ctx, store.ListRunningRoomIDsForTenantAccountParams{TenantID: "tenant_acme", AccountID: accountID})
		if err != nil {
			t.Fatal(err)
		}
		if got := slices.Contains(rooms, roomID); got != want {
			t.Fatalf("Room list working=%v, want %v", got, want)
		}
		status, err := queries.GetAgentRunStatus(ctx, runID)
		if err != nil || status.Replied == want {
			t.Fatalf("Run status replied=%v err=%v, want %v", status.Replied, err, !want)
		}
		// Stop still reaches the Run however it is shown.
		target, err := queries.GetRoomRunForControl(ctx, store.GetRoomRunForControlParams{RoomID: roomID, TenantID: "tenant_acme", RunID: runID})
		if err != nil || target.RunID != runID {
			t.Fatalf("cancel lookup = %+v err=%v", target, err)
		}
	}
	hints := listenTenantHints(t, env.pool)
	agentHints := func() int { return hints()[realtime.InvalidationKindPrefix+realtime.InvalidateAgents] }

	// The reply command runs, publishes the final answer, and is still open.
	offer("replied-send-start", map[string]any{"type": "activity.started", "activity_id": "send", "kind": "message", "title": "Sending"})
	reply("message_run_replied_answer", false)
	working(true)
	agentHints()

	// Its activity finishing is when the Agent has replied.
	offer("replied-send-finish", map[string]any{"type": "activity.finished", "activity_id": "send", "outcome": "succeeded"})
	working(false)
	if got := agentHints(); got != 1 {
		t.Fatalf("agent hints after the reply = %d, want 1", got)
	}

	// The native turn ending its last model request only thinks.
	offer("replied-thinking", map[string]any{"type": "status.changed", "status": "thinking", "title": "Wrapping up"})
	working(false)
	if got := agentHints(); got != 0 {
		t.Fatalf("agent hints while thinking = %d, want 0", got)
	}

	// New work after the reply makes the Agent working again.
	offer("replied-more-start", map[string]any{"type": "activity.started", "activity_id": "more", "kind": "command", "title": "Checking"})
	working(true)
	if got := agentHints(); got != 1 {
		t.Fatalf("agent hints after new work = %d, want 1", got)
	}
	offer("replied-more-finish", map[string]any{"type": "activity.finished", "activity_id": "more", "outcome": "succeeded"})
	working(true)

	// A reply that says more follows is not the final one.
	offer("replied-progress-start", map[string]any{"type": "activity.started", "activity_id": "progress", "kind": "message", "title": "Sending"})
	reply("message_run_replied_progress", true)
	offer("replied-progress-finish", map[string]any{"type": "activity.finished", "activity_id": "progress", "outcome": "succeeded"})
	working(true)

	offer("replied-final-start", map[string]any{"type": "activity.started", "activity_id": "final", "kind": "message", "title": "Sending"})
	reply("message_run_replied_final", false)
	offer("replied-final-finish", map[string]any{"type": "activity.finished", "activity_id": "final", "outcome": "succeeded"})
	working(false)

	// A follow-up newer than the reply is work the Agent has not answered.
	acceptTrustedSteerGroup(t, env, runID, "run-replied-follow-up", "steer-run-replied")
	working(true)
}
