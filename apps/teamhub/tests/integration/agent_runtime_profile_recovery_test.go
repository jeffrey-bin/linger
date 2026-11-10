package integration_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentruntimestate"
)

func TestAgentRuntimeClaimDeliversProfileUpdateOnce(t *testing.T) {
	allowParallelIntegrationTest(t)
	env := newRuntimeStateTestEnv(t)
	setProfileTestProvider(t, env, "codex")
	revision := activeRuntimeConfigurationRevision(t, env.pool)
	checkpoint := runtimeSessionCheckpoint(0, revision, "profile-update-thread")
	checkpoint.ProviderKind = "local"
	if _, err := env.service.CheckpointRuntimeSession(t.Context(), agentruntimestate.CheckpointSessionInput{ContextKey: env.contextKey, Epoch: env.epoch, Checkpoint: checkpoint}); err != nil {
		t.Fatal(err)
	}
	if _, err := env.pool.Exec(t.Context(), `WITH changed AS (
		UPDATE agent_registrations SET configuration_revision=configuration_revision+1,instructions='Plan the release.'
		WHERE agent_management_id=$1 RETURNING actor_id,tenant_id)
		UPDATE actors SET display_name='Planner' FROM changed WHERE actors.id=changed.actor_id AND actors.tenant_id=changed.tenant_id`, testRuntimeAgentID); err != nil {
		t.Fatal(err)
	}
	claim := func(name string) *agentruntimestate.ProfileUpdate {
		t.Helper()
		submitted, err := env.service.SubmitTrustedTurn(t.Context(), agentruntimestate.SubmitTrustedTurnInput{ContextKey: env.contextKey, Epoch: env.epoch,
			Inputs: []agentruntimestate.RuntimeInput{runtimeInput("input-"+name, "trusted_turn", "", name)},
		})
		if err != nil {
			t.Fatal(err)
		}
		input := agentruntimestate.ClaimLocalRunInput{ClaimID: "claim-" + name, ContextKey: env.contextKey, Epoch: env.epoch}
		claimed, err := env.service.ClaimLocalRun(t.Context(), input)
		if err != nil || claimed.Run == nil || claimed.Run.RunID != submitted.RunID {
			t.Fatalf("claim %s: %+v %v", name, claimed, err)
		}
		replay, err := env.service.ClaimLocalRun(t.Context(), input)
		if err != nil || replay.Run == nil || (replay.Run.ProfileUpdate == nil) != (claimed.Run.ProfileUpdate == nil) {
			t.Fatalf("replayed claim %s changed its profile update: %+v %v", name, replay, err)
		}
		if _, err := env.service.FinishLocalRun(t.Context(), agentruntimestate.FinishLocalRunInput{ContextKey: env.contextKey, Epoch: env.epoch, RunID: submitted.RunID,
			Terminal: json.RawMessage(`{"type":"succeeded"}`),
		}); err != nil {
			t.Fatal(err)
		}
		return claimed.Run.ProfileUpdate
	}
	update := claim("first-after-change")
	if update == nil || update.ConfigurationRevision != revision+1 || update.Name != "Planner" || update.Instructions != "Plan the release." {
		t.Fatalf("first claim after a profile change: %+v", update)
	}
	if update := claim("second-after-change"); update != nil {
		t.Fatalf("the same profile was delivered twice: %+v", update)
	}
	// A Runtime change discards the Session at activation instead.
	if _, err := env.pool.Exec(t.Context(), `UPDATE agent_registrations SET configuration_revision=configuration_revision+1,
		runtime_configuration_revision=configuration_revision+1 WHERE agent_management_id=$1`, testRuntimeAgentID); err != nil {
		t.Fatal(err)
	}
	if update := claim("after-runtime-change"); update != nil {
		t.Fatalf("a Runtime change was delivered as a profile update: %+v", update)
	}
}

