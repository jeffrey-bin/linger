package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/transport"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/protocol"
)

func TestDaemonReconnectsAndReplaysRecordedEventAfterBackgroundWriteTimeout(t *testing.T) {
	ledger := NewMemoryLedger()
	operation := OperationIdentity{
		TenantID: "tenant-1", RunnerID: "computer-1", RegistrationID: "reg-1", AssignmentRevision: 1,
		AgentID: "agent-1", OperationID: "op-1", ConnectionEpoch: 1, RunnerRevision: 1,
		Generation: 1, ExecutionLeaseID: "lease-1", WorkspaceGrantID: "grant-1", RuntimeType: "codex",
	}
	if _, err := ledger.Begin(context.Background(), operation); err != nil {
		t.Fatal(err)
	}
	terminal, err := ledger.Complete(context.Background(), operation, protocol.Event{
		Type: protocol.EventOperationCompleted, ProtocolVersion: "1.2",
		TenantID: operation.TenantID, RunnerID: operation.RunnerID,
		RegistrationID: operation.RegistrationID, AssignmentRevision: operation.AssignmentRevision,
		AgentID: operation.AgentID, OperationID: operation.OperationID,
		ConnectionEpoch: operation.ConnectionEpoch, RunnerRevision: operation.RunnerRevision,
		Generation: operation.Generation, ExecutionLeaseID: operation.ExecutionLeaseID,
		WorkspaceGrantID: operation.WorkspaceGrantID, RuntimeType: operation.RuntimeType,
		Payload: json.RawMessage(`{"output":"` + strings.Repeat("x", 2*1024*1024) + `"}`),
	})
	if err != nil {
		t.Fatal(err)
	}

	var connections atomic.Int32
	var dialAttempts atomic.Int32
	peerReady := make(chan error, 1)
	releaseFirstPeer := make(chan struct{})
	replayed := make(chan json.RawMessage, 1)
	upgrader := websocket.Upgrader{}
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if !websocket.IsWebSocketUpgrade(request) {
			// Ordinary HTTP probes are outside the fixture's Gateway protocol.
			http.NotFound(writer, request)
			return
		}
		peer, err := upgrader.Upgrade(writer, request, nil)
		if err != nil {
			t.Error(err)
			return
		}
		defer peer.Close()
		epoch := connections.Add(1)
		if _, _, err := peer.ReadMessage(); err != nil { // runner.hello
			t.Error(err)
			return
		}
		welcome := map[string]any{
			"type": "runner.welcome", "protocol_version": "2", "runner_id": "computer-1", "connection_id": "connection-1",
			"connection_epoch": epoch, "heartbeat_interval_ms": 30_000, "reconcile_operation_ids": []string{},
		}
		if epoch > 1 {
			welcome["reconcile_operation_ids"] = []string{operation.OperationID}
		}
		if err := peer.WriteJSON(welcome); err != nil {
			t.Error(err)
			return
		}
		if epoch == 1 {
			peerReady <- peer.NetConn().(*net.TCPConn).SetReadBuffer(1024)
			<-releaseFirstPeer
			return
		}
		_, encoded, err := peer.ReadMessage()
		if err != nil {
			t.Error(err)
			return
		}
		replayed <- encoded
		_, _, _ = peer.ReadMessage() // Keep the new connection alive until shutdown.
	}))
	t.Cleanup(server.Close)
	t.Cleanup(func() { close(releaseFirstPeer) })

	device, err := transport.GenerateIdentity()
	if err != nil {
		t.Fatal(err)
	}
	daemon, err := newTestDaemon(t, Options{
		ComputerID: "computer-1", IdentityStore: fakeStore{value: device},
		OperationResolver: fakeOperationResolver{}, Ledger: ledger,
		ControlPlane: transport.GatewayControlPlane{
			URL: "ws" + strings.TrimPrefix(server.URL, "http"), BearerToken: "test-token",
			WriteTimeout: 100 * time.Millisecond,
			Dialer: &websocket.Dialer{NetDialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
				connection, err := (&net.Dialer{}).DialContext(ctx, network, address)
				// Only constrain the stalled connection. A tiny send buffer on
				// the healthy replacement can itself time out on a large replay.
				if err == nil && dialAttempts.Add(1) == 1 {
					err = connection.(*net.TCPConn).SetWriteBuffer(1024)
					if err != nil {
						_ = connection.Close()
					}
				}
				return connection, err
			}},
		},
		RetryDelay: func(int) time.Duration { return 0 },
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- daemon.Run(ctx) }()
	t.Cleanup(func() {
		cancel()
		select {
		case <-done:
		case <-time.After(2 * time.Second):
			t.Error("Daemon did not stop after cancellation")
		}
	})
	if err := <-peerReady; err != nil {
		t.Fatal(err)
	}
	// Admission of delivery must follow welcome/replay activation, not just the
	// peer's handshake. This lock also makes the test's stream lookup race-free.
	deadline := time.Now().Add(2 * time.Second)
	for {
		daemon.connectionMu.Lock()
		active := daemon.operationStream != nil
		daemon.connectionMu.Unlock()
		if active {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("Daemon did not activate the first connection")
		}
		time.Sleep(time.Millisecond)
	}
	go daemon.deliverRecordedOperationEvent(context.Background(), terminal)
	select {
	case encoded := <-replayed:
		var event struct {
			Type        string          `json:"type"`
			OperationID string          `json:"operation_id"`
			Sequence    uint64          `json:"seq"`
			Result      json.RawMessage `json:"result"`
			Epoch       uint64          `json:"connection_epoch"`
		}
		if err := json.Unmarshal(encoded, &event); err != nil {
			t.Fatal(err)
		}
		if event.Type != terminal.Type || event.OperationID != operation.OperationID || event.Sequence != terminal.Sequence || event.Epoch != terminal.ConnectionEpoch || string(event.Result) != string(terminal.Payload) {
			t.Fatal("reconnected stream did not replay the recorded event with its original identity and payload")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("background write failure did not reconnect and replay the unacknowledged event")
	}
}

