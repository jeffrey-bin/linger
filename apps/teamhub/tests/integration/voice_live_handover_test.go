package integration_test

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentruntimestate"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/realtime"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

func insertRuntimeLiveSession(t *testing.T, env runtimeStateTestEnv) {
	t.Helper()
	useAllActionableRuntimeAgent(t, env)
	_, err := env.pool.Exec(t.Context(), `INSERT INTO voice_sessions(id,tenant_id,room_id,created_by_actor_id,status,provider_room_name,participant_identity,purpose)
 VALUES('voice-handover','tenant_acme',$1,'actor_acme_alice','provisioning','live-handover','alice-live','chat_live')`, testRuntimeInboxRoom)
	if err != nil {
		t.Fatal(err)
	}
}

func TestVoiceLiveLeaseFencesQueuedMetaAndCarriesHandoverAtClaim(t *testing.T) {
	allowParallelIntegrationTest(t)
	env := newRuntimeStateTestEnv(t)
	queued, err := env.service.SubmitTrustedTurn(t.Context(), agentruntimestate.SubmitTrustedTurnInput{ContextKey: env.contextKey, Epoch: env.epoch, Inputs: []agentruntimestate.RuntimeInput{runtimeInput("input-before-live", "trusted_turn", "room:"+testRuntimeInboxRoom, "continue")}})
	if err != nil {
		t.Fatal(err)
	}
	insertRuntimeLiveSession(t, env)
	claim := func(command string) agentruntimestate.ClaimLocalRunResult {
		t.Helper()
		got, err := env.service.ClaimLocalRun(t.Context(), agentruntimestate.ClaimLocalRunInput{ClaimID: command, ContextKey: env.contextKey, Epoch: env.epoch})
		if err != nil {
			t.Fatal(err)
		}
		return got
	}
	if got := claim("claim-during-live"); got.Run != nil {
		t.Fatalf("Meta started during Live: %+v", got)
	}
	// Live refuses the claim, not the input: a Message during Live still
	// queues a Meta Run, which starts after Live.
	var recipient bool
	if err := env.pool.QueryRow(t.Context(), `SELECT EXISTS(SELECT 1 FROM agent_inbox_recipients($1) WHERE context_key=$2)`, "room:"+testRuntimeInboxRoom, env.contextKey).Scan(&recipient); err != nil || !recipient {
		t.Fatalf("Meta receives Messages during Live=%v err=%v", recipient, err)
	}
	for i := 1; i <= 23; i++ {
		queueRuntimeInboxMessage(t, env, fmt.Sprintf("live-message-%02d", i), fmt.Sprint(i), fmt.Sprintf("message %02d ", i)+strings.Repeat("x", 2000), false)
	}
	if got := claim("claim-queued-during-live"); got.Run != nil {
		t.Fatalf("Meta started a Run queued during Live: %+v", got)
	}
	queries := store.New(env.pool)
	params := store.ClaimVoiceLiveToolCallParams{VoiceSessionID: "voice-handover", CallID: "uncertain-click", TurnID: "lt-1", Name: "page_action", Arguments: `{"action":"click"}`, RequestHash: "hash-one"}
	if count, err := queries.ClaimVoiceLiveToolCall(t.Context(), params); err != nil || count != 1 {
		t.Fatalf("admit=%d %v", count, err)
	}
	if count, err := queries.ClaimVoiceLiveToolCall(t.Context(), params); err != nil || count != 0 {
		t.Fatalf("duplicate accepted=%d %v", count, err)
	}
	if _, err = env.pool.Exec(t.Context(), `UPDATE voice_sessions SET live_lease_until=clock_timestamp()-interval '1 second' WHERE id='voice-handover'`); err != nil {
		t.Fatal(err)
	}
	if count, err := queries.RenewVoiceLiveLease(t.Context(), "voice-handover"); err != nil || count != 0 {
		t.Fatalf("expired lease revived=%d %v", count, err)
	}
	params.CallID = "stale-click"
	if count, err := queries.ClaimVoiceLiveToolCall(t.Context(), params); err != nil || count != 0 {
		t.Fatalf("stale tool admitted=%d %v", count, err)
	}
	got := claim("claim-after-live")
	if got.Run == nil || got.Run.RunID != queued.RunID {
		t.Fatalf("queued task lost: %+v", got)
	}
	var payload struct {
		Handover struct {
			Messages []struct {
				Body      string `json:"body"`
				Truncated bool   `json:"truncated"`
			} `json:"messages"`
			Operations []any `json:"unconfirmed_operations"`
		} `json:"liveHandover"`
	}
	if err = json.Unmarshal(got.Run.Inputs[0].Payload, &payload); err != nil {
		t.Fatal(err)
	}
	if len(payload.Handover.Messages) != 20 || !strings.HasPrefix(payload.Handover.Messages[0].Body, "message 04 ") || !payload.Handover.Messages[0].Truncated || len(payload.Handover.Operations) != 1 {
		t.Fatalf("handover=%s", got.Run.Inputs[0].Payload)
	}
	var stored bool
	if err = env.pool.QueryRow(t.Context(), `SELECT payload ? 'liveHandover' FROM agent_runtime_inputs WHERE context_key=$1 AND input_id='input-before-live'`, env.contextKey).Scan(&stored); err != nil || !stored {
		t.Fatalf("handover not durable: %v %v", stored, err)
	}
	// A canceled receiver must not consume the context transfer for the next Run.
	if _, err = env.service.FinishLocalRun(t.Context(), agentruntimestate.FinishLocalRunInput{ContextKey: env.contextKey, Epoch: env.epoch, RunID: got.Run.RunID, Terminal: json.RawMessage(`{"type":"canceled"}`)}); err != nil {
		t.Fatal(err)
	}
	if _, err = env.service.SubmitTrustedTurn(t.Context(), agentruntimestate.SubmitTrustedTurnInput{ContextKey: env.contextKey, Epoch: env.epoch, Inputs: []agentruntimestate.RuntimeInput{runtimeInput("input-after-cancel", "trusted_turn", "room:"+testRuntimeInboxRoom, "resume")}}); err != nil {
		t.Fatal(err)
	}
	resumed := claim("claim-after-cancel")
	if resumed.Run == nil || !strings.Contains(string(resumed.Run.Inputs[0].Payload), "liveHandover") {
		t.Fatalf("canceled receiver lost handover: %+v", resumed)
	}
}