func TestAgentRuntimeProfileChangeColdRecovery(t *testing.T) {
	allowParallelIntegrationTest(t)
	for _, scenario := range []string{
		"local-codex", "local-claude", "local-failed-checkpoint", "suspended",
		"runtime-change",
		"human-update-after-read", "update-during-clear", "failed-checkpoint",
	} {
		t.Run(scenario, func(t *testing.T) {
			env := newRuntimeStateTestEnv(t)
			provider := "codex"
			if scenario == "local-claude" {
				provider = "claude"
			}
			setProfileTestProvider(t, env, provider)
			revision := activeRuntimeConfigurationRevision(t, env.pool)
			checkpoint := runtimeSessionCheckpoint(0, revision, "sealed-before-restart")
			checkpoint.ProviderKind = "local"
			checkpoint.Session = json.RawMessage(`{"threadId":"sealed-before-restart","sandboxNativeCheckpoint":{"generation":"durable-generation"}}`)
			stored, err := env.service.CheckpointRuntimeSession(t.Context(), agentruntimestate.CheckpointSessionInput{ContextKey: env.contextKey, Epoch: env.epoch, Checkpoint: checkpoint})
			if err != nil {
				t.Fatal(err)
			}
			// A profile-only change: the Runtime revision stays.
			if _, err := env.pool.Exec(t.Context(), `UPDATE agent_registrations SET configuration_revision=configuration_revision+1,
				instructions='Initialized profile',updated_at=clock_timestamp()
				WHERE agent_management_id=$1`, testRuntimeAgentID); err != nil {
				t.Fatal(err)
			}
			mutations := map[string]string{
				"suspended":      "UPDATE agent_execution_contexts SET target_residency='suspended'",
				"runtime-change": "UPDATE agent_registrations SET runtime_configuration_revision=configuration_revision WHERE agent_management_id='" + testRuntimeAgentID + "'",
			}
			if sql := mutations[scenario]; sql != "" {
				if _, err := env.pool.Exec(t.Context(), sql); err != nil {
					t.Fatal(err)
				}
			}
			expectCompatible := scenario == "local-codex" || scenario == "local-claude" ||
				scenario == "local-failed-checkpoint" || scenario == "suspended" ||
				scenario == "human-update-after-read" || scenario == "update-during-clear" || scenario == "failed-checkpoint"
			read, err := env.service.GetRuntimeSession(t.Context(), env.contextKey)
			if err != nil || read == nil {
				t.Fatalf("read old Session: %+v %v", read, err)
			}
			encoded, err := json.Marshal(read)
			if err != nil {
				t.Fatal(err)
			}
			var proof struct {
				CompatibleRevision int64 `json:"compatible_configuration_revision"`
			}
			if err := json.Unmarshal(encoded, &proof); err != nil {
				t.Fatal(err)
			}
			if expectCompatible && proof.CompatibleRevision != revision+1 || !expectCompatible && proof.CompatibleRevision != 0 {
				t.Fatalf("compatibility=%d compatible=%v original=%d", proof.CompatibleRevision, expectCompatible, revision)
			}
			if read.Revision != stored.Revision || read.ConfigurationRevision != revision ||
				read.ThreadID != stored.ThreadID || !bytes.Equal(read.Session, stored.Session) || !read.UpdatedAt.Equal(stored.UpdatedAt) {
				t.Fatal("read compatibility mutated the old checkpoint")
			}
			if scenario == "human-update-after-read" {
				if _, err := env.pool.Exec(t.Context(), `UPDATE agent_registrations SET configuration_revision=configuration_revision+1
					WHERE agent_management_id=$1`, testRuntimeAgentID); err != nil {
					t.Fatal(err)
				}
			}
			// Automatic clearing is bound to the revision the replacement loaded.
			// A stale client must not erase a compatible or concurrently changed Session.
			clear := agentruntimestate.ClearRuntimeSessionInput{ContextKey: env.contextKey, Epoch: env.epoch, ConfigurationRevision: revision}
			guard, _ := json.Marshal(map[string]int64{"expected_current_configuration_revision": revision + 1})
			if err := json.Unmarshal(guard, &clear); err != nil {
				t.Fatal(err)
			}
			var cleared agentruntimestate.ClearRuntimeSessionResult
			var clearErr error
			if scenario == "update-during-clear" {
				// The clear must wait for the in-flight registration transaction,
				// then reject its obsolete expected revision without deleting bytes.
				ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
				defer cancel()
				update, err := env.pool.Begin(ctx)
				if err != nil {
					t.Fatal(err)
				}
				defer update.Rollback(context.Background())
				if _, err := update.Exec(ctx, `UPDATE agent_registrations SET configuration_revision=configuration_revision+1
					WHERE agent_management_id=$1`, testRuntimeAgentID); err != nil {
					t.Fatal(err)
				}
				done := make(chan error, 1)
				go func() {
					_, err := env.service.ClearRuntimeSession(ctx, clear)
					done <- err
				}()
				for {
					var waiting bool
					if err := env.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity
						WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid)))`, update.Conn().PgConn().PID()).Scan(&waiting); err != nil {
						t.Fatal(err)
					}
					if waiting {
						break
					}
					select {
					case err := <-done:
						t.Fatalf("clear bypassed in-flight registration: %v", err)
					case <-ctx.Done():
						t.Fatal(ctx.Err())
					case <-time.After(10 * time.Millisecond):
					}
				}
				// Registration writers may next lock Contexts during deletion.
				// A waiting clear must not already hold that lock in reverse order.
				if _, err := update.Exec(ctx, "SELECT 1 FROM agent_execution_contexts WHERE context_key=$1 FOR NO KEY UPDATE NOWAIT", env.contextKey); err != nil {
					t.Fatalf("automatic clear inverted registration/Context locks: %v", err)
				}
				if err := update.Commit(ctx); err != nil {
					t.Fatal(err)
				}
				clearErr = <-done
			} else {
				cleared, clearErr = env.service.ClearRuntimeSession(t.Context(), clear)
			}
			mustPreserve := expectCompatible
			if mustPreserve {
				if !errors.Is(clearErr, agentruntimestate.ErrConflict) || cleared.Cleared {
					t.Fatalf("automatic clear discarded a protected checkpoint: %+v %v", cleared, clearErr)
				}
			} else {
				if clearErr != nil || !cleared.Cleared {
					t.Fatalf("ordinary incompatible revision did not clear: %+v %v", cleared, clearErr)
				}
				return
			}
			if scenario == "local-codex" || scenario == "local-claude" ||
				scenario == "local-failed-checkpoint" || scenario == "failed-checkpoint" {
				env.epoch = "replacement-controller"
				startRuntimeEpoch(t, env.service, env.epoch)
				checkpoint.ExpectedRevision = stored.Revision
				checkpoint.ConfigurationRevision = revision + 1
				if scenario == "failed-checkpoint" || scenario == "local-failed-checkpoint" {
					checkpoint.ExpectedRevision++
				}
				next, checkpointErr := env.service.CheckpointRuntimeSession(t.Context(), agentruntimestate.CheckpointSessionInput{ContextKey: env.contextKey, Epoch: env.epoch, Checkpoint: checkpoint})
				if scenario != "failed-checkpoint" && scenario != "local-failed-checkpoint" {
					if checkpointErr != nil || next.Revision != stored.Revision+1 || next.ConfigurationRevision != revision+1 ||
						next.ThreadID != stored.ThreadID || !bytes.Equal(next.Session, stored.Session) {
						t.Fatalf("resume did not preserve native identity: %+v %v", next, checkpointErr)
					}
					return
				}
				if !errors.Is(checkpointErr, agentruntimestate.ErrConflict) {
					t.Fatalf("failed checkpoint CAS was accepted: %v", checkpointErr)
				}
			}
			retained, err := env.service.GetRuntimeSession(t.Context(), env.contextKey)
			if err != nil || retained == nil || retained.Revision != stored.Revision ||
				retained.ConfigurationRevision != revision || !bytes.Equal(retained.Session, stored.Session) {
				t.Fatalf("failure lost the old checkpoint: %+v %v", retained, err)
			}
		})
	}
}
