package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	lingercontext "github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/context"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/registration"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/transport"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/protocol"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider/native"
)

// dispatchStream is a Gateway stream fed by the test. Sent events are recorded
// in order, and end closes the stream so Receive returns io.EOF.
type dispatchStream struct {
	incoming  chan protocol.Command
	closed    chan struct{}
	closeOnce sync.Once
	mu        sync.Mutex
	events    []protocol.Event
}

func newDispatchStream() *dispatchStream {
	return &dispatchStream{incoming: make(chan protocol.Command, 64), closed: make(chan struct{})}
}

func (s *dispatchStream) Receive(ctx context.Context) (protocol.Command, error) {
	select {
	case command := <-s.incoming:
		return command, nil
	case <-s.closed:
		return protocol.Command{}, io.EOF
	case <-ctx.Done():
		return protocol.Command{}, ctx.Err()
	}
}

func (s *dispatchStream) Send(_ context.Context, event protocol.Event) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.events = append(s.events, event)
	return nil
}

func (s *dispatchStream) Close() error {
	s.closeOnce.Do(func() { close(s.closed) })
	return nil
}

func (s *dispatchStream) snapshot() []protocol.Event {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]protocol.Event(nil), s.events...)
}

// indexOf returns the position of the first matching event, or -1.
func (s *dispatchStream) indexOf(match func(protocol.Event) bool) int {
	for index, event := range s.snapshot() {
		if match(event) {
			return index
		}
	}
	return -1
}

type dispatchControlPlane struct{ stream transport.Stream }

func (p dispatchControlPlane) Connect(context.Context, transport.Hello) (transport.Stream, error) {
	return p.stream, nil
}

// gatedDownloads is a Context content route whose file requests are held
// until a token is sent or releaseAll is closed. A file's content is its
// logical path, which each request reports on requests; a request whose
// context was cancelled is reported on canceled.
type gatedDownloads struct {
	content    *testViewContent
	requests   chan string
	canceled   chan string
	tokens     chan struct{}
	releaseAll chan struct{}
	once       sync.Once
}

func newGatedDownloads(t *testing.T) *gatedDownloads {
	t.Helper()
	gate := &gatedDownloads{
		content:  newTestViewContent(t),
		requests: make(chan string, 64), canceled: make(chan string, 64),
		tokens: make(chan struct{}), releaseAll: make(chan struct{}),
	}
	gate.content.hold = func(request *http.Request, path string) bool {
		gate.requests <- path
		select {
		case <-gate.tokens:
		case <-gate.releaseAll:
		case <-request.Context().Done():
			gate.canceled <- path
			return false
		}
		return true
	}
	t.Cleanup(gate.release)
	return gate
}

func (g *gatedDownloads) release() { g.once.Do(func() { close(g.releaseAll) }) }

// fileMapping maps one held file whose content is path.
func fileMapping(gate *gatedDownloads, path, name string) lingercontext.Mapping {
	return gate.content.mapping(name, path)
}

// missingFileMapping maps a file the content route does not have.
func missingFileMapping(name string) lingercontext.Mapping {
	return lingercontext.Mapping{
		Kind: "memory", TargetPath: "memory", Access: "read_only",
		Files: []lingercontext.FileInput{{RelativePath: name, MediaType: "text/plain", SizeBytes: 1, SHA256: strings.Repeat("c", 64)}},
	}
}

// completingBackend finishes every Operation immediately.
type completingBackend struct{}

func (completingBackend) Start(context.Context, string, native.RunSpec) (*native.Run, error) {
	messages := make(chan native.Event)
	close(messages)
	results := make(chan native.Outcome, 1)
	results <- native.Outcome{Status: "completed", SessionID: "thread-1"}
	close(results)
	return &native.Run{Events: messages, Outcome: results}, nil
}

type dispatchResolver struct{ workingDirectory string }

func (r dispatchResolver) Resolve(ctx context.Context, command protocol.Command, request json.RawMessage) (provider.OperationSpec, error) {
	spec, err := fakeOperationResolver{}.Resolve(ctx, command, request)
	spec.WorkingDirectory = r.workingDirectory
	return spec, err
}

func (dispatchResolver) ValidateAgentRunner(context.Context, protocol.Command, json.RawMessage) error {
	return nil
}

