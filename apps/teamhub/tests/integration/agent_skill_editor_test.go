package integration_test

import (
	"net/http"
	"testing"

	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

func readEditorBindings(t *testing.T, env *testEnv, client *http.Client, agentID string) httpapi.AgentSkillBindingList {
	t.Helper()
	status, _, body := env.request(client, http.MethodGet, "/v0/tenants/"+acmeTenant+"/agents/"+agentID+"/skill-bindings", nil, "")
	if status != 200 {
		t.Fatalf("read bindings: %d %s", status, body)
	}
	var result httpapi.AgentSkillBindingList
	decode(t, body, &result)
	return result
}
