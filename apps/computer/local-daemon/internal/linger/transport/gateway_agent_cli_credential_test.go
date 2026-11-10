package transport

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/protocol"
)

func TestGatewayAgentCLICredentialRoundTripsIdentityAndOutcomeWithoutToken(t *testing.T) {
	token := "th_agent_" + strings.Repeat("a", 43)
	upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	received := make(chan map[string]any, 2)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		socket, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Error(err)
			return
		}
		defer socket.Close()
		command := map[string]any{"type": "execute", "kind": "cli_credential", "protocol_version": "2", "command_id": "put-one", "tenant_id": "tenant-one", "runner_id": "computer-one", "agent_id": "agent-one", "registration_id": "registration-one", "assignment_revision": 2, "connection_epoch": 3, "runner_revision": 4, "profile": map[string]any{"url": "https://teamhub.example", "tenant_id": "tenant-one", "agent_id": "agent-one"}, "access_token": token}
		if err := socket.WriteJSON(command); err != nil {
			t.Error(err)
			return
		}
		var event map[string]any
		if err := socket.ReadJSON(&event); err != nil {
			t.Error(err)
			return
		}
		received <- event
	}))
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	stream, err := (GatewayControlPlane{URL: "ws" + strings.TrimPrefix(server.URL, "http"), BearerToken: "test"}).Connect(ctx, Hello{})
	if err != nil {
		t.Fatal(err)
	}
	defer stream.Close()
	command, err := stream.Receive(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if command.Type != protocol.CommandAgentCLICredentialPut || command.CommandID != "put-one" || command.RegistrationID != "registration-one" {
		t.Fatalf("credential command lost identity: %+v", command)
	}
	var payload map[string]any
	if err := json.Unmarshal(command.Payload, &payload); err != nil {
		t.Fatal(err)
	}
	if payload["access_token"] != token {
		t.Fatalf("credential payload = %+v", payload)
	}
	err = stream.Send(ctx, protocol.Event{Type: protocol.EventAgentCLICredentialStored, CommandID: command.CommandID, TenantID: command.TenantID, RunnerID: command.RunnerID, AgentID: command.AgentID, RegistrationID: command.RegistrationID, AssignmentRevision: command.AssignmentRevision, ConnectionEpoch: command.ConnectionEpoch, RunnerRevision: command.RunnerRevision, Payload: json.RawMessage(`{"sha256":"` + strings.Repeat("c", 64) + `"}`)})
	if err != nil {
		t.Fatal(err)
	}
	select {
	case event := <-received:
		if event["type"] != "executed" || event["kind"] != "cli_credential" || event["outcome"] != "succeeded" || event["command_id"] != "put-one" || event["sha256"] != strings.Repeat("c", 64) {
			t.Fatalf("stored outcome = %+v", event)
		}
		if strings.Contains(mustMarshalForTest(t, event), token) {
			t.Fatal("stored outcome exposes the access token")
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
}

func TestAgentRunnerReadyEncodesTheStoredCLICredential(t *testing.T) {
	ready := protocol.Event{Type: protocol.EventAgentRunnerReady, CommandID: "ensure-one", TenantID: "tenant-one", RunnerID: "computer-one", AgentID: "agent-one", ConnectionEpoch: 3, RunnerRevision: 4}
	if value, err := replyMap(ready); err != nil || value["cli_credential"] != nil {
		t.Fatalf("ready without a stored credential = %+v", value)
	}
	report := `{"sha256":"` + strings.Repeat("c", 64) + `","assignment_revision":2,"profile":{"url":"https://teamhub.example","tenant_id":"tenant-one","agent_id":"agent-one"}}`
	ready.Payload = json.RawMessage(`{"cli_credential":` + report + `}`)
	value, err := replyMap(ready)
	if err != nil {
		t.Fatal(err)
	}
	var want any
	if err := json.Unmarshal([]byte(report), &want); err != nil {
		t.Fatal(err)
	}
	if got := mustMarshalForTest(t, value["cli_credential"]); got != mustMarshalForTest(t, want) {
		t.Fatalf("ready credential = %s, want the stored credential report", got)
	}
}

func mustMarshalForTest(t *testing.T, value any) string {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(encoded)
}

// replyMap is the wire frame of a reply event as the Agent Service reads it.
func replyMap(event protocol.Event) (map[string]any, error) {
	frame, err := replyFrame(event)
	if err != nil {
		return nil, err
	}
	encoded, err := json.Marshal(frame)
	if err != nil {
		return nil, err
	}
	var value map[string]any
	return value, json.Unmarshal(encoded, &value)
}
