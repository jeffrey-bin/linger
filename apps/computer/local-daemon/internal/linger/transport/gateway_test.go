package transport

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/protocol"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider/native"
)

func TestGatewayControlPlaneUsesBearerAndRoundTripsJSON(t *testing.T) {
	upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if got := request.Header.Get("Authorization"); got != "Bearer test-token" {
			t.Errorf("authorization = %q", got)
		}
		socket, err := upgrader.Upgrade(writer, request, nil)
		if err != nil {
			t.Error(err)
			return
		}
		defer socket.Close()
		if err := socket.WriteJSON(map[string]any{
			"type": protocol.CommandOperationStart, "protocol_version": "2", "host_access": "trusted",
			"command_id": "start-1", "operation_id": "op-1", "registration_id": "registration-1", "assignment_revision": 1,
			"tenant_id": "tenant-1", "runner_id": "computer-1", "agent_id": "agent-1", "execution_context_key": "context-1",
			"runtime_instance_id": "runtime-1", "execution_lease_id": "lease-1", "workspace_grant_id": "grant-1", "runtime_type": "codex",
			"connection_epoch": 1, "runner_revision": 1, "generation": 1, "context_view_ref": map[string]any{"view_digest": strings.Repeat("a", 64)},
			"request": map[string]any{"kind": "run.start"},
		}); err != nil {
			t.Error(err)
			return
		}
		_, _, _ = socket.ReadMessage()
	}))
	defer server.Close()
	url := "ws" + strings.TrimPrefix(server.URL, "http")
	stream, err := (GatewayControlPlane{URL: url, BearerToken: "test-token"}).Connect(context.Background(), Hello{})
	if err != nil {
		t.Fatal(err)
	}
	defer stream.Close()
	command, err := stream.Receive(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if command.Type != protocol.CommandOperationStart || command.OperationID != "op-1" {
		t.Fatalf("command = %+v", command)
	}
	if err := stream.Send(context.Background(), protocol.Event{
		Type: protocol.EventRuntimeObserved, ProtocolVersion: "2", CommandID: "snapshot-1",
		ConnectionEpoch: 1, Payload: json.RawMessage(`{"count":0}`),
	}); err != nil {
		t.Fatal(err)
	}
}

