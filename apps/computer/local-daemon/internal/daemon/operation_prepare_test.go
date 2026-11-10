package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/assignment"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/mcpproxy"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/transport"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/protocol"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider/native"
)

type prepareOperationResolver struct {
	workingDirectory string
	relays           json.RawMessage
}

func (r prepareOperationResolver) Resolve(context.Context, protocol.Command, json.RawMessage) (provider.OperationSpec, error) {
	return provider.OperationSpec{
		OperationKind: "run.start", Provider: "codex", ExecutablePath: "/bin/codex",
		WorkingDirectory: r.workingDirectory, ResumeSessionID: "thread-1", MCPRelays: append(json.RawMessage(nil), r.relays...),
		CodexVersion: "0.155.1",
	}, nil
}

type prepareBackend struct {
	mu             sync.Mutex
	options        []native.RunSpec
	mcpBindings    []*mcpproxy.Set
	prepareErr     error
	prepareResult  *native.Outcome
	prepareStarted chan struct{}
	blockPrepare   bool
	prepareRelease chan struct{}
	cleanupDelay   time.Duration
	cleanupRelease chan struct{}
	active         int
	maxActive      int
}

func (b *prepareBackend) Start(ctx context.Context, _ string, options native.RunSpec) (*native.Run, error) {
	b.mu.Lock()
	b.options = append(b.options, options)
	b.active++
	if b.active > b.maxActive {
		b.maxActive = b.active
	}
	b.mu.Unlock()
	defer func() {
		b.mu.Lock()
		b.active--
		b.mu.Unlock()
	}()
	if options.WarmMCP && b.prepareStarted != nil {
		close(b.prepareStarted)
	}
	if options.WarmMCP && b.blockPrepare {
		if b.prepareRelease == nil {
			<-ctx.Done()
		} else {
			select {
			case <-b.prepareRelease:
			case <-ctx.Done():
			}
		}
		if ctx.Err() != nil {
			if b.cleanupRelease != nil {
				<-b.cleanupRelease
			}
			if b.cleanupDelay > 0 {
				time.Sleep(b.cleanupDelay)
			}
			if b.prepareResult == nil || (!b.prepareResult.ExitUnconfirmed && b.prepareResult.NativeResume == nil) {
				return nil, ctx.Err()
			}
		}
	}
	if options.WarmMCP && b.prepareErr != nil {
		return nil, b.prepareErr
	}
	messages := make(chan native.Event)
	results := make(chan native.Outcome, 1)
	close(messages)
	result := native.Outcome{Status: "completed", SessionID: "thread-1"}
	if options.WarmMCP && b.prepareResult != nil {
		result = *b.prepareResult
	}
	results <- result
	close(results)
	return &native.Run{Events: messages, Outcome: results}, nil
}

func (b *prepareBackend) snapshot() []native.RunSpec {
	b.mu.Lock()
	defer b.mu.Unlock()
	return append([]native.RunSpec(nil), b.options...)
}

func (b *prepareBackend) maximumConcurrentExecutions() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.maxActive
}

func (b *prepareBackend) bindingsSnapshot() []*mcpproxy.Set {
	b.mu.Lock()
	defer b.mu.Unlock()
	return append([]*mcpproxy.Set(nil), b.mcpBindings...)
}

func prepareCommand(operationID string) protocol.Command {
	return protocol.Command{
		Type: protocol.CommandOperationPrepare, CommandID: "prepare-" + operationID, ProtocolVersion: "1.2",
		HostAccess: "trusted", TenantID: "tenant-1", RunnerID: "computer-1", RegistrationID: "registration-1", AssignmentRevision: 1,
		AgentID: "agent-1", OperationID: operationID, OperationKind: "run.start", ConnectionEpoch: 1, RunnerRevision: 3,
		Generation: 7, ExecutionLeaseID: "lease-1", WorkspaceGrantID: "grant-1", RuntimeType: "codex",
		ExecutionContextKey: "context-1", RuntimeInstanceID: "runtime-1",
		ContextViewRef: json.RawMessage(`{"context_generation":7,"view_generation":"view-1","view_digest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","resource_digest":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","receipt_ref":"receipt-1"}`),
		Payload:        json.RawMessage(`{"kind":"run.start","runtime":{"type":"codex"},"session":{"threadId":"thread-1"},"run_resources":{"mcp_servers":[]}}`),
	}
}

func startFromPrepare(command protocol.Command) protocol.Command {
	command.Type = protocol.CommandOperationStart
	command.CommandID = "start-" + command.OperationID
	command.Payload = json.RawMessage(`{"kind":"run.start","runtime":{"type":"codex"},"session":{"threadId":"thread-1"},"input":{"type":"text","text":"hello"},"run_resources":{"mcp_servers":[]}}`)
	return command
}

