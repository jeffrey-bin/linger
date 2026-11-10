package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"testing"

	lingercontext "github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/context"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/registration"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/transport"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/protocol"
)

func TestOperationStartPrepareWaitDoesNotBlockGatewayCancel(t *testing.T) {
	backend := &prepareBackend{prepareStarted: make(chan struct{}), blockPrepare: true}
	d, _, prepare := prepareDaemonFixture(t, backend)
	if err := d.handleOperationPrepare(t.Context(), &fakeStream{}, prepare); err != nil {
		t.Fatal(err)
	}
	<-backend.prepareStarted
	cancel := prepare
	cancel.Type = protocol.CommandOperationCancel
	stream := &fakeStream{commands: []protocol.Command{
		{Type: "runner.welcome", ConnectionEpoch: 1},
		{Type: "runner.reconciled", ConnectionEpoch: 1, RunnerID: prepare.RunnerID},
		startFromPrepare(prepare), cancel,
	}}
	d.controlPlane = fakeControlPlane{stream: stream}
	stream.idle = dispatchIdle(d)
	device, err := transport.GenerateIdentity()
	if err != nil {
		t.Fatal(err)
	}
	if err = d.runConnection(t.Context(), device); !errors.Is(err, io.EOF) {
		t.Fatal(err)
	}
	d.WaitForOperations()
	if got := len(backend.snapshot()); got != 1 {
		t.Fatalf("Gateway cancellation arrived after %d provider executions", got)
	}
	events, err := d.ledger.Replay(t.Context(), []string{prepare.OperationID})
	if err != nil || len(events) != 2 || events[1].Type != protocol.EventOperationCancelled {
		t.Fatalf("pending cancellation was not durably recorded: events=%+v err=%v", events, err)
	}
}

func TestOperationStartAdoptedPrepareSurvivesConnectionEndAndReplay(t *testing.T) {
	release := make(chan struct{})
	backend := &prepareBackend{prepareStarted: make(chan struct{}), blockPrepare: true, prepareRelease: release}
	d, stream, prepare := prepareDaemonFixture(t, backend)
	connectionCtx, disconnect := context.WithCancel(t.Context())
	defer disconnect()
	if err := d.handleOperationPrepare(connectionCtx, stream, prepare); err != nil {
		t.Fatal(err)
	}
	<-backend.prepareStarted
	start := startFromPrepare(prepare)
	if err := d.handleOperationStart(t.Context(), stream, start); err != nil {
		t.Fatal(err)
	}
	disconnect()
	d.cancelPreparedOperations("")
	if err := d.handleOperationStart(t.Context(), stream, start); err != nil {
		t.Fatal(err)
	}
	close(release)
	d.WaitForOperations()
	options := backend.snapshot()
	if len(options) != 2 || string(options[0].MCPServers) != string(options[1].MCPServers) {
		t.Fatalf("accepted connection replacement lost or duplicated preparation: %+v", options)
	}
	events := stream.snapshotEvents()
	if events[len(events)-1].Type != protocol.EventOperationCompleted {
		t.Fatalf("adopted operation failed: %+v", events)
	}
}

func TestOperationPrepareReleasesConnectionCallbackAfterFailureOrCancel(t *testing.T) {
	for _, failure := range []string{"provider_failure", "cancel"} {
		t.Run(failure, func(t *testing.T) {
			release := make(chan struct{})
			backend := &prepareBackend{prepareStarted: make(chan struct{}), blockPrepare: true, prepareRelease: release, prepareErr: errors.New("fixture preparation failed")}
			d, stream, prepare := prepareDaemonFixture(t, backend)
			connectionCtx, disconnect := context.WithCancel(t.Context())
			defer disconnect()
			if err := d.handleOperationPrepare(connectionCtx, stream, prepare); err != nil {
				t.Fatal(err)
			}
			<-backend.prepareStarted
			d.preparationMu.Lock()
			prepared := d.preparedOperations[prepare.OperationID]
			d.preparationMu.Unlock()
			if failure == "cancel" {
				if err := d.cancelPreparedOperation(prepare); err != nil {
					t.Fatal(err)
				}
			} else {
				close(release)
			}
			d.WaitForOperations()
			if prepared.stopConnection() {
				t.Fatal("finished preparation retained its callback on the live Gateway connection")
			}
		})
	}
}

func TestOperationStartAdoptedPreparationCountsCapacityOnce(t *testing.T) {
	backend := &prepareBackend{prepareStarted: make(chan struct{}), blockPrepare: true}
	d, stream, prepare := prepareDaemonFixture(t, backend)
	capacity := 2
	d.capacity = &capacity
	if err := d.handleOperationPrepare(t.Context(), stream, prepare); err != nil {
		t.Fatal(err)
	}
	<-backend.prepareStarted
	if err := d.handleOperationStart(t.Context(), stream, startFromPrepare(prepare)); err != nil {
		t.Fatal(err)
	}
	other := startFromPrepare(prepareCommand("other-context"))
	other.ExecutionContextKey, other.RuntimeInstanceID = "context-2", "runtime-2"
	if err := d.handleOperationStart(t.Context(), stream, other); err != nil {
		t.Fatal(err)
	}
	if err := d.handleOperationCancel(prepare); err != nil {
		t.Fatal(err)
	}
	d.WaitForOperations()
	if got := len(backend.snapshot()); got != 2 {
		t.Fatalf("adopted future consumed capacity twice: executions=%d", got)
	}
}

