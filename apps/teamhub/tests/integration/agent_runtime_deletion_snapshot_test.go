package integration_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentruntimestate"
	"github.com/simplexai-labs/linger/contracts-go/teamhubinternal"
)

func TestAgentRuntimeDeletionSnapshotIsReadOnlyAndDeletionOnly(t *testing.T) {
	allowParallelIntegrationTest(t)
	for _, persisted := range []bool{false, true} {
		name := "empty topology"
		if persisted {
			name = "existing leased and terminal Contexts with Session"
		}
		t.Run(name, func(t *testing.T) {
			pool, handler := runtimeConfigRecoveryFixture(t)
			path := "/v0/agent-runtime/deletion-snapshot?agent_id=" + url.QueryEscape(testRuntimeAgentID)
			if persisted {
				status, body := agentRuntimeStateRequest(t, handler, http.MethodGet, "/v0/agent-runtime/config?agent_id="+testRuntimeAgentID, teamHubInternalToken, nil)
				if status != http.StatusOK {
					t.Fatalf("prepare existing Contexts: status=%d body=%s", status, body)
				}
				service := agentruntimestate.New(pool)
				ensured, err := service.EnsureContext(t.Context(), agentruntimestate.EnsureContextInput{Ref: agentruntimestate.ContextRef{Kind: "meta", AgentID: testRuntimeAgentID, RoomID: "room_config_one"}, TargetResidency: "active"})
				if err != nil {
					t.Fatal(err)
				}
				startRuntimeEpoch(t, service, "deletion-fixture")
				if _, err := service.CheckpointRuntimeSession(t.Context(), agentruntimestate.CheckpointSessionInput{ContextKey: ensured.Context.ContextKey,
					Epoch:      "deletion-fixture",
					Checkpoint: runtimeSessionCheckpoint(0, 1, "retained-native-thread"),
				}); err != nil {
					t.Fatal(err)
				}
				if _, err := pool.Exec(t.Context(), `UPDATE agent_execution_contexts SET terminal_reason='context_deleted',terminated_at=clock_timestamp() WHERE agent_management_id=$1 AND room_id='room_config_two'`, testRuntimeAgentID); err != nil {
					t.Fatal(err)
				}
			}
			for _, status := range []string{"active"} {
				if _, err := pool.Exec(t.Context(), `UPDATE agent_registrations SET status=$1 WHERE agent_management_id=$2`, status, testRuntimeAgentID); err != nil {
					t.Fatal(err)
				}
				code, _ := agentRuntimeStateRequest(t, handler, http.MethodGet, path, teamHubInternalToken, nil)
				if code != http.StatusNotFound {
					t.Fatalf("registration %s got HTTP %d", status, code)
				}
			}
			if _, err := pool.Exec(t.Context(), `UPDATE agent_registrations SET status='revoked' WHERE agent_management_id=$1`, testRuntimeAgentID); err != nil {
				t.Fatal(err)
			}
			for _, request := range []struct {
				path, token string
				want        int
			}{
				{path, "", http.StatusUnauthorized},
				{"/v0/agent-runtime/deletion-snapshot?agent_id=missing-agent", teamHubInternalToken, http.StatusNotFound},
				{"/v0/agent-runtime/config?agent_id=" + testRuntimeAgentID, teamHubInternalToken, http.StatusNotFound},
			} {
				code, _ := agentRuntimeStateRequest(t, handler, http.MethodGet, request.path, request.token, nil)
				if code != request.want {
					t.Fatalf("request %s: status=%d want=%d", request.path, code, request.want)
				}
			}
			readState := func() [3]string {
				t.Helper()
				var state [3]string
				for i, query := range []string{
					`SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY context_key),'[]')::text FROM agent_execution_contexts c WHERE agent_management_id=$1`,
					`SELECT coalesce(jsonb_agg(c.session ORDER BY c.context_key),'[]')::text FROM agent_execution_contexts c WHERE c.agent_management_id=$1`,
					`SELECT coalesce(jsonb_agg(to_jsonb(i) ORDER BY i.context_key,i.inbox_id),'[]')::text FROM agent_context_inbox_cursors i JOIN agent_execution_contexts c USING(context_key) WHERE c.agent_management_id=$1`,
				} {
					if err := pool.QueryRow(t.Context(), query, testRuntimeAgentID).Scan(&state[i]); err != nil {
						t.Fatal(err)
					}
				}
				return state
			}
			before := readState()
			// A cleanup identity read must not wait for or mutate existing lease rows.
			writer, err := pool.Begin(t.Context())
			if err != nil {
				t.Fatal(err)
			}
			defer writer.Rollback(context.Background())
			if _, err := writer.Exec(t.Context(), `UPDATE agent_execution_contexts SET updated_at=clock_timestamp() WHERE agent_management_id=$1`, testRuntimeAgentID); err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(t.Context(), time.Second)
			defer cancel()
			request := httptest.NewRequest(http.MethodGet, path, nil).WithContext(ctx)
			request.Header.Set("Authorization", "Bearer "+teamHubInternalToken)
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code != http.StatusOK {
				t.Fatalf("snapshot: status=%d body=%s", response.Code, response.Body.String())
			}
			var snapshot teamhubinternal.AgentRuntimeDeletionSnapshot
			decode(t, response.Body.Bytes(), &snapshot)
			wantContexts := 0
			if persisted {
				wantContexts = 2
			}
			if snapshot.AgentId != testRuntimeAgentID || snapshot.ActorId != "actor_acme_official" || snapshot.TenantId != "tenant_acme" || snapshot.ConfigurationRevision != "1" || len(snapshot.Contexts) != wantContexts {
				t.Fatalf("unexpected deletion identity: %+v", snapshot)
			}
			if after := readState(); !reflect.DeepEqual(before, after) {
				t.Fatal("deletion snapshot changed Context, Session or Inbox state")
			}
			var responseKeys map[string]any
			decode(t, response.Body.Bytes(), &responseKeys)
			if len(responseKeys) != 6 || responseKeys["agent"] != nil || responseKeys["session"] != nil || responseKeys["resources"] != nil {
				t.Fatal("deletion identity exposes activation configuration or native state")
			}
		})
	}
}
