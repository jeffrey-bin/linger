package integration_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentruntimestate"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

const (
	testRuntimeAgentID   = "agent-management-acme-official"
	testRuntimeInboxRoom = "room_runtime_inbox"
)

type runtimeStateTestEnv struct {
	pool       *pgxpool.Pool
	service    *agentruntimestate.Service
	contextKey string
	epoch      string
}

func TestAgentRuntimeReconcilesDefaultPerRoomMetaContexts(t *testing.T) {
	allowParallelIntegrationTest(t)
	databaseURL := newIntegrationDatabase(t)
	pool, err := pgxpool.New(t.Context(), databaseURL)
	if err != nil {
		t.Fatalf("open Runtime state database: %v", err)
	}
	t.Cleanup(pool.Close)
	const agentID = "agent-reconcile-per-room"
	insertRuntimeRegistrationFixture(t, pool, agentID, "active")
	roomIDs := []string{"room_reconcile_per_room_one", "room_reconcile_per_room_two"}
	for _, roomID := range roomIDs {
		insertRuntimeRoomMembershipForAgent(t, pool, roomID, "actor-"+agentID)
	}

	service := agentruntimestate.New(pool)
	first, err := service.ReconcileMetaContexts(t.Context(), agentruntimestate.ReconcileMetaContextsInput{Limit: 1000})
	if err != nil {
		t.Fatalf("reconcile missing per-Room meta Contexts: %v", err)
	}
	if first.ExaminedCount < len(roomIDs) || first.CreatedCount < len(roomIDs) ||
		first.ExistingCount != first.ExaminedCount-first.CreatedCount || first.NextCursor != "" {
		t.Fatalf("first reconciliation result=%+v", first)
	}
	created := make(map[string]bool, len(first.CreatedContextKeys))
	for _, contextKey := range first.CreatedContextKeys {
		created[contextKey] = true
	}
	for _, roomID := range roomIDs {
		contextKey := `["meta","` + agentID + `","room","` + roomID + `"]`
		if !created[contextKey] {
			t.Fatalf("first reconciliation did not create %q: %+v", contextKey, first)
		}
	}

	var total, coldRoomBound, global int
	if err := pool.QueryRow(t.Context(), `
		SELECT count(*),
		       count(*) FILTER (
		           WHERE target_residency='suspended'
		             AND room_id IS NOT NULL
		             AND membership_epoch_id IS NOT NULL
		       ),
		       count(*) FILTER (WHERE room_id IS NULL)
		FROM agent_execution_contexts
		WHERE agent_management_id=$1 AND context_kind='meta'`, agentID).Scan(&total, &coldRoomBound, &global); err != nil {
		t.Fatalf("read reconciled per-Room meta Contexts: %v", err)
	}
	if total != len(roomIDs) || coldRoomBound != len(roomIDs) || global != 0 {
		t.Fatalf("reconciled topology total=%d cold_room_bound=%d global=%d", total, coldRoomBound, global)
	}

	second, err := service.ReconcileMetaContexts(t.Context(), agentruntimestate.ReconcileMetaContextsInput{Limit: 1000})
	if err != nil {
		t.Fatalf("repeat meta Context reconciliation: %v", err)
	}
	if second.ExaminedCount != first.ExaminedCount || second.CreatedCount != 0 ||
		second.ExistingCount != second.ExaminedCount || len(second.CreatedContextKeys) != 0 || second.NextCursor != "" {
		t.Fatalf("second reconciliation result=%+v", second)
	}
}

func TestAgentRuntimeReconcileMetaContextsFiltersAndPreservesState(t *testing.T) {
	allowParallelIntegrationTest(t)
	databaseURL := newIntegrationDatabase(t)
	pool, err := pgxpool.New(t.Context(), databaseURL)
	if err != nil {
		t.Fatalf("open Runtime state database: %v", err)
	}
	t.Cleanup(pool.Close)

	statuses := []string{"active", "revoked"}
	for _, status := range statuses {
		agentID := "agent-reconcile-" + status
		insertRuntimeRegistrationFixture(t, pool, agentID, status)
		insertRuntimeRoomMembershipForAgent(t, pool, "room_reconcile_"+status, "actor-"+agentID)
	}
	insertRuntimeRegistrationFixture(t, pool, "agent-reconcile-suspended", "active")
	const suspendedRoom = "room_reconcile_suspended"
	insertRuntimeRoomMembershipForAgent(t, pool, suspendedRoom, "actor-agent-reconcile-suspended")
	const suspendedKey = `["meta","agent-reconcile-suspended","room","` + suspendedRoom + `"]`
	if tag, err := pool.Exec(t.Context(), `
		INSERT INTO agent_execution_contexts(
			context_key,tenant_id,agent_actor_id,agent_management_id,context_kind,
			room_id,room_kind,membership_epoch_id,
			target_residency,next_input_sequence,state_revision
		)
		SELECT $1,'tenant_acme',membership.actor_id,'agent-reconcile-suspended','meta',
			membership.room_id,'collaboration',membership.membership_epoch_id,
			'suspended',17,29
		FROM room_members membership
		WHERE membership.room_id=$2 AND membership.actor_id='actor-agent-reconcile-suspended'`,
		suspendedKey, suspendedRoom); err != nil || tag.RowsAffected() != 1 {
		t.Fatalf("insert suspended meta Context rows=%d: %v", tag.RowsAffected(), err)
	}

	service := agentruntimestate.New(pool)
	cursor := ""
	examined := 0
	created := 0
	for {
		page, err := service.ReconcileMetaContexts(t.Context(), agentruntimestate.ReconcileMetaContextsInput{
			Limit: 2, Cursor: cursor,
		})
		if err != nil {
			t.Fatalf("reconcile meta Context page after %q: %v", cursor, err)
		}
		examined += page.ExaminedCount
		created += page.CreatedCount
		if page.NextCursor == "" {
			break
		}
		if page.NextCursor == cursor {
			t.Fatalf("reconciliation cursor did not advance: %q", cursor)
		}
		cursor = page.NextCursor
	}
	if examined < 2 || created < 1 {
		t.Fatalf("reconciliation totals examined=%d created=%d", examined, created)
	}

	for _, status := range statuses {
		var count int
		if err := pool.QueryRow(t.Context(), `
			SELECT count(*) FROM agent_execution_contexts
			WHERE agent_management_id=$1 AND context_kind='meta'`, "agent-reconcile-"+status).Scan(&count); err != nil {
			t.Fatalf("count %s meta Context: %v", status, err)
		}
		want := 0
		if status == "active" {
			want = 1
		}
		if count != want {
			t.Fatalf("%s meta Context count=%d, want %d", status, count, want)
		}
	}

	var residency string
	var inputSequence, revision int64
	if err := pool.QueryRow(t.Context(), `
		SELECT target_residency,next_input_sequence,state_revision
		FROM agent_execution_contexts WHERE context_key=$1`, suspendedKey).Scan(
		&residency, &inputSequence, &revision,
	); err != nil {
		t.Fatalf("read preserved suspended meta Context: %v", err)
	}
	if residency != "suspended" || inputSequence != 17 || revision != 29 {
		t.Fatalf("suspended meta Context changed: residency=%q input=%d revision=%d",
			residency, inputSequence, revision)
	}
}

func TestAgentRuntimeReconcileMetaContextsRejectsOwnershipConflict(t *testing.T) {
	allowParallelIntegrationTest(t)
	databaseURL := newIntegrationDatabase(t)
	pool, err := pgxpool.New(t.Context(), databaseURL)
	if err != nil {
		t.Fatalf("open Runtime state database: %v", err)
	}
	t.Cleanup(pool.Close)
	insertRuntimeRegistrationFixture(t, pool, "agent-a-conflict-target", "active")
	insertRuntimeRegistrationFixture(t, pool, "agent-z-conflict-owner", "active")
	const conflictRoom = "room_reconcile_conflict"
	insertRuntimeRoomMembershipForAgent(t, pool, conflictRoom, "actor-agent-a-conflict-target")
	if _, err := pool.Exec(t.Context(), `
		INSERT INTO room_members(room_id,tenant_id,actor_id,role,added_by_actor_id)
		VALUES($1,'tenant_acme','actor-agent-z-conflict-owner','member','actor_acme_alice')`, conflictRoom); err != nil {
		t.Fatalf("insert conflicting owner Room membership: %v", err)
	}
	if tag, err := pool.Exec(t.Context(), `
		INSERT INTO agent_execution_contexts(
			context_key,tenant_id,agent_actor_id,agent_management_id,context_kind,
			room_id,room_kind,membership_epoch_id,target_residency
		)
		SELECT '["meta","agent-a-conflict-target","room","`+conflictRoom+`"]','tenant_acme',
			membership.actor_id,'agent-z-conflict-owner','meta',
			membership.room_id,'collaboration',membership.membership_epoch_id,'active'
		FROM room_members membership
		WHERE membership.room_id=$1 AND membership.actor_id='actor-agent-z-conflict-owner'`, conflictRoom); err != nil || tag.RowsAffected() != 1 {
		t.Fatalf("insert conflicting meta Context rows=%d: %v", tag.RowsAffected(), err)
	}

	service := agentruntimestate.New(pool)
	if _, err := service.ReconcileMetaContexts(t.Context(), agentruntimestate.ReconcileMetaContextsInput{Limit: 1000}); !errors.Is(err, agentruntimestate.ErrConflict) {
		t.Fatalf("reconcile ownership conflict error=%v, want conflict", err)
	}
	var count int
	if err := pool.QueryRow(t.Context(), `
		SELECT count(*) FROM agent_execution_contexts
		WHERE agent_management_id='agent-z-conflict-owner'`).Scan(&count); err != nil {
		t.Fatalf("count conflicting owner Contexts: %v", err)
	}
	if count != 1 {
		t.Fatalf("ownership conflict partially applied reconciliation: owner Contexts=%d", count)
	}
}

func TestAgentRuntimeProtectsMaterializableMetaContextDeletion(t *testing.T) {
	allowParallelIntegrationTest(t)
	env := newRuntimeStateTestEnv(t)
	current, err := env.service.GetContext(t.Context(), env.contextKey)
	if err != nil {
		t.Fatalf("read active meta Context: %v", err)
	}
	if _, err := env.service.DeleteContext(t.Context(), agentruntimestate.DeleteContextInput{ContextKey: env.contextKey,
		ExpectedRevision: current.StateRevision,
	}); !errors.Is(err, agentruntimestate.ErrConflict) {
		t.Fatalf("delete active meta Context error=%v, want conflict", err)
	}
	if _, err := env.pool.Exec(t.Context(), `
		UPDATE agent_registrations SET status='revoked'
		WHERE agent_management_id=$1`, testRuntimeAgentID); err != nil {
		t.Fatalf("revoke Agent registration: %v", err)
	}
	deleted, err := env.service.DeleteContext(t.Context(), agentruntimestate.DeleteContextInput{ContextKey: env.contextKey,
		ExpectedRevision: current.StateRevision,
	})
	if err != nil || !deleted {
		t.Fatalf("delete revoked meta Context deleted=%t err=%v", deleted, err)
	}
}

