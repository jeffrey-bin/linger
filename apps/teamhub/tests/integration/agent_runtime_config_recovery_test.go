package integration_test

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/config"
)

func runtimeConfigRecoveryFixture(t *testing.T) (*pgxpool.Pool, http.Handler) {
	t.Helper()
	databaseURL := newIntegrationDatabase(t)
	pool, err := pgxpool.New(t.Context(), databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	seedReadyFixtureComputers(t, pool)
	application, err := newIntegrationApp(t.Context(), config.ForTest(func(c *config.Config) {
		c.DatabaseURL = databaseURL
		c.SessionTTL = time.Hour
		c.CookieName = "teamhub_session"
		c.TeamHubInternalToken = teamHubInternalToken
		c.NodeServicesInternalToken = nodeServicesInternalToken
		c.AgentRunTokenSecret = agentRunTokenSecret
		c.ArtifactStorageRoot = t.TempDir()
		c.ArtifactMaxBytes = 1 << 20
	}))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(application.Close)
	insertRuntimeRoomMembership(t, pool, "room_config_one")
	insertRuntimeRoomMembership(t, pool, "room_config_two")
	return pool, application.Handler()
}

func TestAgentRuntimeConfigReadDoesNotWaitForExistingContextWriter(t *testing.T) {
	allowParallelIntegrationTest(t)
	pool, handler := runtimeConfigRecoveryFixture(t)
	requestPath := "/v0/agent-runtime/config?agent_id=" + testRuntimeAgentID
	status, body := agentRuntimeStateRequest(t, handler, http.MethodGet, requestPath, teamHubInternalToken, nil)
	if status != http.StatusOK {
		t.Fatalf("initial config: status=%d body=%s", status, body)
	}

	writer, err := pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Rollback(context.Background())
	if _, err := writer.Exec(t.Context(), `UPDATE agent_execution_contexts SET updated_at=clock_timestamp() WHERE agent_management_id=$1`, testRuntimeAgentID); err != nil {
		t.Fatal(err)
	}

	// A configuration read of already reconciled Contexts must finish while a
	// lease writer still owns their row locks, without waiting or changing state.
	ctx, cancel := context.WithTimeout(t.Context(), time.Second)
	defer cancel()
	request := httptest.NewRequest(http.MethodGet, requestPath, nil).WithContext(ctx)
	request.Header.Set("Authorization", "Bearer "+teamHubInternalToken)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK || response.Body.String() != string(body) {
		t.Fatalf("config read blocked on Context writer: status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestAgentRuntimeConfigRetriesCompleteTransaction(t *testing.T) {
	allowParallelIntegrationTest(t)
	for _, tc := range []struct {
		name             string
		code             string
		failures         int
		wantStatus       int
		wantTriggerCalls int
		wantContexts     int
	}{
		{name: "commit serialization failure", code: "40001", failures: 1, wantStatus: 200, wantTriggerCalls: 3, wantContexts: 2},
		{name: "bounded serialization failures", code: "40001", failures: 100, wantStatus: 500, wantTriggerCalls: 3},
		{name: "other database error", code: "23514", failures: 100, wantStatus: 500, wantTriggerCalls: 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			pool, handler := runtimeConfigRecoveryFixture(t)
			// Sequence values survive rollback. A deferred trigger fails COMMIT
			// after both Contexts/cursors were written, proving whole-transaction
			// rollback and retry rather than retrying a statement in an aborted tx.
			_, err := pool.Exec(t.Context(), fmt.Sprintf(`
				CREATE SEQUENCE config_commit_attempt;
				CREATE FUNCTION fail_config_commit() RETURNS trigger LANGUAGE plpgsql AS $$
				BEGIN
					IF nextval('config_commit_attempt') <= %d THEN
						RAISE EXCEPTION 'injected configuration transaction failure' USING ERRCODE='%s';
					END IF;
					RETURN NEW;
				END $$;
				CREATE CONSTRAINT TRIGGER config_commit_failure AFTER INSERT ON agent_execution_contexts
				DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fail_config_commit();
			`, tc.failures, tc.code))
			if err != nil {
				t.Fatal(err)
			}
			status, body := agentRuntimeStateRequest(t, handler, http.MethodGet,
				"/v0/agent-runtime/config?agent_id="+testRuntimeAgentID, teamHubInternalToken, nil)
			if status != tc.wantStatus {
				t.Fatalf("config status=%d want=%d body=%s", status, tc.wantStatus, body)
			}
			var triggerCalls, contexts int
			if err := pool.QueryRow(t.Context(), `SELECT last_value FROM config_commit_attempt`).Scan(&triggerCalls); err != nil {
				t.Fatal(err)
			}
			if err := pool.QueryRow(t.Context(), `SELECT count(*) FROM agent_execution_contexts WHERE agent_management_id=$1`, testRuntimeAgentID).Scan(&contexts); err != nil {
				t.Fatal(err)
			}
			if triggerCalls != tc.wantTriggerCalls || contexts != tc.wantContexts {
				t.Fatalf("commit trigger calls=%d contexts=%d; want %d/%d", triggerCalls, contexts, tc.wantTriggerCalls, tc.wantContexts)
			}
		})
	}
}