func TestOperationStartOfAnEarlierEpochIsNeverExecuted(t *testing.T) {
	for _, scenario := range []struct {
		name, code    string
		seenByProcess bool
		retryable     bool
	}{
		// The start was sent to a previous Daemon process, which may have run it.
		{name: "earlier_process", code: "DAEMON_RESTARTED"},
		// This process was welcomed on that epoch and never admitted the start.
		{name: "this_process", code: "EXECUTION_NOT_ADMITTED", seenByProcess: true, retryable: true},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			backend := &prepareBackend{}
			d, stream, _ := prepareDaemonFixture(t, backend)
			start := startFromPrepare(prepareCommand("start-" + scenario.name))
			if scenario.seenByProcess {
				d.recordWelcomedEpoch(start.ConnectionEpoch)
			}
			d.welcomeSeen = true
			d.connectionEpoch = start.ConnectionEpoch + 1
			d.recordWelcomedEpoch(d.connectionEpoch)
			for range 2 {
				if err := d.handleOperationStart(t.Context(), stream, start); err != nil {
					t.Fatal(err)
				}
			}
			d.WaitForOperations()
			if len(backend.snapshot()) != 0 {
				t.Fatal("a start of an earlier epoch was executed")
			}
			events := stream.snapshotEvents()
			if len(events) != 2 || events[1].Sequence != events[0].Sequence {
				t.Fatalf("the repeated start did not replay the same terminal: %+v", events)
			}
			var failure struct {
				Code      string `json:"code"`
				Retryable bool   `json:"retryable"`
			}
			if events[0].Type != protocol.EventOperationFailed || json.Unmarshal(events[0].Payload, &failure) != nil ||
				failure.Code != scenario.code || failure.Retryable != scenario.retryable {
				t.Fatalf("terminal=%+v", events[0])
			}
		})
	}
}

func TestOperationStartPrepareWaitRevalidatesPublishedAuthority(t *testing.T) {
	for _, change := range []string{"none", "registration_unavailable"} {
		t.Run(change, func(t *testing.T) {
			release := make(chan struct{})
			backend := &prepareBackend{prepareStarted: make(chan struct{}), blockPrepare: true, prepareRelease: release}
			d, stream, prepare := prepareDaemonFixture(t, backend)
			relays := d.operationResolver.(prepareOperationResolver).relays
			views, ref := readyTestContextView(t, prepare)
			ready, err := views.CurrentView(t.Context(), prepare.ExecutionContextKey, "")
			if err != nil {
				t.Fatal(err)
			}
			d.contextViews = views
			observation := registration.Observation{RegistrationID: prepare.RegistrationID, Revision: 1, Status: registration.StatusOnline,
				Key: registration.Key{DaemonID: "daemon-1", TenantID: prepare.TenantID, OwnerActorID: "owner-1", ProviderType: "codex"}}
			if _, err = d.registrations.Apply(t.Context(), observation); err != nil {
				t.Fatal(err)
			}
			d.operationResolver = lingercontext.ExecutionResolver{
				Views: views, Providers: map[string]lingercontext.ProviderInstallation{"codex": {Type: "codex", ExecutablePath: "/bin/codex", Version: "0.155.1"}},
				WorkspaceGrants: map[string]lingercontext.WorkspaceGrant{prepare.WorkspaceGrantID: {GrantID: prepare.WorkspaceGrantID, TenantID: prepare.TenantID, Path: ready.WorkspacePath}},
				RegistrationLookup: func(ctx context.Context, id string) (lingercontext.RegistrationBinding, bool, error) {
					items, err := d.registrations.List(ctx)
					for _, item := range items {
						if item.RegistrationID == id {
							return lingercontext.RegistrationBinding{RegistrationID: id, TenantID: item.Key.TenantID, OwnerActorID: item.Key.OwnerActorID, ProviderType: item.Key.ProviderType, Status: item.Status}, true, err
						}
					}
					return lingercontext.RegistrationBinding{}, false, err
				},
			}
			prepare.ContextViewRef = ref
			prepare.Payload = mustJSON(map[string]any{"kind": "run.start", "runtime": map[string]string{"type": "codex"}, "session": map[string]string{"threadId": "thread-1"}, "run_resources": map[string]json.RawMessage{"mcp_servers": relays}})
			if err = d.handleOperationPrepare(t.Context(), stream, prepare); err != nil {
				t.Fatal(err)
			}
			<-backend.prepareStarted
			start := prepare
			start.Type, start.CommandID = protocol.CommandOperationStart, "start"
			if err = d.handleOperationStart(t.Context(), stream, start); err != nil {
				t.Fatal(err)
			}
			if change == "registration_unavailable" {
				observation.Revision, observation.Status = 2, registration.StatusUnavailable
				if _, err = d.registrations.Apply(t.Context(), observation); err != nil {
					t.Fatal(err)
				}
			}
			close(release)
			d.WaitForOperations()
			want := 1
			if change == "none" {
				want = 2
			}
			if got := len(backend.snapshot()); got != want {
				t.Fatalf("provider executions=%d want=%d after %s", got, want, change)
			}
		})
	}
}
