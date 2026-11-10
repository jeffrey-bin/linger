package integration_test

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentruntimestate"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

func TestMembershipRevocationClosesOnlyCanceledRuntimePresentations(t *testing.T) {
	allowParallelIntegrationTest(t)
	for _, phase := range []string{"running", "queued", "preexisting_terminal", "preexisting_failed", "preexisting_canceled"} {
		t.Run(phase, func(t *testing.T) {
			preexisting := strings.HasPrefix(phase, "preexisting_")
			env := newRuntimeStateTestEnv(t)
			rooms := []string{"room_revoke_status", "room_keep_status"}
			for _, roomID := range rooms {
				insertRuntimeStatusAuthorityFixture(t, env.pool, roomID, "message_"+roomID)
			}
			contexts := map[string]runtimeStateTestEnv{}
			for _, roomID := range rooms {
				if _, err := env.service.EnsureContext(t.Context(), agentruntimestate.EnsureContextInput{Ref: agentruntimestate.ContextRef{Kind: "meta", AgentID: testRuntimeAgentID, RoomID: roomID}, TargetResidency: "active"}); err != nil {
					t.Fatal(err)
				}
			}
			listed, err := env.service.ListContexts(t.Context(), testRuntimeAgentID)
			if err != nil {
				t.Fatalf("list Contexts: %+v %v", listed, err)
			}
			for _, row := range listed {
				if row.Ref.RoomID == rooms[0] || row.Ref.RoomID == rooms[1] {
					contexts[row.Ref.RoomID] = runtimeStateTestEnv{pool: env.pool, service: env.service, contextKey: row.ContextKey, epoch: env.epoch}
				}
			}
			submit := func(roomID, suffix string, claim bool) string {
				t.Helper()
				owner := contexts[roomID]
				input := runtimeInput("input-"+suffix, "trusted_turn", "room:"+roomID, "synthetic")
				input.SourceMessageID = "message_" + roomID
				result, err := env.service.SubmitTrustedTurn(t.Context(), agentruntimestate.SubmitTrustedTurnInput{ContextKey: owner.contextKey, Epoch: owner.epoch, Inputs: []agentruntimestate.RuntimeInput{input}})
				if err != nil {
					t.Fatal(err)
				}
				if claim {
					if _, err := env.service.ClaimLocalRun(t.Context(), agentruntimestate.ClaimLocalRunInput{ClaimID: "claim-" + suffix, ContextKey: owner.contextKey, Epoch: owner.epoch}); err != nil {
						t.Fatal(err)
					}
				}
				return result.RunID
			}
			owner := contexts[rooms[0]]
			completedID := submit(rooms[0], "completed", true)
			if _, err := env.service.FinishLocalRun(t.Context(), agentruntimestate.FinishLocalRunInput{ContextKey: owner.contextKey, Epoch: owner.epoch, RunID: completedID, Terminal: json.RawMessage(`{"type":"succeeded"}`)}); err != nil {
				t.Fatal(err)
			}
			runID := submit(rooms[0], "revoked", phase == "running" || preexisting)
			otherID := submit(rooms[1], "unaffected", false)
			if phase == "running" {
				if _, err := env.service.OfferRuntimePresentationEvents(t.Context(), agentruntimestate.OfferPresentationEventsInput{LocalRunID: runID, Events: []agentruntimestate.OfferedPresentationEvent{{CommandID: "working-presentation", Event: json.RawMessage(`{"type":"status.changed","status":"working"}`)}}}); err != nil {
					t.Fatal(err)
				}
			}
			snapshot := func(id string) string {
				t.Helper()
				var value string
				if err := env.pool.QueryRow(t.Context(), `SELECT jsonb_build_object('run',to_jsonb(r),'events',(SELECT jsonb_agg(to_jsonb(e) ORDER BY event_ordinal) FROM agent_runtime_status_events e WHERE e.local_run_id=r.run_id))::text FROM agent_local_runs r WHERE r.run_id=$1`, id).Scan(&value); err != nil {
					t.Fatal(err)
				}
				return value
			}
			lateOffer := func(commandID string) error {
				_, err := env.service.OfferRuntimePresentationEvents(t.Context(), agentruntimestate.OfferPresentationEventsInput{LocalRunID: runID, Events: []agentruntimestate.OfferedPresentationEvent{{CommandID: commandID, Event: json.RawMessage(`{"type":"status.changed","status":"working"}`)}}})
				return err
			}
			completedBefore, otherBefore := snapshot(completedID), snapshot(otherID)
			if preexisting {
				terminal := json.RawMessage(`{"type":"succeeded"}`)
				if phase == "preexisting_failed" {
					terminal = json.RawMessage(`{"type":"failed","error":"execution_failed"}`)
				}
				if phase == "preexisting_canceled" {
					terminal = json.RawMessage(`{"type":"canceled"}`)
				}
				if _, err := env.service.FinishLocalRun(t.Context(), agentruntimestate.FinishLocalRunInput{ContextKey: owner.contextKey, Epoch: owner.epoch, RunID: runID, Terminal: terminal}); err != nil {
					t.Fatal(err)
				}
			}
			terminalBefore := snapshot(runID)
			tx, err := env.pool.Begin(t.Context())
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback(t.Context())
			queries := store.New(tx)
			member, err := queries.GetRoomMemberForUpdate(t.Context(), store.GetRoomMemberForUpdateParams{RoomID: rooms[0], ActorID: "actor_acme_official"})
			if err != nil {
				t.Fatal(err)
			}
			if err := queries.DeleteRoomMemberForMembershipEpoch(t.Context(), member.MembershipEpochID); err != nil {
				t.Fatal(err)
			}
			if err := agentruntimestate.SuspendRoomContextsForMembershipRevocation(t.Context(), queries, member.ActorID, rooms[0], member.MembershipEpochID); err != nil {
				t.Fatal(err)
			}
			if err := tx.Commit(t.Context()); err != nil {
				t.Fatal(err)
			}
			if preexisting {
				if snapshot(runID) != terminalBefore || snapshot(completedID) != completedBefore || snapshot(otherID) != otherBefore {
					t.Fatal("revocation changed an existing terminal intent")
				}
				if _, err := store.New(env.pool).GetRoomAgentMessageAuthority(t.Context(), store.GetRoomAgentMessageAuthorityParams{RoomID: rooms[0], AgentManagementID: testRuntimeAgentID}); !errors.Is(err, pgx.ErrNoRows) {
					t.Fatalf("terminal presentation prevented revocation: %v", err)
				}
				if err := lateOffer("late-after-accepted-terminal"); !errors.Is(err, agentruntimestate.ErrConflict) {
					t.Fatalf("late terminal writer: %v", err)
				}
				if snapshot(runID) != terminalBefore {
					t.Fatal("late writer changed the terminal history")
				}
				if _, err := store.New(env.pool).GetRoomAgentMessageAuthority(t.Context(), store.GetRoomAgentMessageAuthorityParams{RoomID: rooms[0], AgentManagementID: testRuntimeAgentID}); !errors.Is(err, pgx.ErrNoRows) {
					t.Fatalf("late writer restored authority: %v", err)
				}
				return
			}
			var runStatus, reason string
			if err := env.pool.QueryRow(t.Context(), `SELECT status,COALESCE(terminal->>'reason','') FROM agent_local_runs WHERE run_id=$1`, runID).Scan(&runStatus, &reason); err != nil {
				t.Fatal(err)
			}
			if runStatus != "canceled" || reason != "room_membership_revoked" {
				t.Fatalf("revoked Run did not converge: run=%s reason=%s", runStatus, reason)
			}
			if eventType, event := lastRunStatusEvent(t, env.pool, runID); eventType != "status.changed" || event["status"] != "stopped" || event["outcome"] != "canceled" {
				t.Fatalf("terminal presentation=%s %v", eventType, event)
			}
			if snapshot(completedID) != completedBefore || snapshot(otherID) != otherBefore {
				t.Fatal("revocation changed a completed Run or another Room's presentation")
			}
			revokedBefore := snapshot(runID)
			if err := lateOffer("late-presentation"); !errors.Is(err, agentruntimestate.ErrConflict) {
				t.Fatalf("late writer error=%v, want conflict", err)
			}
			if _, err := store.New(env.pool).GetRoomAgentMessageAuthority(t.Context(), store.GetRoomAgentMessageAuthorityParams{RoomID: rooms[0], AgentManagementID: testRuntimeAgentID}); !errors.Is(err, pgx.ErrNoRows) {
				t.Fatalf("revoked business authority error=%v, want no rows", err)
			}
			if snapshot(runID) != revokedBefore {
				t.Fatal("late writer changed the revoked terminal history")
			}
		})
	}
}
