package daemon

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/transport"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider/native"
)

// Exercise runConnection -> Executor -> ledger -> real WebSocket serialization.
// The same envelope is consumed by Agent parser/logging tests.
func TestFailureDiagnosticsReachTheWireAndReplay(t *testing.T) {
	data, err := os.ReadFile("../../../../../contracts/runner-gateway/fixtures/failure-diagnostics.json")
	if err != nil {
		t.Fatal(err)
	}
	device, err := transport.GenerateIdentity()
	if err != nil {
		t.Fatal(err)
	}
	var executions atomic.Int32
	d, err := newTestDaemon(t, Options{ComputerID: "computer-1", ControlPlane: fakeControlPlane{}, IdentityStore: fakeStore{value: device}, OperationResolver: fakeOperationResolver{}, Executor: provider.Executor{NewBackend: func(string, native.Profile) (native.Runtime, error) {
		executions.Add(1)
		messages := make(chan native.Event)
		close(messages)
		results := make(chan native.Outcome, 1)
		results <- native.Outcome{Status: "failed", Diagnostics: native.RuntimeFailureDiagnostics{Code: "httpConnectionFailed", StatusCode: new(429), ExitCode: new(3), Signal: "SIGSEGV"}}
		close(results)
		return fakeBackend{session: &native.Run{Events: messages, Outcome: results}}, nil
	}}})
	if err != nil {
		t.Fatal(err)
	}
	d.daemonID = device.DaemonID
	for connection := range 2 {
		var expected map[string]any
		if err := json.Unmarshal(data, &expected); err != nil {
			t.Fatal(err)
		}
		start := make(map[string]any)
		for key, value := range expected {
			start[key] = value
		}
		delete(start, "error")
		delete(start, "seq")
		delete(start, "stage")
		start["type"], start["command_id"] = "operation.start", "start-diag"
		start["request"] = map[string]any{"kind": "run.start", "runtime": map[string]any{"type": "codex"}, "input": map[string]any{"type": "text", "text": "hello"}}
		expected["error"].(map[string]any)["message"] = "codex process exited"
		peerDone := make(chan error, 1)
		server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
			peerDone <- func() error {
				upgrader := websocket.Upgrader{}
				peer, err := upgrader.Upgrade(writer, request, nil)
				if err != nil {
					return err
				}
				defer peer.Close()
				_ = peer.SetReadDeadline(time.Now().Add(10 * time.Second))
				var hello map[string]any
				if err := peer.ReadJSON(&hello); err != nil {
					return err
				}
				welcome := map[string]any{
					"type": "runner.welcome", "protocol_version": "2", "runner_id": "computer-1", "connection_id": "connection-1",
					"connection_epoch": 7 + connection, "heartbeat_interval_ms": 30_000, "reconcile_operation_ids": []string{"op-diag"},
				}
				if err := peer.WriteJSON(welcome); err != nil {
					return err
				}
				if connection == 0 {
					if err := peer.WriteJSON(start); err != nil {
						return err
					}
				}
				// First connection also repeats the original start to exercise ledger replay.
				terminals := 1
				if connection == 0 {
					terminals = 2
				}
				for received := 0; received < terminals; {
					var envelope map[string]any
					if err := peer.ReadJSON(&envelope); err != nil {
						return err
					}
					if envelope["type"] != "operation.failed" {
						continue
					}
					if !reflect.DeepEqual(envelope, expected) {
						return fmt.Errorf("connection %d\nactual=%s\nfixture=%s", connection, mustJSON(envelope), mustJSON(expected))
					}
					received++
					if received < terminals {
						if err := peer.WriteJSON(start); err != nil {
							return err
						}
					}
				}
				return nil
			}()
		}))
		d.controlPlane = transport.GatewayControlPlane{URL: "ws" + strings.TrimPrefix(server.URL, "http"), BearerToken: "fixture-token"}
		_ = d.runConnection(context.Background(), device) // Peer closes after the expected terminal(s).
		d.WaitForOperations()
		peerErr := <-peerDone
		server.Close()
		if peerErr != nil {
			t.Fatal(peerErr)
		}
	}
	if executions.Load() != 1 {
		t.Fatalf("replay executed provider %d times", executions.Load())
	}
}