func prepareDaemonFixture(t *testing.T, backend *prepareBackend, withoutSockets ...bool) (*Daemon, *fakeStream, protocol.Command) {
	t.Helper()
	upstreamURL := "http://127.0.0.1:1"
	if len(withoutSockets) == 0 {
		upstream := httptest.NewServer(nil)
		t.Cleanup(upstream.Close)
		upstreamURL = upstream.URL
	}
	relays := mustJSON([]mcpproxy.Descriptor{{
		Name: "linger_teamhub_collaboration", RelayURL: upstreamURL, RelayToken: "relay-secret-relay-secret-relay-secret",
		ToolNames: []string{"send_message"}, ExpiresAt: time.Now().Add(time.Minute),
	}})
	stream := &fakeStream{}
	d, err := newTestDaemon(t, Options{
		ComputerID: "computer-1", ControlPlane: fakeControlPlane{stream: stream}, IdentityStore: fakeStore{},
		OperationResolver: prepareOperationResolver{workingDirectory: t.TempDir(), relays: relays},
		Executor: provider.Executor{NewBackend: func(string, native.Profile) (native.Runtime, error) {
			return backend, nil
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(withoutSockets) > 0 {
		d.openMCPProxies = func(context.Context, json.RawMessage, mcpproxy.OperationIdentity) (*mcpproxy.Set, error) {
			return &mcpproxy.Set{}, nil
		}
	}
	openMCPProxies := d.openMCPProxies
	d.openMCPProxies = func(ctx context.Context, config json.RawMessage, identity mcpproxy.OperationIdentity) (*mcpproxy.Set, error) {
		proxies, err := openMCPProxies(ctx, config, identity)
		if err == nil {
			backend.mu.Lock()
			backend.mcpBindings = append(backend.mcpBindings, proxies)
			backend.mu.Unlock()
		}
		return proxies, err
	}
	d.operationStream = stream
	command := prepareCommand("operation-prepare")
	if _, err := d.assignments.Apply(t.Context(), assignment.Command{
		Type: protocol.CommandAgentRunnerEnsure, CommandID: "fixture-assignment", RunnerID: command.RunnerID,
		TenantID: command.TenantID, AgentID: command.AgentID, RegistrationID: command.RegistrationID, AssignmentRevision: command.AssignmentRevision,
		RunnerRevision: command.RunnerRevision, WorkspaceGrantID: command.WorkspaceGrantID, Runtime: json.RawMessage(`{"type":"codex"}`),
	}, 1); err != nil {
		t.Fatal(err)
	}
	return d, stream, command
}

func TestOperationPrepareReusesExactMCPBindingWithoutStartingTurn(t *testing.T) {
	backend := &prepareBackend{}
	d, stream, prepare := prepareDaemonFixture(t, backend)
	if err := d.handleOperationPrepare(context.Background(), stream, prepare); err != nil {
		t.Fatal(err)
	}
	d.preparationMu.Lock()
	ready := d.preparedOperations[prepare.OperationID].done
	d.preparationMu.Unlock()
	<-ready
	if err := d.handleOperationStart(context.Background(), stream, startFromPrepare(prepare)); err != nil {
		t.Fatal(err)
	}
	d.WaitForOperations()
	options := backend.snapshot()
	if len(options) != 2 {
		t.Fatalf("provider executions=%d, want prepare and start", len(options))
	}
	if !options[0].PrepareOnly || !options[0].WarmMCP || options[0].ExposeTurnStarted {
		t.Fatalf("prepare options=%+v", options[0])
	}
	if options[1].PrepareOnly || options[1].WarmMCP || !options[1].ExposeTurnStarted {
		t.Fatalf("start options=%+v", options[1])
	}
	if string(options[0].MCPServers) != string(options[1].MCPServers) {
		t.Fatalf("start did not reuse exact prepared proxy: prepare=%s start=%s", options[0].MCPServers, options[1].MCPServers)
	}
	if options[0].MCPReady == nil || options[1].MCPReady != nil {
		t.Fatal("only preparation may observe the Operation-bound MCP catalogs")
	}
	unlisted, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if err := options[0].MCPReady(unlisted); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("prepare readiness was not bound to unlisted proxied catalogs: %v", err)
	}
	events := stream.snapshotEvents()
	preparedSeen, acceptedSeen := false, false
	for _, event := range events {
		preparedSeen = preparedSeen || event.Type == protocol.EventOperationPrepared
		acceptedSeen = acceptedSeen || event.Type == protocol.EventOperationAccepted
	}
	if !preparedSeen || !acceptedSeen {
		t.Fatalf("events=%+v", events)
	}
}

func TestOperationPrepareDuplicateIsIdempotent(t *testing.T) {
	backend := &prepareBackend{}
	d, stream, prepare := prepareDaemonFixture(t, backend)
	if err := d.handleOperationPrepare(context.Background(), stream, prepare); err != nil {
		t.Fatal(err)
	}
	if err := d.handleOperationPrepare(context.Background(), stream, prepare); err != nil {
		t.Fatal(err)
	}
	if err := d.handleOperationStart(context.Background(), stream, startFromPrepare(prepare)); err != nil {
		t.Fatal(err)
	}
	d.WaitForOperations()
	if got := len(backend.snapshot()); got != 2 {
		t.Fatalf("provider executions=%d, duplicate prepare launched another handshake", got)
	}
}

func TestOperationPrepareMismatchFallsBackToFreshBinding(t *testing.T) {
	mutations := map[string]func(*protocol.Command){
		"tenant":             func(command *protocol.Command) { command.TenantID = "tenant-2" },
		"agent":              func(command *protocol.Command) { command.AgentID = "agent-2" },
		"context":            func(command *protocol.Command) { command.ExecutionContextKey = "context-2" },
		"context generation": func(command *protocol.Command) { command.Generation++ },
		"execution lease":    func(command *protocol.Command) { command.ExecutionLeaseID = "lease-2" },
		"runner revision":    func(command *protocol.Command) { command.RunnerRevision++ },
		"workspace grant":    func(command *protocol.Command) { command.WorkspaceGrantID = "grant-2" },
		"context view": func(command *protocol.Command) {
			command.ContextViewRef = json.RawMessage(`{"context_generation":7,"view_generation":"view-2","view_digest":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","resource_digest":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","receipt_ref":"receipt-2"}`)
		},
	}
	for name, mutate := range mutations {
		t.Run(name, func(t *testing.T) {
			backend := &prepareBackend{}
			d, stream, prepare := prepareDaemonFixture(t, backend)
			if err := d.handleOperationPrepare(context.Background(), stream, prepare); err != nil {
				t.Fatal(err)
			}
			d.preparationWG.Wait()
			d.preparationMu.Lock()
			pending := d.preparedOperations[prepare.OperationID]
			d.preparationMu.Unlock()
			start := startFromPrepare(prepare)
			mutate(&start)
			if err := d.handleOperationStart(context.Background(), stream, start); err != nil {
				t.Fatal(err)
			}
			d.WaitForOperations()
			options := backend.snapshot()
			bindings := backend.bindingsSnapshot()
			if len(options) < 1 || len(options) > 2 || pending.requireActivation() == nil {
				t.Fatalf("mismatch reused prepared authority: %+v", options)
			}
			if len(bindings) < 1 || len(bindings) > 2 || bindings[0] != pending.mcpProxies ||
				(len(options) == 2 && len(bindings) != 2) || (len(bindings) == 2 && bindings[0] == bindings[1]) {
				t.Fatalf("mismatch did not create a fresh proxy for fallback: %v", bindings)
			}
		})
	}
}

func TestOperationPrepareFailureDoesNotBlockStartFallback(t *testing.T) {
	backend := &prepareBackend{prepareErr: errors.New("reload unavailable")}
	d, stream, prepare := prepareDaemonFixture(t, backend)
	if err := d.handleOperationPrepare(context.Background(), stream, prepare); err != nil {
		t.Fatal(err)
	}
	if err := d.handleOperationStart(context.Background(), stream, startFromPrepare(prepare)); err != nil {
		t.Fatal(err)
	}
	d.WaitForOperations()
	options := backend.snapshot()
	if len(options) != 2 || options[1].WarmMCP {
		t.Fatalf("start did not use legacy fallback: %+v", options)
	}
}

func TestOperationStartDoesNotReuseNarrowedToolAuthority(t *testing.T) {
	backend := &prepareBackend{}
	d, stream, prepare := prepareDaemonFixture(t, backend)
	if err := d.handleOperationPrepare(t.Context(), stream, prepare); err != nil {
		t.Fatal(err)
	}
	d.preparationWG.Wait()
	d.preparationMu.Lock()
	pending := d.preparedOperations[prepare.OperationID]
	d.preparationMu.Unlock()
	resolver := d.operationResolver.(prepareOperationResolver)
	var relays []mcpproxy.Descriptor
	if err := json.Unmarshal(resolver.relays, &relays); err != nil {
		t.Fatal(err)
	}
	relays[0].ToolNames = []string{}
	resolver.relays = mustJSON(relays)
	d.operationResolver = resolver
	if err := d.handleOperationStart(t.Context(), stream, startFromPrepare(prepare)); err != nil {
		t.Fatal(err)
	}
	d.WaitForOperations()
	options := backend.snapshot()
	if len(options) != 2 || pending.requireActivation() == nil {
		t.Fatalf("narrowed tools reused the previous MCP authority: %+v", options)
	}
	bindings := backend.bindingsSnapshot()
	if len(bindings) != 2 || bindings[0] != pending.mcpProxies || bindings[0] == bindings[1] {
		t.Fatalf("narrowed tools did not create a fresh proxy for fallback: %v", bindings)
	}
}

func TestOperationStartJoinsInFlightPrepareAndReusesRuntime(t *testing.T) {
	release := make(chan struct{})
	backend := &prepareBackend{
		prepareStarted: make(chan struct{}),
		blockPrepare:   true,
		prepareRelease: release,
	}
	d, stream, prepare := prepareDaemonFixture(t, backend)
	if err := d.handleOperationPrepare(context.Background(), stream, prepare); err != nil {
		t.Fatal(err)
	}
	select {
	case <-backend.prepareStarted:
	case <-time.After(time.Second):
		t.Fatal("prepare did not reach provider")
	}

	startDone := make(chan error, 1)
	go func() {
		startDone <- d.handleOperationStart(context.Background(), stream, startFromPrepare(prepare))
	}()
	select {
	case err := <-startDone:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(200 * time.Millisecond):
		close(release)
		<-startDone
		d.WaitForOperations()
		t.Fatal("prepare join blocked Gateway command admission")
	}
	if d.ActiveOperationCount() != 1 {
		t.Fatal("admitted start did not own the Context slot while preparation was pending")
	}
	time.Sleep(100 * time.Millisecond)
	if got := len(backend.snapshot()); got != 1 {
		t.Fatalf("viable preparation was replaced before readiness: executions=%d", got)
	}
	close(release)
	d.WaitForOperations()
	options := backend.snapshot()
	if len(options) != 2 || !options[0].WarmMCP || options[1].WarmMCP {
		t.Fatalf("operation.start did not reuse the prepared Runtime: %+v", options)
	}
	if string(options[0].MCPServers) != string(options[1].MCPServers) {
		t.Fatalf("operation.start replaced the prepared MCP binding: prepare=%s start=%s", options[0].MCPServers, options[1].MCPServers)
	}
	if got := backend.maximumConcurrentExecutions(); got != 1 {
		t.Fatalf("prepare overlapped start provider execution: max concurrency=%d", got)
	}
}

func TestOperationPreparedProxyLivesUntilAdoptedOperationCancels(t *testing.T) {
	var upstreamCalls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamCalls.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": 1, "result": map[string]any{}})
	}))
	defer upstream.Close()
	d, stream, command := prepareDaemonFixture(t, &prepareBackend{})
	d.setGatewayState("connected")
	d.gatewayStateMu.Lock()
	d.reconciled = true
	d.gatewayStateMu.Unlock()
	resolver := d.operationResolver.(prepareOperationResolver)
	resolver.relays = mustJSON([]mcpproxy.Descriptor{{
		Name: "product", RelayURL: upstream.URL, RelayToken: strings.Repeat("x", 32),
		ToolNames: []string{"send_message"}, ExpiresAt: time.Now().Add(time.Minute),
	}})
	d.operationResolver = resolver
	if err := d.handleOperationPrepare(t.Context(), stream, command); err != nil {
		t.Fatal(err)
	}
	d.preparationWG.Wait() // Worker has returned, not merely published ready.
	d.preparationMu.Lock()
	prepared := d.preparedOperations[command.OperationID]
	d.preparationMu.Unlock()
	if prepared == nil {
		t.Fatal("ready preparation was lost")
	}
	defer d.discardPreparedOperation(prepared, "test_cleanup")
	var config struct {
		Servers map[string]struct{ URL string } `json:"mcpServers"`
	}
	if err := json.Unmarshal(prepared.mcpProxies.Config(), &config); err != nil {
		t.Fatal(err)
	}
	call := func() int {
		t.Helper()
		response, err := http.Post(config.Servers["product"].URL, "application/json", strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"send_message","arguments":{}}}`))
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		_, _ = io.Copy(io.Discard, response.Body)
		return response.StatusCode
	}
	if code := call(); code != http.StatusServiceUnavailable || upstreamCalls.Load() != 0 {
		t.Fatalf("unadopted prepare dispatched a tool: status=%d calls=%d", code, upstreamCalls.Load())
	}
	d.takePreparedOperation(command.OperationID)
	if code := call(); code != http.StatusServiceUnavailable || upstreamCalls.Load() != 0 {
		t.Fatalf("adoption alone activated tools: status=%d calls=%d", code, upstreamCalls.Load())
	}
	command = startFromPrepare(command)
	spec, err := resolver.Resolve(t.Context(), command, command.Payload)
	if err != nil {
		t.Fatal(err)
	}
	proxies, err := d.claimPreparedOperation(t.Context(), command, bindOperationSpec(command, spec), prepared)
	if err != nil || proxies == nil {
		t.Fatalf("claim: proxies=%v err=%v", proxies, err)
	}
	if code := call(); code != http.StatusOK || upstreamCalls.Load() != 1 {
		t.Fatalf("ready worker canceled adopted MCP authority: status=%d calls=%d", code, upstreamCalls.Load())
	}
	prepared.cancelFrom("operation_lifecycle")
	if code := call(); code != http.StatusServiceUnavailable || upstreamCalls.Load() != 1 {
		t.Fatalf("operation cancellation still dispatched MCP: status=%d calls=%d", code, upstreamCalls.Load())
	}
}

func TestOperationPrepareReadyWithoutStartExpires(t *testing.T) {
	testUnadoptedPreparationExpires(t, &prepareBackend{})
}

func TestOperationPrepareUnadoptedNativeFenceExpires(t *testing.T) {
	testUnadoptedPreparationExpires(t, &prepareBackend{prepareResult: &native.Outcome{
		Status: "failed", Error: "child still running", ExitUnconfirmed: true,
	}})
}

func testUnadoptedPreparationExpires(t *testing.T, backend *prepareBackend) {
	t.Helper()
	d, stream, command := prepareDaemonFixture(t, backend)
	if err := d.handleOperationPrepare(t.Context(), stream, command); err != nil {
		t.Fatal(err)
	}
	d.preparationWG.Wait()
	d.preparationMu.Lock()
	prepared := d.preparedOperations[command.OperationID]
	d.preparationMu.Unlock()
	defer d.discardPreparedOperation(prepared, "test_cleanup")
	select {
	case <-prepared.cleanupDone:
	case <-time.After(operationMCPPrepareTimeout + time.Second):
		t.Fatal("ready-but-unadopted proxy outlived its speculative budget")
	}
	if occupied, _ := d.operationOccupancy(OperationIdentity{}); occupied != 0 {
		t.Fatalf("expired ready preparation retained %d slots", occupied)
	}
	select {
	case <-prepared.cancelled:
	default:
		t.Fatal("expiry did not cancel unadopted proxy authority")
	}
}

func TestOperationStartOwnsPrepareBeyondSpeculativeDeadline(t *testing.T) {
	release := make(chan struct{})
	backend := &prepareBackend{prepareStarted: make(chan struct{}), blockPrepare: true, prepareRelease: release}
	d, stream, prepare := prepareDaemonFixture(t, backend)
	if err := d.handleOperationPrepare(t.Context(), stream, prepare); err != nil {
		t.Fatal(err)
	}
	<-backend.prepareStarted
	if err := d.handleOperationStart(t.Context(), stream, startFromPrepare(prepare)); err != nil {
		t.Fatal(err)
	}
	time.Sleep(operationMCPPrepareTimeout + 100*time.Millisecond)
	beforeReady := len(backend.snapshot())
	close(release)
	d.WaitForOperations()
	options := backend.snapshot()
	if beforeReady != 1 {
		t.Fatalf("adopted preparation was replaced at speculative deadline: executions=%d", beforeReady)
	}
	if len(options) != 2 || string(options[0].MCPServers) != string(options[1].MCPServers) {
		t.Fatalf("late readiness did not hand off the exact MCP binding: %+v", options)
	}
	if backend.maximumConcurrentExecutions() != 1 {
		t.Fatal("adopted preparation overlapped a replacement provider")
	}
}

func TestOperationPrepareAdoptionAndExpiryRace(t *testing.T) {
	for attempt := 0; attempt < 20; attempt++ {
		release := make(chan struct{})
		backend := &prepareBackend{prepareStarted: make(chan struct{}), blockPrepare: true, prepareRelease: release}
		d, stream, prepare := prepareDaemonFixture(t, backend)
		if err := d.handleOperationPrepare(t.Context(), stream, prepare); err != nil {
			t.Fatal(err)
		}
		<-backend.prepareStarted
		d.preparationMu.Lock()
		pending := d.preparedOperations[prepare.OperationID]
		d.preparationMu.Unlock()
		gate, expired := make(chan struct{}), make(chan struct{})
		go func() {
			<-gate
			d.expirePreparedOperation(pending)
			close(expired)
		}()
		close(gate)
		if err := d.handleOperationStart(t.Context(), stream, startFromPrepare(prepare)); err != nil {
			t.Fatal(err)
		}
		<-expired
		expiryWon := pending.cancellationCategory(nil) == "prepare_deadline"
		close(release)
		d.WaitForOperations()
		options := backend.snapshot()
		if len(options) != 2 || backend.maximumConcurrentExecutions() != 1 {
			t.Fatalf("attempt %d: expiry/adoption duplicated provider: %+v", attempt, options)
		}
		// The OS can reuse a closed proxy's port, so equal configs do not prove reuse.
		reused := pending.requireActivation() == nil
		if reused == expiryWon {
			t.Fatalf("attempt %d: expiryWon=%v reused=%v", attempt, expiryWon, reused)
		}
		bindings := backend.bindingsSnapshot()
		if len(bindings) < 1 || len(bindings) > 2 || (reused && bindings[0] != pending.mcpProxies) ||
			(len(bindings) == 1) != reused || (len(bindings) == 2 && bindings[0] == bindings[1]) {
			t.Fatalf("attempt %d: reused=%v proxy bindings=%v", attempt, reused, bindings)
		}
	}
}

func TestOperationPrepareExpiryReleasesDaemonOccupancyAfterNativeFence(t *testing.T) {
	backend := &prepareBackend{prepareStarted: make(chan struct{}), blockPrepare: true,
		prepareResult: &native.Outcome{Status: "failed", Error: "child still running", ExitUnconfirmed: true}}
	d, stream, prepare := prepareDaemonFixture(t, backend)
	if err := d.handleOperationPrepare(t.Context(), stream, prepare); err != nil {
		t.Fatal(err)
	}
	<-backend.prepareStarted
	d.preparationMu.Lock()
	pending := d.preparedOperations[prepare.OperationID]
	d.preparationMu.Unlock()
	d.expirePreparedOperation(pending)
	d.WaitForOperations()
	if !errors.Is(pending.err, provider.ErrPreparationCleanupUnconfirmed) {
		t.Fatalf("expected native cleanup fence, got %v", pending.err)
	}
	if occupied, _ := d.operationOccupancy(OperationIdentity{}); occupied != 0 {
		t.Fatalf("expired preparation retained %d daemon slots without a start", occupied)
	}
}

func TestOperationStartPendingPrepareCanBeCancelled(t *testing.T) {
	backend := &prepareBackend{prepareStarted: make(chan struct{}), blockPrepare: true}
	d, stream, prepare := prepareDaemonFixture(t, backend)
	if err := d.handleOperationPrepare(t.Context(), stream, prepare); err != nil {
		t.Fatal(err)
	}
	<-backend.prepareStarted
	if err := d.handleOperationStart(t.Context(), stream, startFromPrepare(prepare)); err != nil {
		t.Fatal(err)
	}
	cancel := prepare
	cancel.Type = protocol.CommandOperationCancel
	if err := d.handleOperationCancel(cancel); err != nil {
		t.Fatal(err)
	}
	d.WaitForOperations()
	if options := backend.snapshot(); len(options) != 1 {
		t.Fatalf("canceled pending preparation started a model: %+v", options)
	}
	events := stream.snapshotEvents()
	if events[len(events)-1].Type != protocol.EventOperationCancelled {
		t.Fatalf("pending cancellation did not produce a terminal receipt: %+v", events)
	}
}

func TestOperationStartRejectsUnconfirmedPrepareCleanup(t *testing.T) {
	backend := &prepareBackend{prepareResult: &native.Outcome{Status: "failed", Error: "child still running", ExitUnconfirmed: true}}
	d, stream, prepare := prepareDaemonFixture(t, backend)
	if err := d.handleOperationPrepare(t.Context(), stream, prepare); err != nil {
		t.Fatal(err)
	}
	d.preparationWG.Wait()
	if err := d.handleOperationStart(t.Context(), stream, startFromPrepare(prepare)); err != nil {
		t.Fatal(err)
	}
	d.WaitForOperations()
	if got := len(backend.snapshot()); got != 1 {
		t.Fatalf("unconfirmed cleanup authorized %d provider executions", got)
	}
	events := stream.snapshotEvents()
	if events[len(events)-1].Type != protocol.EventOperationFailed {
		t.Fatalf("missing cleanup failure terminal: %+v", events)
	}
	// The native real-process tests prove the next Operation must confirm
	// cleanup before replacing its writer; the Daemon must not duplicate that
	// home-scoped fence with a permanent Context quarantine.
	if occupied, _ := d.operationOccupancy(OperationIdentity{}); occupied != 0 {
		t.Fatalf("terminal preparation permanently occupied %d Context slots", occupied)
	}
}

func TestOperationStartRevalidatesAssignmentAfterPrepareWait(t *testing.T) {
	for _, change := range []string{"none", "revision", "runner_id", "missing", "removed"} {
		t.Run(change, func(t *testing.T) {
			release := make(chan struct{})
			backend := &prepareBackend{prepareStarted: make(chan struct{}), blockPrepare: true, prepareRelease: release}
			d, stream, prepare := prepareDaemonFixture(t, backend)
			ensure := assignment.Command{Type: protocol.CommandAgentRunnerEnsure, CommandID: "fixture-assignment", RunnerID: prepare.RunnerID,
				TenantID: prepare.TenantID, AgentID: prepare.AgentID, RegistrationID: prepare.RegistrationID, AssignmentRevision: prepare.AssignmentRevision,
				RunnerRevision: prepare.RunnerRevision, WorkspaceGrantID: prepare.WorkspaceGrantID, Runtime: json.RawMessage(`{"type":"codex"}`)}
			if _, err := d.assignments.Apply(t.Context(), ensure, 1); err != nil {
				t.Fatal(err)
			}
			if err := d.handleOperationPrepare(t.Context(), stream, prepare); err != nil {
				t.Fatal(err)
			}
			<-backend.prepareStarted
			if err := d.handleOperationStart(t.Context(), stream, startFromPrepare(prepare)); err != nil {
				t.Fatal(err)
			}
			if change == "missing" {
				d.admissionMu.Lock()
				d.assignments = newTestAssignments(t)
				d.admissionMu.Unlock()
			} else if change != "none" {
				ensure.CommandID = "ensure-next"
				if change == "runner_id" {
					ensure.RunnerID = "computer-other"
					d.admissionMu.Lock()
					d.assignments = newTestAssignments(t)
					d.admissionMu.Unlock()
				} else {
					ensure.RunnerRevision++
				}
				if change == "removed" {
					ensure.Type = protocol.CommandAgentRunnerRemove
				}
				if _, err := d.assignments.Apply(t.Context(), ensure, 1); err != nil {
					t.Fatal(err)
				}
			}
			close(release)
			d.WaitForOperations()
			want := 2
			if change != "none" {
				want = 1
			}
			if got := len(backend.snapshot()); got != want {
				t.Fatalf("provider executions=%d want=%d", got, want)
			}
		})
	}
}

func TestOperationStartFallsBackOnlyAfterPrepareDeadlineAndCleanup(t *testing.T) {
	backend := &prepareBackend{prepareStarted: make(chan struct{}), blockPrepare: true}
	d, stream, prepare := prepareDaemonFixture(t, backend)
	startedAt := time.Now()
	if err := d.handleOperationPrepare(context.Background(), stream, prepare); err != nil {
		t.Fatal(err)
	}
	select {
	case <-backend.prepareStarted:
	case <-time.After(time.Second):
		t.Fatal("prepare did not reach provider")
	}
	// No start has adopted this speculative work before its deadline.
	d.WaitForOperations()
	if err := d.handleOperationStart(context.Background(), stream, startFromPrepare(prepare)); err != nil {
		t.Fatal(err)
	}
	d.WaitForOperations()
	elapsed := time.Since(startedAt)
	if elapsed < operationMCPPrepareTimeout-100*time.Millisecond || elapsed > operationMCPPrepareTimeout+time.Second {
		t.Fatalf("operation.start fallback wait=%s, want prepare deadline before fallback", elapsed)
	}
	d.WaitForOperations()
	options := backend.snapshot()
	if len(options) != 2 || !options[0].WarmMCP || options[1].WarmMCP {
		t.Fatalf("prepare deadline did not use legacy fallback: %+v", options)
	}
	if got := backend.maximumConcurrentExecutions(); got != 1 {
		t.Fatalf("prepare cleanup overlapped fallback provider execution: max concurrency=%d", got)
	}
}

func TestPreparedOperationCleanupTimeoutDoesNotAuthorizeFallback(t *testing.T) {
	release := make(chan struct{})
	backend := &prepareBackend{
		prepareStarted: make(chan struct{}),
		blockPrepare:   true,
		cleanupRelease: release,
	}
	d, stream, prepare := prepareDaemonFixture(t, backend)
	startedAt := time.Now()
	if err := d.handleOperationPrepare(context.Background(), stream, prepare); err != nil {
		t.Fatal(err)
	}
	select {
	case <-backend.prepareStarted:
	case <-time.After(time.Second):
		t.Fatal("prepare did not reach provider")
	}
	d.preparationMu.Lock()
	pending := d.preparedOperations[prepare.OperationID]
	d.preparationMu.Unlock()
	<-pending.cancelled // Expiry wins before start; cleanup is still unresolved.
	if err := d.handleOperationStart(context.Background(), stream, startFromPrepare(prepare)); err != nil {
		t.Fatal(err)
	}
	for d.ActiveOperationCount() != 0 && time.Since(startedAt) < operationMCPPrepareTimeout+operationMCPCleanupLimit+time.Second {
		time.Sleep(10 * time.Millisecond)
	}
	elapsed := time.Since(startedAt)
	if elapsed < operationMCPPrepareTimeout+operationMCPCleanupLimit-100*time.Millisecond || elapsed > operationMCPPrepareTimeout+operationMCPCleanupLimit+time.Second {
		t.Fatalf("operation.start cleanup wait=%s, want separate prepare and cleanup budgets", elapsed)
	}
	options := backend.snapshot()
	if len(options) != 1 || !options[0].WarmMCP {
		t.Fatalf("cleanup timeout authorized fallback provider execution: %+v", options)
	}
	events := stream.snapshotEvents()
	if len(events) == 0 || events[len(events)-1].Type != protocol.EventOperationFailed {
		t.Fatalf("cleanup timeout events=%+v, want operation.failed", events)
	}
	next := startFromPrepare(prepare)
	next.OperationID, next.CommandID, next.ExecutionLeaseID = "after-cleanup-timeout", "start-after-cleanup-timeout", "lease-next"
	if err := d.handleOperationStart(t.Context(), stream, next); err != nil {
		t.Fatal(err)
	}
	if got := len(backend.snapshot()); got != 1 {
		t.Errorf("late cleanup allowed a second provider: executions=%d", got)
	}
	close(release)
	d.WaitForOperations()
	if got := backend.maximumConcurrentExecutions(); got != 1 {
		t.Fatalf("late cleanup overlapped next operation: concurrency=%d", got)
	}
}

func TestOperationStartReplayDoesNotInitializeOrStartAgain(t *testing.T) {
	backend := &prepareBackend{}
	d, stream, prepare := prepareDaemonFixture(t, backend)
	if err := d.handleOperationPrepare(context.Background(), stream, prepare); err != nil {
		t.Fatal(err)
	}
	start := startFromPrepare(prepare)
	if err := d.handleOperationStart(context.Background(), stream, start); err != nil {
		t.Fatal(err)
	}
	if err := d.handleOperationStart(context.Background(), stream, start); err != nil {
		t.Fatal(err)
	}
	d.WaitForOperations()
	if got := len(backend.snapshot()); got != 2 {
		t.Fatalf("duplicate operation.start executed Provider %d times, want one prepare and one start", got)
	}
}

func TestOperationPrepareCancellationDiscardsUnadmittedAuthority(t *testing.T) {
	backend := &prepareBackend{prepareStarted: make(chan struct{}), blockPrepare: true}
	d, stream, prepare := prepareDaemonFixture(t, backend)
	if err := d.handleOperationPrepare(context.Background(), stream, prepare); err != nil {
		t.Fatal(err)
	}
	select {
	case <-backend.prepareStarted:
	case <-time.After(time.Second):
		t.Fatal("prepare did not reach provider")
	}
	cancel := prepare
	cancel.Type = protocol.CommandOperationCancel
	cancel.CommandID = "cancel-" + prepare.OperationID
	cancel.Payload = json.RawMessage("{\"reason\":\"cloud cancelled before start\"}")
	if err := d.handleOperationCancel(cancel); err != nil {
		t.Fatal(err)
	}
	d.WaitForOperations()
	if got := len(backend.snapshot()); got != 1 {
		t.Fatalf("provider executions=%d, cancellation started a turn", got)
	}
	d.preparationMu.Lock()
	retained := len(d.preparedOperations)
	d.preparationMu.Unlock()
	if retained != 0 {
		t.Fatalf("cancel retained %d prepared bindings", retained)
	}
	for _, event := range stream.snapshotEvents() {
		if event.Type == protocol.EventOperationPrepared {
			t.Fatalf("cancelled preparation emitted a stale receipt: %+v", event)
		}
	}
}

func TestOperationPrepareReservesItsContextUntilStartOrCancel(t *testing.T) {
	backend := &prepareBackend{prepareStarted: make(chan struct{}), blockPrepare: true}
	d, stream, prepare := prepareDaemonFixture(t, backend)
	if err := d.handleOperationPrepare(context.Background(), stream, prepare); err != nil {
		t.Fatal(err)
	}
	select {
	case <-backend.prepareStarted:
	case <-time.After(time.Second):
		t.Fatal("prepare did not reach provider")
	}

	competing := prepareCommand("operation-competing")
	if err := d.handleOperationStart(context.Background(), stream, startFromPrepare(competing)); err != nil {
		t.Fatal(err)
	}
	if got := len(backend.snapshot()); got != 1 {
		t.Fatalf("competing Context start reached Provider while preparation was pending: %d executions", got)
	}
	cancel := prepare
	cancel.Type = protocol.CommandOperationCancel
	cancel.CommandID = "cancel-" + prepare.OperationID
	if err := d.handleOperationCancel(cancel); err != nil {
		t.Fatal(err)
	}
	d.WaitForOperations()
}

func TestOperationPrepareCountsTowardDaemonCapacity(t *testing.T) {
	backend := &prepareBackend{prepareStarted: make(chan struct{}), blockPrepare: true}
	d, stream, prepare := prepareDaemonFixture(t, backend)
	capacity := 1
	d.capacity = &capacity
	if err := d.handleOperationPrepare(context.Background(), stream, prepare); err != nil {
		t.Fatal(err)
	}
	select {
	case <-backend.prepareStarted:
	case <-time.After(time.Second):
		t.Fatal("prepare did not reach provider")
	}

	competing := prepareCommand("operation-capacity")
	competing.ExecutionContextKey = "context-2"
	competing.RuntimeInstanceID = "runtime-2"
	if err := d.handleOperationStart(context.Background(), stream, startFromPrepare(competing)); err != nil {
		t.Fatal(err)
	}
	if got := len(backend.snapshot()); got != 1 {
		t.Fatalf("start exceeded capacity while preparation was pending: %d executions", got)
	}
	events := stream.snapshotEvents()
	if len(events) == 0 || events[len(events)-1].Type != protocol.EventOperationFailed ||
		!strings.Contains(string(events[len(events)-1].Payload), "capacity") {
		t.Fatalf("capacity rejection events=%+v", events)
	}
	cancel := prepare
	cancel.Type = protocol.CommandOperationCancel
	cancel.CommandID = "cancel-" + prepare.OperationID
	if err := d.handleOperationCancel(cancel); err != nil {
		t.Fatal(err)
	}
	d.WaitForOperations()
}

func TestOperationPrepareIsDiscardedWhenGatewayConnectionEnds(t *testing.T) {
	backend := &prepareBackend{}
	d, _, prepare := prepareDaemonFixture(t, backend)
	device, err := transport.GenerateIdentity()
	if err != nil {
		t.Fatal(err)
	}
	eofGate := make(chan struct{})
	stream := &fakeStream{
		commands: []protocol.Command{
			{
				Type: "runner.welcome", ConnectionEpoch: 1,
			},
			{Type: "runner.reconciled", ConnectionEpoch: 1, RunnerID: "computer-1"},
			prepare,
		},
		wait: eofGate,
	}
	d.controlPlane = fakeControlPlane{stream: stream}
	done := make(chan error, 1)
	go func() { done <- d.runConnection(context.Background(), device) }()
	deadline := time.Now().Add(2 * time.Second)
	preparedSeen := false
	for time.Now().Before(deadline) {
		for _, event := range stream.snapshotEvents() {
			preparedSeen = preparedSeen || event.Type == protocol.EventOperationPrepared
		}
		if preparedSeen {
			break
		}
		time.Sleep(time.Millisecond)
	}
	if !preparedSeen {
		t.Fatal("prepare did not become ready before disconnect")
	}
	d.preparationMu.Lock()
	pending := d.preparedOperations[prepare.OperationID]
	d.preparationMu.Unlock()
	close(eofGate)
	if err := <-done; !errors.Is(err, io.EOF) {
		t.Fatalf("runConnection error=%v, want EOF", err)
	}
	d.WaitForOperations()
	d.preparationMu.Lock()
	retained := len(d.preparedOperations)
	d.preparationMu.Unlock()
	if retained != 0 {
		t.Fatalf("Gateway disconnect retained %d prepared bindings", retained)
	}

	fallbackStream := &fakeStream{}
	if err := d.handleOperationStart(context.Background(), fallbackStream, startFromPrepare(prepare)); err != nil {
		t.Fatal(err)
	}
	d.WaitForOperations()
	options := backend.snapshot()
	if len(options) != 2 || options[1].WarmMCP || pending.requireActivation() == nil {
		t.Fatalf("post-disconnect start reused stale preparation: %+v", options)
	}
	bindings := backend.bindingsSnapshot()
	if len(bindings) != 2 || bindings[0] != pending.mcpProxies || bindings[0] == bindings[1] {
		t.Fatalf("post-disconnect start did not create a fresh proxy: %v", bindings)
	}
}

func TestOperationPrepareRunsAfterGatewayWelcome(t *testing.T) {
	backend := &prepareBackend{}
	d, _, prepare := prepareDaemonFixture(t, backend)
	device, err := transport.GenerateIdentity()
	if err != nil {
		t.Fatal(err)
	}
	release := make(chan struct{})
	stream := &fakeStream{commands: []protocol.Command{
		{
			Type: "runner.welcome", ConnectionEpoch: 1,
		},
		prepare,
	}, wait: release}
	d.controlPlane = fakeControlPlane{stream: stream}
	done := make(chan error, 1)
	go func() { done <- d.runConnection(context.Background(), device) }()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		for _, event := range stream.snapshotEvents() {
			if event.Type == protocol.EventOperationPrepared {
				close(release)
				if err := <-done; !errors.Is(err, io.EOF) {
					t.Fatalf("runConnection error=%v, want EOF", err)
				}
				options := backend.snapshot()
				if len(options) != 1 || !options[0].WarmMCP {
					t.Fatalf("prepare executions=%+v", options)
				}
				return
			}
		}
		time.Sleep(time.Millisecond)
	}
	close(release)
	<-done
	t.Fatal("prepare did not emit operation.prepared")
}

func TestOperationPrepareResumeMeasurementReceipts(t *testing.T) {
	for _, outcome := range []string{"completed", "failed", "timeout"} {
		t.Run(outcome, func(t *testing.T) {
			resume := &native.NativeResumeMeasurement{DurationMs: 123, Result: "success"}
			if outcome != "completed" {
				resume.Result = "error"
			}
			backend := &prepareBackend{prepareResult: &native.Outcome{Status: outcome, Error: "prepare failed", SessionID: "thread-1", NativeResume: resume}}
			d, stream, prepare := prepareDaemonFixture(t, backend, true)
			if err := d.handleOperationPrepare(context.Background(), stream, prepare); err != nil {
				t.Fatal(err)
			}
			d.preparationWG.Wait()
			found := false
			for _, event := range stream.snapshotEvents() {
				if event.Type != protocol.EventOperationPrepared {
					continue
				}
				var payload map[string]any
				if err := json.Unmarshal(event.Payload, &payload); err != nil {
					t.Fatal(err)
				}
				if payload["prepare_native_resume"] == nil {
					t.Fatalf("prepare measurement lost: %s", event.Payload)
				}
				found = true
			}
			if !found {
				t.Fatal("missing prepare receipt")
			}
			if outcome == "completed" {
				if err := d.handleOperationStart(context.Background(), stream, startFromPrepare(prepare)); err != nil {
					t.Fatal(err)
				}
				d.WaitForOperations()
				found = false
				for _, event := range stream.snapshotEvents() {
					if event.Type != protocol.EventOperationCompleted {
						continue
					}
					var payload map[string]any
					if err := json.Unmarshal(event.Payload, &payload); err != nil {
						t.Fatal(err)
					}
					if payload["prepare_native_resume"] == nil || payload["native_resume"] != nil {
						t.Fatalf("terminal did not retain prepare-only resume: %s", event.Payload)
					}
					found = true
				}
				if !found {
					t.Fatal("missing terminal")
				}
			} else {
				d.WaitForOperations()
			}
		})
	}
}

func TestOperationPrepareDeadlineRetainsResumeMeasurementWithoutExecute(t *testing.T) {
	backend := &prepareBackend{blockPrepare: true, prepareStarted: make(chan struct{}), prepareResult: &native.Outcome{
		Status: "failed", Error: "resume canceled", NativeResume: &native.NativeResumeMeasurement{DurationMs: 12, Result: "canceled"},
	}}
	d, stream, command := prepareDaemonFixture(t, backend, true)
	if err := d.handleOperationPrepare(context.Background(), stream, command); err != nil {
		t.Fatal(err)
	}
	<-backend.prepareStarted
	d.preparationMu.Lock()
	prepared := d.preparedOperations[command.OperationID]
	d.preparationMu.Unlock()
	d.expirePreparedOperation(prepared)
	d.WaitForOperations()
	found := false
	for _, event := range stream.snapshotEvents() {
		if event.Type != protocol.EventOperationPrepared {
			continue
		}
		var payload map[string]any
		if err := json.Unmarshal(event.Payload, &payload); err != nil {
			t.Fatal(err)
		}
		measurement, ok := payload["prepare_native_resume"].(map[string]any)
		if !ok || measurement["result"] != "canceled" || payload["prepared"] != false {
			t.Fatalf("deadline lost timing: %s", event.Payload)
		}
		found = true
	}
	if !found {
		t.Fatal("prepare-only deadline must send a measurement receipt")
	}
	if len(backend.snapshot()) != 1 {
		t.Fatal("deadline started an execution")
	}
}