func TestGatewayOperationPrepareUsesAdditiveExactWireShape(t *testing.T) {
	upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	received := make(chan map[string]any, 1)
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		socket, err := upgrader.Upgrade(writer, request, nil)
		if err != nil {
			t.Error(err)
			return
		}
		defer socket.Close()
		if err := socket.WriteJSON(map[string]any{
			"type": "prepare", "target": "operation", "protocol_version": "2", "host_access": "trusted", "command_id": "prepare-1",
			"tenant_id": "tenant-1", "runner_id": "computer-1", "registration_id": "registration-1",
			"assignment_revision": 2, "agent_id": "agent-1", "operation_id": "operation-1",
			"connection_epoch": 3, "runner_revision": 4, "generation": 5, "execution_lease_id": "lease-1",
			"workspace_grant_id": "grant-1", "runtime_type": "codex", "execution_context_key": "context-1",
			"runtime_instance_id": "runtime-1", "context_view_ref": map[string]any{"view_digest": strings.Repeat("a", 64)},
			"runtime":         map[string]any{"type": "codex", "model": "gpt-6"},
			"session_options": map[string]any{"thread_name": "Agent"}, "session": map[string]any{"threadId": "thread-1"},
			"mcp_relays":        []any{map[string]any{"name": "linger_teamhub_collaboration"}},
			"permission_review": true,
		}); err != nil {
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
	stream, err := (GatewayControlPlane{URL: "ws" + strings.TrimPrefix(server.URL, "http"), BearerToken: "test-token"}).Connect(context.Background(), Hello{})
	if err != nil {
		t.Fatal(err)
	}
	defer stream.Close()
	command, err := stream.Receive(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if command.Type != protocol.CommandOperationPrepare || command.OperationKind != "run.start" || command.HostAccess != "trusted" {
		t.Fatalf("prepare command=%+v", command)
	}
	var semantic map[string]any
	if err := json.Unmarshal(command.Payload, &semantic); err != nil {
		t.Fatal(err)
	}
	runContext, _ := semantic["run_context"].(map[string]any)
	if semantic["kind"] != "run.start" || semantic["input"] != nil || runContext["permission_review"] != true {
		t.Fatalf("prepare semantic payload=%+v", semantic)
	}
	if err := stream.Send(context.Background(), protocol.Event{
		Type: protocol.EventOperationPrepared, ProtocolVersion: "2", HostAccess: "trusted", CommandID: "prepare-1",
		TenantID: "tenant-1", RunnerID: "computer-1", RegistrationID: "registration-1", AssignmentRevision: 2,
		AgentID: "agent-1", OperationID: "operation-1", ConnectionEpoch: 3, RunnerRevision: 4, Generation: 5,
		ExecutionLeaseID: "lease-1", WorkspaceGrantID: "grant-1", RuntimeType: "codex",
		ExecutionContextKey: "context-1", RuntimeInstanceID: "runtime-1", ContextViewRef: json.RawMessage(`{"view_digest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}`),
		Payload: json.RawMessage("{\"prepare_command_id\":\"prepare-1\",\"prepared\":true,\"duration_ms\":123,\"outcome\":\"ready\"}"),
	}); err != nil {
		t.Fatal(err)
	}
	wire := <-received
	if wire["type"] != "prepared" || wire["target"] != "operation" || wire["prepared"] != true || wire["prepare_command_id"] != "prepare-1" {
		t.Fatalf("prepared event=%+v", wire)
	}
	if _, exists := wire["seq"]; exists {
		t.Fatalf("operation.prepared consumed operation sequence: %+v", wire)
	}
}

func TestGatewayStreamReceiveStopsWhenContextIsCanceled(t *testing.T) {
	upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	connected := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		socket, err := upgrader.Upgrade(writer, request, nil)
		if err != nil {
			t.Error(err)
			return
		}
		defer socket.Close()
		close(connected)
		_, _, _ = socket.ReadMessage()
	}))
	defer server.Close()
	url := "ws" + strings.TrimPrefix(server.URL, "http")
	stream, err := (GatewayControlPlane{URL: url, BearerToken: "test-token"}).Connect(context.Background(), Hello{})
	if err != nil {
		t.Fatal(err)
	}
	defer stream.Close()
	<-connected
	ctx, cancel := context.WithCancel(context.Background())
	result := make(chan error, 1)
	go func() {
		_, err := stream.Receive(ctx)
		result <- err
	}()
	cancel()
	select {
	case err := <-result:
		if err == nil {
			t.Fatal("canceled receive returned without an error")
		}
	case <-time.After(time.Second):
		t.Fatal("canceled receive remained blocked on a silent Gateway")
	}
}

func TestGatewayControlPlaneRejectsMissingCredentialAndWrongScheme(t *testing.T) {
	if _, err := (GatewayControlPlane{URL: "ws://example.test"}).Connect(context.Background(), Hello{}); err == nil {
		t.Fatal("missing credential was accepted")
	}
	if _, err := (GatewayControlPlane{URL: "http://example.test", BearerToken: "token"}).Connect(context.Background(), Hello{}); err == nil {
		t.Fatal("http Gateway URL was accepted")
	}
}

func TestGatewayControlPlaneClassifiesAuthenticationRejection(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.WriteHeader(http.StatusUnauthorized)
	}))
	defer server.Close()
	url := "ws" + strings.TrimPrefix(server.URL, "http")
	_, err := (GatewayControlPlane{URL: url, BearerToken: "rejected"}).Connect(context.Background(), Hello{})
	var authenticationError *AuthenticationError
	if !errors.As(err, &authenticationError) || authenticationError.StatusCode != http.StatusUnauthorized {
		t.Fatalf("authentication rejection error = %v", err)
	}
}

