package realtime

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

type blockingCloseListenerConnection struct {
	execErr      error
	waitErr      error
	closeRelease <-chan struct{}
	closeCalls   atomic.Int32
	closeBounded atomic.Bool
}

func (connection *blockingCloseListenerConnection) Exec(context.Context, string, ...any) (pgconn.CommandTag, error) {
	return pgconn.CommandTag{}, connection.execErr
}

func (connection *blockingCloseListenerConnection) WaitForNotification(ctx context.Context) (*pgconn.Notification, error) {
	if connection.waitErr != nil {
		return nil, connection.waitErr
	}
	<-ctx.Done()
	return nil, ctx.Err()
}

func (connection *blockingCloseListenerConnection) Close(ctx context.Context) error {
	connection.closeCalls.Add(1)
	if _, ok := ctx.Deadline(); ok {
		connection.closeBounded.Store(true)
	}
	if connection.closeRelease != nil {
		<-connection.closeRelease
		return nil
	}
	<-ctx.Done()
	return ctx.Err()
}

func newFaultInjectedListener(t *testing.T, connector listenerConnector) *Listener {
	t.Helper()
	listener, err := NewListener(
		"postgres://teamhub:teamhub@127.0.0.1:5432/teamhub?sslmode=disable",
		NewBroker(1), slog.New(slog.NewTextHandler(io.Discard, nil)),
	)
	if err != nil {
		t.Fatal(err)
	}
	listener.connector = connector
	listener.closeTimeout = 20 * time.Millisecond
	listener.shutdownTimeout = 200 * time.Millisecond
	return listener
}

func TestListenerStartBoundsConnectionCloseAfterListenFailure(t *testing.T) {
	closeRelease := make(chan struct{})
	t.Cleanup(func() { close(closeRelease) })
	connection := &blockingCloseListenerConnection{execErr: errors.New("LISTEN failed"), closeRelease: closeRelease}
	listener := newFaultInjectedListener(t, func(context.Context, *pgx.ConnConfig) (listenerConnection, error) {
		return connection, nil
	})

	startedAt := time.Now()
	if err := listener.Start(t.Context()); err == nil {
		t.Fatal("Start() error=nil")
	}
	if elapsed := time.Since(startedAt); elapsed > 150*time.Millisecond {
		t.Fatalf("Start() blocked for %s", elapsed)
	}
	if connection.closeCalls.Load() != 1 || !connection.closeBounded.Load() {
		t.Fatalf("close calls=%d bounded=%t", connection.closeCalls.Load(), connection.closeBounded.Load())
	}
}

func TestListenerReconnectAndShutdownBoundConnectionClose(t *testing.T) {
	closeRelease := make(chan struct{})
	t.Cleanup(func() { close(closeRelease) })
	disconnected := &blockingCloseListenerConnection{waitErr: errors.New("network half-open"), closeRelease: closeRelease}
	reconnected := &blockingCloseListenerConnection{closeRelease: closeRelease}
	var connects atomic.Int32
	listener := newFaultInjectedListener(t, func(context.Context, *pgx.ConnConfig) (listenerConnection, error) {
		if connects.Add(1) == 1 {
			return disconnected, nil
		}
		return reconnected, nil
	})
	subscription := listener.broker.Subscribe(AgentInboxWakeTopic)
	defer subscription.Close()
	if err := listener.Start(t.Context()); err != nil {
		t.Fatal(err)
	}

	deadline := time.Now().Add(time.Second)
	for listener.Status().Reconnects != 1 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if listener.Status().Reconnects != 1 {
		t.Fatal("Listener did not reconnect after bounded connection close")
	}
	select {
	case wake := <-subscription.Events():
		if wake.Kind != ReconcileKind {
			t.Fatalf("reconnect wake=%+v", wake)
		}
	case <-time.After(time.Second):
		t.Fatal("LISTEN reconnect did not reconcile Agent Inboxes")
	}
	if disconnected.closeCalls.Load() != 1 || !disconnected.closeBounded.Load() {
		t.Fatalf("disconnected close calls=%d bounded=%t", disconnected.closeCalls.Load(), disconnected.closeBounded.Load())
	}

	closed := make(chan struct{})
	go func() {
		listener.Close()
		close(closed)
	}()
	select {
	case <-closed:
	case <-time.After(150 * time.Millisecond):
		t.Fatal("Listener.Close() blocked on connection close")
	}
	if reconnected.closeCalls.Load() != 1 || !reconnected.closeBounded.Load() {
		t.Fatalf("reconnected close calls=%d bounded=%t", reconnected.closeCalls.Load(), reconnected.closeBounded.Load())
	}
}
