package integration_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentauth"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

func TestAgentCLIRechecksAuthorityAfterBusinessLock(t *testing.T) {
	allowParallelIntegrationTest(t)
	for _, change := range []string{"credential expired", "Room membership removed"} {
		t.Run("routine "+change+" while waiting", func(t *testing.T) {
			env, alice, issued, roomID := newAgentCLIIdentity(t)
			ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
			defer cancel()
			invocation := "agent-invocation-sha256:" + strings.Repeat("c", 64)
			key := "agent:actor_acme_official|createRoutine:" + roomID + "|" + agentauth.IdempotencyKey("create_routine", invocation)
			blocker, pid := lockAgentCLICommit(t, ctx, env, key)
			encoded, err := json.Marshal(map[string]any{"invocation_id": invocation, "name": "Current authority", "instruction": "Write a note", "schedule": map[string]any{"kind": "every_n_hours", "interval_hours": 4}})
			if err != nil {
				t.Fatal(err)
			}
			request, err := http.NewRequestWithContext(ctx, http.MethodPost, env.server.URL+"/api/agent/v1/routines", bytes.NewReader(encoded))
			if err != nil {
				t.Fatal(err)
			}
			request.Header.Set("Authorization", "Bearer "+issued.AccessToken)
			request.Header.Set("Content-Type", "application/json")
			request.Header.Set("X-TeamHub-Context-Kind", "room")
			request.Header.Set("X-TeamHub-Context-Id", roomID)
			done := make(chan agentCLICommitResult, 1)
			go func() {
				response, err := http.DefaultClient.Do(request)
				if err != nil {
					done <- agentCLICommitResult{err: err}
					return
				}
				defer response.Body.Close()
				body, err := io.ReadAll(response.Body)
				done <- agentCLICommitResult{code: response.StatusCode, err: err, body: body}
			}()
			waitAgentCLICommitLock(t, ctx, env, pid, done)
			if change == "credential expired" {
				if err := revokeAgentCredential(ctx, env.pool, issued.CredentialID); err != nil {
					t.Fatal(err)
				}
			} else {
				code, _, body := env.request(alice, http.MethodDelete, "/v0/rooms/"+roomID+"/members/actor_acme_official", nil, "")
				if code != http.StatusNoContent {
					t.Fatalf("remove Agent: %d %s", code, body)
				}
			}
			if err := blocker.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			got := <-done
			if got.err != nil || (got.code != http.StatusForbidden && got.code != http.StatusUnauthorized && got.code != http.StatusNotFound) {
				t.Fatalf("routine accepted stale authority: status=%d err=%v body=%s", got.code, got.err, got.body)
			}
			if n := countRows(t, env, `SELECT count(*) FROM room_reminders WHERE room_id=$1`, roomID); n != 0 {
				t.Fatalf("persisted routines after revocation=%d", n)
			}
		})
	}
}

func lockAgentCLICommit(t *testing.T, ctx context.Context, env *testEnv, key string) (pgx.Tx, int32) {
	t.Helper()
	tx, err := env.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = tx.Rollback(context.Background()) })
	if err := store.New(tx).AcquireAdvisoryTransactionLock(ctx, key); err != nil {
		t.Fatal(err)
	}
	var pid int32
	if err := tx.QueryRow(ctx, `SELECT pg_backend_pid()`).Scan(&pid); err != nil {
		t.Fatal(err)
	}
	return tx, pid
}

type agentCLICommitResult struct {
	code int
	err  error
	body []byte
}

func waitAgentCLICommitLock(t *testing.T, ctx context.Context, env *testEnv, pid int32, done <-chan agentCLICommitResult) {
	t.Helper()
	for {
		select {
		case got := <-done:
			t.Fatalf("request returned before reaching business lock: status=%d err=%v body=%s", got.code, got.err, got.body)
		default:
		}
		var waiting bool
		if err := env.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid)))`, pid).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting {
			return
		}
		select {
		case <-ctx.Done():
			select {
			case got := <-done:
				t.Fatalf("timed out waiting for business lock; request already returned status=%d err=%v body=%s", got.code, got.err, got.body)
			default:
				t.Fatalf("timed out waiting for business lock; request still in flight: %v", ctx.Err())
			}
		case <-time.After(10 * time.Millisecond):
		}
	}
}