func TestGatewayControlPlaneReportsRejectedUpgradeStatus(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.WriteHeader(http.StatusBadGateway)
	}))
	defer server.Close()
	url := "ws" + strings.TrimPrefix(server.URL, "http")
	_, err := (GatewayControlPlane{URL: url, BearerToken: "accepted"}).Connect(context.Background(), Hello{})
	var authenticationError *AuthenticationError
	if err == nil || errors.As(err, &authenticationError) || !errors.Is(err, websocket.ErrBadHandshake) || !strings.Contains(err.Error(), "HTTP 502") {
		t.Fatalf("rejected upgrade error = %v", err)
	}
}

func TestGatewayStreamClassifiesUpgradeRequiredClose(t *testing.T) {
	upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		socket, err := upgrader.Upgrade(writer, request, nil)
		if err != nil {
			t.Error(err)
			return
		}
		defer socket.Close()
		_ = socket.WriteControl(
			websocket.CloseMessage,
			websocket.FormatCloseMessage(websocket.ClosePolicyViolation, "upgrade_required: protocol 1.2"),
			time.Now().Add(time.Second),
		)
	}))
	defer server.Close()
	url := "ws" + strings.TrimPrefix(server.URL, "http")
	stream, err := (GatewayControlPlane{URL: url, BearerToken: "test-token"}).Connect(context.Background(), Hello{})
	if err != nil {
		t.Fatal(err)
	}
	defer stream.Close()
	_, err = stream.Receive(context.Background())
	var upgradeRequired *UpgradeRequiredError
	if !errors.As(err, &upgradeRequired) || upgradeRequired.Reason != "upgrade_required: protocol 1.2" {
		t.Fatalf("upgrade-required close error = %v", err)
	}
}

func TestGatewayStreamDecodesRuntimeRegistrationSnapshot(t *testing.T) {
	upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		socket, err := upgrader.Upgrade(writer, request, nil)
		if err != nil {
			t.Error(err)
			return
		}
		defer socket.Close()
		_ = socket.WriteJSON(map[string]any{
			"type": "runtime.registration.snapshot", "protocol_version": "2",
			"command_id": "snapshot-1", "runner_id": "computer-local", "connection_epoch": 3,
			"registrations": []any{map[string]any{
				"registration_id": "registration-codex",
				"observation": map[string]any{
					"tenant_id": "tenant-acme", "owner_actor_id": "actor-alice", "provider_type": "codex",
					"status": "online", "revision": 1, "capabilities": []string{"turn"},
					"runtime_diagnostics": map[string]any{"status": "ready"},
				},
			}},
		})
	}))
	defer server.Close()
	url := "ws" + strings.TrimPrefix(server.URL, "http")
	stream, err := (GatewayControlPlane{URL: url, BearerToken: "test-token"}).Connect(context.Background(), Hello{})
	if err != nil {
		t.Fatal(err)
	}
	defer stream.Close()
	command, err := stream.Receive(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	var registrations []RuntimeRegistration
	if err := json.Unmarshal(command.Payload, &registrations); err != nil {
		t.Fatal(err)
	}
	if command.ConnectionEpoch != 3 || len(registrations) != 1 || registrations[0].RegistrationID != "registration-codex" {
		t.Fatalf("decoded snapshot command=%+v registrations=%+v", command, registrations)
	}
}

