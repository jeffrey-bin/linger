package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/assignment"
	lingercontext "github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/context"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/registration"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/transport"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/protocol"
)

func TestReconnectHelloCarriesTheProcessRegistrationsAndRunners(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	device, err := transport.GenerateIdentity()
	if err != nil {
		t.Fatal(err)
	}
	store := registration.NewMemoryStore()
	for _, runtime := range []string{"codex", "claude", "pi"} {
		_, err := store.Apply(ctx, registration.Observation{
			RegistrationID: "registration-" + runtime,
			Key: registration.Key{
				DaemonID: device.DaemonID, TenantID: "tenant-1", OwnerActorID: "owner-1", ProviderType: runtime,
			},
			Status: registration.StatusUnavailable, Revision: 97, Capabilities: []string{},
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	before, err := store.List(ctx)
	if err != nil {
		t.Fatal(err)
	}

	assignments := assignment.NewMemoryStore()
	_, err = assignments.Apply(ctx, assignment.Command{
		Type: "agent_runner.ensure", CommandID: "ensure-1", RunnerID: "computer-1",
		TenantID: "tenant-1", AgentID: "agent-1", RegistrationID: "registration-codex",
		AssignmentRevision: 4, RunnerRevision: 7, Runtime: json.RawMessage(`{"type":"codex"}`), WorkspaceGrantID: "grant-1",
	}, 123)
	if err != nil {
		t.Fatal(err)
	}
	assignmentsBefore, err := assignments.List(ctx)
	if err != nil {
		t.Fatal(err)
	}

	frames := make(chan []byte, 1)
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		peer, err := (&websocket.Upgrader{}).Upgrade(writer, request, nil)
		if err != nil {
			t.Error(err)
			return
		}
		defer peer.Close()
		if err := peer.SetReadDeadline(time.Now().Add(5 * time.Second)); err != nil {
			t.Error(err)
			return
		}
		_, raw, err := peer.ReadMessage()
		if err != nil {
			t.Error(err)
			return
		}
		frames <- raw
		if err := peer.WriteMessage(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseNormalClosure, "fixture captured hello")); err != nil {
			t.Error(err)
		}
	}))
	defer server.Close()

	for attempt := range 2 {
		// Each attempt is a reconnect of one Daemon process: its stores stay.
		d, err := newTestDaemon(t, Options{
			ComputerID: "computer-1", IdentityStore: fakeStore{value: device},
			ControlPlane:      transport.GatewayControlPlane{URL: "ws" + strings.TrimPrefix(server.URL, "http"), BearerToken: "fixture-token"},
			OperationResolver: fakeOperationResolver{}, Registrations: store, Assignments: assignments,
			Runtimes:           []string{"codex"},
			RuntimeDiagnostics: json.RawMessage(`[{"type":"codex","status":"ready","protocol":"app-server","checked_at":"2026-10-15T00:00:00Z"},{"type":"claude","status":"not_installed","protocol":"stream-json","checked_at":"2026-10-15T00:00:00Z"},{"type":"pi","status":"not_installed","protocol":"rpc","checked_at":"2026-10-15T00:00:00Z"}]`),
			WorkspaceGrants:    json.RawMessage(`[{"grant_id":"grant-1","tenant_id":"tenant-1","mode":"workspace-write","scope":"owner"}]`),
			RuntimeObservations: []transport.RegistrationObservation{{
				TenantID: "tenant-1", OwnerActorID: "owner-1", ProviderType: "codex", Status: "online",
				Revision: 1, Capabilities: []string{"turn"}, RuntimeDiagnostics: json.RawMessage(`{}`),
			}},
		})
		if err != nil {
			t.Fatal(err)
		}
		if err := d.runConnection(ctx, device); !websocket.IsCloseError(err, websocket.CloseNormalClosure) {
			t.Fatalf("reconnect %d did not reach the wire peer: %v", attempt, err)
		}
		raw := <-frames
		// Retain the actual Go wire frame in verbose output for strict schema probes.
		t.Logf("registration-upgrade-wire: %s", raw)
		var hello struct {
			Registrations []transport.RegistrationObservation `json:"runtime_registrations"`
			Runners       []assignment.Record                 `json:"agent_runners"`
		}
		if err := json.Unmarshal(raw, &hello); err != nil {
			t.Fatal(err)
		}
		providers := make([]string, len(hello.Registrations))
		for i, observation := range hello.Registrations {
			providers[i] = observation.ProviderType
			if observation.ProviderType == "codex" && (observation.Status != "online" || observation.Revision != 98) {
				t.Fatalf("fresh supported probe lost: %+v", observation)
			}
		}
		if !reflect.DeepEqual(providers, []string{"claude", "codex", "pi"}) {
			t.Fatalf("a Runtime this Computer does not offer entered Hello: %v", providers)
		}
		// Private command digests are intentionally omitted by the wire encoder.
		expected, err := json.Marshal(assignmentsBefore)
		if err != nil {
			t.Fatal(err)
		}
		actual, err := json.Marshal(hello.Runners)
		if err != nil || string(expected) != string(actual) {
			t.Fatalf("retained assignments changed on wire: %s != %s err=%v", actual, expected, err)
		}
		after, err := store.List(ctx)
		if err != nil || !reflect.DeepEqual(before, after) {
			t.Fatalf("registrations changed across the reconnect: %+v err=%v", after, err)
		}
		assignmentsAfter, err := assignments.List(ctx)
		if err != nil || !reflect.DeepEqual(assignmentsBefore, assignmentsAfter) {
			t.Fatalf("assignment changed across the reconnect: %+v err=%v", assignmentsAfter, err)
		}
	}
}