type dispatchFixture struct {
	t       *testing.T
	device  transport.Identity
	daemon  *Daemon
	stream  *dispatchStream
	views   *lingercontext.ViewStore
	gate    *gatedDownloads
	backend native.Runtime
	// exited closes when runConnection returns; exitErr is valid after that.
	exited  chan struct{}
	exitErr error
}

// newDispatchFixture builds a Daemon with a real ViewStore whose content
// route is the gate. A limit of 0 keeps the default dispatch limit.
func newDispatchFixture(t *testing.T, gate *gatedDownloads, limit int) *dispatchFixture {
	t.Helper()
	device, err := transport.GenerateIdentity()
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	t.Cleanup(func() {
		// Context workspaces contain read-only files that TempDir cleanup cannot remove.
		_ = filepath.Walk(root, func(path string, _ os.FileInfo, err error) error {
			if err == nil {
				_ = os.Chmod(path, 0o700)
			}
			return nil
		})
	})
	views, err := lingercontext.OpenViewStore(filepath.Join(root, "context.sqlite"), filepath.Join(root, "views"), nil)
	if err != nil {
		t.Fatal(err)
	}
	registrations := newTestRegistrations(t)
	if _, err := registrations.Apply(context.Background(), registration.Observation{
		RegistrationID: "registration-1",
		Key:            registration.Key{DaemonID: device.DaemonID, TenantID: "tenant-1", OwnerActorID: "owner-1", ProviderType: "codex"},
		Status:         registration.StatusOnline, Revision: 1,
	}); err != nil {
		t.Fatal(err)
	}
	fx := &dispatchFixture{t: t, device: device, stream: newDispatchStream(), views: views, gate: gate, backend: completingBackend{}, exited: make(chan struct{})}
	t.Cleanup(func() { _ = views.Close() })
	daemon, err := newTestDaemon(t, Options{
		ComputerID: "computer-1", ControlPlane: dispatchControlPlane{stream: fx.stream},
		IdentityStore: fakeStore{value: device}, OperationResolver: dispatchResolver{workingDirectory: t.TempDir()},
		ContextViews: views, Registrations: registrations,
		Executor: provider.Executor{NewBackend: func(string, native.Profile) (native.Runtime, error) {
			return fx.backend, nil
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	daemon.daemonID = device.DaemonID
	if limit > 0 {
		daemon.contextDispatchLimit = limit
	}
	fx.daemon = daemon
	t.Cleanup(fx.stop)
	return fx
}

// start runs the connection and sends the Gateway welcome.
func (fx *dispatchFixture) start() {
	fx.t.Helper()
	go func() {
		fx.exitErr = fx.daemon.runConnection(context.Background(), fx.device)
		close(fx.exited)
	}()
	fx.send(protocol.Command{Type: "runner.welcome", ConnectionEpoch: 1, ContextContentURL: fx.gate.content.url()})
}

func (fx *dispatchFixture) send(command protocol.Command) {
	fx.stream.incoming <- command
}

// stop ends the connection and waits for it to return and its workers to exit.
func (fx *dispatchFixture) stop() {
	fx.gate.release()
	_ = fx.stream.Close()
	select {
	case <-fx.exited:
	case <-time.After(10 * time.Second):
		fx.t.Error("connection did not return after the Gateway stream ended")
	}
	fx.daemon.WaitForOperations()
}

// nextRequest returns the next download the gate received.
func (fx *dispatchFixture) nextRequest() string {
	fx.t.Helper()
	select {
	case path := <-fx.gate.requests:
		return path
	case <-time.After(5 * time.Second):
		fx.t.Fatal("no download request arrived")
		return ""
	}
}

func operationEvent(eventType, operationID string) func(protocol.Event) bool {
	return func(event protocol.Event) bool {
		return event.Type == eventType && event.OperationID == operationID
	}
}

// awaitEvent waits until an event matches and returns its position.
func (fx *dispatchFixture) awaitEvent(what string, match func(protocol.Event) bool) int {
	fx.t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		if index := fx.stream.indexOf(match); index >= 0 {
			return index
		}
		if time.Now().After(deadline) {
			fx.t.Fatalf("timed out waiting for %s; events=%s", what, describeEvents(fx.stream.snapshot()))
		}
		time.Sleep(time.Millisecond)
	}
}

func (fx *dispatchFixture) assertNoEvent(what string, match func(protocol.Event) bool) {
	fx.t.Helper()
	if index := fx.stream.indexOf(match); index >= 0 {
		fx.t.Fatalf("unexpected %s at event %d", what, index)
	}
}

func (fx *dispatchFixture) awaitRequest(path string) {
	fx.t.Helper()
	select {
	case got := <-fx.gate.requests:
		if got != path {
			fx.t.Fatalf("download request = %q, want %q", got, path)
		}
	case <-time.After(5 * time.Second):
		fx.t.Fatalf("download %q did not start", path)
	}
}

func describeEvents(events []protocol.Event) string {
	parts := make([]string, 0, len(events))
	for _, event := range events {
		parts = append(parts, event.Type+"("+event.CommandID+")")
	}
	return strings.Join(parts, " ")
}

func eventOf(eventType, commandID string) func(protocol.Event) bool {
	return func(event protocol.Event) bool {
		return event.Type == eventType && event.CommandID == commandID
	}
}

// startWithView is a start whose View maps the given files.
func (fx *dispatchFixture) startWithView(operationID, key, agentID string, mappings ...lingercontext.Mapping) protocol.Command {
	start := dispatchStartCommand(operationID, key, agentID)
	start.ContextViewRef = fx.gate.content.publish(fx.t, start, mappings...)
	return start
}

func dispatchStartCommand(operationID, key, agentID string) protocol.Command {
	return protocol.Command{
		Type: protocol.CommandOperationStart, CommandID: "start-" + operationID, ProtocolVersion: "1.2",
		TenantID: "tenant-1", RunnerID: "computer-1", RegistrationID: "registration-1", AssignmentRevision: 1,
		AgentID: agentID, OperationID: operationID, ConnectionEpoch: 1, RunnerRevision: 1,
		Generation: 1, ExecutionLeaseID: "lease-" + operationID, WorkspaceGrantID: "grant-1", RuntimeType: "codex",
		ExecutionContextKey: key, RuntimeInstanceID: "runtime-" + key, OperationKind: "run.start",
		Payload: json.RawMessage(`{"kind":"run.start","runtime":{"type":"codex"},"input":{"type":"text","text":"hello"}}`),
	}
}

// operationCancelCommand copies the start's identity, as the Gateway does.
func operationCancelCommand(start protocol.Command) protocol.Command {
	cancel := start
	cancel.Type = protocol.CommandOperationCancel
	cancel.CommandID = "cancel-" + start.OperationID
	cancel.Payload = json.RawMessage(`{"reason":"Gateway cancel"}`)
	return cancel
}

func agentRunnerDispatchCommand(commandType, agentID string, revision uint64) protocol.Command {
	return protocol.Command{
		Type: commandType, CommandID: commandType + "-" + agentID + "-" + fmt.Sprint(revision), ProtocolVersion: "1.2",
		TenantID: "tenant-1", RunnerID: "computer-1", RegistrationID: "registration-1",
		AssignmentRevision: 1, AgentID: agentID, ConnectionEpoch: 1, RunnerRevision: revision,
		Payload: json.RawMessage(`{"runtime":{"type":"codex"},"workspace_grant_id":"grant-1"}`),
	}
}

func TestContextOfOneAgentDoesNotBlockAnotherContext(t *testing.T) {
	gate := newGatedDownloads(t)
	fx := newDispatchFixture(t, gate, 0)
	fx.start()
	fx.send(fx.startWithView("operation-a", "context-a", "agent-1", fileMapping(gate, "/a", "a.txt")))
	fx.awaitRequest("/a")

	fx.send(fx.startWithView("operation-b", "context-b", "agent-2"))
	fx.awaitEvent("Context B operation accepted", operationEvent(protocol.EventOperationAccepted, "operation-b"))
	fx.assertNoEvent("Context A admitted while its View is held", operationEvent(protocol.EventOperationAccepted, "operation-a"))

	gate.release()
	fx.awaitEvent("Context A admitted after release", operationEvent(protocol.EventOperationAccepted, "operation-a"))
}

func TestCommandsOfOneContextKeepTheirOrder(t *testing.T) {
	gate := newGatedDownloads(t)
	fx := newDispatchFixture(t, gate, 0)
	fx.start()
	fx.send(fx.startWithView("operation-a", "context-a", "agent-1", fileMapping(gate, "/a", "a.txt")))
	fx.awaitRequest("/a")
	fx.send(fx.startWithView("operation-a2", "context-a", "agent-1", fileMapping(gate, "/a", "a.txt")))

	gate.release()
	first := fx.awaitEvent("first start accepted", operationEvent(protocol.EventOperationAccepted, "operation-a"))
	second := fx.awaitEvent("second start answered", func(event protocol.Event) bool { return event.OperationID == "operation-a2" })
	if first > second {
		t.Fatalf("Context commands ran out of order: %s", describeEvents(fx.stream.snapshot()))
	}
}

func TestAgentRunnerRemoveWaitsForAgentsInFlightContextView(t *testing.T) {
	gate := newGatedDownloads(t)
	fx := newDispatchFixture(t, gate, 0)
	fx.start()
	fx.send(agentRunnerDispatchCommand(protocol.CommandAgentRunnerEnsure, "agent-x", 1))
	fx.awaitEvent("Agent Runner ready", eventOf(protocol.EventAgentRunnerReady, "agent_runner.ensure-agent-x-1"))
	fx.send(fx.startWithView("operation-x", "context-x", "agent-x", fileMapping(gate, "/x", "x.txt")))
	fx.awaitRequest("/x")
	fx.send(agentRunnerDispatchCommand(protocol.CommandAgentRunnerRemove, "agent-x", 2))

	// The remove waits behind the start whose View is being fetched.
	fx.assertNoEvent("Agent Runner removed while its start is in flight", eventOf(protocol.EventAgentRunnerRemoved, "agent_runner.remove-agent-x-2"))

	gate.release()
	settled := fx.awaitEvent("start settled", func(event protocol.Event) bool {
		return event.OperationID == "operation-x" && (event.Type == protocol.EventOperationAccepted || event.Type == protocol.EventOperationFailed)
	})
	removed := fx.awaitEvent("Agent Runner removed", eventOf(protocol.EventAgentRunnerRemoved, "agent_runner.remove-agent-x-2"))
	if settled > removed {
		t.Fatalf("Agent Runner removed before its start settled: %s", describeEvents(fx.stream.snapshot()))
	}
}

func TestOperationCancelIsNotBlockedBySlowInputView(t *testing.T) {
	gate := newGatedDownloads(t)
	fx := newDispatchFixture(t, gate, 0)
	cleaned := make(chan struct{})
	fx.backend = cancellationBackend{cleaned: cleaned}
	fx.start()
	start := fx.startWithView("operation-a", "context-a", "agent-1")
	fx.send(start)
	fx.awaitEvent("operation accepted", operationEvent(protocol.EventOperationAccepted, start.OperationID))
	// The cancelled Provider's cleanup is what this test waits on, so the input
	// and cancel arrive only after the Provider has started.
	awaitOperationStarted(t, fx.daemon)
	input := start
	input.Type, input.CommandID, input.ExpectedTurnID = protocol.CommandOperationInput, "input-a", "turn-1"
	input.Input = json.RawMessage(`{"type":"text","text":"more"}`)
	input.InputContextViewRef = fx.gate.content.publish(t, start, fileMapping(gate, "/input", "input.txt"))
	fx.send(input)
	fx.awaitRequest("/input")

	fx.send(operationCancelCommand(start))
	fx.awaitEvent("operation cancelled while the input View is held", operationEvent(protocol.EventOperationCancelled, start.OperationID))
	gate.release()
	<-cleaned
}

func TestOperationCancelDuringBlockedViewIsAppliedAfterStart(t *testing.T) {
	gate := newGatedDownloads(t)
	fx := newDispatchFixture(t, gate, 0)
	fx.backend = cancellationBackend{cleaned: make(chan struct{})}
	fx.start()
	start := fx.startWithView("operation-a", "context-a", "agent-1", fileMapping(gate, "/a", "a.txt"))
	fx.send(start)
	fx.awaitRequest("/a")
	fx.send(operationCancelCommand(start))

	gate.release()
	accepted := fx.awaitEvent("start admitted", operationEvent(protocol.EventOperationAccepted, start.OperationID))
	cancelled := fx.awaitEvent("start cancelled", operationEvent(protocol.EventOperationCancelled, start.OperationID))
	fx.assertNoEvent("start completed instead of cancelled", operationEvent(protocol.EventOperationCompleted, start.OperationID))
	if accepted > cancelled {
		t.Fatalf("start was cancelled before admission: %s", describeEvents(fx.stream.snapshot()))
	}
}

func TestConnectionLossCancelsBlockedDownloadAndDropsQueuedCommands(t *testing.T) {
	gate := newGatedDownloads(t)
	fx := newDispatchFixture(t, gate, 0)
	baseline := runtime.NumGoroutine()
	fx.start()
	fx.send(fx.startWithView("operation-a", "context-a", "agent-1", fileMapping(gate, "/a", "a.txt")))
	fx.awaitRequest("/a")
	fx.send(fx.startWithView("operation-a2", "context-a", "agent-1", fileMapping(gate, "/a2", "a2.txt")))
	eventually(t, "queued start received", func() bool { return fx.daemon.dispatcher.Load().activeCount() == 2 })

	_ = fx.stream.Close()
	select {
	case <-fx.exited:
		if !errors.Is(fx.exitErr, io.EOF) {
			t.Fatalf("runConnection() error = %v, want EOF", fx.exitErr)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("connection did not return while a download was blocked")
	}
	select {
	case path := <-fx.gate.canceled:
		if path != "/a" {
			t.Fatalf("cancelled download = %q", path)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("blocked download was not cancelled with the connection")
	}
	select {
	case path := <-fx.gate.requests:
		t.Fatalf("queued start fetched after connection loss: %s", path)
	default:
	}
	gate.content.server.Client().CloseIdleConnections()
	eventually(t, "dispatch goroutines to exit", func() bool { return runtime.NumGoroutine() <= baseline })
}

func TestDrainCancelsBlockedDispatchAndWaitForOperationsReturns(t *testing.T) {
	gate := newGatedDownloads(t)
	fx := newDispatchFixture(t, gate, 0)
	fx.start()
	fx.send(fx.startWithView("operation-a", "context-a", "agent-1", fileMapping(gate, "/a", "a.txt")))
	fx.awaitRequest("/a")

	fx.daemon.Drain()
	waited := make(chan struct{})
	go func() {
		fx.daemon.WaitForOperations()
		close(waited)
	}()
	select {
	case <-waited:
	case <-time.After(5 * time.Second):
		t.Fatal("WaitForOperations did not return after Drain cancelled the blocked View fetch")
	}
	fx.assertNoEvent("start admitted after drain", operationEvent(protocol.EventOperationAccepted, "operation-a"))
}

func TestContextConcurrencyLimitCapsDownloadsInFlight(t *testing.T) {
	gate := newGatedDownloads(t)
	fx := newDispatchFixture(t, gate, 2)
	fx.start()
	for index := 1; index <= 3; index++ {
		key := fmt.Sprintf("context-%d", index)
		path := fmt.Sprintf("/c%d", index)
		fx.send(fx.startWithView("operation-"+key, key, fmt.Sprintf("agent-%d", index), fileMapping(gate, path, fmt.Sprintf("c%d.txt", index))))
	}
	first, second := fx.nextRequest(), fx.nextRequest()
	if first == second {
		t.Fatalf("two downloads started for the same Context: %s", first)
	}
	select {
	case path := <-gate.requests:
		t.Fatalf("third download exceeded the limit of 2: %s", path)
	case <-time.After(300 * time.Millisecond):
	}

	gate.tokens <- struct{}{}
	fx.nextRequest()
	gate.release()
	for index := 1; index <= 3; index++ {
		fx.awaitEvent("start accepted", operationEvent(protocol.EventOperationAccepted, fmt.Sprintf("operation-context-%d", index)))
	}
}

func TestContextViewFailureIsNotConnectionFatal(t *testing.T) {
	gate := newGatedDownloads(t)
	fx := newDispatchFixture(t, gate, 0)
	fx.start()
	fx.send(fx.startWithView("operation-a", "context-a", "agent-1", missingFileMapping("missing.txt")))
	fx.awaitEvent("Context A failed", operationEvent(protocol.EventOperationFailed, "operation-a"))
	fx.send(fx.startWithView("operation-b", "context-b", "agent-2"))
	fx.awaitEvent("Context B accepted", operationEvent(protocol.EventOperationAccepted, "operation-b"))
	select {
	case <-fx.exited:
		t.Fatalf("Context View failure ended the connection: %v", fx.exitErr)
	default:
	}
}

func eventually(t *testing.T, what string, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !condition() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(time.Millisecond)
	}
}