func TestGatewayStreamEncodesStrictOperationEvent(t *testing.T) {
	upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	received := make(chan map[string]any, 1)
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		socket, err := upgrader.Upgrade(writer, request, nil)
		if err != nil {
			t.Error(err)
			return
		}
		defer socket.Close()
		var envelope map[string]any
		if err := socket.ReadJSON(&envelope); err == nil {
			received <- envelope
		}
	}))
	defer server.Close()
	url := "ws" + strings.TrimPrefix(server.URL, "http")
	stream, err := (GatewayControlPlane{URL: url, BearerToken: "test-token"}).Connect(context.Background(), Hello{RunnerID: "computer-local"})
	if err != nil {
		t.Fatal(err)
	}
	defer stream.Close()
	event := protocol.Event{
		Type: protocol.EventOperationEvent, ProtocolVersion: "2",
		HostAccess: "trusted",
		TenantID:   "tenant-acme", RunnerID: "computer-local", RegistrationID: "registration-codex",
		AssignmentRevision: 2, AgentID: "agent-reviewer", OperationID: "operation-1",
		ConnectionEpoch: 3, RunnerRevision: 4, Generation: 1, ExecutionLeaseID: "lease-1",
		WorkspaceGrantID: "grant-local", RuntimeType: "codex", Sequence: 5,
		ExecutionContextKey: "context-key", RuntimeInstanceID: "runtime-instance",
		Payload: json.RawMessage(`{"type":"message.delta","message_id":"message-1","delta":"hello"}`),
	}
	if err := stream.Send(context.Background(), event); err != nil {
		t.Fatal(err)
	}
	envelope := <-received
	if envelope["event"] == nil || envelope["registration_id"] != "registration-codex" || envelope["seq"] != float64(5) || envelope["host_access"] != "trusted" {
		t.Fatalf("unexpected Operation envelope: %+v", envelope)
	}
	if _, ok := envelope["payload"]; ok {
		t.Fatal("strict Operation envelope leaked local payload wrapper")
	}
	if _, ok := envelope["sent_at"]; ok {
		t.Fatal("strict Operation envelope leaked local timestamp")
	}
}

func TestGatewayStreamEncodesRuntimeDiagnosticsRevision(t *testing.T) {
	upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	received := make(chan map[string]any, 1)
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		socket, err := upgrader.Upgrade(writer, request, nil)
		if err != nil {
			t.Error(err)
			return
		}
		defer socket.Close()
		var envelope map[string]any
		if err := socket.ReadJSON(&envelope); err == nil {
			received <- envelope
		}
	}))
	defer server.Close()
	url := "ws" + strings.TrimPrefix(server.URL, "http")
	stream, err := (GatewayControlPlane{URL: url, BearerToken: "test-token"}).Connect(context.Background(), Hello{RunnerID: "computer-local"})
	if err != nil {
		t.Fatal(err)
	}
	defer stream.Close()
	checkedAt := "2026-09-01T00:00:15Z"
	diagnostics := json.RawMessage(`[{"type":"codex","status":"ready","protocol":"app-server","checked_at":"` + checkedAt + `"},{"type":"claude","status":"not_installed","protocol":"stream-json","checked_at":"` + checkedAt + `","error":{"code":"RUNTIME_NOT_INSTALLED","message":"missing"}},{"type":"pi","status":"not_installed","protocol":"rpc","checked_at":"` + checkedAt + `","error":{"code":"RUNTIME_NOT_INSTALLED","message":"missing"}}]`)
	if err := stream.Send(context.Background(), protocol.Event{
		Type: protocol.EventRuntimeDiagnostics, ProtocolVersion: "2", RunnerID: "computer-local",
		Revision: 2, SentAt: time.Date(2026, 9, 1, 0, 0, 15, 0, time.UTC), Payload: diagnostics,
	}); err != nil {
		t.Fatal(err)
	}
	envelope := <-received
	items, ok := envelope["runtime_diagnostics"].([]any)
	if envelope["type"] != protocol.EventRuntimeDiagnostics || envelope["revision"] != float64(2) || !ok || len(items) != 3 {
		t.Fatalf("Runtime diagnostics envelope = %+v", envelope)
	}
	if _, leaked := envelope["payload"]; leaked {
		t.Fatal("Runtime diagnostics envelope leaked local payload wrapper")
	}
}