func TestVoiceLiveRequestsOldMetaCancellation(t *testing.T) {
	allowParallelIntegrationTest(t)
	env := newRuntimeStateTestEnv(t)
	_, err := env.service.SubmitTrustedTurn(t.Context(), agentruntimestate.SubmitTrustedTurnInput{ContextKey: env.contextKey, Epoch: env.epoch, Inputs: []agentruntimestate.RuntimeInput{runtimeInput("meta-before-live", "trusted_turn", "room:"+testRuntimeInboxRoom, "work")}})
	if err != nil {
		t.Fatal(err)
	}
	claimed, err := env.service.ClaimLocalRun(t.Context(), agentruntimestate.ClaimLocalRunInput{ClaimID: "claim-before-live", ContextKey: env.contextKey, Epoch: env.epoch})
	if err != nil || claimed.Run == nil {
		t.Fatalf("claim before Live=%+v err=%v", claimed, err)
	}
	runID := claimed.Run.RunID
	insertRuntimeLiveSession(t, env)
	var canceled bool
	if err := env.pool.QueryRow(t.Context(), `SELECT cancellation_requested FROM agent_local_runs WHERE run_id=$1`, runID).Scan(&canceled); err != nil || !canceled {
		t.Fatalf("old Meta continues: canceled=%v err=%v", canceled, err)
	}
}

func TestVoiceLiveEndWakesMetaRunsQueuedDuringLive(t *testing.T) {
	allowParallelIntegrationTest(t)
	env := newRuntimeStateTestEnv(t)
	insertRuntimeLiveSession(t, env)
	queueRuntimeInboxMessage(t, env, "live-queued-message", "1", "while Live talks", false)
	listener, err := env.pool.Acquire(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Release()
	if _, err := listener.Exec(t.Context(), "LISTEN "+realtime.ChannelName); err != nil {
		t.Fatal(err)
	}
	if _, err := env.pool.Exec(t.Context(), `UPDATE voice_sessions SET status='closed',closed_at=clock_timestamp() WHERE id='voice-handover'`); err != nil {
		t.Fatal(err)
	}
	for {
		ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
		notification, err := listener.Conn().WaitForNotification(ctx)
		cancel()
		if err != nil {
			t.Fatalf("no run.queued hint after Live ended: %v", err)
		}
		var hint struct {
			Kind       string `json:"kind"`
			ResourceID string `json:"resource_id"`
		}
		if err := json.Unmarshal([]byte(notification.Payload), &hint); err != nil {
			t.Fatal(err)
		}
		if hint.Kind == realtime.RunQueuedKind && hint.ResourceID == env.contextKey {
			return
		}
	}
}