type blockedDeliveryStream struct {
	receiving chan struct{}
	failRead  chan struct{}
	sending   chan struct{}
	closed    chan struct{}
	welcomed  bool
	closeOnce sync.Once
}

func (s *blockedDeliveryStream) Receive(ctx context.Context) (protocol.Command, error) {
	if !s.welcomed {
		s.welcomed = true
		return protocol.Command{Type: "runner.welcome", ConnectionEpoch: 1}, nil
	}
	close(s.receiving)
	select {
	case <-s.failRead:
		return protocol.Command{}, io.EOF
	case <-s.closed:
		return protocol.Command{}, io.EOF
	case <-ctx.Done():
		return protocol.Command{}, ctx.Err()
	}
}

func (s *blockedDeliveryStream) Send(_ context.Context, event protocol.Event) error {
	if event.Type != protocol.EventOperationCompleted {
		return nil
	}
	close(s.sending)
	<-s.closed
	return errors.New("connection closed")
}

func (s *blockedDeliveryStream) Close() error {
	s.closeOnce.Do(func() { close(s.closed) })
	return nil
}

type cleanupRecoveryControlPlane struct {
	first       transport.Stream
	reconnected chan struct{}
	calls       int
}

func (p *cleanupRecoveryControlPlane) Connect(_ context.Context, _ transport.Hello) (transport.Stream, error) {
	p.calls++
	if p.calls == 1 {
		return p.first, nil
	}
	close(p.reconnected)
	return nil, &transport.AuthenticationError{StatusCode: http.StatusUnauthorized}
}

func TestDaemonClosesConnectionBeforeCleaningUpBlockedDelivery(t *testing.T) {
	device, err := transport.GenerateIdentity()
	if err != nil {
		t.Fatal(err)
	}
	stream := &blockedDeliveryStream{
		receiving: make(chan struct{}), failRead: make(chan struct{}),
		sending: make(chan struct{}), closed: make(chan struct{}),
	}
	controlPlane := &cleanupRecoveryControlPlane{first: stream, reconnected: make(chan struct{})}
	daemon, err := newTestDaemon(t, Options{
		ComputerID: "computer-1", ControlPlane: controlPlane,
		IdentityStore: fakeStore{value: device}, OperationResolver: fakeOperationResolver{},
		RetryDelay: func(int) time.Duration { return 0 },
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- daemon.Run(ctx) }()
	t.Cleanup(func() {
		cancel()
		_ = stream.Close()
		select {
		case <-done:
		case <-time.After(2 * time.Second):
			t.Error("Daemon did not stop after releasing the blocked delivery")
		}
	})
	<-stream.receiving
	deliveryDone := make(chan struct{})
	go func() {
		daemon.deliverRecordedOperationEvent(context.Background(), protocol.Event{Type: protocol.EventOperationCompleted})
		close(deliveryDone)
	}()
	<-stream.sending
	close(stream.failRead)
	select {
	case <-controlPlane.reconnected:
	case <-time.After(time.Second):
		t.Fatal("read failure blocked cleanup behind connectionMu instead of closing the stream and reconnecting")
	}
	select {
	case <-deliveryDone:
	case <-time.After(time.Second):
		t.Fatal("connection cleanup did not unblock the background delivery")
	}
}
