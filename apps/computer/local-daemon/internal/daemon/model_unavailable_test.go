package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"testing"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/transport"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/protocol"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider/native"
)

type modelOperationResolver struct{ fakeOperationResolver }

func (r modelOperationResolver) Resolve(ctx context.Context, command protocol.Command, request json.RawMessage) (provider.OperationSpec, error) {
	spec, err := r.fakeOperationResolver.Resolve(ctx, command, request)
	spec.Model = "gpt-pro-only"
	return spec, err
}

// A Run whose Runtime reported the model unavailable reports its model, so
// the Computer stops offering it in the model picker.
func TestDaemonReportsAModelTheLoginRefused(t *testing.T) {
	for _, tc := range []struct {
		name    string
		outcome native.Outcome
		want    []string
	}{
		{"refused", native.Outcome{Status: "failed", Error: "model refused", FailureCode: "model_unavailable"}, []string{"codex", "gpt-pro-only"}},
		{"other failure", native.Outcome{Status: "failed", Error: "model refused", Diagnostics: native.RuntimeFailureDiagnostics{Code: "unauthorized"}}, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			device, err := transport.GenerateIdentity()
			if err != nil {
				t.Fatal(err)
			}
			messages := make(chan native.Event)
			results := make(chan native.Outcome, 1)
			close(messages)
			results <- tc.outcome
			close(results)
			payload := mustJSON(map[string]any{
				"kind": "run.start", "runtime": map[string]any{"type": "codex"},
				"input": map[string]any{"type": "text", "text": "hello"},
			})
			stream := &fakeStream{commands: []protocol.Command{
				{Type: "runner.welcome", ConnectionEpoch: 7},
				{Type: protocol.CommandRegistrationSnapshot, CommandID: "registration-snapshot-1", ConnectionEpoch: 7,
					Payload: mustJSON([]transport.RuntimeRegistration{{
						RegistrationID: "reg-1",
						Observation: transport.RegistrationObservation{
							TenantID: "tenant-1", OwnerActorID: "owner-1", ProviderType: "codex",
							Status: "online", Revision: 1, Capabilities: []string{"turn"},
						},
					}})},
				{Type: protocol.CommandOperationStart, CommandID: "cmd-123",
					ProtocolVersion: "1.2", TenantID: "tenant-1", RunnerID: "computer-1", RegistrationID: "reg-1", AssignmentRevision: 1,
					AgentID: "agent-1", OperationID: "op-1", ConnectionEpoch: 7, Payload: payload,
					RunnerRevision: 1, Generation: 1, ExecutionLeaseID: "lease-1", WorkspaceGrantID: "grant-1", RuntimeType: "codex",
					ExecutionContextKey: "context-1", RuntimeInstanceID: "runtime-1", ContextViewRef: testContextViewRef,
				},
			}}
			var reported []string
			daemon, err := newTestDaemon(t, Options{
				ComputerID:        "computer-1",
				OperationResolver: modelOperationResolver{},
				ControlPlane:      fakeControlPlane{stream: stream},
				IdentityStore:     fakeStore{value: device},
				Executor: provider.Executor{NewBackend: func(string, native.Profile) (native.Runtime, error) {
					return fakeBackend{session: &native.Run{Events: messages, Outcome: results}}, nil
				}},
				OnModelUnavailable: func(runtimeType, modelID string) { reported = append(reported, runtimeType, modelID) },
			})
			if err != nil {
				t.Fatal(err)
			}
			daemon.daemonID = device.DaemonID
			if err := daemon.runConnection(context.Background(), device); !errors.Is(err, io.EOF) {
				t.Fatalf("Run() error = %v, want EOF from fake stream", err)
			}
			waitForEvents(t, stream, 4)
			events := stream.snapshotEvents()
			if events[len(events)-1].Type != protocol.EventOperationFailed {
				t.Fatalf("terminal = %s, want failed", events[len(events)-1].Type)
			}
			if len(reported) != len(tc.want) || (len(tc.want) > 0 && (reported[0] != tc.want[0] || reported[1] != tc.want[1])) {
				t.Fatalf("reported = %v, want %v", reported, tc.want)
			}
		})
	}
}