func TestHelloCarriesDeviceIdentityWithoutCredential(t *testing.T) {
	device, err := GenerateIdentity()
	if err != nil {
		t.Fatal(err)
	}
	hello := Hello{Identity: device}
	if hello.Identity.DaemonID == "" || hello.Signature != nil {
		t.Fatalf("unexpected hello identity: %+v", hello)
	}
}

func TestRunnerHelloCarriesVerifiableDaemonIdentityProof(t *testing.T) {
	device, err := GenerateIdentity()
	if err != nil {
		t.Fatal(err)
	}
	hello := Hello{
		ProtocolVersion: "2", RunnerID: "computer-local",
		ConnectionNonce: "nonce-proof", Identity: device,
		SentAt:           time.Date(2026, 9, 2, 12, 0, 0, 0, time.UTC),
		ActiveOperations: json.RawMessage(`[{"operation_id":"operation-1"}]`),
	}
	hello.Signature, err = device.Sign(IdentityProofPayload(hello))
	if err != nil {
		t.Fatal(err)
	}
	wire, err := (&gatewayStream{hello: hello}).runnerHello()
	if err != nil {
		t.Fatal(err)
	}
	if wire.Platform != nativePlatform() {
		t.Fatalf("runner hello platform=%q", wire.Platform)
	}
	if wire.RunnerID != "computer-local" || wire.ConnectionNonce != "nonce-proof" || wire.DaemonIdentity.Proof == "" {
		t.Fatalf("unexpected runner hello: %+v", wire)
	}
	if len(wire.ActiveOperations) != 1 || wire.ActiveOperations[0].OperationID != "operation-1" {
		t.Fatalf("runner hello active Operations=%+v", wire.ActiveOperations)
	}
	proof, err := base64.StdEncoding.DecodeString(wire.DaemonIdentity.Proof)
	if err != nil || !device.Verify(IdentityProofPayload(hello), proof) {
		t.Fatal("runner hello daemon proof is not verifiable")
	}
}

func TestTerminalInputReceiptDoesNotExtendOperationSequence(t *testing.T) {
	value, err := replyMap(protocol.Event{Type: protocol.EventOperationInputClosed, CommandID: "input-1", OperationID: "op-1", Sequence: 99, Payload: json.RawMessage(`{"expected_turn_id":"turn-1","effect":"definitely_not_applied"}`)})
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := value["seq"]; ok {
		t.Fatalf("closed input advanced terminal sequence: %+v", value)
	}
	if value["command_id"] != "input-1" || value["expected_turn_id"] != "turn-1" || value["effect"] != "definitely_not_applied" {
		t.Fatalf("lost command receipt: %+v", value)
	}
}

func TestOperationEventForwardsPrepareResumeMeasurement(t *testing.T) {
	identity := protocol.Event{}
	if encoded := os.Getenv("LINGER_PREPARE_RESUME_WIRE_IDENTITY"); encoded != "" {
		if err := json.Unmarshal([]byte(encoded), &identity); err != nil {
			t.Fatal(err)
		}
	}
	var outcomes []map[string]any
	for _, eventType := range []string{protocol.EventOperationPrepared, protocol.EventOperationCompleted, protocol.EventOperationFailed, protocol.EventOperationCancelled} {
		t.Run(eventType, func(t *testing.T) {
			event := identity
			event.Type, event.Sequence = eventType, 2
			payload := map[string]any{
				"prepare_native_resume": native.NativeResumeMeasurement{DurationMs: 123, Result: "success"},
			}
			switch eventType {
			case protocol.EventOperationPrepared:
				payload["prepare_command_id"], payload["prepared"] = event.CommandID, true
				payload["duration_ms"], payload["outcome"] = 125, "ready"
			case protocol.EventOperationCompleted:
				payload["type"], payload["final_response"] = "run", "done"
				payload["session"] = map[string]any{"thread_id": "thread-1"}
			case protocol.EventOperationFailed:
				payload["code"], payload["message"], payload["retryable"] = "FAILED", "failed", false
			case protocol.EventOperationCancelled:
				payload["reason"] = "cancelled"
			}
			if eventType != protocol.EventOperationPrepared {
				payload["native_resume"] = native.NativeResumeMeasurement{DurationMs: 50, Result: "error"}
			}
			var err error
			event.Payload, err = json.Marshal(payload)
			if err != nil {
				t.Fatal(err)
			}
			wire, err := replyMap(event)
			if err != nil {
				t.Fatal(err)
			}
			target := wire
			if eventType == protocol.EventOperationCompleted {
				target = wire["result"].(map[string]any)
			}
			measurement, ok := target["prepare_native_resume"].(map[string]any)
			if !ok || measurement["duration_ms"] != float64(123) {
				t.Fatalf("measurement dropped: %v", wire)
			}
			if eventType == protocol.EventOperationFailed {
				if wire["error"].(map[string]any)["prepare_native_resume"] != nil {
					t.Fatal("measurement leaked into strict error payload")
				}
			}
			outcomes = append(outcomes, wire)
		})
	}
	// The TS regression consumes the production serializer's output directly.
	if target := os.Getenv("LINGER_PREPARE_RESUME_WIRE_FIXTURE"); target != "" {
		encoded, err := json.Marshal(outcomes)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(target, encoded, 0600); err != nil {
			t.Fatal(err)
		}
	}
}

