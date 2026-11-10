package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/assignment"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/mcpproxy"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/protocol"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider/native"
)

// blockingBinder holds Bind for one Operation until released or until its
// context ends, standing in for a slow tool catalog discovery.
type blockingBinder struct {
	operationID string
	bound       chan *mcpproxy.Set
	release     <-chan struct{}
	err         error
}

func (b *blockingBinder) Bind(ctx context.Context, _ provider.OperationSpec, identity mcpproxy.OperationIdentity, set *mcpproxy.Set) error {
	if identity.OperationID != b.operationID {
		return nil
	}
	b.bound <- set
	select {
	case <-b.release:
		return b.err
	case <-ctx.Done():
		return context.Cause(ctx)
	}
}

func newBlockingBinder(operationID string, release <-chan struct{}) *blockingBinder {
	return &blockingBinder{operationID: operationID, bound: make(chan *mcpproxy.Set, 1), release: release}
}

// acceptedStartDaemon builds a Daemon whose Providers signal on started and
// hold until providerRelease closes. MCP opening is stubbed, so only the binder blocks.
func acceptedStartDaemon(t *testing.T, binder LocalToolBinder, started chan<- struct{}, providerRelease <-chan struct{}) (*Daemon, *fakeStream) {
	t.Helper()
	stream := &fakeStream{}
	d, err := newTestDaemon(t, Options{
		ComputerID: "computer-1", ControlPlane: fakeControlPlane{stream: stream}, IdentityStore: fakeStore{},
		OperationResolver: fakeOperationResolver{},
		Executor: provider.Executor{NewBackend: func(string, native.Profile) (native.Runtime, error) {
			started <- struct{}{}
			return heldBackend{release: providerRelease}, nil
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	d.localTools = binder
	d.openMCPProxies = func(context.Context, json.RawMessage, mcpproxy.OperationIdentity) (*mcpproxy.Set, error) {
		return &mcpproxy.Set{}, nil
	}
	d.operationStream = stream
	return d, stream
}

func awaitAcceptedOperationEvent(t *testing.T, stream *fakeStream, operationID, eventType string) protocol.Event {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for {
		for _, event := range stream.snapshotEvents() {
			if event.OperationID == operationID && event.Type == eventType {
				return event
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("%s for %s was not delivered: %+v", eventType, operationID, stream.snapshotEvents())
		}
		time.Sleep(time.Millisecond)
	}
}

func awaitBound(t *testing.T, binder *blockingBinder) *mcpproxy.Set {
	t.Helper()
	select {
	case set := <-binder.bound:
		return set
	case <-time.After(2 * time.Second):
		t.Fatal("MCP preparation did not start")
	}
	return nil
}

func assertNoProviderStart(t *testing.T, started <-chan struct{}) {
	t.Helper()
	select {
	case <-started:
		t.Fatal("Provider started for an Operation that must not start")
	default:
	}
}

// Accepted is sent and other Contexts keep admitting while one Operation's MCP
// preparation is still blocked.
func TestOperationStartAdmissionIsNotBlockedBySlowMCPPreparation(t *testing.T) {
	bindRelease, providerRelease := make(chan struct{}), make(chan struct{})
	started := make(chan struct{}, 8)
	binder := newBlockingBinder("operation-slow", bindRelease)
	d, stream := acceptedStartDaemon(t, binder, started, providerRelease)
	slow := daemonOperationStart("operation-slow", "agent-1")
	slow.ExecutionContextKey = "room:a"
	fast := daemonOperationStart("operation-fast", "agent-1")
	fast.ExecutionContextKey = "room:b"

	admitted := make(chan error, 1)
	go func() { admitted <- d.handleOperationStart(context.Background(), stream, slow) }()
	select {
	case err := <-admitted:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("admission blocked behind MCP preparation")
	}
	awaitBound(t, binder)
	awaitAcceptedOperationEvent(t, stream, slow.OperationID, protocol.EventOperationAccepted)

	if err := d.handleOperationStart(context.Background(), stream, fast); err != nil {
		t.Fatal(err)
	}
	awaitProviderStarts(t, started, 1)
	drained := make(chan int, 1)
	go func() { drained <- d.DrainIfIdle() }()
	select {
	case active := <-drained:
		if active <= 0 {
			t.Fatalf("DrainIfIdle=%d while an Operation is preparing, want busy", active)
		}
	case <-time.After(time.Second):
		t.Fatal("DrainIfIdle waited for MCP preparation")
	}

	close(bindRelease)
	awaitProviderStarts(t, started, 1)
	close(providerRelease)
	d.WaitForOperations()
	awaitAcceptedOperationEvent(t, stream, slow.OperationID, protocol.EventOperationCompleted)
	awaitAcceptedOperationEvent(t, stream, fast.OperationID, protocol.EventOperationCompleted)
}

// A failure after accepted ends the Operation through its terminal, closes the
// MCP proxies, releases the slot, and never starts the Provider.
func TestOperationStartMCPFailureAfterAcceptedFailsWithoutStart(t *testing.T) {
	providerRelease := make(chan struct{})
	started := make(chan struct{}, 8)
	bindRelease := make(chan struct{})
	binder := newBlockingBinder("operation-mcp-failure", bindRelease)
	binder.err = errors.New("tool catalog failed")
	close(bindRelease)
	d, stream := acceptedStartDaemon(t, binder, started, providerRelease)
	relays := mustJSON([]map[string]any{{
		"name": "teamhub", "relay_url": "http://127.0.0.1:1", "relay_token": strings.Repeat("secret", 6),
		"tool_names": []string{"materialize_artifact"}, "expires_at": time.Now().Add(time.Minute),
	}})
	d.openMCPProxies = mcpproxy.Open
	d.operationResolver = mcpOperationResolver{relays: relays}
	start := daemonOperationStart("operation-mcp-failure", "agent-1")
	if err := d.handleOperationStart(context.Background(), stream, start); err != nil {
		t.Fatal(err)
	}
	set := awaitBound(t, binder)
	var config struct {
		Servers map[string]struct {
			URL string `json:"url"`
		} `json:"mcpServers"`
	}
	if err := json.Unmarshal(set.Config(), &config); err != nil || config.Servers["teamhub"].URL == "" {
		t.Fatalf("MCP config=%s err=%v", set.Config(), err)
	}
	awaitAcceptedOperationEvent(t, stream, start.OperationID, protocol.EventOperationAccepted)
	failed := awaitAcceptedOperationEvent(t, stream, start.OperationID, protocol.EventOperationFailed)
	if !strings.Contains(string(failed.Payload), "RUNTIME_EXECUTION_FAILED") {
		t.Fatalf("failure payload=%s", failed.Payload)
	}
	d.WaitForOperations()
	if active := d.ActiveOperationCount(); active != 0 {
		t.Fatalf("active Operations after failure=%d, want 0", active)
	}
	assertNoProviderStart(t, started)
	deadline := time.Now().Add(time.Second)
	for {
		response, err := http.Get(config.Servers["teamhub"].URL)
		if err != nil {
			break
		}
		_ = response.Body.Close()
		if time.Now().After(deadline) {
			t.Fatal("MCP proxy remained reachable after the failed Operation")
		}
		time.Sleep(time.Millisecond)
	}
}

// Stopping the Agent Runner while MCP preparation is blocked cancels the
// Operation before any Provider starts.
func TestAgentRunnerStopDuringMCPPreparationCancelsWithoutStart(t *testing.T) {
	providerRelease := make(chan struct{})
	started := make(chan struct{}, 8)
	binder := newBlockingBinder("operation-stop-prep", make(chan struct{}))
	d, stream := acceptedStartDaemon(t, binder, started, providerRelease)
	start := daemonOperationStart("operation-stop-prep", "agent-1")
	if err := d.handleOperationStart(context.Background(), stream, start); err != nil {
		t.Fatal(err)
	}
	awaitBound(t, binder)
	stopped := make(chan error, 1)
	go func() { stopped <- d.StopAgentRunner(context.Background(), "agent-1") }()
	select {
	case err := <-stopped:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("stop did not finish after cancelling the preparing Operation")
	}
	awaitAcceptedOperationEvent(t, stream, start.OperationID, protocol.EventOperationCancelled)
	assertNoProviderStart(t, started)
	d.WaitForOperations()
}

// Drain during MCP preparation reports the Operation as busy, then cancels it
// into a cancelled terminal without starting the Provider.
func TestDaemonDrainDuringMCPPreparationCancelsWithoutStart(t *testing.T) {
	providerRelease := make(chan struct{})
	started := make(chan struct{}, 8)
	binder := newBlockingBinder("operation-drain-prep", make(chan struct{}))
	d, stream := acceptedStartDaemon(t, binder, started, providerRelease)
	start := daemonOperationStart("operation-drain-prep", "agent-1")
	if err := d.handleOperationStart(context.Background(), stream, start); err != nil {
		t.Fatal(err)
	}
	awaitBound(t, binder)
	if active := d.DrainIfIdle(); active <= 0 {
		t.Fatalf("DrainIfIdle=%d during MCP preparation, want busy", active)
	}
	d.Drain()
	d.WaitForOperations()
	awaitAcceptedOperationEvent(t, stream, start.OperationID, protocol.EventOperationCancelled)
	assertNoProviderStart(t, started)
	if active := d.ActiveOperationCount(); active != 0 {
		t.Fatalf("active Operations after drain=%d, want 0", active)
	}
}

// A provider prepare admitted for the same Context during MCP preparation must
// finish before the accepted Operation starts its Provider.
func TestOperationStartJoinsProviderPrepareAdmittedDuringMCPPreparation(t *testing.T) {
	backend := &providerPrepareBackend{started: make(chan struct{}), release: make(chan struct{})}
	d, stream := providerPrepareFixture(t, backend)
	if _, err := d.assignments.Apply(t.Context(), assignment.Command{
		Type: protocol.CommandAgentRunnerEnsure, CommandID: "fixture-assignment", RunnerID: "computer-1",
		TenantID: "tenant-1", AgentID: "agent-1", RegistrationID: "registration-1", AssignmentRevision: 1,
		RunnerRevision: 3, WorkspaceGrantID: "grant-1", Runtime: json.RawMessage(`{"type":"codex"}`),
	}, 1); err != nil {
		t.Fatal(err)
	}
	bindRelease := make(chan struct{})
	binder := newBlockingBinder("operation-prep-join", bindRelease)
	d.localTools = binder
	d.openMCPProxies = func(context.Context, json.RawMessage, mcpproxy.OperationIdentity) (*mcpproxy.Set, error) {
		return &mcpproxy.Set{}, nil
	}
	start := startFromPrepare(prepareCommand("operation-prep-join"))
	if err := d.handleOperationStart(context.Background(), stream, start); err != nil {
		t.Fatal(err)
	}
	awaitBound(t, binder)
	if err := d.handleProviderPrepare(context.Background(), stream, providerPrepareCommand("prepare-join")); err != nil {
		t.Fatal(err)
	}
	<-backend.started

	close(bindRelease)
	time.Sleep(100 * time.Millisecond)
	if got := backend.executions(); len(got) != 1 || !got[0].PrepareOnly {
		t.Fatalf("Operation started while its Context prepare was in flight: executions=%d", len(got))
	}
	close(backend.release)
	d.WaitForOperations()
	if got := backend.executions(); len(got) != 2 || !got[0].PrepareOnly || got[1].PrepareOnly {
		t.Fatalf("executions=%d, want one prepare then one start", len(got))
	}
}

// A duplicate operation.start while the first is still preparing replays the
// retained frames and never admits a second Operation.
func TestDuplicateOperationStartDuringMCPPreparationReplays(t *testing.T) {
	providerRelease := make(chan struct{})
	started := make(chan struct{}, 8)
	bindRelease := make(chan struct{})
	binder := newBlockingBinder("operation-duplicate", bindRelease)
	d, stream := acceptedStartDaemon(t, binder, started, providerRelease)
	start := daemonOperationStart("operation-duplicate", "agent-1")
	if err := d.handleOperationStart(context.Background(), stream, start); err != nil {
		t.Fatal(err)
	}
	awaitBound(t, binder)
	if err := d.handleOperationStart(context.Background(), stream, start); err != nil {
		t.Fatal(err)
	}
	assertNoProviderStart(t, started)
	if active := d.ActiveOperationCount(); active != 1 {
		t.Fatalf("active Operations after duplicate=%d, want 1", active)
	}
	close(bindRelease)
	awaitProviderStarts(t, started, 1)
	assertNoProviderStart(t, started)
	close(providerRelease)
	d.WaitForOperations()
	awaitAcceptedOperationEvent(t, stream, start.OperationID, protocol.EventOperationCompleted)
}

// countingResolver counts Resolve calls of the wrapped resolver.
type countingResolver struct {
	fakeOperationResolver
	calls atomic.Int32
}

func (r *countingResolver) Resolve(ctx context.Context, command protocol.Command, request json.RawMessage) (provider.OperationSpec, error) {
	r.calls.Add(1)
	return r.fakeOperationResolver.Resolve(ctx, command, request)
}

// An accepted start resolves again after its MCP preparation only when a
// command that can change its authority ran meanwhile.
func TestAcceptedStartResolvesAgainOnlyAfterAuthorityChange(t *testing.T) {
	for _, changed := range []bool{false, true} {
		bindRelease, providerRelease := make(chan struct{}), make(chan struct{})
		started := make(chan struct{}, 1)
		binder := newBlockingBinder("operation-resolve", bindRelease)
		d, stream := acceptedStartDaemon(t, binder, started, providerRelease)
		resolver := &countingResolver{}
		d.operationResolver = resolver
		if err := d.handleOperationStart(context.Background(), stream, daemonOperationStart("operation-resolve", "agent-1")); err != nil {
			t.Fatal(err)
		}
		awaitBound(t, binder)
		if changed {
			snapshot := protocol.Command{Type: protocol.CommandRegistrationSnapshot, CommandID: "snapshot", Payload: json.RawMessage(`[]`)}
			if err := d.applyRegistrationSnapshot(context.Background(), stream, snapshot); err != nil {
				t.Fatal(err)
			}
		}
		close(bindRelease)
		awaitProviderStarts(t, started, 1)
		want := int32(1)
		if changed {
			want = 2
		}
		if got := resolver.calls.Load(); got != want {
			t.Fatalf("changed=%v Resolve calls=%d, want %d", changed, got, want)
		}
		close(providerRelease)
		d.WaitForOperations()
	}
}
