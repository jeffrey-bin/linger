package transport

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/protocol"
)

var heartbeat = protocol.Event{Type: protocol.EventRunnerHeartbeat, Payload: json.RawMessage(`{"active_operation_ids":[]}`)}

// The peer completes the handshake, then stops reading. Small TCP buffers make
// a frame within the protocol's size limit reliably block the writer.
func stalledGatewayStream(t *testing.T, writeTimeout time.Duration) *gatewayStream {
	t.Helper()
	peerReady := make(chan error, 1)
	releasePeer := make(chan struct{})
	upgrader := websocket.Upgrader{}
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if !websocket.IsWebSocketUpgrade(request) {
			http.NotFound(writer, request)
			return
		}
		peer, err := upgrader.Upgrade(writer, request, nil)
		if err != nil {
			peerReady <- err
			return
		}
		defer peer.Close()
		peerReady <- peer.NetConn().(*net.TCPConn).SetReadBuffer(1024)
		<-releasePeer
	}))
	t.Cleanup(server.Close)
	t.Cleanup(func() { close(releasePeer) })
	stream, err := (GatewayControlPlane{
		URL: "ws" + strings.TrimPrefix(server.URL, "http"), BearerToken: "test-token",
		WriteTimeout: writeTimeout,
	}).Connect(context.Background(), Hello{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = stream.Close() })
	if err := <-peerReady; err != nil {
		t.Fatal(err)
	}
	gateway := stream.(*gatewayStream)
	if err := gateway.socket.NetConn().(*net.TCPConn).SetWriteBuffer(1024); err != nil {
		t.Fatal(err)
	}
	return gateway
}

func TestGatewayWriteTimeoutClosesStreamAndUnblocksReceive(t *testing.T) {
	for _, test := range []struct {
		name         string
		writeTimeout time.Duration
		ctxTimeout   time.Duration
	}{
		{name: "without context deadline", writeTimeout: 100 * time.Millisecond},
		{name: "earlier transport deadline", writeTimeout: 100 * time.Millisecond, ctxTimeout: 5 * time.Second},
		// Leave time for JSON encoding under the race detector before the I/O
		// deadline expires; this case must reach the blocked socket write.
		{name: "earlier context deadline", writeTimeout: 5 * time.Second, ctxTimeout: time.Second},
	} {
		t.Run(test.name, func(t *testing.T) {
			stream := stalledGatewayStream(t, test.writeTimeout)
			receiveDone := make(chan error, 1)
			go func() {
				_, err := stream.Receive(context.Background())
				receiveDone <- err
			}()
			ctx := context.Background()
			if test.ctxTimeout != 0 {
				var cancel context.CancelFunc
				ctx, cancel = context.WithTimeout(ctx, test.ctxTimeout)
				defer cancel()
			}
			sendDone := make(chan error, 1)
			go func() {
				sendDone <- stream.Send(ctx, protocol.Event{
					Type:    protocol.EventModelInvoked,
					Payload: json.RawMessage(`{"output":"` + strings.Repeat("x", 2*1024*1024) + `"}`),
				})
			}()
			select {
			case err := <-sendDone:
				if errors.Is(err, context.DeadlineExceeded) {
					t.Fatal("context expired during encoding instead of timing out the socket write")
				}
				var timeoutErr net.Error
				if !errors.As(err, &timeoutErr) || !timeoutErr.Timeout() {
					t.Fatalf("Send() error = %v, want a write timeout", err)
				}
			case <-time.After(2 * time.Second):
				t.Fatal("Send remained blocked beyond the shorter write deadline")
			}
			select {
			case err := <-receiveDone:
				if err == nil {
					t.Fatal("Receive succeeded after a write timeout")
				}
			case <-time.After(time.Second):
				t.Fatal("write timeout did not close the connection and unblock Receive")
			}
			if err := stream.Send(context.Background(), heartbeat); err == nil {
				t.Fatal("closed connection accepted another Send")
			}
		})
	}
}

type entryObservedContext struct {
	context.Context
	checked chan struct{}
	once    sync.Once
}

func (c *entryObservedContext) Err() error {
	err := c.Context.Err()
	c.once.Do(func() { close(c.checked) })
	return err
}

func TestGatewaySendRechecksCancellationAfterWaitingForWriter(t *testing.T) {
	stream := stalledGatewayStream(t, time.Second)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	observed := &entryObservedContext{Context: ctx, checked: make(chan struct{})}
	stream.writeMu.Lock()
	done := make(chan error, 1)
	go func() { done <- stream.Send(observed, heartbeat) }()
	<-observed.checked
	cancel()
	stream.writeMu.Unlock()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("queued Send() error = %v, want context.Canceled", err)
		}
	case <-time.After(time.Second):
		t.Fatal("canceled Send remained blocked after the writer was released")
	}
}

type writeDeadlineObservedConn struct {
	net.Conn
	deadlines chan time.Time
}

func (c *writeDeadlineObservedConn) SetWriteDeadline(deadline time.Time) error {
	c.deadlines <- deadline
	return c.Conn.SetWriteDeadline(deadline)
}

func TestGatewaySendResetsExpiredContextDeadlineToDefault(t *testing.T) {
	for _, writeTimeout := range []time.Duration{0, -time.Second} {
		t.Run(writeTimeout.String(), func(t *testing.T) {
			upgrader := websocket.Upgrader{}
			server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
				if !websocket.IsWebSocketUpgrade(request) {
					http.NotFound(writer, request)
					return
				}
				peer, err := upgrader.Upgrade(writer, request, nil)
				if err != nil {
					t.Error(err)
					return
				}
				defer peer.Close()
				for range 2 {
					if _, _, err := peer.ReadMessage(); err != nil {
						return
					}
				}
			}))
			defer server.Close()
			deadlines := make(chan time.Time, 2)
			stream, err := (GatewayControlPlane{
				URL: "ws" + strings.TrimPrefix(server.URL, "http"), BearerToken: "test-token",
				WriteTimeout: writeTimeout,
				Dialer: &websocket.Dialer{NetDialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
					connection, err := (&net.Dialer{}).DialContext(ctx, network, address)
					if err != nil {
						return nil, err
					}
					return &writeDeadlineObservedConn{Conn: connection, deadlines: deadlines}, nil
				}},
			}).Connect(context.Background(), Hello{})
			if err != nil {
				t.Fatal(err)
			}
			defer stream.Close()
			ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
			defer cancel()
			if err := stream.Send(ctx, heartbeat); err != nil {
				t.Fatal(err)
			}
			<-deadlines
			<-ctx.Done()
			started := time.Now()
			if err := stream.Send(context.Background(), heartbeat); err != nil {
				t.Fatalf("successful earlier write left an expired deadline on the connection: %v", err)
			}
			deadline := <-deadlines
			if budget := deadline.Sub(started); budget < 9*time.Second || budget > 11*time.Second {
				t.Fatalf("socket write budget = %s, want the default 10 seconds", budget)
			}
		})
	}
}