func TestAgentRuntimeTrustedProfileNotificationAndStaleSessionClear(t *testing.T) {
	allowParallelIntegrationTest(t)
	env := newRuntimeStateTestEnv(t)
	submitted, err := env.service.SubmitTrustedTurn(t.Context(), agentruntimestate.SubmitTrustedTurnInput{ContextKey: env.contextKey, Epoch: env.epoch,
		Inputs: []agentruntimestate.RuntimeInput{runtimeInput("profile-request", "trusted_turn", "", "Initialize your profile")},
	})
	if err != nil {
		t.Fatal(err)
	}
	claimed, err := env.service.ClaimLocalRun(t.Context(), agentruntimestate.ClaimLocalRunInput{
		ClaimID: "claim-profile-initialization-run", ContextKey: env.contextKey, Epoch: env.epoch,
	})
	if err != nil || claimed.Run == nil || claimed.Run.RunID != submitted.RunID {
		t.Fatalf("claim profile initialization Run=%+v err=%v", claimed, err)
	}
	if len(claimed.Run.Inputs) == 0 {
		t.Fatal("claimed Run has no inputs")
	}
	for _, input := range claimed.Run.Inputs {
		if input.CreatedAt.IsZero() {
			t.Fatalf("claimed input %s has no created_at", input.InputID)
		}
	}
	notification := runtimeInput(
		"profile_initialized_1", "internal", "",
		"<profile_initialized>\nYour identity is now set. Continue working on the Sponsor's current request; do not initialize again in this Context.\n</profile_initialized>",
	)
	accepted, err := env.service.AcceptTrustedNotification(t.Context(), agentruntimestate.AcceptTrustedNotificationInput{ContextKey: env.contextKey, Epoch: env.epoch,
		ExecutionRunRef: submitted.RunID, Input: notification,
	})
	if err != nil || accepted.Status != "committed" || accepted.SteerGroupID == "" {
		t.Fatalf("accept trusted profile notification=%+v err=%v", accepted, err)
	}
	replayed, err := env.service.AcceptTrustedNotification(t.Context(), agentruntimestate.AcceptTrustedNotificationInput{ContextKey: env.contextKey, Epoch: env.epoch,
		ExecutionRunRef: submitted.RunID, Input: notification,
	})
	if err != nil || replayed.Status != "already_accepted" {
		t.Fatalf("replay trusted profile notification=%+v err=%v", replayed, err)
	}
	var inputStatus, sourceKind, steerGroupID string
	if err := env.pool.QueryRow(t.Context(), `
		SELECT status,source_kind,steer_group_id FROM agent_runtime_inputs
		WHERE context_key=$1 AND input_id=$2
	`, env.contextKey, notification.InputID).Scan(&inputStatus, &sourceKind, &steerGroupID); err != nil {
		t.Fatal(err)
	}
	if inputStatus != "steering" || sourceKind != "internal" || steerGroupID != accepted.SteerGroupID {
		t.Fatalf("trusted notification status=%q source=%q group=%q", inputStatus, sourceKind, steerGroupID)
	}
	wrongRun := submitted.RunID + "-other"
	if _, err := env.service.AcceptTrustedNotification(t.Context(), agentruntimestate.AcceptTrustedNotificationInput{ContextKey: env.contextKey, Epoch: env.epoch,
		ExecutionRunRef: wrongRun, Input: runtimeInput("profile_initialized_2", "internal", "", "Profile updated"),
	}); !errors.Is(err, agentruntimestate.ErrNotFound) {
		t.Fatalf("wrong Run trusted notification error=%v want not found", err)
	}

	configurationRevision := activeRuntimeConfigurationRevision(t, env.pool)
	if _, err := env.service.CheckpointRuntimeSession(t.Context(), agentruntimestate.CheckpointSessionInput{ContextKey: env.contextKey, Epoch: env.epoch,
		Checkpoint: runtimeSessionCheckpoint(0, configurationRevision, "thread-before-profile"),
	}); err != nil {
		t.Fatal(err)
	}
	current, err := env.service.GetContext(t.Context(), env.contextKey)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := env.service.SetContextResidency(t.Context(), agentruntimestate.SetContextResidencyInput{ContextKey: env.contextKey,
		ExpectedRevision: current.StateRevision, TargetResidency: "suspended",
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := env.service.AcceptTrustedNotification(t.Context(), agentruntimestate.AcceptTrustedNotificationInput{ContextKey: env.contextKey, Epoch: env.epoch,
		ExecutionRunRef: submitted.RunID, Input: runtimeInput("profile_initialized_3", "internal", "", "Profile updated"),
	}); !errors.Is(err, agentruntimestate.ErrConflict) {
		t.Fatalf("suspended Context trusted notification error=%v want conflict", err)
	}
	if _, err := env.service.ClearRuntimeSession(t.Context(), agentruntimestate.ClearRuntimeSessionInput{ContextKey: env.contextKey, Epoch: env.epoch,
		ConfigurationRevision: configurationRevision + 1,
	}); !errors.Is(err, agentruntimestate.ErrConflict) {
		t.Fatalf("clear wrong RuntimeSession revision error=%v want conflict", err)
	}
	cleared, err := env.service.ClearRuntimeSession(t.Context(), agentruntimestate.ClearRuntimeSessionInput{ContextKey: env.contextKey, Epoch: env.epoch,
		ConfigurationRevision: configurationRevision,
	})
	if err != nil || !cleared.Cleared {
		t.Fatalf("clear stale RuntimeSession=%+v err=%v", cleared, err)
	}
	if session, err := env.service.GetRuntimeSession(t.Context(), env.contextKey); err != nil || session != nil {
		t.Fatalf("RuntimeSession after clear=%+v err=%v", session, err)
	}
}

func insertRuntimeRegistrationFixture(t *testing.T, pool *pgxpool.Pool, agentID, status string) {
	t.Helper()
	actorID := "actor-" + agentID
	if _, err := pool.Exec(t.Context(), `
		INSERT INTO actors(id,tenant_id,kind,display_name,handle)
		VALUES($1,'tenant_acme','agent',$2,$3)`, actorID, agentID, "@"+agentID); err != nil {
		t.Fatalf("insert %s Agent actor: %v", status, err)
	}
	if _, err := pool.Exec(t.Context(), `
		INSERT INTO agent_registrations(
			actor_id,tenant_id,agent_management_id,status,description,instructions,
			runtime_model,created_by_actor_id,visibility_scope,agent_type,
			computer_id,local_runtime_type,workspace_grant_id
		) VALUES($1,'tenant_acme',$2,$3,'fixture','fixture','gpt-test',
			'actor_acme_alice','workspace','general','computer_fixture','codex','grant_files')`, actorID, agentID, status); err != nil {
		t.Fatalf("insert %s Agent registration: %v", status, err)
	}
}

func TestAgentRuntimeEpochStartMarksLocalComputersOffline(t *testing.T) {
	allowParallelIntegrationTest(t)
	databaseURL := newIntegrationDatabase(t)
	pool, err := pgxpool.New(t.Context(), databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	if _, err := pool.Exec(t.Context(), `
		INSERT INTO local_computers(
			computer_id,display_name,status,active_operations,owner_tenant_id,owner_actor_id,
			runtime_inventory,workspace_grants,runtime_diagnostics
		) VALUES(
			'computer-startup-offline','Startup Offline','online',2,'tenant_acme','actor_acme_alice',
			'["codex"]','[]','[]'
		)
	`); err != nil {
		t.Fatal(err)
	}
	if _, err := agentruntimestate.New(pool).StartEpoch(t.Context(), "epoch-startup-offline"); err != nil {
		t.Fatalf("start epoch: %v", err)
	}
	var status string
	var activeOperations int32
	if err := pool.QueryRow(t.Context(), `
		SELECT status,active_operations FROM local_computers WHERE computer_id='computer-startup-offline'
	`).Scan(&status, &activeOperations); err != nil {
		t.Fatal(err)
	}
	if status != "offline" || activeOperations != 0 {
		t.Fatalf("Computer after epoch start: status=%q active_operations=%d", status, activeOperations)
	}
}

func TestAgentRuntimeRejectsDuplicateInputPayload(t *testing.T) {
	allowParallelIntegrationTest(t)
	env := newRuntimeStateTestEnv(t)
	original := runtimeInput("duplicate-input", "trusted_turn", "", "original")
	submitted, err := env.service.SubmitTrustedTurn(t.Context(), agentruntimestate.SubmitTrustedTurnInput{ContextKey: env.contextKey, Epoch: env.epoch,
		Inputs: []agentruntimestate.RuntimeInput{original},
	})
	if err != nil || !submitted.Created {
		t.Fatalf("submit original Runtime input: result=%+v err=%v", submitted, err)
	}

	conflicting := runtimeInput("duplicate-input", "trusted_turn", "", "changed")
	if _, err := env.service.SubmitTrustedTurn(t.Context(), agentruntimestate.SubmitTrustedTurnInput{ContextKey: env.contextKey, Epoch: env.epoch,
		Inputs: []agentruntimestate.RuntimeInput{conflicting},
	}); !errors.Is(err, agentruntimestate.ErrConflict) {
		t.Fatalf("accept duplicate input with changed payload error=%v, want conflict", err)
	}
}

func TestAgentRuntimeDeletesContextWithLocalRunInputs(t *testing.T) {
	allowParallelIntegrationTest(t)
	env := newRuntimeStateTestEnv(t)
	if _, err := env.service.SubmitTrustedTurn(t.Context(), agentruntimestate.SubmitTrustedTurnInput{ContextKey: env.contextKey, Epoch: env.epoch,
		Inputs: []agentruntimestate.RuntimeInput{
			runtimeInput("context-delete-input", "trusted_turn", "", "delete me"),
		},
	}); err != nil {
		t.Fatalf("submit Context deletion turn: %v", err)
	}
	current, err := env.service.GetContext(t.Context(), env.contextKey)
	if err != nil {
		t.Fatalf("read Context before deletion: %v", err)
	}
	if _, err := env.service.DeleteContext(t.Context(), agentruntimestate.DeleteContextInput{ContextKey: env.contextKey,
		ExpectedRevision: current.StateRevision - 1,
	}); !errors.Is(err, agentruntimestate.ErrConflict) {
		t.Fatalf("delete Context with stale revision error=%v, want conflict", err)
	}
	var relationCount int
	if err := env.pool.QueryRow(t.Context(), `
		SELECT count(*) FROM agent_local_run_inputs WHERE context_key=$1
	`, env.contextKey).Scan(&relationCount); err != nil {
		t.Fatalf("count Local Run input relations after stale deletion: %v", err)
	}
	if relationCount != 1 {
		t.Fatalf("Local Run input relations after stale deletion=%d, want 1", relationCount)
	}
	if _, err := env.pool.Exec(t.Context(), `
		UPDATE agent_registrations SET status='revoked'
		WHERE agent_management_id=$1`, testRuntimeAgentID); err != nil {
		t.Fatalf("revoke Agent registration before Context cleanup: %v", err)
	}

	request := agentruntimestate.DeleteContextInput{ContextKey: env.contextKey,
		ExpectedRevision: current.StateRevision,
	}
	deleted, err := env.service.DeleteContext(t.Context(), request)
	if err != nil || !deleted {
		t.Fatalf("delete Context with Local Run inputs: deleted=%t err=%v", deleted, err)
	}
	for table, want := range map[string]int{
		"agent_execution_contexts": 0,
		"agent_runtime_inputs":     0,
		"agent_local_runs":         0,
		"agent_local_run_inputs":   0,
	} {
		var count int
		if err := env.pool.QueryRow(t.Context(), fmt.Sprintf(
			"SELECT count(*) FROM %s WHERE context_key=$1", table,
		), env.contextKey).Scan(&count); err != nil {
			t.Fatalf("count %s after Context deletion: %v", table, err)
		}
		if count != want {
			t.Fatalf("%s rows after Context deletion=%d, want %d", table, count, want)
		}
	}
	// A repeated deletion finds no Context left to delete.
	if _, err := env.service.DeleteContext(t.Context(), request); !errors.Is(err, agentruntimestate.ErrNotFound) {
		t.Fatalf("replay Context deletion error=%v, want not found", err)
	}
}

func TestAgentRuntimeRetainsContextHistoryWhenDeletingContext(t *testing.T) {
	allowParallelIntegrationTest(t)
	env := newRuntimeStateTestEnv(t)
	if _, err := env.pool.Exec(t.Context(), `
		INSERT INTO agent_local_runs(run_id,context_key,status,terminal,finished_at)
		VALUES('run-context-history',$1,'succeeded','{"type":"succeeded"}'::jsonb,clock_timestamp())
	`, env.contextKey); err != nil {
		t.Fatalf("seed Runtime history run: %v", err)
	}
	insertRuntimeStatusFixture(t, env, "run-context-history")
	if _, err := env.pool.Exec(t.Context(), `
		INSERT INTO agent_runtime_status_events(local_run_id,event_ordinal,segment_id,command_id,event_type,payload)
		VALUES('run-context-history',1,'context-history-segment','context-history-event','status.changed','{"type":"status.changed","status":"done"}'::jsonb)
	`); err != nil {
		t.Fatalf("seed Runtime history: %v", err)
	}
	current, err := env.service.GetContext(t.Context(), env.contextKey)
	if err != nil {
		t.Fatalf("read Context before history deletion: %v", err)
	}
	deleted, err := env.service.DeleteContext(t.Context(), agentruntimestate.DeleteContextInput{ContextKey: env.contextKey,
		ExpectedRevision: current.StateRevision,
	})
	if err != nil || !deleted {
		t.Fatalf("delete Context with Runtime history: deleted=%t err=%v", deleted, err)
	}
	var terminalReason string
	if err := env.pool.QueryRow(t.Context(), `
		SELECT terminal_reason FROM agent_execution_contexts WHERE context_key=$1
	`, env.contextKey).Scan(&terminalReason); err != nil {
		t.Fatalf("read retained Context: %v", err)
	}
	if terminalReason != "context_deleted" {
		t.Fatalf("retained Context terminal_reason=%q, want context_deleted", terminalReason)
	}
	var eventCount int
	if err := env.pool.QueryRow(t.Context(), `
		SELECT count(*) FROM agent_runtime_status_events WHERE local_run_id='run-context-history'
	`).Scan(&eventCount); err != nil {
		t.Fatalf("count retained Runtime history: %v", err)
	}
	if eventCount != 1 {
		t.Fatalf("retained Runtime history events=%d, want 1", eventCount)
	}
}

func TestAgentRuntimeDeletionIsIdempotentForTerminalContextHistory(t *testing.T) {
	allowParallelIntegrationTest(t)
	env := newRuntimeStateTestEnv(t)
	if _, err := env.pool.Exec(t.Context(), `
		INSERT INTO agent_local_runs(run_id,context_key,status,terminal,finished_at)
		VALUES('run-terminal-context-history',$1,'succeeded','{"type":"succeeded"}'::jsonb,clock_timestamp())
	`, env.contextKey); err != nil {
		t.Fatalf("seed terminal Context Runtime history run: %v", err)
	}
	insertRuntimeStatusFixture(t, env, "run-terminal-context-history")
	if _, err := env.pool.Exec(t.Context(), `
		INSERT INTO agent_runtime_status_events(local_run_id,event_ordinal,segment_id,command_id,event_type,payload)
		VALUES('run-terminal-context-history',1,'terminal-context-history-segment',
			'terminal-context-history-event','status.changed','{"type":"status.changed","status":"done"}'::jsonb)
	`); err != nil {
		t.Fatalf("seed terminal Context Runtime event: %v", err)
	}
	if _, err := env.pool.Exec(t.Context(), `
		UPDATE agent_execution_contexts
		SET target_residency='suspended',terminal_reason='room_deleted',
			terminated_at=clock_timestamp(),state_revision=state_revision+1
		WHERE context_key=$1
	`, env.contextKey); err != nil {
		t.Fatalf("seed terminal Context with Runtime history: %v", err)
	}
	current, err := env.service.GetContext(t.Context(), env.contextKey)
	if err != nil {
		t.Fatalf("read terminal Context before idempotent deletion: %v", err)
	}
	if current.TerminalReason != "room_deleted" {
		t.Fatalf("terminal Context reason=%q, want room_deleted", current.TerminalReason)
	}
	var runtimeEventCount int64
	if err := env.pool.QueryRow(t.Context(), `
		SELECT count(*)::bigint
		FROM agent_runtime_status_events event
		JOIN agent_local_runs run ON run.run_id=event.local_run_id
		WHERE run.context_key=$1
	`, env.contextKey).Scan(&runtimeEventCount); err != nil {
		t.Fatalf("count terminal Context Runtime events: %v", err)
	}
	if runtimeEventCount != 1 {
		t.Fatalf("terminal Context Runtime events=%d, want 1", runtimeEventCount)
	}
	request := agentruntimestate.DeleteContextInput{ContextKey: env.contextKey,
		ExpectedRevision: current.StateRevision - 1,
	}
	deleted, err := env.service.DeleteContext(t.Context(), request)
	if err != nil || !deleted {
		t.Fatalf("delete terminal Context with Runtime history: deleted=%t err=%v", deleted, err)
	}
	var terminalReason string
	var stateRevision int64
	if err := env.pool.QueryRow(t.Context(), `
		SELECT terminal_reason,state_revision
		FROM agent_execution_contexts WHERE context_key=$1
	`, env.contextKey).Scan(&terminalReason, &stateRevision); err != nil {
		t.Fatalf("read retained terminal Context: %v", err)
	}
	if terminalReason != "room_deleted" || stateRevision != current.StateRevision {
		t.Fatalf("retained terminal Context reason/revision=%q/%d, want room_deleted/%d",
			terminalReason, stateRevision, current.StateRevision)
	}
	var eventCount int
	if err := env.pool.QueryRow(t.Context(), `
		SELECT count(*) FROM agent_runtime_status_events
		WHERE local_run_id='run-terminal-context-history'
	`).Scan(&eventCount); err != nil {
		t.Fatalf("count retained terminal Runtime history: %v", err)
	}
	if eventCount != 1 {
		t.Fatalf("retained terminal Runtime history events=%d, want 1", eventCount)
	}
	replayed, err := env.service.DeleteContext(t.Context(), request)
	if err != nil || !replayed {
		t.Fatalf("replay terminal Context deletion: deleted=%t err=%v", replayed, err)
	}
}

func TestAgentRuntimeClaimsOnlyOneRunningRun(t *testing.T) {
	allowParallelIntegrationTest(t)
	env := newRuntimeStateTestEnv(t)
	for index := 1; index <= 2; index++ {
		inputID := fmt.Sprintf("queued-input-%d", index)
		if result, err := env.service.SubmitTrustedTurn(t.Context(), agentruntimestate.SubmitTrustedTurnInput{ContextKey: env.contextKey, Epoch: env.epoch,
			Inputs: []agentruntimestate.RuntimeInput{runtimeInput(inputID, "trusted_turn", "", inputID)},
		}); err != nil || !result.Created {
			t.Fatalf("submit trusted turn %d: result=%+v err=%v", index, result, err)
		}
	}

	results := make(chan agentruntimestate.ClaimLocalRunResult, 2)
	errorsCh := make(chan error, 2)
	var ready sync.WaitGroup
	ready.Add(2)
	start := make(chan struct{})
	for index := 1; index <= 2; index++ {

		go func() {
			ready.Done()
			<-start
			claimed, err := env.service.ClaimLocalRun(context.Background(), agentruntimestate.ClaimLocalRunInput{
				ClaimID: fmt.Sprintf("claim-local-run-%d", index), ContextKey: env.contextKey, Epoch: env.epoch,
			})
			results <- claimed
			errorsCh <- err
		}()
	}
	ready.Wait()
	close(start)

	nonEmpty := 0
	for index := 0; index < 2; index++ {
		if err := <-errorsCh; err != nil {
			t.Fatalf("claim Local Run: %v", err)
		}
		if claimed := <-results; claimed.Run != nil {
			nonEmpty++
		}
	}
	if nonEmpty != 1 {
		t.Fatalf("non-empty claims=%d, want 1", nonEmpty)
	}

	var running, queued int
	if err := env.pool.QueryRow(t.Context(), `
		SELECT count(*) FILTER (WHERE status='running'),count(*) FILTER (WHERE status='queued')
		FROM agent_local_runs WHERE context_key=$1`, env.contextKey).Scan(&running, &queued); err != nil {
		t.Fatalf("count Local Runs: %v", err)
	}
	if running != 1 || queued != 1 {
		t.Fatalf("Local Run states running=%d queued=%d, want 1/1", running, queued)
	}
	// Preserve queued cancellation, immutable trusted replay and terminal consistency
	// at PostgreSQL authority after retiring the Agent's SQLite implementation.
	var runningID, queuedID, queuedInputID string
	if err := env.pool.QueryRow(t.Context(), `SELECT run_id FROM agent_local_runs WHERE context_key=$1 AND status='running'`, env.contextKey).Scan(&runningID); err != nil {
		t.Fatal(err)
	}
	if err := env.pool.QueryRow(t.Context(), `SELECT run.run_id,input.input_id FROM agent_local_runs run JOIN agent_local_run_inputs input ON input.run_id=run.run_id WHERE run.context_key=$1 AND run.status='queued' AND input.relation='initial'`, env.contextKey).Scan(&queuedID, &queuedInputID); err != nil {
		t.Fatal(err)
	}
	canceled, err := env.service.CancelLocalRun(t.Context(), agentruntimestate.CancelLocalRunInput{ContextKey: env.contextKey, Epoch: env.epoch, RunID: queuedID})
	if err != nil || canceled.Status != "canceled" {
		t.Fatalf("queued cancellation=%+v error=%v", canceled, err)
	}
	replayed, err := env.service.SubmitTrustedTurn(t.Context(), agentruntimestate.SubmitTrustedTurnInput{ContextKey: env.contextKey, Epoch: env.epoch,
		Inputs: []agentruntimestate.RuntimeInput{runtimeInput(queuedInputID, "trusted_turn", "", queuedInputID)},
	})
	if err != nil || replayed.RunID != queuedID || replayed.Created {
		t.Fatalf("canceled trusted input created another Run=%+v error=%v", replayed, err)
	}
	canceled, err = env.service.CancelLocalRun(t.Context(), agentruntimestate.CancelLocalRunInput{ContextKey: env.contextKey, Epoch: env.epoch, RunID: runningID})
	if err != nil || canceled.Status != "cancel_requested" {
		t.Fatalf("running cancellation=%+v error=%v", canceled, err)
	}
	finish := agentruntimestate.FinishLocalRunInput{ContextKey: env.contextKey, Epoch: env.epoch, RunID: runningID, Terminal: json.RawMessage(`{"type":"canceled"}`)}
	for range 2 {
		finished, err := env.service.FinishLocalRun(t.Context(), finish)
		if err != nil || finished.Run.Status != "canceled" {
			t.Fatalf("consistent terminal=%+v error=%v", finished, err)
		}
	}
	finish.Terminal = json.RawMessage(`{"type":"failed","error":"late"}`)
	if _, err := env.service.FinishLocalRun(t.Context(), finish); !errors.Is(err, agentruntimestate.ErrConflict) {
		t.Fatalf("conflicting terminal error=%v", err)
	}

}

// A holder that finishes a Run TeamHub canceled for a reason, such as a Task
// ending without moving its lease, gets that cancellation back.
func TestAgentRuntimeFinishReturnsTeamHubCancellation(t *testing.T) {
	allowParallelIntegrationTest(t)
	env := newRuntimeStateTestEnv(t)
	submitted, err := env.service.SubmitTrustedTurn(t.Context(), agentruntimestate.SubmitTrustedTurnInput{ContextKey: env.contextKey, Epoch: env.epoch,
		Inputs: []agentruntimestate.RuntimeInput{runtimeInput("upstream-canceled-input", "trusted_turn", "", "work")},
	})
	if err != nil {
		t.Fatal(err)
	}
	if claimed, err := env.service.ClaimLocalRun(t.Context(), agentruntimestate.ClaimLocalRunInput{
		ClaimID: "claim-upstream-canceled", ContextKey: env.contextKey, Epoch: env.epoch,
	}); err != nil || claimed.Run == nil {
		t.Fatalf("claim: %+v %v", claimed, err)
	}
	tx, err := env.pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(t.Context())
	if _, err := agentruntimestate.TerminateLocalRuns(t.Context(), store.New(tx), []string{submitted.RunID},
		json.RawMessage(`{"type":"canceled","reason":"task_terminal"}`)); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
	finish := agentruntimestate.FinishLocalRunInput{ContextKey: env.contextKey, Epoch: env.epoch,
		RunID: submitted.RunID, Terminal: json.RawMessage(`{"type":"succeeded"}`),
	}
	for range 2 {
		finished, err := env.service.FinishLocalRun(t.Context(), finish)
		if err != nil || finished.Run.Status != "canceled" || !strings.Contains(string(finished.Run.Terminal), "task_terminal") {
			t.Fatalf("finish after TeamHub cancellation: run=%+v err=%v", finished.Run, err)
		}
	}
	// A cancellation without a reason is the holder's own, so a different
	// terminal still conflicts.
	submitted, err = env.service.SubmitTrustedTurn(t.Context(), agentruntimestate.SubmitTrustedTurnInput{ContextKey: env.contextKey, Epoch: env.epoch,
		Inputs: []agentruntimestate.RuntimeInput{runtimeInput("own-canceled-input", "trusted_turn", "", "work")},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := env.service.ClaimLocalRun(t.Context(), agentruntimestate.ClaimLocalRunInput{
		ClaimID: "claim-own-canceled", ContextKey: env.contextKey, Epoch: env.epoch,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := env.service.FinishLocalRun(t.Context(), agentruntimestate.FinishLocalRunInput{ContextKey: env.contextKey, Epoch: env.epoch,
		RunID: submitted.RunID, Terminal: json.RawMessage(`{"type":"canceled"}`),
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := env.service.FinishLocalRun(t.Context(), agentruntimestate.FinishLocalRunInput{ContextKey: env.contextKey, Epoch: env.epoch,
		RunID: submitted.RunID, Terminal: json.RawMessage(`{"type":"succeeded"}`),
	}); !errors.Is(err, agentruntimestate.ErrConflict) {
		t.Fatalf("different terminal after own cancellation: %v", err)
	}
}

func TestAgentRuntimeRequeuesDefinitelyNotStartedRunWithAttemptCount(t *testing.T) {
	allowParallelIntegrationTest(t)
	env := newRuntimeStateTestEnv(t)
	submitted, err := env.service.SubmitTrustedTurn(t.Context(), agentruntimestate.SubmitTrustedTurnInput{ContextKey: env.contextKey, Epoch: env.epoch,
		Inputs: []agentruntimestate.RuntimeInput{runtimeInput("retryable-run-input", "trusted_turn", "", "retry")},
	})
	if err != nil {
		t.Fatalf("submit retryable Local Run: %v", err)
	}
	first, err := env.service.ClaimLocalRun(t.Context(), agentruntimestate.ClaimLocalRunInput{
		ClaimID: "claim-retryable-run-first", ContextKey: env.contextKey, Epoch: env.epoch,
	})
	if err != nil || first.Run == nil || first.Run.RunID != submitted.RunID || first.Run.AttemptCount != 1 {
		t.Fatalf("first retryable claim: result=%+v err=%v", first, err)
	}
	if err := env.service.RequeueLocalRun(t.Context(), agentruntimestate.RequeueLocalRunInput{ContextKey: env.contextKey, Epoch: env.epoch, RunID: submitted.RunID}); err != nil {
		t.Fatalf("requeue definitely-not-started Local Run: %v", err)
	}
	second, err := env.service.ClaimLocalRun(t.Context(), agentruntimestate.ClaimLocalRunInput{
		ClaimID: "claim-retryable-run-second", ContextKey: env.contextKey, Epoch: env.epoch,
	})
	if err != nil || second.Run == nil || second.Run.RunID != submitted.RunID || second.Run.AttemptCount != 2 {
		t.Fatalf("second retryable claim: result=%+v err=%v", second, err)
	}
	startRuntimeEpoch(t, env.service, "agent-epoch-requeue")
	if err := env.service.RequeueLocalRun(t.Context(), agentruntimestate.RequeueLocalRunInput{
		ContextKey: env.contextKey, Epoch: env.epoch, RunID: submitted.RunID,
	}); !errors.Is(err, agentruntimestate.ErrFenced) {
		t.Fatalf("previous epoch requeue error=%v, want fenced", err)
	}
}

func TestAgentRuntimeAssignsCompletesAndEnqueuesSteer(t *testing.T) {
	allowParallelIntegrationTest(t)
	env := newRuntimeStateTestEnv(t)
	active, err := env.service.SubmitTrustedTurn(t.Context(), agentruntimestate.SubmitTrustedTurnInput{ContextKey: env.contextKey, Epoch: env.epoch,
		Inputs: []agentruntimestate.RuntimeInput{runtimeInput("active-steer-target", "trusted_turn", "", "active")},
	})
	if err != nil {
		t.Fatalf("submit active steer target: %v", err)
	}
	claimed, err := env.service.ClaimLocalRun(t.Context(), agentruntimestate.ClaimLocalRunInput{
		ClaimID: "claim-active-steer-target", ContextKey: env.contextKey, Epoch: env.epoch,
	})
	if err != nil || claimed.Run == nil || claimed.Run.RunID != active.RunID {
		t.Fatalf("claim active steer target: result=%+v err=%v", claimed, err)
	}

	firstGroup := acceptTrustedSteerGroup(t, env, active.RunID, "steer-applied-input", "accept-steer-applied")
	if err := env.service.AssignSteerRun(t.Context(), agentruntimestate.AssignSteerRunInput{ContextKey: env.contextKey, Epoch: env.epoch,
		GroupID: firstGroup, RunID: active.RunID,
	}); err != nil {
		t.Fatalf("assign steer to active Run: %v", err)
	}
	if err := env.service.CompleteSteer(t.Context(), agentruntimestate.CompleteSteerInput{ContextKey: env.contextKey, Epoch: env.epoch,
		GroupID: firstGroup, RunID: active.RunID, Outcome: "applied",
	}); err != nil {
		t.Fatalf("complete applied steer: %v", err)
	}
	if outcome := runtimeSteerOutcome(t, env, "steer-applied-input"); outcome != "applied" {
		t.Fatalf("read applied steer outcome: outcome=%q", outcome)
	}

	secondGroup := acceptTrustedSteerGroup(t, env, active.RunID, "steer-fallback-input", "accept-steer-fallback")
	if err := env.service.AssignSteerRun(t.Context(), agentruntimestate.AssignSteerRunInput{ContextKey: env.contextKey, Epoch: env.epoch,
		GroupID: secondGroup, RunID: active.RunID,
	}); err != nil {
		t.Fatalf("assign fallback steer to active Run: %v", err)
	}
	enqueued, err := env.service.EnqueueSteer(t.Context(), agentruntimestate.EnqueueSteerInput{ContextKey: env.contextKey, Epoch: env.epoch, GroupID: secondGroup})
	if err != nil || enqueued.RunID == "" || enqueued.RunID == active.RunID {
		t.Fatalf("enqueue fallback steer: result=%+v err=%v", enqueued, err)
	}
	run, err := env.service.GetLocalRun(t.Context(), env.contextKey, enqueued.RunID)
	if err != nil || run.Status != "queued" || len(run.InitialInputIDs) != 1 || run.InitialInputIDs[0] != "steer-fallback-input" {
		t.Fatalf("fallback Local Run: run=%+v err=%v", run, err)
	}
	activeRun, err := env.service.GetLocalRun(t.Context(), env.contextKey, active.RunID)
	if err != nil || len(activeRun.SteerInputIDs) != 1 || activeRun.SteerInputIDs[0] != "steer-applied-input" {
		t.Fatalf("active Run steer input after fallback: run=%+v err=%v", activeRun, err)
	}
}

func TestAgentRuntimePerRoomMetaContextsUseMembershipEpochs(t *testing.T) {
	allowParallelIntegrationTest(t)
	databaseURL := newIntegrationDatabase(t)
	pool, err := pgxpool.New(t.Context(), databaseURL)
	if err != nil {
		t.Fatalf("open per-Room Runtime state database: %v", err)
	}
	t.Cleanup(pool.Close)
	if _, err := pool.Exec(t.Context(), `UPDATE agent_registrations SET agent_type='anotherme',receives_all_messages=true,represented_human_actor_id=created_by_actor_id WHERE agent_management_id=$1`, testRuntimeAgentID); err != nil {
		t.Fatal(err)
	}
	service := agentruntimestate.New(pool)

	if _, err := service.EnsureContext(t.Context(), agentruntimestate.EnsureContextInput{Ref: agentruntimestate.ContextRef{Kind: "meta", AgentID: testRuntimeAgentID},
		TargetResidency: "active",
	}); !errors.Is(err, agentruntimestate.ErrInvalid) {
		t.Fatalf("ensure room-less Meta error=%v, want invalid", err)
	}
	if _, err := service.EnsureContext(t.Context(), agentruntimestate.EnsureContextInput{
		Ref: agentruntimestate.ContextRef{
			Kind: "meta", AgentID: testRuntimeAgentID, RoomID: "room_runtime_unjoined",
		},
		TargetResidency: "active",
	}); !errors.Is(err, agentruntimestate.ErrNotFound) {
		t.Fatalf("ensure unjoined per-Room Meta error=%v, want not found", err)
	}

	roomIDs := []string{"room_runtime_per_room_one", "room_runtime_per_room_two"}
	for index, roomID := range roomIDs {
		insertRuntimeRoomMembership(t, pool, roomID)
		if index == 0 {
			if _, err := pool.Exec(t.Context(), `
				UPDATE rooms SET direct_human_actor_id='actor_acme_alice',direct_agent_actor_id='actor_acme_official'
				WHERE id=$1 AND tenant_id='tenant_acme'`, roomID); err != nil {
				t.Fatal(err)
			}
			if _, err := pool.Exec(t.Context(), `INSERT INTO messages(id,tenant_id,room_id,author_actor_id,body,segments)
				VALUES('per-room-history-source','tenant_acme',$1,'actor_acme_alice','history','[{"type":"text","content":"history"}]')`, roomID); err != nil {
				t.Fatal(err)
			}
			if _, err := pool.Exec(t.Context(), `INSERT INTO room_events(event_id,tenant_id,room_id,room_seq,event_type,actor_id,resource_id,payload)
				VALUES('per-room-history-event','tenant_acme',$1,5,'message.created','actor_acme_alice','per-room-history-source','{}')`, roomID); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := agentruntimestate.EnsurePerRoomMetaContexts(
		t.Context(), store.New(pool), "actor_acme_official",
	); err != nil {
		t.Fatalf("ensure per-Room Meta Contexts: %v", err)
	}
	listed, err := service.ListContexts(t.Context(), testRuntimeAgentID)
	if err != nil || len(listed) != len(roomIDs) {
		t.Fatalf("list per-Room Contexts: contexts=%+v err=%v", listed, err)
	}
	contexts := make(map[string]agentruntimestate.Context, len(roomIDs))
	for _, context := range listed {
		if context.MembershipEpochID == "" {
			t.Fatalf("per-Room Meta Context has no membership epoch: %+v", context)
		}
		contexts[context.Ref.RoomID] = context
	}
	if contexts[roomIDs[0]].RoomKind != "direct" || contexts[roomIDs[1]].RoomKind != "collaboration" {
		t.Fatalf("per-Room Context Room kinds were not derived from TeamHub authority: %+v", contexts)
	}
	if contexts[roomIDs[0]].ContextKey == contexts[roomIDs[1]].ContextKey ||
		contexts[roomIDs[0]].MembershipEpochID == contexts[roomIDs[1]].MembershipEpochID {
		t.Fatalf("per-Room Context identities were not isolated: %+v", contexts)
	}
	var sessionCount int
	if err := pool.QueryRow(t.Context(), `
		SELECT count(*)
		FROM agent_execution_contexts context
		WHERE context.agent_management_id=$1 AND context.session IS NOT NULL`, testRuntimeAgentID).Scan(&sessionCount); err != nil {
		t.Fatalf("count cold per-Room Runtime Sessions: %v", err)
	}
	if sessionCount != 0 {
		t.Fatalf("cold per-Room Runtime Session count=%d, want 0", sessionCount)
	}

	startRuntimeEpoch(t, service, testRuntimeEpoch)
	for _, context := range listed {
		if context.TargetResidency != "suspended" {
			t.Fatalf("cold per-Room Context residency=%q, want suspended", context.TargetResidency)
		}
	}

	firstRoom := roomIDs[0]
	secondRoom := roomIDs[1]
	firstContext := contexts[firstRoom]
	const taskWorkRoom = "room_runtime_coordinator_work"
	insertRuntimeRoomMembership(t, pool, taskWorkRoom)
	taskRoomIDs := []string{firstRoom, secondRoom, taskWorkRoom}
	taskIDs := []string{"workitem_runtime_per_room_one", "workitem_runtime_per_room_two", "workitem_runtime_coordinator_bound"}
	tx, err := pool.Begin(t.Context())
	if err != nil {
		t.Fatalf("begin per-Room Runtime Task fixture: %v", err)
	}
	defer tx.Rollback(t.Context())
	for index, taskID := range taskIDs {
		coordinatorKey := ""
		if index == 2 {
			coordinatorKey = firstContext.ContextKey
		}
		if _, err := tx.Exec(t.Context(), `
			INSERT INTO work_items(
				id,tenant_id,number,kind,title,created_by_actor_id,updated_by_actor_id,state,
				task_execution_generation,task_execution_status,
				task_execution_revision,task_desired_control,task_control_revision,
				task_control_settled_revision,task_execution_updated_at,
				task_next_reconcile_at,task_lease_generation
			) VALUES(
				$1,'tenant_acme',$2,'task',$1,'actor_acme_alice','actor_acme_alice','in_progress',
				1,'idle',1,'run',0,0,clock_timestamp(),clock_timestamp(),0
			)`,
			taskID, 9000+index); err != nil {
			t.Fatalf("insert per-Room Runtime Task %s: %v", taskID, err)
		}
		if _, err := tx.Exec(t.Context(), `
			INSERT INTO task_execution_generations(
				task_id,tenant_id,generation,
				result_agent_actor_id,spec,spec_hash,coordinator_actor_id,coordinator_context_key
			) VALUES(
				$1,'tenant_acme',1,
				'actor_acme_official','{}'::jsonb,decode(repeat('00',32),'hex'),CASE WHEN $2::text='' THEN NULL ELSE 'actor_acme_official' END,NULLIF($2::text,'')
			)`, taskID, coordinatorKey); err != nil {
			t.Fatalf("insert per-Room Runtime Task generation %s: %v", taskID, err)
		}
		if _, err := tx.Exec(t.Context(), `
			INSERT INTO task_execution_participants(
				task_id,tenant_id,generation,actor_id,
				agent_management_id,execution_context_ref
			) VALUES(
				$1,'tenant_acme',1,'actor_acme_official',$2::text,
				jsonb_build_object('kind','alter_ego','agentId',$2::text,'taskId',$1::text)
			)`, taskID, testRuntimeAgentID); err != nil {
			t.Fatalf("insert per-Room Runtime Task participant %s: %v", taskID, err)
		}
		if _, err := tx.Exec(t.Context(), `
			INSERT INTO task_meta_inboxes(task_id,tenant_id,agent_actor_id)
			VALUES($1,'tenant_acme','actor_acme_official')`, taskID); err != nil {
			t.Fatalf("insert per-Room Runtime Task Meta Inbox %s: %v", taskID, err)
		}
		if _, err := tx.Exec(t.Context(), `
			INSERT INTO work_item_room_links(
				work_item_id,tenant_id,link_type,room_id,linked_by_actor_id
			) VALUES($1,'tenant_acme','work',$2,'actor_acme_alice')`,
			taskID, taskRoomIDs[index]); err != nil {
			t.Fatalf("link per-Room Runtime Task %s: %v", taskID, err)
		}
	}
	if err := tx.Commit(t.Context()); err != nil {
		t.Fatalf("commit per-Room Runtime Task fixture: %v", err)
	}
	if scope := firstContext.SharedTaskScope; scope == nil || scope.Role != "meta" || scope.OriginRoomID != firstRoom || scope.TaskID != "" {
		t.Fatalf("Room Meta shared Task scope=%+v, want meta of %s", scope, firstRoom)
	}
	for index, taskID := range taskIDs {
		ensured, err := service.EnsureContext(t.Context(), agentruntimestate.EnsureContextInput{TargetResidency: "active",
			Ref: agentruntimestate.ContextRef{Kind: "alter_ego", AgentID: testRuntimeAgentID, TaskID: taskID},
		})
		if err != nil {
			t.Fatalf("ensure alter_ego for %s: %v", taskID, err)
		}
		scope := ensured.Context.SharedTaskScope
		if index != 2 {
			if scope != nil {
				t.Fatalf("alter_ego without coordinator %s scope=%+v, want none", taskID, scope)
			}
			continue
		}
		// The origin is the frozen coordinator's Room, not the Task Room.
		if scope == nil || scope.Role != "alter_ego" || scope.TaskID != taskID || scope.OriginRoomID != firstRoom || scope.TenantID != "tenant_acme" {
			t.Fatalf("coordinated alter_ego scope=%+v, want origin %s", scope, firstRoom)
		}
	}
	listedScopes, err := service.ListContexts(t.Context(), testRuntimeAgentID)
	if err != nil {
		t.Fatal(err)
	}
	scopedAlterEgos := 0
	for _, listed := range listedScopes {
		if listed.Ref.Kind == "alter_ego" && listed.SharedTaskScope != nil {
			scopedAlterEgos++
			if listed.Ref.TaskID != taskIDs[2] || listed.SharedTaskScope.OriginRoomID != firstRoom {
				t.Fatalf("listed alter_ego scope=%+v for %s", listed.SharedTaskScope, listed.Ref.TaskID)
			}
		}
	}
	if scopedAlterEgos != 1 {
		t.Fatalf("listed scoped alter_ego Contexts=%d, want 1", scopedAlterEgos)
	}
	firstTaskInbox := "task:" + taskIDs[0]
	secondTaskInbox := "task:" + taskIDs[1]
	// Every Room Message notifies an all-actionable Agent, so only Inbox
	// authority decides which Contexts receive it.
	if _, err := pool.Exec(t.Context(), `UPDATE agent_registrations SET agent_type='anotherme',receives_all_messages=true,represented_human_actor_id=created_by_actor_id WHERE agent_management_id=$1`, testRuntimeAgentID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(t.Context(), `INSERT INTO messages(id,tenant_id,room_id,author_actor_id,body,segments)
        VALUES('current-runtime-source','tenant_acme',$1,'actor_acme_alice','current','[{"type":"text","content":"current"}]')`, firstRoom); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(t.Context(), `INSERT INTO room_events(event_id,tenant_id,room_id,room_seq,event_type,actor_id,resource_id,payload)
	        VALUES('current-runtime-event','tenant_acme',$1,9,'message.created','actor_acme_alice','current-runtime-source','{}')`, firstRoom); err != nil {
		t.Fatal(err)
	}
	// A Work Room Message reaches its Room's Meta through the Task Inbox only.
	var queuedInboxes []string
	if err := pool.QueryRow(t.Context(), `
		SELECT coalesce(array_agg(context_key||' '||source_inbox_id ORDER BY context_key),'{}')
		FROM agent_runtime_inputs WHERE source_message_id='current-runtime-source'`).Scan(&queuedInboxes); err != nil {
		t.Fatal(err)
	}
	if want := []string{firstContext.ContextKey + " " + firstTaskInbox}; !slices.Equal(queuedInboxes, want) {
		t.Fatalf("Work Room Message queued for %v, want %v", queuedInboxes, want)
	}
	unaffectedContext, err := service.GetContext(t.Context(), contexts[secondRoom].ContextKey)
	if err != nil || unaffectedContext.TargetResidency != "suspended" {
		t.Fatalf("sibling Context residency changed: context=%+v err=%v", unaffectedContext, err)
	}

	const wrongRoomMessageID = "message_runtime_wrong_room"
	if _, err := pool.Exec(t.Context(), `
		INSERT INTO messages(id,tenant_id,room_id,author_actor_id,body,segments)
		VALUES($1,'tenant_acme',$2,'actor_acme_alice','wrong Room callback',
		       '[{"type":"text","content":"wrong Room callback"}]'::jsonb)`, wrongRoomMessageID, taskWorkRoom); err != nil {
		t.Fatalf("insert wrong-Room callback source: %v", err)
	}
	wrongRoomInput := runtimeInput(
		"wrong-room-runtime-input", "trusted_turn", "room:"+secondRoom, "wrong Room callback",
	)
	wrongRoomInput.SourceMessageID = wrongRoomMessageID
	if _, err := service.SubmitTrustedTurn(t.Context(), agentruntimestate.SubmitTrustedTurnInput{ContextKey: contexts[firstRoom].ContextKey,
		Epoch: testRuntimeEpoch, Inputs: []agentruntimestate.RuntimeInput{wrongRoomInput},
	}); !errors.Is(err, agentruntimestate.ErrInboxNotAuthorized) {
		t.Fatalf("submit trusted turn for another Room error=%v, want Inbox authorization rejection", err)
	}

	// The coordinator lives in the origin Room, but Task messages live in the work Room.
	coordinatorTaskInbox := "task:" + taskIDs[2]
	if _, err := pool.Exec(t.Context(), `INSERT INTO room_events(event_id,tenant_id,room_id,room_seq,event_type,actor_id,resource_id,payload)
        VALUES('task-coordinator-source-event','tenant_acme',$1,10,'message.created','actor_acme_alice',$2,'{}')`, taskWorkRoom, wrongRoomMessageID); err != nil {
		t.Fatal(err)
	}
	coordinatorInput := queuedRuntimeInbox(t, pool, firstContext.ContextKey, wrongRoomMessageID)
	if coordinatorInput.RunID == "" {
		t.Fatalf("Task Message from a different work Room was not queued: %+v", coordinatorInput)
	}
	var acceptedPayload, acceptedInbox string
	if err := pool.QueryRow(t.Context(), `SELECT payload::text,source_inbox_id FROM agent_runtime_inputs WHERE context_key=$1 AND input_id=$2`, firstContext.ContextKey, coordinatorInput.InputID).Scan(&acceptedPayload, &acceptedInbox); err != nil {
		t.Fatal(err)
	}
	if acceptedInbox != coordinatorTaskInbox || !strings.Contains(acceptedPayload, wrongRoomMessageID) || !strings.Contains(acceptedPayload, "wrong Room callback") {
		t.Fatalf("queued Task lost authoritative work Room message: inbox=%s payload=%s", acceptedInbox, acceptedPayload)
	}

	if _, err := pool.Exec(t.Context(), `
		DELETE FROM room_members WHERE membership_epoch_id=$1`, contexts[firstRoom].MembershipEpochID); err != nil {
		t.Fatalf("revoke first Room membership epoch: %v", err)
	}
	if _, err := service.SubmitTrustedTurn(t.Context(), agentruntimestate.SubmitTrustedTurnInput{ContextKey: contexts[firstRoom].ContextKey,
		Epoch: testRuntimeEpoch, Inputs: []agentruntimestate.RuntimeInput{
			runtimeInput("revoked-room-input", "trusted_turn", firstTaskInbox, "revoked"),
		},
	}); !errors.Is(err, agentruntimestate.ErrFenced) {
		t.Fatalf("accept input with revoked Room authority error=%v, want fenced", err)
	}
	if _, err := service.SubmitTrustedTurn(t.Context(), agentruntimestate.SubmitTrustedTurnInput{ContextKey: contexts[secondRoom].ContextKey,
		Epoch: testRuntimeEpoch, Inputs: []agentruntimestate.RuntimeInput{
			runtimeInput("current-room-input", "trusted_turn", secondTaskInbox, "current"),
		},
	}); err != nil {
		t.Fatalf("accept input for unaffected Room: %v", err)
	}
}

func TestAgentRuntimeRetiresWorkRoomPerRoomMetaWithoutCoordinator(t *testing.T) {
	allowParallelIntegrationTest(t)
	databaseURL := newIntegrationDatabase(t)
	pool, err := pgxpool.New(t.Context(), databaseURL)
	if err != nil {
		t.Fatalf("open work Room Runtime database: %v", err)
	}
	t.Cleanup(pool.Close)
	service := agentruntimestate.New(pool)

	const collaborationRoom = "room_runtime_keep_meta"
	const workRoom = "room_runtime_task_work"
	insertRuntimeRoomMembership(t, pool, collaborationRoom)
	insertRuntimeRoomMembership(t, pool, workRoom)
	if err := agentruntimestate.EnsurePerRoomMetaContexts(
		t.Context(), store.New(pool), "actor_acme_official",
	); err != nil {
		t.Fatalf("ensure per-Room Meta Contexts: %v", err)
	}
	workContextKey := `["meta","` + testRuntimeAgentID + `","room","` + workRoom + `"]`
	collaborationContextKey := `["meta","` + testRuntimeAgentID + `","room","` + collaborationRoom + `"]`
	startRuntimeEpoch(t, service, testRuntimeEpoch)
	if _, err := service.SubmitTrustedTurn(t.Context(), agentruntimestate.SubmitTrustedTurnInput{ContextKey: workContextKey, Epoch: testRuntimeEpoch,
		Inputs: []agentruntimestate.RuntimeInput{
			runtimeInput("work-room-turn", "trusted_turn", "room:"+workRoom, "still queued"),
		},
	}); err != nil {
		t.Fatalf("submit work Room turn: %v", err)
	}

	const taskID = "workitem_runtime_task_work_room"
	tx, err := pool.Begin(t.Context())
	if err != nil {
		t.Fatalf("begin Task fixture: %v", err)
	}
	defer tx.Rollback(t.Context())
	if _, err := tx.Exec(t.Context(), `
		INSERT INTO work_items(
			id,tenant_id,number,kind,title,created_by_actor_id,updated_by_actor_id,state,
			task_execution_generation,task_execution_status,
			task_execution_revision,task_desired_control,task_control_revision,
			task_control_settled_revision,task_execution_updated_at,
			task_next_reconcile_at,task_lease_generation
		) VALUES(
			$1,'tenant_acme',9101,'task',$1,'actor_acme_alice','actor_acme_alice','in_progress',
			1,'idle',1,'run',0,0,clock_timestamp(),clock_timestamp(),0
		)`, taskID); err != nil {
		t.Fatalf("insert Task: %v", err)
	}
	if _, err := tx.Exec(t.Context(), `
		INSERT INTO task_execution_generations(
			task_id,tenant_id,generation,
			result_agent_actor_id,spec,spec_hash
		) VALUES(
			$1,'tenant_acme',1,
			'actor_acme_official','{}'::jsonb,decode(repeat('00',32),'hex')
		)`, taskID); err != nil {
		t.Fatalf("insert Task generation: %v", err)
	}
	if _, err := tx.Exec(t.Context(), `
		INSERT INTO task_execution_participants(
			task_id,tenant_id,generation,actor_id,
			agent_management_id,execution_context_ref
		) VALUES(
			$1,'tenant_acme',1,'actor_acme_official',$2::text,
			jsonb_build_object('kind','alter_ego','agentId',$2::text,'taskId',$1::text)
		)`, taskID, testRuntimeAgentID); err != nil {
		t.Fatalf("insert Task participant: %v", err)
	}
	if _, err := tx.Exec(t.Context(), `
		INSERT INTO task_meta_inboxes(task_id,tenant_id,agent_actor_id)
		VALUES($1,'tenant_acme','actor_acme_official')`, taskID); err != nil {
		t.Fatalf("insert Task Meta Inbox: %v", err)
	}
	if _, err := tx.Exec(t.Context(), `
		INSERT INTO work_item_room_links(
			work_item_id,tenant_id,link_type,room_id,linked_by_actor_id
		) VALUES($1,'tenant_acme','work',$2,'actor_acme_alice')`, taskID, workRoom); err != nil {
		t.Fatalf("link work Room: %v", err)
	}
	if err := tx.Commit(t.Context()); err != nil {
		t.Fatalf("commit Task fixture: %v", err)
	}

	if err := agentruntimestate.EnsurePerRoomMetaContexts(
		t.Context(), store.New(pool), "actor_acme_official",
	); err != nil {
		t.Fatalf("retire work Room Meta Context: %v", err)
	}
	var workResidency, workTerminal, runStatus, inputStatus string
	if err := pool.QueryRow(t.Context(), `
		SELECT target_residency, COALESCE(terminal_reason,'')
		FROM agent_execution_contexts WHERE context_key=$1`, workContextKey).Scan(&workResidency, &workTerminal); err != nil {
		t.Fatalf("read retired work Room Context: %v", err)
	}
	if workResidency != "suspended" || workTerminal != "context_deleted" {
		t.Fatalf("work Room Context residency=%q terminal=%q", workResidency, workTerminal)
	}
	if err := pool.QueryRow(t.Context(), `
		SELECT status FROM agent_local_runs WHERE context_key=$1`, workContextKey).Scan(&runStatus); err != nil {
		t.Fatalf("read canceled work Room Run: %v", err)
	}
	if runStatus != "canceled" {
		t.Fatalf("work Room Run status=%q, want canceled", runStatus)
	}
	if err := pool.QueryRow(t.Context(), `
		SELECT status FROM agent_runtime_inputs WHERE context_key=$1 AND input_id='work-room-turn'`, workContextKey).Scan(&inputStatus); err != nil {
		t.Fatalf("read settled work Room input: %v", err)
	}
	if inputStatus != "handled" {
		t.Fatalf("work Room input status=%q, want handled", inputStatus)
	}
	var collaborationResidency, collaborationTerminal string
	if err := pool.QueryRow(t.Context(), `
		SELECT target_residency, COALESCE(terminal_reason,'')
		FROM agent_execution_contexts WHERE context_key=$1`, collaborationContextKey).Scan(
		&collaborationResidency, &collaborationTerminal); err != nil {
		t.Fatalf("read collaboration Context: %v", err)
	}
	if collaborationResidency == "" || collaborationTerminal != "" {
		t.Fatalf("collaboration Context residency=%q terminal=%q", collaborationResidency, collaborationTerminal)
	}
	if err := agentruntimestate.EnsurePerRoomMetaContexts(
		t.Context(), store.New(pool), "actor_acme_official",
	); err != nil {
		t.Fatalf("repeat ensure: %v", err)
	}
	var revived int
	if err := pool.QueryRow(t.Context(), `
		SELECT count(*) FROM agent_execution_contexts
		WHERE context_key=$1 AND terminal_reason IS NULL`, workContextKey).Scan(&revived); err != nil {
		t.Fatalf("count revived work Room Context: %v", err)
	}
	if revived != 0 {
		t.Fatalf("work Room Context was recreated")
	}
	// The direct Ensure API must enforce the same Work Room exclusion as topology sync.
	const newWorkRoom = "room_runtime_new_work"
	insertRuntimeRoomMembership(t, pool, newWorkRoom)
	if _, err := pool.Exec(t.Context(), `UPDATE work_item_room_links SET room_id=$1 WHERE work_item_id=$2 AND link_type='work'`, newWorkRoom, taskID); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if _, err := service.EnsureContext(t.Context(), agentruntimestate.EnsureContextInput{
			Ref:             agentruntimestate.ContextRef{Kind: "meta", AgentID: testRuntimeAgentID, RoomID: newWorkRoom},
			TargetResidency: "active",
		}); !errors.Is(err, agentruntimestate.ErrNotFound) {
			t.Fatalf("Work Room Meta ensure: %v, want not found", err)
		}
	}
	var unwanted int
	if err := pool.QueryRow(t.Context(), `SELECT count(*) FROM agent_execution_contexts WHERE room_id=$1 AND context_kind='meta'`, newWorkRoom).Scan(&unwanted); err != nil || unwanted != 0 {
		t.Fatalf("unexpected Work Room Meta count=%d err=%v", unwanted, err)
	}
	for _, ref := range []agentruntimestate.ContextRef{
		{Kind: "meta", AgentID: testRuntimeAgentID, RoomID: collaborationRoom},
		{Kind: "alter_ego", AgentID: testRuntimeAgentID, TaskID: taskID},
	} {
		if _, err := service.EnsureContext(t.Context(), agentruntimestate.EnsureContextInput{Ref: ref, TargetResidency: "active"}); err != nil {
			t.Fatalf("valid %s Context: %v", ref.Kind, err)
		}
	}

}

func TestAgentRuntimeSessionRevisionAndTerminalTransaction(t *testing.T) {
	allowParallelIntegrationTest(t)
	env := newRuntimeStateTestEnv(t)
	configurationRevision := activeRuntimeConfigurationRevision(t, env.pool)

	first, err := env.service.CheckpointRuntimeSession(t.Context(), agentruntimestate.CheckpointSessionInput{ContextKey: env.contextKey, Epoch: env.epoch,
		Checkpoint: runtimeSessionCheckpoint(0, configurationRevision, "thread-one"),
	})
	if err != nil || first.Revision != 1 {
		t.Fatalf("create RuntimeSession: session=%+v err=%v", first, err)
	}
	if _, err := env.service.CheckpointRuntimeSession(t.Context(), agentruntimestate.CheckpointSessionInput{ContextKey: env.contextKey, Epoch: env.epoch,
		Checkpoint: runtimeSessionCheckpoint(0, configurationRevision, "thread-stale"),
	}); !errors.Is(err, agentruntimestate.ErrConflict) {
		t.Fatalf("stale RuntimeSession checkpoint error=%v, want conflict", err)
	}
	second, err := env.service.CheckpointRuntimeSession(t.Context(), agentruntimestate.CheckpointSessionInput{ContextKey: env.contextKey, Epoch: env.epoch,
		Checkpoint: runtimeSessionCheckpoint(1, configurationRevision, "thread-two"),
	})
	if err != nil || second.Revision != 2 {
		t.Fatalf("advance RuntimeSession: session=%+v err=%v", second, err)
	}

	submitted, err := env.service.SubmitTrustedTurn(t.Context(), agentruntimestate.SubmitTrustedTurnInput{ContextKey: env.contextKey, Epoch: env.epoch,
		Inputs: []agentruntimestate.RuntimeInput{runtimeInput("terminal-input", "trusted_turn", "", "terminal")},
	})
	if err != nil {
		t.Fatalf("submit terminal transaction turn: %v", err)
	}
	claimed, err := env.service.ClaimLocalRun(t.Context(), agentruntimestate.ClaimLocalRunInput{
		ClaimID: "claim-terminal-transaction-run", ContextKey: env.contextKey, Epoch: env.epoch,
	})
	if err != nil || claimed.Run == nil || claimed.Run.RunID != submitted.RunID {
		t.Fatalf("claim terminal transaction Run: claim=%+v err=%v", claimed, err)
	}
	insertRuntimeStatusFixture(t, env, submitted.RunID)

	terminal := json.RawMessage(`{"type":"succeeded"}`)
	badCheckpoint := runtimeSessionCheckpoint(99, configurationRevision, "thread-bad")
	if _, err := env.service.FinishLocalRun(t.Context(), agentruntimestate.FinishLocalRunInput{ContextKey: env.contextKey, Epoch: env.epoch,
		RunID: submitted.RunID, Terminal: terminal, Session: &badCheckpoint,
	}); !errors.Is(err, agentruntimestate.ErrConflict) {
		t.Fatalf("finish with stale Session error=%v, want conflict", err)
	}
	assertRuntimeTerminalState(t, env.pool, submitted.RunID, "running", "", 2)

	goodCheckpoint := runtimeSessionCheckpoint(2, configurationRevision, "thread-final")
	finished, err := env.service.FinishLocalRun(t.Context(), agentruntimestate.FinishLocalRunInput{ContextKey: env.contextKey, Epoch: env.epoch,
		RunID: submitted.RunID, Terminal: terminal, Session: &goodCheckpoint,
	})
	if err != nil || finished.Run.Status != "succeeded" || finished.Session == nil || finished.Session.Revision != 3 {
		t.Fatalf("finish atomic terminal transaction: result=%+v err=%v", finished, err)
	}
	assertRuntimeTerminalState(t, env.pool, submitted.RunID, "succeeded", "completed", 3)
	submitted, err = env.service.SubmitTrustedTurn(t.Context(), agentruntimestate.SubmitTrustedTurnInput{ContextKey: env.contextKey, Epoch: env.epoch,
		Inputs: []agentruntimestate.RuntimeInput{runtimeInput("long-failure-input", "trusted_turn", "", "failure")},
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = env.service.ClaimLocalRun(t.Context(), agentruntimestate.ClaimLocalRunInput{ClaimID: "claim-long-failure", ContextKey: env.contextKey, Epoch: env.epoch})
	if err != nil {
		t.Fatal(err)
	}
	insertRuntimeStatusFixture(t, env, submitted.RunID)
	reason := strings.Repeat("provider unavailable ", 150)
	terminal, _ = json.Marshal(map[string]string{"type": "failed", "error": reason})
	finish := agentruntimestate.FinishLocalRunInput{ContextKey: env.contextKey, Epoch: env.epoch, RunID: submitted.RunID, Terminal: terminal}
	for range 2 {
		result, err := env.service.FinishLocalRun(t.Context(), finish)
		if err != nil || result.Run.Status != "failed" {
			t.Fatalf("long provider failure: status=%s err=%v", result.Run.Status, err)
		}
	}
	if eventType, event := lastRunStatusEvent(t, env.pool, submitted.RunID); eventType != "status.changed" || event["outcome"] != "failed" || strings.Contains(fmt.Sprint(event), "provider unavailable") {
		t.Fatalf("failure status=%s %v", eventType, event)
	}

}

func testAgentRuntimeThreadReplyPublishesIntoParentStatus(t *testing.T) {
	env := newRuntimeStateTestEnv(t)
	const roomID = "room_runtime_status"
	const messageID = "message_runtime_status"
	const boundMessageIDOne = "message_runtime_bound_one"
	const boundInvocationOne = "agent-invocation-sha256:1111111111111111111111111111111111111111111111111111111111111111"
	insertRuntimeStatusAuthorityFixture(t, env.pool, roomID, messageID)
	env = useRuntimeRoomContext(t, env, roomID)

	input := runtimeInput("runtime-status-input", "trusted_turn", "room:"+roomID, "status")
	input.SourceMessageID = messageID
	submitted, err := env.service.SubmitTrustedTurn(t.Context(), agentruntimestate.SubmitTrustedTurnInput{ContextKey: env.contextKey, Epoch: env.epoch,
		Inputs: []agentruntimestate.RuntimeInput{input},
	})
	if err != nil {
		t.Fatalf("submit Runtime status turn: %v", err)
	}
	claimed, err := env.service.ClaimLocalRun(t.Context(), agentruntimestate.ClaimLocalRunInput{
		ClaimID: "claim-runtime-status-run", ContextKey: env.contextKey, Epoch: env.epoch,
	})
	if err != nil || claimed.Run == nil {
		t.Fatalf("claim Runtime status Run: result=%+v err=%v", claimed, err)
	}
	opened, err := env.service.OpenRuntimeStatus(t.Context(), agentruntimestate.OpenStatusInput{ContextKey: env.contextKey, Epoch: env.epoch,
		LocalRunID: submitted.RunID, InitialSourceIDs: []string{"room:" + roomID},
	})
	if err != nil || !opened.Opened || opened.RoomID != roomID {
		t.Fatalf("open Runtime status stream: result=%+v err=%v", opened, err)
	}
	const threadID = "room_runtime_thread"
	if _, err := env.pool.Exec(t.Context(), `
		INSERT INTO rooms(id,tenant_id,name,created_by_actor_id)
		VALUES($1,'tenant_acme','Thread reply','actor_acme_alice')`, threadID); err != nil {
		t.Fatal(err)
	}
	if _, err := env.pool.Exec(t.Context(), `
		UPDATE rooms SET parent_room_id=$2,root_message_id=$3
		WHERE id=$1 AND tenant_id='tenant_acme'`, threadID, roomID, messageID); err != nil {
		t.Fatal(err)
	}
	insertRuntimeRunMessageFixture(t, env.pool, threadID, boundMessageIDOne, submitted.RunID, "Thread reply")
	output := agentruntimestate.PresentationOutput{
		LocalRunID: submitted.RunID, TenantID: "tenant_acme", RoomID: threadID,
		AgentActorID: "actor_acme_official", InvocationID: boundInvocationOne,
		OutputID: boundMessageIDOne, OutputKind: "message", Surface: "room_timeline", MessageID: boundMessageIDOne,
	}
	wrongAgent := output
	wrongAgent.AgentActorID = "actor_unrelated_agent"
	if got := recordRuntimePresentationOutput(t, env.pool, wrongAgent); got.Recorded {
		t.Fatal("recorded another Agent's output")
	}
	unrelated := output
	unrelated.RoomID = "room_acme_general"
	if got := recordRuntimePresentationOutput(t, env.pool, unrelated); got.Recorded {
		t.Fatal("recorded an unrelated Room's output")
	}
	got := recordRuntimePresentationOutput(t, env.pool, output)
	if !got.Recorded || got.EventOrdinal != 2 {
		t.Fatalf("Thread output was not linked to parent status: %+v", got)
	}
	replay := recordRuntimePresentationOutput(t, env.pool, output)
	if replay.Recorded || replay.EventOrdinal != got.EventOrdinal {
		t.Fatalf("Thread output replay: %+v", replay)
	}
	var linkedMessageID string
	if err := env.pool.QueryRow(t.Context(), `SELECT message_id FROM agent_runtime_status_events WHERE local_run_id=$1 AND event_ordinal=$2`, submitted.RunID, got.EventOrdinal).Scan(&linkedMessageID); err != nil {
		t.Fatal(err)
	}
	if linkedMessageID != boundMessageIDOne {
		t.Fatalf("linked Message %s, want %s", linkedMessageID, boundMessageIDOne)
	}
}

func TestAgentRuntimePreservedSessionFinishesAfterConfigurationAdvance(t *testing.T) {
	allowParallelIntegrationTest(t)
	env := newRuntimeStateTestEnv(t)
	configurationRevision := activeRuntimeConfigurationRevision(t, env.pool)

	session, err := env.service.CheckpointRuntimeSession(t.Context(), agentruntimestate.CheckpointSessionInput{ContextKey: env.contextKey, Epoch: env.epoch,
		Checkpoint: runtimeSessionCheckpoint(0, configurationRevision, "thread-preserved"),
	})
	if err != nil || session.Revision != 1 {
		t.Fatalf("checkpoint preserved RuntimeSession: session=%+v err=%v", session, err)
	}
	submitted, err := env.service.SubmitTrustedTurn(t.Context(), agentruntimestate.SubmitTrustedTurnInput{ContextKey: env.contextKey, Epoch: env.epoch,
		Inputs: []agentruntimestate.RuntimeInput{runtimeInput("preserved-session-input", "trusted_turn", "", "initialize profile")},
	})
	if err != nil {
		t.Fatal(err)
	}
	claimed, err := env.service.ClaimLocalRun(t.Context(), agentruntimestate.ClaimLocalRunInput{
		ClaimID: "claim-preserved-session-run", ContextKey: env.contextKey, Epoch: env.epoch,
	})
	if err != nil || claimed.Run == nil || claimed.Run.RunID != submitted.RunID {
		t.Fatalf("claim preserved-session Run=%+v err=%v", claimed, err)
	}
	if _, err := env.pool.Exec(t.Context(), `
		UPDATE agent_registrations
		SET configuration_revision=configuration_revision+1,updated_at=clock_timestamp()
		WHERE agent_management_id=$1 AND status='active'`, testRuntimeAgentID); err != nil {
		t.Fatalf("advance Agent configuration revision: %v", err)
	}
	if _, err := env.service.ClearRuntimeSession(t.Context(), agentruntimestate.ClearRuntimeSessionInput{ContextKey: env.contextKey, Epoch: env.epoch,
		ConfigurationRevision: configurationRevision,
	}); !errors.Is(err, agentruntimestate.ErrConflict) {
		t.Fatalf("clear running stale RuntimeSession error=%v want conflict", err)
	}

	checkpoint := runtimeSessionCheckpoint(1, configurationRevision, "thread-preserved")
	finished, err := env.service.FinishLocalRun(t.Context(), agentruntimestate.FinishLocalRunInput{ContextKey: env.contextKey, Epoch: env.epoch,
		RunID: submitted.RunID, Terminal: json.RawMessage(`{"type":"succeeded"}`),
		Session: &checkpoint,
	})
	if err != nil || finished.Run.Status != "succeeded" || finished.Session == nil || finished.Session.Revision != 2 ||
		finished.Session.ConfigurationRevision != configurationRevision {
		t.Fatalf("finish preserved-session Run=%+v err=%v", finished, err)
	}

	cleared, err := env.service.ClearRuntimeSession(t.Context(), agentruntimestate.ClearRuntimeSessionInput{ContextKey: env.contextKey, Epoch: env.epoch,
		ConfigurationRevision: configurationRevision,
	})
	if err != nil || !cleared.Cleared {
		t.Fatalf("clear active stale RuntimeSession=%+v err=%v", cleared, err)
	}
	if _, err := env.service.CheckpointRuntimeSession(t.Context(), agentruntimestate.CheckpointSessionInput{ContextKey: env.contextKey, Epoch: env.epoch,
		Checkpoint: runtimeSessionCheckpoint(0, configurationRevision, "thread-forged-stale"),
	}); !errors.Is(err, agentruntimestate.ErrConflict) {
		t.Fatalf("forge cleared stale RuntimeSession error=%v want conflict", err)
	}
}

func TestAgentRuntimeStatusResolvesPersistedProvenance(t *testing.T) {
	allowParallelIntegrationTest(t)
	t.Run("Thread reply publishes into parent status", testAgentRuntimeThreadReplyPublishesIntoParentStatus)
	env := newRuntimeStateTestEnv(t)
	const roomID = "room_runtime_status"
	const messageID = "message_runtime_status"
	const boundMessageIDOne = "message_runtime_bound_one"
	const boundMessageIDTwo = "message_runtime_bound_two"
	const outputInvocationOne = "agent-invocation-sha256:1111111111111111111111111111111111111111111111111111111111111111"
	const outputInvocationTwo = "agent-invocation-sha256:2222222222222222222222222222222222222222222222222222222222222222"
	insertRuntimeStatusAuthorityFixture(t, env.pool, roomID, messageID)
	env = useRuntimeRoomContext(t, env, roomID)

	input := runtimeInput("runtime-status-input", "trusted_turn", "room:"+roomID, "status")
	input.SourceMessageID = messageID
	submitted, err := env.service.SubmitTrustedTurn(t.Context(), agentruntimestate.SubmitTrustedTurnInput{ContextKey: env.contextKey, Epoch: env.epoch,
		Inputs: []agentruntimestate.RuntimeInput{input},
	})
	if err != nil {
		t.Fatalf("submit Runtime status turn: %v", err)
	}
	claimed, err := env.service.ClaimLocalRun(t.Context(), agentruntimestate.ClaimLocalRunInput{
		ClaimID: "claim-runtime-status-run", ContextKey: env.contextKey, Epoch: env.epoch,
	})
	if err != nil || claimed.Run == nil {
		t.Fatalf("claim Runtime status Run: result=%+v err=%v", claimed, err)
	}
	opened, err := env.service.OpenRuntimeStatus(t.Context(), agentruntimestate.OpenStatusInput{ContextKey: env.contextKey, Epoch: env.epoch,
		LocalRunID: submitted.RunID, InitialSourceIDs: []string{"room:" + roomID},
	})
	if err != nil || !opened.Opened || opened.RoomID != roomID {
		t.Fatalf("open Runtime status stream: result=%+v err=%v", opened, err)
	}
	offer := func(commandID string, event any) (agentruntimestate.OfferPresentationEventResult, error) {
		t.Helper()
		payload, marshalErr := json.Marshal(event)
		if marshalErr != nil {
			t.Fatalf("encode Runtime presentation event: %v", marshalErr)
		}
		return env.service.OfferRuntimePresentationEvents(t.Context(), agentruntimestate.OfferPresentationEventsInput{
			LocalRunID: submitted.RunID, Events: []agentruntimestate.OfferedPresentationEvent{{CommandID: commandID, Event: payload}},
		})
	}
	workingEvent := map[string]any{"type": "status.changed", "status": "working"}
	offered, err := offer("offer-runtime-status-working", workingEvent)
	if err != nil || !offered.Accepted || offered.EventOrdinal != 2 {
		t.Fatalf("offer working Runtime status: result=%+v err=%v", offered, err)
	}
	replayed, err := offer("offer-runtime-status-working", workingEvent)
	if err != nil || replayed.EventOrdinal != 2 {
		t.Fatalf("replay working Runtime status: result=%+v err=%v", replayed, err)
	}
	if _, err := offer("offer-runtime-status-working", map[string]any{"type": "status.changed", "status": "thinking"}); !errors.Is(err, agentruntimestate.ErrIdempotencyConflict) {
		t.Fatalf("reuse Runtime event command with another payload error=%v, want idempotency conflict", err)
	}
	if _, err := offer("offer-runtime-working-title", map[string]any{
		"type": "status.changed", "status": "working", "title": "Not allowed",
	}); !errors.Is(err, agentruntimestate.ErrInvalid) {
		t.Fatalf("offer working Runtime title error=%v, want invalid", err)
	}
	if offered, err = offer("offer-runtime-long-thinking-title", map[string]any{
		"type": "status.changed", "status": "thinking", "title": strings.Repeat("x", 201),
	}); err != nil || !offered.Accepted || offered.EventOrdinal != 3 {
		t.Fatalf("offer long Runtime thinking title: result=%+v err=%v", offered, err)
	}
	if _, err := offer("offer-runtime-long-activity-content", map[string]any{
		"type": "activity.started", "activity_id": "activity-invalid", "kind": "command", "title": "Running a command",
		"content": []map[string]any{{"format": "code", "content": strings.Repeat("x", 4001)}},
	}); !errors.Is(err, agentruntimestate.ErrInvalid) {
		t.Fatalf("offer long Runtime activity content error=%v, want invalid", err)
	}
	if _, err := offer("offer-runtime-activity-update-before-start", map[string]any{
		"type": "activity.updated", "activity_id": "activity-1", "detail": "Too early",
	}); !errors.Is(err, agentruntimestate.ErrConflict) {
		t.Fatalf("offer Runtime activity update before start error=%v, want conflict", err)
	}
	if offered, err = offer("offer-runtime-activity-start", map[string]any{
		"type": "activity.started", "activity_id": "activity-1", "kind": "tool", "title": "Using Send Message",
		"content": []map[string]any{{"format": "json", "label": "Input", "content": `{"message":"Hello"}`}},
	}); err != nil || offered.EventOrdinal != 4 {
		t.Fatalf("offer Runtime activity start: result=%+v err=%v", offered, err)
	}
	if _, err := offer("offer-runtime-activity-start-duplicate", map[string]any{
		"type": "activity.started", "activity_id": "activity-1", "kind": "tool", "title": "Using Send Message",
	}); !errors.Is(err, agentruntimestate.ErrConflict) {
		t.Fatalf("offer duplicate Runtime activity start error=%v, want conflict", err)
	}
	if offered, err = offer("offer-runtime-activity-update", map[string]any{
		"type": "activity.updated", "activity_id": "activity-1", "detail": "Publishing the answer",
	}); err != nil || offered.EventOrdinal != 5 {
		t.Fatalf("offer Runtime activity update: result=%+v err=%v", offered, err)
	}

	if offered, err = offer("offer-runtime-activity-update-sending", map[string]any{
		"type": "activity.updated", "activity_id": "activity-1", "detail": "Sending the answer",
	}); err != nil || offered.EventOrdinal != 6 {
		t.Fatalf("offer second Runtime activity update: result=%+v err=%v", offered, err)
	}
	insertRuntimeRunMessageFixture(t, env.pool, roomID, boundMessageIDOne, submitted.RunID, "first bound answer")
	firstOutput := recordRuntimePresentationOutput(t, env.pool, agentruntimestate.PresentationOutput{
		LocalRunID: submitted.RunID, TenantID: "tenant_acme", RoomID: roomID,
		AgentActorID: "actor_acme_official", InvocationID: outputInvocationOne,
		OutputID: boundMessageIDOne, OutputKind: "message", Surface: "room_timeline",
		MessageID: boundMessageIDOne,
	})
	if !firstOutput.Recorded || firstOutput.EventOrdinal != 7 || firstOutput.SegmentID == "" {
		t.Fatalf("record first Runtime output: %+v", firstOutput)
	}
	firstOutputReplay := recordRuntimePresentationOutput(t, env.pool, agentruntimestate.PresentationOutput{
		LocalRunID: submitted.RunID, TenantID: "tenant_acme", RoomID: roomID,
		AgentActorID: "actor_acme_official", InvocationID: outputInvocationOne,
		OutputID: boundMessageIDOne, OutputKind: "message", Surface: "room_timeline",
		MessageID: boundMessageIDOne,
	})
	if firstOutputReplay.Recorded || firstOutputReplay.EventOrdinal != firstOutput.EventOrdinal ||
		firstOutputReplay.SegmentID != firstOutput.SegmentID {
		t.Fatalf("replay first Runtime output: %+v, want existing %+v", firstOutputReplay, firstOutput)
	}
	if offered, err = offer("offer-runtime-activity-finish", map[string]any{
		"type": "activity.finished", "activity_id": "activity-1", "outcome": "succeeded",
		"content": []map[string]any{{"format": "text", "label": "Result", "content": "Message published"}},
	}); err != nil || offered.EventOrdinal != 8 {
		t.Fatalf("offer Runtime activity finish: result=%+v err=%v", offered, err)
	}
	if _, err := offer("offer-runtime-activity-update-after-finish", map[string]any{
		"type": "activity.updated", "activity_id": "activity-1", "detail": "Too late",
	}); !errors.Is(err, agentruntimestate.ErrConflict) {
		t.Fatalf("offer Runtime activity update after finish error=%v, want conflict", err)
	}
	if offered, err = offer("offer-runtime-status-thinking", map[string]any{
		"type": "status.changed", "status": "thinking", "title": "Inspecting runtime status",
	}); err != nil || offered.EventOrdinal != 9 {
		t.Fatalf("offer thinking Runtime status: result=%+v err=%v", offered, err)
	}

	if offered, err = offer("offer-runtime-status-working-again", map[string]any{
		"type": "status.changed", "status": "working",
	}); err != nil || offered.EventOrdinal != 10 {
		t.Fatalf("offer working Runtime status: result=%+v err=%v", offered, err)
	}
	insertRuntimeRunMessageFixture(t, env.pool, roomID, boundMessageIDTwo, submitted.RunID, "second bound answer")
	secondOutput := recordRuntimePresentationOutput(t, env.pool, agentruntimestate.PresentationOutput{
		LocalRunID: submitted.RunID, TenantID: "tenant_acme", RoomID: roomID,
		AgentActorID: "actor_acme_official", InvocationID: outputInvocationTwo,
		OutputID: boundMessageIDTwo, OutputKind: "message", Surface: "room_timeline",
		MessageID: boundMessageIDTwo,
	})
	if !secondOutput.Recorded || secondOutput.EventOrdinal != 11 || secondOutput.SegmentID == firstOutput.SegmentID {
		t.Fatalf("record second Runtime output: %+v; first=%+v", secondOutput, firstOutput)
	}
	if offered, err = offer("offer-runtime-plan", map[string]any{
		"type":  "plan.updated",
		"steps": []map[string]any{{"content": "Publish exact order", "status": "in_progress"}},
	}); err != nil || offered.EventOrdinal != 12 {
		t.Fatalf("offer Runtime plan: result=%+v err=%v", offered, err)
	}

	type concurrentOfferResult struct {
		result agentruntimestate.OfferPresentationEventResult
		err    error
	}
	concurrent := make(chan concurrentOfferResult, 2)
	for index, step := range []string{"Check the reply", "Close the Run"} {
		go func() {
			result, offerErr := offer(fmt.Sprintf("offer-runtime-concurrent-plan-%d", index), map[string]any{
				"type":  "plan.updated",
				"steps": []map[string]any{{"content": step, "status": "pending"}},
			})
			concurrent <- concurrentOfferResult{result: result, err: offerErr}
		}()
	}
	concurrentOrdinals := map[int64]bool{}
	for range 2 {
		current := <-concurrent
		if current.err != nil {
			t.Fatalf("offer concurrent Runtime event: %v", current.err)
		}
		concurrentOrdinals[current.result.EventOrdinal] = true
	}
	if !concurrentOrdinals[13] || !concurrentOrdinals[14] || len(concurrentOrdinals) != 2 {
		t.Fatalf("concurrent Runtime event ordinals=%v, want 13 and 14", concurrentOrdinals)
	}
	group := acceptTrustedSteerGroup(t, env, submitted.RunID, "unconfirmed-follow-up", "accept-unconfirmed-follow-up")
	if err := env.service.AssignSteerRun(t.Context(), agentruntimestate.AssignSteerRunInput{ContextKey: env.contextKey, Epoch: env.epoch, GroupID: group, RunID: submitted.RunID}); err != nil {
		t.Fatal(err)
	}
	if err := env.service.CompleteSteer(t.Context(), agentruntimestate.CompleteSteerInput{ContextKey: env.contextKey, Epoch: env.epoch, GroupID: group, RunID: submitted.RunID, Outcome: "uncertain"}); err != nil {
		t.Fatal(err)
	}
	if _, err := env.service.FinishLocalRun(t.Context(), agentruntimestate.FinishLocalRunInput{ContextKey: env.contextKey, Epoch: env.epoch,
		RunID:    submitted.RunID,
		Terminal: json.RawMessage(`{"type":"succeeded","finalResponse":"global meta result stays internal"}`),
	}); err != nil {
		t.Fatalf("finish Runtime status Run: %v", err)
	}
	var terminalPayload []byte
	if err := env.pool.QueryRow(t.Context(), `SELECT payload FROM agent_runtime_status_events WHERE local_run_id=$1 AND event_type='status.changed' ORDER BY event_ordinal DESC LIMIT 1`, submitted.RunID).Scan(&terminalPayload); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(terminalPayload), `"unconfirmed_input_ids": ["unconfirmed-follow-up"]`) {
		t.Fatalf("successful Run lost unconfirmed follow-up: %s", terminalPayload)
	}
	finishedRun, err := env.service.GetLocalRun(t.Context(), env.contextKey, submitted.RunID)
	if err != nil || finishedRun.Status != "succeeded" {
		t.Fatalf("follow-up warning changed prior Run outcome: %+v %v", finishedRun, err)
	}
	var conversationCount int
	if err := env.pool.QueryRow(t.Context(), `
		SELECT count(*) FROM messages
		WHERE room_id=$1 AND author_actor_id='actor_acme_official'
		  AND message_kind='conversation' AND body='global meta result stays internal'`, roomID).Scan(&conversationCount); err != nil {
		t.Fatalf("count global meta conversations: %v", err)
	}
	if conversationCount != 0 {
		t.Fatalf("global meta fallback conversation count=%d, want 0", conversationCount)
	}
	if status, ordinal := lastRunStatusAnnouncement(t, env.pool, roomID, submitted.RunID); status != "completed" || ordinal != 15 {
		t.Fatalf("terminal Runtime status announcement: status=%s ordinal=%d", status, ordinal)
	}
	if _, err := offer("offer-runtime-event-after-terminal", map[string]any{"type": "status.changed", "status": "working"}); !errors.Is(err, agentruntimestate.ErrConflict) {
		t.Fatalf("offer Runtime event after terminal error=%v, want conflict", err)
	}
	rows, err := env.pool.Query(t.Context(), `
		SELECT event_ordinal,event_type,segment_id,COALESCE(message_id,''),COALESCE(activity_id,'')
		FROM agent_runtime_status_events
		WHERE local_run_id=$1
		ORDER BY event_ordinal`, submitted.RunID)
	if err != nil {
		t.Fatalf("list persisted Runtime presentation events: %v", err)
	}
	defer rows.Close()
	type persistedEvent struct {
		ordinal    int64
		eventType  string
		segmentID  string
		messageID  string
		activityID string
	}
	var events []persistedEvent
	for rows.Next() {
		var event persistedEvent
		if err := rows.Scan(&event.ordinal, &event.eventType, &event.segmentID, &event.messageID, &event.activityID); err != nil {
			t.Fatalf("scan persisted Runtime presentation event: %v", err)
		}
		events = append(events, event)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("iterate persisted Runtime presentation events: %v", err)
	}
	wantTypes := []string{
		"status.changed", // durable queued event
		"status.changed", "status.changed", "activity.started", "activity.updated", "activity.updated",
		"presentation.output_created", "activity.finished", "status.changed", "status.changed",
		"presentation.output_created", "plan.updated", "plan.updated", "plan.updated",
		"status.changed",
	}
	if len(events) != len(wantTypes) {
		t.Fatalf("persisted Runtime event count=%d, want %d: %+v", len(events), len(wantTypes), events)
	}
	for index, event := range events {
		if event.ordinal != int64(index+1) || event.eventType != wantTypes[index] {
			t.Fatalf("persisted Runtime event %d=%+v, want ordinal/type %d/%q", index, event, index+1, wantTypes[index])
		}
		wantMessageID := ""
		if index == 6 {
			wantMessageID = boundMessageIDOne
		} else if index == 10 {
			wantMessageID = boundMessageIDTwo
		}
		if event.messageID != wantMessageID {
			t.Fatalf("persisted Runtime event %d message=%q, want %q", index+1, event.messageID, wantMessageID)
		}
		wantActivityID := ""
		if index >= 3 && index <= 5 || index == 7 {
			wantActivityID = "activity-1"
		}
		if event.activityID != wantActivityID {
			t.Fatalf("persisted Runtime event %d activity=%q, want %q", index+1, event.activityID, wantActivityID)
		}
	}
	if firstOutput.SegmentID != events[1].segmentID || firstOutput.SegmentID != events[6].segmentID {
		t.Fatalf("first Segment IDs=%q/%q, want %q", events[1].segmentID, events[6].segmentID, firstOutput.SegmentID)
	}
	if secondOutput.SegmentID != events[7].segmentID || secondOutput.SegmentID != events[10].segmentID {
		t.Fatalf("second Segment IDs=%q/%q, want %q", events[7].segmentID, events[10].segmentID, secondOutput.SegmentID)
	}
	if events[11].segmentID == firstOutput.SegmentID || events[11].segmentID == secondOutput.SegmentID {
		t.Fatalf("terminal Segment %q reused an output Segment", events[11].segmentID)
	}
	for index, event := range events {
		wantSegmentID := events[11].segmentID
		if index <= 6 {
			wantSegmentID = firstOutput.SegmentID
		} else if index <= 10 {
			wantSegmentID = secondOutput.SegmentID
		}
		if event.segmentID != wantSegmentID {
			t.Fatalf("persisted Runtime event %d Segment=%q, want %q", index+1, event.segmentID, wantSegmentID)
		}
	}
	linkedRun, err := store.New(env.pool).GetAgentRunStatusForMessage(t.Context(), store.GetAgentRunStatusForMessageParams{MessageID: boundMessageIDOne, RoomID: roomID})
	if err != nil || linkedRun.RunID != submitted.RunID {
		t.Fatalf("message history run=%q err=%v", linkedRun.RunID, err)
	}
	if _, err := store.New(env.pool).GetAgentRunStatusForMessage(t.Context(), store.GetAgentRunStatusForMessageParams{MessageID: boundMessageIDOne, RoomID: "wrong-room"}); err == nil {
		t.Fatal("message history accepted another Room")
	}
	if _, err := store.New(env.pool).GetAgentRunStatusForMessage(t.Context(), store.GetAgentRunStatusForMessageParams{MessageID: messageID, RoomID: roomID}); err == nil {
		t.Fatal("unlinked Human message acquired Agent history")
	}

	var aliceAccountID string
	if err := env.pool.QueryRow(t.Context(), `
		SELECT account_id FROM actors WHERE id='actor_acme_alice'`).Scan(&aliceAccountID); err != nil {
		t.Fatalf("read Runtime presentation account: %v", err)
	}
	historicalRuns, err := store.New(env.pool).ListRuntimePresentationRunsForAccountByRoom(
		t.Context(),
		store.ListRuntimePresentationRunsForAccountByRoomParams{
			AccountID: aliceAccountID, RoomID: roomID, MessageIds: []string{boundMessageIDOne},
		},
	)
	if err != nil {
		t.Fatalf("list historical Runtime presentation Runs for Room: %v", err)
	}
	if len(historicalRuns) != 1 || historicalRuns[0].Status != "succeeded" || historicalRuns[0].EventOrdinal != 15 {
		t.Fatalf("historical Runtime presentation Runs for Room=%+v", historicalRuns)
	}
	unrelatedRuns, err := store.New(env.pool).ListRuntimePresentationRunsForAccountByRoom(
		t.Context(),
		store.ListRuntimePresentationRunsForAccountByRoomParams{
			AccountID: aliceAccountID, RoomID: roomID, MessageIds: []string{"message_unrelated"},
		},
	)
	if err != nil {
		t.Fatalf("list unrelated Runtime presentation Runs for Room: %v", err)
	}
	if len(unrelatedRuns) != 0 {
		t.Fatalf("unrelated Runtime presentation Runs for Room=%+v, want none", unrelatedRuns)
	}
	visibleMessageIDs := []string{boundMessageIDOne}
	for value := 1; value <= 100; value++ {
		visibleMessageIDs = append(visibleMessageIDs, fmt.Sprintf("message-history-limit-%d", value))
	}
	seeds := []struct {
		args  []any
		label string
		query string
	}{
		{
			label: "terminal Runs",
			query: `
				INSERT INTO agent_local_runs(run_id,context_key,status,terminal,finished_at,created_at,status_room_id)
				SELECT 'run-history-limit-' || value,$1,'failed','{"type":"failed","error":"test terminal history"}'::jsonb,
				       clock_timestamp(),clock_timestamp() + value * interval '1 second',$2
				FROM generate_series(1,100) value`,
			args: []any{env.contextKey, roomID},
		},
		{
			// Every Message has exactly one writing Run; an output event cannot
			// attach one Message to all of the historical Runs.
			label: "terminal outputs",
			query: `
				INSERT INTO messages(
					id,tenant_id,room_id,author_actor_id,body,segments,local_run_id
				)
				SELECT 'message-history-limit-' || value,'tenant_acme',$1,'actor_acme_official',
				       'history reply','[{"type":"text","content":"history reply"}]'::jsonb,
				       'run-history-limit-' || value
				FROM generate_series(1,100) value`,
			args: []any{roomID},
		},
		{
			label: "active Run",
			query: `
				INSERT INTO agent_local_runs(run_id,context_key,status,created_at,status_room_id)
				VALUES('run-active-priority',$1,'queued',clock_timestamp() - interval '1 day',$2)`,
			args: []any{env.contextKey, roomID},
		},
	}
	for _, seed := range seeds {
		if _, err := env.pool.Exec(t.Context(), seed.query, seed.args...); err != nil {
			t.Fatalf("seed bounded Runtime presentation %s: %v", seed.label, err)
		}
	}
	prioritizedRuns, err := store.New(env.pool).ListRuntimePresentationRunsForAccountByRoom(
		t.Context(),
		store.ListRuntimePresentationRunsForAccountByRoomParams{
			AccountID: aliceAccountID, RoomID: roomID, MessageIds: visibleMessageIDs,
		},
	)
	if err != nil {
		t.Fatalf("list prioritized Runtime presentation Runs for Room: %v", err)
	}
	if len(prioritizedRuns) != 100 {
		t.Fatalf("prioritized Runtime presentation Run count=%d, want 100", len(prioritizedRuns))
	}
	if !slices.ContainsFunc(prioritizedRuns, func(run store.ListRuntimePresentationRunsForAccountByRoomRow) bool {
		return run.RunID == "run-active-priority" && run.Status == "queued"
	}) {
		t.Fatalf("prioritized Runtime presentation Runs omitted the queued Run")
	}
}

func newRuntimeStateTestEnv(t *testing.T) runtimeStateTestEnv {
	t.Helper()
	databaseURL := newIntegrationDatabase(t)
	pool, err := pgxpool.New(t.Context(), databaseURL)
	if err != nil {
		t.Fatalf("open Runtime state database: %v", err)
	}
	t.Cleanup(pool.Close)
	service := agentruntimestate.New(pool)
	insertRuntimeRoomMembership(t, pool, testRuntimeInboxRoom)
	ensured, err := service.EnsureContext(t.Context(), agentruntimestate.EnsureContextInput{
		Ref: agentruntimestate.ContextRef{
			Kind: "meta", AgentID: testRuntimeAgentID, RoomID: testRuntimeInboxRoom,
		},
		TargetResidency: "active",
	})
	if err != nil {
		t.Fatalf("ensure Runtime Context: %v", err)
	}
	startRuntimeEpoch(t, service, testRuntimeEpoch)
	return runtimeStateTestEnv{
		pool: pool, service: service, contextKey: ensured.Context.ContextKey, epoch: testRuntimeEpoch,
	}
}

// useRuntimeRoomContext moves env to the Agent's per-Room Meta Context in
// roomID. A Meta Context receives only the Inboxes of its own Room, so
// fixtures that deliver another Room's messages need that Room's Context.
func useRuntimeRoomContext(t *testing.T, env runtimeStateTestEnv, roomID string) runtimeStateTestEnv {
	t.Helper()
	ensured, err := env.service.EnsureContext(t.Context(), agentruntimestate.EnsureContextInput{
		Ref: agentruntimestate.ContextRef{
			Kind: "meta", AgentID: testRuntimeAgentID, RoomID: roomID,
		},
		TargetResidency: "active",
	})
	if err != nil {
		t.Fatalf("ensure Runtime Context in %s: %v", roomID, err)
	}
	env.contextKey = ensured.Context.ContextKey
	return env
}

// Ordinary-message delivery fixtures use the Another Me template: its type and
// its receives-every-message option.
// No request turns the option on; only the template sets it.
func useAllActionableRuntimeAgent(t *testing.T, env runtimeStateTestEnv) {
	t.Helper()
	if _, err := env.pool.Exec(t.Context(), `UPDATE agent_registrations SET agent_type='anotherme',receives_all_messages=true,represented_human_actor_id=created_by_actor_id WHERE agent_management_id=$1`, testRuntimeAgentID); err != nil {
		t.Fatal(err)
	}
}

func runtimeInput(inputID, sourceKind, inboxID, body string) agentruntimestate.RuntimeInput {
	payload, err := json.Marshal(map[string]any{
		"messageId": inputID, "body": body,
		"sourceInboxIds": func() []string {
			if inboxID == "" {
				return []string{}
			}
			return []string{inboxID}
		}(),
	})
	if err != nil {
		panic(err)
	}
	return agentruntimestate.RuntimeInput{
		InputID: inputID, Payload: payload, SourceKind: sourceKind, SourceInboxID: inboxID,
	}
}

// queuedRuntimeInboxInput is the Inbox input TeamHub queued for one Message.
type queuedRuntimeInboxInput struct {
	InputID, RunID, SteerGroupID, Status string
}

// queueRuntimeInboxMessage writes a Message in the test Room and queues it for
// env's Context as the Message transaction does at commit. mentioned makes the
// Message target the Agent, so it may steer the Run that reads the Room.
func queueRuntimeInboxMessage(t *testing.T, env runtimeStateTestEnv, messageID, sequence, body string, mentioned bool) queuedRuntimeInboxInput {
	t.Helper()
	segments, err := json.Marshal([]map[string]string{{"type": "text", "content": body}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := env.pool.Exec(t.Context(), `
		INSERT INTO messages(id,tenant_id,room_id,author_actor_id,body,segments)
		VALUES($1,'tenant_acme',$2,'actor_acme_alice',$3,$4::jsonb)`, messageID, testRuntimeInboxRoom, body, segments); err != nil {
		t.Fatal(err)
	}
	if _, err := env.pool.Exec(t.Context(), `SELECT queue_agent_inbox_notification($1,$2,'tenant_acme',$3,$4::bigint,$5)`,
		env.contextKey, "room:"+testRuntimeInboxRoom, messageID, sequence, mentioned); err != nil {
		t.Fatalf("queue Inbox Message %s: %v", messageID, err)
	}
	return queuedRuntimeInbox(t, env.pool, env.contextKey, messageID)
}

// queuedRuntimeInbox reads the Inbox input TeamHub queued for messageID.
func queuedRuntimeInbox(t *testing.T, pool *pgxpool.Pool, contextKey, messageID string) queuedRuntimeInboxInput {
	t.Helper()
	var queued queuedRuntimeInboxInput
	if err := pool.QueryRow(t.Context(), `
		SELECT input_id,coalesce(local_run_id,''),coalesce(steer_group_id,''),status
		FROM agent_runtime_inputs WHERE context_key=$1 AND source_message_id=$2`, contextKey, messageID).Scan(
		&queued.InputID, &queued.RunID, &queued.SteerGroupID, &queued.Status); err != nil {
		t.Fatalf("read the Inbox input queued for %s: %v", messageID, err)
	}
	return queued
}

// acceptTrustedSteerGroup steers an internal notification into the running
// Local Run and returns its steer group.
func acceptTrustedSteerGroup(t *testing.T, env runtimeStateTestEnv, runID, inputID, commandID string) string {
	t.Helper()
	accepted, err := env.service.AcceptTrustedNotification(t.Context(), agentruntimestate.AcceptTrustedNotificationInput{ContextKey: env.contextKey, Epoch: env.epoch, ExecutionRunRef: runID,
		Input: runtimeInput(inputID, "internal", "", inputID),
	})
	if err != nil || accepted.Status != "committed" || accepted.SteerGroupID == "" {
		t.Fatalf("steer %q into Run %s: result=%+v err=%v", inputID, runID, accepted, err)
	}
	return accepted.SteerGroupID
}

func activeRuntimeConfigurationRevision(t *testing.T, pool *pgxpool.Pool) int64 {
	t.Helper()
	var revision int64
	if err := pool.QueryRow(t.Context(), `
		SELECT configuration_revision FROM agent_registrations WHERE agent_management_id=$1`, testRuntimeAgentID).Scan(&revision); err != nil {
		t.Fatalf("read active Agent configuration revision: %v", err)
	}
	return revision
}

func runtimeSessionCheckpoint(expectedRevision, configurationRevision int64, threadID string) agentruntimestate.RuntimeSessionCheckpoint {
	payload, err := json.Marshal(map[string]any{"threadId": threadID})
	if err != nil {
		panic(err)
	}
	return agentruntimestate.RuntimeSessionCheckpoint{
		ExpectedRevision: expectedRevision, ProviderKind: "codex", SchemaVersion: 1,
		Session: payload, ThreadID: threadID, ConfigurationRevision: configurationRevision,
	}
}

func insertRuntimeStatusFixture(t *testing.T, env runtimeStateTestEnv, runID string) {
	t.Helper()
	roomID := "room_runtime_state_test_" + runID
	if _, err := env.pool.Exec(t.Context(), `
		INSERT INTO rooms(id,tenant_id,name,created_by_actor_id)
		VALUES($1,'tenant_acme','Runtime state test','actor_acme_alice')`, roomID); err != nil {
		t.Fatalf("insert Runtime status Room: %v", err)
	}
	if _, err := env.pool.Exec(t.Context(), `
		UPDATE agent_local_runs SET status_room_id=$3 WHERE run_id=$1 AND context_key=$2`, runID, env.contextKey, roomID); err != nil {
		t.Fatalf("show Runtime status in its Room: %v", err)
	}
}

func insertRuntimeStatusAuthorityFixture(t *testing.T, pool *pgxpool.Pool, roomID, messageID string) {
	t.Helper()
	insertRuntimeRoomMembership(t, pool, roomID)
	if _, err := pool.Exec(t.Context(), `
		INSERT INTO messages(id,tenant_id,room_id,author_actor_id,body,segments)
		VALUES($1,'tenant_acme',$2,'actor_acme_alice','status target',
		       '[{"type":"text","content":"status target"}]'::jsonb)`, messageID, roomID); err != nil {
		t.Fatalf("insert Runtime status reply target: %v", err)
	}
	// A per-Room Meta Context accepts a Room message only at its message.created coordinate.
	if _, err := pool.Exec(t.Context(), `
		WITH seq AS (UPDATE rooms SET next_room_seq=next_room_seq+1 WHERE id=$2 RETURNING next_room_seq)
		INSERT INTO room_events(event_id,tenant_id,room_id,room_seq,event_type,actor_id,resource_id,payload)
		SELECT $1||'-event','tenant_acme',$2,seq.next_room_seq,'message.created','actor_acme_alice',$1,'{}' FROM seq`, messageID, roomID); err != nil {
		t.Fatalf("insert Runtime status reply target event: %v", err)
	}
}

func insertRuntimeRoomMembership(t *testing.T, pool *pgxpool.Pool, roomID string) {
	insertRuntimeRoomMembershipForAgent(t, pool, roomID, "actor_acme_official")
}

func insertRuntimeRoomMembershipForAgent(t *testing.T, pool *pgxpool.Pool, roomID, agentActorID string) {
	t.Helper()
	if _, err := pool.Exec(t.Context(), `
		INSERT INTO rooms(id,tenant_id,name,created_by_actor_id)
		VALUES($1,'tenant_acme','Runtime status','actor_acme_alice')`, roomID); err != nil {
		t.Fatalf("insert Runtime status Room: %v", err)
	}
	actorIDs := []string{"actor_acme_alice"}
	if agentActorID != "actor_acme_alice" {
		actorIDs = append(actorIDs, agentActorID)
	}
	for _, actorID := range actorIDs {
		role := "member"
		if actorID == "actor_acme_alice" {
			role = "owner"
		}
		if _, err := pool.Exec(t.Context(), `
			INSERT INTO room_members(room_id,tenant_id,actor_id,role,added_by_actor_id)
				VALUES($1,'tenant_acme',$2,$3,'actor_acme_alice')`, roomID, actorID, role); err != nil {
			t.Fatalf("insert Runtime status Room member %s: %v", actorID, err)
		}
	}
}

func insertRuntimeStatusMessageFixture(t *testing.T, pool *pgxpool.Pool, roomID, messageID, body string) {
	t.Helper()
	insertRuntimeRunMessageFixture(t, pool, roomID, messageID, "", body)
}

func insertRuntimeRunMessageFixture(
	t *testing.T,
	pool *pgxpool.Pool,
	roomID, messageID, runID, body string,
) {
	t.Helper()
	segments, err := json.Marshal([]map[string]string{{"type": "text", "content": body}})
	if err != nil {
		t.Fatalf("encode bound Runtime Message segments: %v", err)
	}
	if _, err := pool.Exec(t.Context(), `
		INSERT INTO messages(id,tenant_id,room_id,author_actor_id,body,segments,local_run_id)
		VALUES($1,'tenant_acme',$2,'actor_acme_official',$3,$4::jsonb,NULLIF($5,''))`, messageID, roomID, body, segments, runID); err != nil {
		t.Fatalf("insert bound Runtime Message: %v", err)
	}
}

func recordRuntimePresentationOutput(
	t *testing.T,
	pool *pgxpool.Pool,
	input agentruntimestate.PresentationOutput,
) agentruntimestate.PresentationRecordResult {
	t.Helper()
	tx, err := pool.Begin(t.Context())
	if err != nil {
		t.Fatalf("begin Runtime output transaction: %v", err)
	}
	result, err := agentruntimestate.RecordPresentationOutput(t.Context(), store.New(tx), input)
	if err != nil {
		_ = tx.Rollback(t.Context())
		t.Fatalf("record Runtime output: %v", err)
	}
	if err := tx.Commit(t.Context()); err != nil {
		t.Fatalf("commit Runtime output: %v", err)
	}
	return result
}

// assertRuntimeTerminalState checks the Run status, the outcome of its
// stopped event ("" for none) and its Context's Session revision.
func assertRuntimeTerminalState(t *testing.T, pool *pgxpool.Pool, runID, wantRunStatus, wantOutcome string, wantSessionRevision int64) {
	t.Helper()
	var runStatus, outcome string
	var sessionRevision int64
	if err := pool.QueryRow(t.Context(), `
		SELECT run.status,context.session_revision,COALESCE((
			SELECT event.payload->>'outcome' FROM agent_runtime_status_events event
			WHERE event.local_run_id=run.run_id AND event.event_type='status.changed' AND event.payload->>'status'='stopped'),'')
		FROM agent_local_runs run
		JOIN agent_execution_contexts context ON context.context_key=run.context_key
		WHERE run.run_id=$1`, runID).Scan(&runStatus, &sessionRevision, &outcome); err != nil {
		t.Fatalf("read Runtime terminal transaction state: %v", err)
	}
	if runStatus != wantRunStatus || outcome != wantOutcome || sessionRevision != wantSessionRevision {
		t.Fatalf("terminal state run=%q outcome=%q sessionRevision=%d, want %q/%q/%d",
			runStatus, outcome, sessionRevision, wantRunStatus, wantOutcome, wantSessionRevision)
	}
}

func TestAgentLocalRunClaimRejectsConcurrentRevocation(t *testing.T) {
	allowParallelIntegrationTest(t)
	env := newRuntimeStateTestEnv(t)
	submitted, err := env.service.SubmitTrustedTurn(t.Context(), agentruntimestate.SubmitTrustedTurnInput{ContextKey: env.contextKey, Epoch: env.epoch,
		Inputs: []agentruntimestate.RuntimeInput{runtimeInput("revocation-input", "trusted_turn", "", "work after revocation")},
	})
	if err != nil {
		t.Fatal(err)
	}
	tx, err := env.pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(t.Context())
	if _, err = tx.Exec(t.Context(), `UPDATE agent_registrations SET status='revoked' WHERE agent_management_id=$1`, testRuntimeAgentID); err != nil {
		t.Fatal(err)
	}
	result := make(chan error, 1)
	go func() {
		_, err := env.service.ClaimLocalRun(t.Context(), agentruntimestate.ClaimLocalRunInput{ClaimID: "claim-during-revocation", ContextKey: env.contextKey, Epoch: env.epoch})
		result <- err
	}()
	select {
	case err := <-result:
		t.Fatalf("claim crossed uncommitted revocation: %v", err)
	case <-time.After(100 * time.Millisecond):
	}
	if err = tx.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-result:
		if !errors.Is(err, agentruntimestate.ErrConflict) {
			t.Fatalf("claim during revocation: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("claim blocked after revocation committed")
	}
	var state string
	if err = env.pool.QueryRow(t.Context(), `SELECT status FROM agent_local_runs WHERE run_id=$1`, submitted.RunID).Scan(&state); err != nil {
		t.Fatal(err)
	}
	if state != "queued" {
		t.Fatalf("rejected claim changed Run: %s", state)
	}
	if _, err = env.pool.Exec(t.Context(), `UPDATE agent_registrations SET status='active' WHERE agent_management_id=$1`, testRuntimeAgentID); err != nil {
		t.Fatal(err)
	}
	claimed, err := env.service.ClaimLocalRun(t.Context(), agentruntimestate.ClaimLocalRunInput{ClaimID: "claim-during-revocation", ContextKey: env.contextKey, Epoch: env.epoch})
	if err != nil || claimed.Run == nil {
		t.Fatalf("claim after configuration update: %+v %v", claimed, err)
	}
}

func TestAgentRuntimeListRecentlyUsedContextsReadsRecentRunsWithoutClaiming(t *testing.T) {
	allowParallelIntegrationTest(t)
	env := newRuntimeStateTestEnv(t)
	list := func() []string {
		t.Helper()
		rows, err := env.service.ListRecentlyUsedContexts(t.Context())
		if err != nil {
			t.Fatalf("list recently used Contexts: %v", err)
		}
		return rows
	}
	if rows := list(); len(rows) != 0 {
		t.Fatalf("Context without Runs listed: %+v", rows)
	}
	submitted, err := env.service.SubmitTrustedTurn(t.Context(), agentruntimestate.SubmitTrustedTurnInput{ContextKey: env.contextKey, Epoch: env.epoch,
		Inputs: []agentruntimestate.RuntimeInput{runtimeInput("recent-trusted", "trusted_turn", "", "recent")},
	})
	if err != nil {
		t.Fatal(err)
	}
	rows := list()
	if len(rows) != 1 || rows[0] != env.contextKey {
		t.Fatalf("recent Run not listed: %+v", rows)
	}
	revision := func() int64 {
		t.Helper()
		var value int64
		if err := env.pool.QueryRow(t.Context(), `SELECT state_revision FROM agent_execution_contexts WHERE context_key=$1`, env.contextKey).Scan(&value); err != nil {
			t.Fatal(err)
		}
		return value
	}
	revisionBefore := revision()
	if _, err := env.pool.Exec(t.Context(), `UPDATE agent_local_runs SET created_at=clock_timestamp()-interval '2 days' WHERE run_id=$1`, submitted.RunID); err != nil {
		t.Fatal(err)
	}
	if rows := list(); len(rows) != 0 {
		t.Fatalf("Run outside window listed: %+v", rows)
	}
	if revision() != revisionBefore {
		t.Fatal("listing changed Context state")
	}
	if _, err := env.pool.Exec(t.Context(), `UPDATE agent_local_runs SET created_at=clock_timestamp() WHERE run_id=$1`, submitted.RunID); err != nil {
		t.Fatal(err)
	}
	if rows := list(); len(rows) != 1 {
		t.Fatalf("Run back in window not listed: %+v", rows)
	}
	// Only active registrations run on a Local Computer; others never use the limit.
	if _, err := env.pool.Exec(t.Context(), `UPDATE agent_registrations SET status='revoked' WHERE agent_management_id=$1`, testRuntimeAgentID); err != nil {
		t.Fatal(err)
	}
	if rows := list(); len(rows) != 0 {
		t.Fatalf("inactive Agent Context listed: %+v", rows)
	}
	if _, err := env.pool.Exec(t.Context(), `UPDATE agent_registrations SET status='active' WHERE agent_management_id=$1`, testRuntimeAgentID); err != nil {
		t.Fatal(err)
	}
	if _, err := env.pool.Exec(t.Context(), `UPDATE agent_execution_contexts SET terminated_at=clock_timestamp(),terminal_reason='context_deleted' WHERE context_key=$1`, env.contextKey); err != nil {
		t.Fatal(err)
	}
	if rows := list(); len(rows) != 0 {
		t.Fatalf("terminal Context listed: %+v", rows)
	}
}
