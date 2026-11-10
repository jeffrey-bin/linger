package realtime

import (
	"context"
	"fmt"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ListenerApplicationName names the Listener's PostgreSQL session, so
// operators and tests can find the one backend that holds LISTEN.
const ListenerApplicationName = "teamhub-realtime-listener"

const (
	listenerReconnectMinimum = 100 * time.Millisecond
	listenerReconnectMaximum = 5 * time.Second
	listenerCloseTimeout     = 5 * time.Second
	listenerShutdownTimeout  = 10 * time.Second
)

type listenerConnection interface {
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
	WaitForNotification(context.Context) (*pgconn.Notification, error)
	Close(context.Context) error
}

type listenerConnector func(context.Context, *pgx.ConnConfig) (listenerConnection, error)

type ListenerStatus struct {
	Connected            bool   `json:"connected"`
	Reconnects           uint64 `json:"reconnects"`
	Notifications        uint64 `json:"notifications"`
	InvalidNotifications uint64 `json:"invalid_notifications"`
}

type Listener struct {
	connectionConfig *pgx.ConnConfig
	broker           *Broker
	logger           *slog.Logger
	connector        listenerConnector
	closeTimeout     time.Duration
	shutdownTimeout  time.Duration

	mu      sync.Mutex
	cancel  context.CancelFunc
	done    chan struct{}
	started bool

	connected            atomic.Bool
	reconnects           atomic.Uint64
	notifications        atomic.Uint64
	invalidNotifications atomic.Uint64
}

func NewListener(databaseURL string, broker *Broker, logger *slog.Logger) (*Listener, error) {
	poolConfig, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		return nil, fmt.Errorf("parse realtime database URL: %w", err)
	}
	if broker == nil {
		return nil, fmt.Errorf("realtime Broker is required")
	}
	if logger == nil {
		logger = slog.Default()
	}
	connectionConfig := poolConfig.ConnConfig.Copy()
	connectionConfig.RuntimeParams["application_name"] = ListenerApplicationName
	return &Listener{
		connectionConfig: connectionConfig, broker: broker, logger: logger,
		connector: func(ctx context.Context, config *pgx.ConnConfig) (listenerConnection, error) {
			return pgx.ConnectConfig(ctx, config)
		},
		closeTimeout: listenerCloseTimeout, shutdownTimeout: listenerShutdownTimeout,
	}, nil
}

// Start establishes LISTEN synchronously so App creation cannot report ready
// before the Pod is able to receive cross-Pod wakes.
func (listener *Listener) Start(ctx context.Context) error {
	listener.mu.Lock()
	defer listener.mu.Unlock()
	if listener.started {
		return fmt.Errorf("realtime Listener is already started")
	}
	connection, err := listener.connect(ctx)
	if err != nil {
		return err
	}
	runContext, cancel := context.WithCancel(context.Background())
	listener.cancel = cancel
	listener.done = make(chan struct{})
	listener.started = true
	listener.connected.Store(true)
	go listener.run(runContext, connection)
	return nil
}

func (listener *Listener) connect(ctx context.Context) (listenerConnection, error) {
	connection, err := listener.connector(ctx, listener.connectionConfig.Copy())
	if err != nil {
		return nil, fmt.Errorf("connect realtime Listener: %w", err)
	}
	if _, err := connection.Exec(ctx, "LISTEN "+pgx.Identifier{ChannelName}.Sanitize()); err != nil {
		listener.closeConnection(connection)
		return nil, fmt.Errorf("subscribe realtime Listener: %w", err)
	}
	return connection, nil
}

func (listener *Listener) closeConnection(connection listenerConnection) {
	closeContext, cancel := context.WithTimeout(context.Background(), listener.closeTimeout)
	defer cancel()
	closed := make(chan error, 1)
	go func() {
		closed <- connection.Close(closeContext)
	}()
	select {
	case err := <-closed:
		if err != nil && closeContext.Err() == nil {
			listener.logger.Warn("close realtime Listener connection", "error", err)
		}
	case <-closeContext.Done():
		listener.logger.Warn("close realtime Listener connection timed out")
	}
}

func (listener *Listener) run(ctx context.Context, connection listenerConnection) {
	defer close(listener.done)
	current := connection
	for {
		notification, err := current.WaitForNotification(ctx)
		if err == nil {
			decoded, decodeErr := DecodeNotification([]byte(notification.Payload))
			if decodeErr != nil {
				listener.invalidNotifications.Add(1)
				listener.logger.Warn("discard invalid realtime notification", "error", decodeErr)
				continue
			}
			listener.notifications.Add(1)
			listener.broker.Publish(decoded.Event())
			continue
		}
		listener.connected.Store(false)
		listener.closeConnection(current)
		if ctx.Err() != nil {
			return
		}
		listener.logger.Warn("realtime Listener disconnected", "error", err)
		var reconnectErr error
		for delay := listenerReconnectMinimum; ; delay = min(delay*2, listenerReconnectMaximum) {
			timer := time.NewTimer(delay)
			select {
			case <-ctx.Done():
				timer.Stop()
				return
			case <-timer.C:
			}
			current, reconnectErr = listener.connect(ctx)
			if reconnectErr == nil {
				break
			}
			listener.logger.Warn("reconnect realtime Listener", "error", reconnectErr)
		}
		listener.connected.Store(true)
		listener.reconnects.Add(1)
		listener.broker.PublishAll()
		listener.logger.Info("realtime Listener reconnected")
	}
}

func (listener *Listener) Status() ListenerStatus {
	return ListenerStatus{
		Connected: listener.connected.Load(), Reconnects: listener.reconnects.Load(),
		Notifications: listener.notifications.Load(), InvalidNotifications: listener.invalidNotifications.Load(),
	}
}

func (listener *Listener) Close() {
	listener.mu.Lock()
	if !listener.started {
		listener.mu.Unlock()
		return
	}
	cancel, done := listener.cancel, listener.done
	listener.started = false
	listener.mu.Unlock()
	cancel()
	timer := time.NewTimer(listener.shutdownTimeout)
	defer timer.Stop()
	select {
	case <-done:
	case <-timer.C:
		listener.logger.Warn("realtime Listener shutdown timed out")
	}
	listener.connected.Store(false)
}
