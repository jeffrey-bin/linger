package integration_test

import (
	"encoding/json"
	"testing"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentruntimestate"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

func TestAgentRuntimeInboxTerminalRunReloadsByInvocationMessage(t *testing.T) {
	allowParallelIntegrationTest(t)
	for _, tc := range []struct {
		name       string
		terminal   string
		wantStatus string
	}{
		{name: "complete", terminal: `{"type":"succeeded"}`, wantStatus: "succeeded"},
		{name: "canceled", terminal: `{"type":"canceled"}`, wantStatus: "canceled"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			env := newRuntimeStateTestEnv(t)
			roomID := "room_inbox_terminal_" + tc.name
			insertRuntimeRoomMembership(t, env.pool, roomID)
			env = useRuntimeRoomContext(t, env, roomID)
			messageID := createAgentMentionRequest(t, env.pool, roomID, "actor_acme_alice")
			submitted := acceptPresentationInboxMessage(t, env, roomID, messageID)
			if _, err := env.service.ClaimLocalRun(t.Context(), agentruntimestate.ClaimLocalRunInput{
				ClaimID: "claim-inbox-terminal-" + tc.name, ContextKey: env.contextKey, Epoch: env.epoch,
			}); err != nil {
				t.Fatal(err)
			}
			if _, err := env.service.OpenRuntimeStatus(t.Context(), agentruntimestate.OpenStatusInput{ContextKey: env.contextKey, Epoch: env.epoch,
				LocalRunID: submitted.RunID, InitialSourceIDs: []string{"room:" + roomID},
			}); err != nil {
				t.Fatal(err)
			}
			if _, err := env.service.FinishLocalRun(t.Context(), agentruntimestate.FinishLocalRunInput{ContextKey: env.contextKey, Epoch: env.epoch,
				RunID: submitted.RunID, Terminal: json.RawMessage(tc.terminal),
			}); err != nil {
				t.Fatal(err)
			}
			var accountID string
			if err := env.pool.QueryRow(t.Context(), `SELECT account_id FROM actors WHERE id='actor_acme_alice'`).Scan(&accountID); err != nil {
				t.Fatal(err)
			}
			query := store.New(env.pool)
			runs, err := query.ListRuntimePresentationRunsForAccountByRoom(t.Context(), store.ListRuntimePresentationRunsForAccountByRoomParams{
				AccountID: accountID, RoomID: roomID, MessageIds: []string{messageID},
			})
			status := ""
			if len(runs) == 1 {
				status = runs[0].Status
			}
			if err != nil || len(runs) != 1 || status != tc.wantStatus {
				t.Fatalf("reload %s by accepted inbox message: count=%d status=%q err=%v", tc.name, len(runs), status, err)
			}
			unrelated, err := query.ListRuntimePresentationRunsForAccountByRoom(t.Context(), store.ListRuntimePresentationRunsForAccountByRoomParams{
				AccountID: accountID, RoomID: roomID, MessageIds: []string{"unrelated-message"},
			})
			if err != nil || len(unrelated) != 0 {
				t.Fatalf("unrelated input matched %s run: count=%d err=%v", tc.name, len(unrelated), err)
			}
		})
	}
}