func TestClassifyConnectionFailure(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want ConnectionFailure
	}{
		{"upgrade required", &UpgradeRequiredError{Reason: "upgrade_required: protocol"}, FailureIncompatible},
		{"schema rejected", &websocket.CloseError{Code: websocket.CloseProtocolError, Text: "Runner protocol violation"}, FailureIncompatible},
		{"credential revoked", fmt.Errorf("receive: %w", &websocket.CloseError{Code: websocket.ClosePolicyViolation, Text: "Runner credential revoked"}), FailureUnavailable},
		{"Gateway restarting", &websocket.CloseError{Code: websocket.CloseServiceRestart}, FailureUnavailable},
		{"connection dropped", &websocket.CloseError{Code: websocket.CloseAbnormalClosure}, FailureUnavailable},
		// The Gateway rejecting this daemon's own credential header or hello is
		// evidence against the release, not an outage.
		{"HTTP authentication", &AuthenticationError{StatusCode: http.StatusUnauthorized}, FailureOther},
		{"HTTP forbidden", &AuthenticationError{StatusCode: http.StatusForbidden}, FailureOther},
		{"credential scope violation", &websocket.CloseError{Code: websocket.ClosePolicyViolation, Text: "Runner credential scope violation"}, FailureOther},
		{"credential verification unavailable", &websocket.CloseError{Code: websocket.CloseInternalServerErr, Text: "Runner credential verification unavailable"}, FailureUnavailable},
		{"unreachable", &GatewayUnreachableError{Err: errors.New("connect Runner Gateway: no route to host")}, FailureUnavailable},
		{"network", &net.OpError{Op: "read", Err: errors.New("connection reset")}, FailureUnavailable},
		{"end of stream", fmt.Errorf("read: %w", io.ErrUnexpectedEOF), FailureUnavailable},
		{"internal error close", &websocket.CloseError{Code: websocket.CloseInternalServerErr}, FailureOther},
		{"decode", errors.New("decode Runner Gateway command: invalid character"), FailureOther},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := ClassifyConnectionFailure(tc.err); got != tc.want {
				t.Fatalf("ClassifyConnectionFailure() = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestConnectReportsUnreachableGateway(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
	}))
	defer server.Close()
	_, err := GatewayControlPlane{URL: "ws" + strings.TrimPrefix(server.URL, "http"), BearerToken: "token"}.Connect(context.Background(), Hello{})
	var unreachable *GatewayUnreachableError
	if !errors.As(err, &unreachable) || !strings.Contains(err.Error(), "HTTP 502") {
		t.Fatalf("error = %v, want unreachable HTTP 502", err)
	}
}
