package integration_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/roomagent"
)

// A new Agent is only TeamHub rows: Agent Service materializes it from the
// served configuration at its first Run, and no global Meta Context exists.
func TestTenantAgentRegistrationServesConfigWithoutGlobalMetaContext(t *testing.T) {
	allowParallelIntegrationTest(t)
	agentManagementServer := httptest.NewServer(http.NotFoundHandler())
	registerIntegrationServerCleanup(t, agentManagementServer)
	gateway, err := roomagent.NewHTTPGateway(
		agentManagementServer.URL, "agent-management-test-token", agentManagementServer.Client(),
	)
	if err != nil {
		t.Fatal(err)
	}
	env, alice := newAgentRegistrationEnv(t, gateway)

	status, _, body := env.request(alice, http.MethodPost, "/v0/tenants/"+acmeTenant+"/agents", map[string]any{
		"name": "Materialized Reviewer", "instructions": "Materialize from TeamHub.",
		"runtime": fixtureRuntime("gpt-5"),
	}, "pending-materialization-registration")
	if status != http.StatusCreated {
		t.Fatalf("register materialized Agent status=%d body=%s", status, body)
	}
	var created struct {
		AgentManagementID string `json:"agent_management_id"`
	}
	if err := json.Unmarshal(body, &created); err != nil || created.AgentManagementID == "" {
		t.Fatalf("created Agent body=%s error=%v", body, err)
	}
	agentID := created.AgentManagementID

	configStatus, configBody, err := pendingMaterializationCallback(
		t.Context(), http.MethodGet,
		env.server.URL+"/v0/agent-runtime/config?agent_id="+url.QueryEscape(agentID), nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	contextStatus, contextBody, err := pendingMaterializationCallback(
		t.Context(), http.MethodPost,
		env.server.URL+"/v0/agent-runtime/contexts", map[string]any{
			"command_id":       "materialize-" + agentID,
			"ref":              map[string]any{"kind": "meta", "agent_id": agentID},
			"target_residency": "active",
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	if configStatus != http.StatusOK || contextStatus != http.StatusBadRequest ||
		!bytes.Contains(configBody, []byte(`"agent_id":"`+agentID+`"`)) ||
		!bytes.Contains(contextBody, []byte(`"code":"INVALID_REQUEST"`)) {
		t.Fatalf("materialization config=%d %s context=%d %s", configStatus, configBody, contextStatus, contextBody)
	}
	if got := countRows(t, env, `
		SELECT count(*)
		FROM agent_registrations registration
		JOIN agent_execution_contexts context
		  ON context.agent_actor_id=registration.actor_id
		 AND context.tenant_id=registration.tenant_id
		 AND context.agent_management_id=registration.agent_management_id
		WHERE registration.agent_management_id=$1
		  AND registration.status='active'
		  AND context.context_kind='meta'
	`, agentID); got != 0 {
		t.Fatalf("active Agent global Meta Context rows=%d want=0", got)
	}
}

func pendingMaterializationCallback(
	ctx context.Context,
	method string,
	endpoint string,
	payload any,
) (int, []byte, error) {
	var body io.Reader
	if payload != nil {
		encoded, err := json.Marshal(payload)
		if err != nil {
			return 0, nil, err
		}
		body = bytes.NewReader(encoded)
	}
	request, err := http.NewRequestWithContext(ctx, method, endpoint, body)
	if err != nil {
		return 0, nil, err
	}
	request.Header.Set("Authorization", "Bearer "+teamHubInternalToken)
	if payload != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return 0, nil, err
	}
	defer response.Body.Close()
	responseBody, err := io.ReadAll(response.Body)
	if err != nil {
		return response.StatusCode, nil, err
	}
	return response.StatusCode, responseBody, nil
}