func TestReconnectUsesCurrentProbeBeyondRetainedRevision(t *testing.T) {
	for _, status := range []string{"online", "unavailable"} {
		t.Run(status, func(t *testing.T) {
			fresh := transport.RegistrationObservation{TenantID: "tenant", OwnerActorID: "owner", ProviderType: "codex", Status: status, Revision: 30, Capabilities: []string{"turn"}, RuntimeDiagnostics: json.RawMessage(`{"status":"ready"}`)}
			retained := fresh
			retained.Status = "offline"
			retained.Revision = 189
			retained.RuntimeDiagnostics = json.RawMessage(`{}`)
			for _, revision := range []uint64{189, 190, 500} {
				retained.Revision = revision
				got := mergeRegistrationObservations([]transport.RegistrationObservation{fresh}, []transport.RegistrationObservation{retained})
				if len(got) != 1 || got[0].Status != status || got[0].Revision <= revision || string(got[0].RuntimeDiagnostics) != string(fresh.RuntimeDiagnostics) {
					t.Fatalf("fresh probe lost at revision %d: %+v", revision, got)
				}
			}
		})
	}
}

func TestUnavailableRunnerDoesNotDisconnectAndRecoversOnSameConnection(t *testing.T) {
	device, err := transport.GenerateIdentity()
	if err != nil {
		t.Fatal(err)
	}
	registrations := newTestRegistrations(t)
	assignments := newTestAssignments(t)
	resolver := lingercontext.ExecutionResolver{
		RegistrationLookup: func(ctx context.Context, id string) (lingercontext.RegistrationBinding, bool, error) {
			items, err := registrations.List(ctx)
			for _, item := range items {
				if item.RegistrationID == id {
					return lingercontext.RegistrationBinding{RegistrationID: id, TenantID: item.Key.TenantID, OwnerActorID: item.Key.OwnerActorID, ProviderType: item.Key.ProviderType, Status: item.Status}, true, err
				}
			}
			return lingercontext.RegistrationBinding{}, false, err
		},
		Providers:       map[string]lingercontext.ProviderInstallation{"codex": {Type: "codex", ExecutablePath: "/bin/codex"}},
		WorkspaceGrants: map[string]lingercontext.WorkspaceGrant{"grant-1": {TenantID: "tenant-1", Path: t.TempDir()}},
	}
	snapshot := func(status string, revision uint64) protocol.Command {
		return protocol.Command{Type: protocol.CommandRegistrationSnapshot, CommandID: status, ConnectionEpoch: 1, Payload: mustJSON([]transport.RuntimeRegistration{{RegistrationID: "registration-1", Observation: transport.RegistrationObservation{TenantID: "tenant-1", OwnerActorID: "owner-1", ProviderType: "codex", Status: status, Revision: revision, Capabilities: []string{"turn"}}}})}
	}
	first := daemonAgentRunnerCommand(protocol.CommandAgentRunnerEnsure, 1)
	second := daemonAgentRunnerCommand(protocol.CommandAgentRunnerEnsure, 2)
	second.CommandID = "retry-ensure"
	stream := &fakeStream{commands: []protocol.Command{{Type: "runner.welcome", ConnectionEpoch: 1}, snapshot("unavailable", 188), first, snapshot("online", 189), second, {Type: "runner.reconciled", RunnerID: "computer-1", ConnectionEpoch: 1}}}
	d, err := newTestDaemon(t, Options{ComputerID: "computer-1", ControlPlane: fakeControlPlane{stream: stream}, IdentityStore: fakeStore{value: device}, OperationResolver: resolver, Registrations: registrations, Assignments: assignments})
	if err != nil {
		t.Fatal(err)
	}
	d.daemonID = device.DaemonID
	if err = d.runConnection(context.Background(), device); !errors.Is(err, io.EOF) {
		t.Fatalf("runner failure terminated connection: %v", err)
	}
	if !d.Reconciled() {
		t.Fatal("Computer never reconciled")
	}
	var failed, ready bool
	for _, event := range stream.events {
		if event.CommandID == first.CommandID && event.Type == protocol.EventAgentRunnerFailed {
			failed = event.AgentID == first.AgentID && event.RegistrationID == first.RegistrationID && event.RunnerRevision == first.RunnerRevision
		}
		if event.CommandID == second.CommandID && event.Type == protocol.EventAgentRunnerReady {
			ready = true
		}
	}
	if !failed || !ready {
		t.Fatalf("missing scoped failure/recovery: %+v", stream.events)
	}
	records, err := assignments.List(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(records) != 1 || records[0].RunnerRevision != 2 || records[0].State != "ready" {
		t.Fatalf("unexpected assignments: %+v", records)
	}
}
