package daemon

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/transport"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/protocol"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider/redact"
)

// defaultContextDispatchLimit caps how many queued Runner Gateway commands run
// at once across all execution Contexts of one connection.
const defaultContextDispatchLimit = 8

// commandDispatcher runs one connection's Context-scoped Runner Gateway
// commands. Commands of one execution Context run FIFO on a single worker, so
// their order is the receive order. Different Contexts run in parallel up to
// the dispatch limit. Every worker uses only this connection's stream and
// context, and the connection waits for all workers before it returns.
type commandDispatcher struct {
	stream transport.Stream
	ctx    context.Context
	cancel context.CancelFunc
	slots  chan struct{}
	// closeOnce closes the stream once, on a fatal handler error or shutdown.
	closeOnce sync.Once

	mu sync.Mutex
	// idle is signaled when the last worker exits.
	idle       *sync.Cond
	workers    int
	queues     map[string]*dispatchQueue
	live       map[*dispatchItem]struct{}
	operations map[string]*dispatchItem
	// err is the first handler error that ends the connection.
	err error
}

type dispatchQueue struct {
	items []*dispatchItem
}

type dispatchTask struct {
	command protocol.Command
	run     func() error
}

type dispatchItem struct {
	dispatchTask
	receivedAt time.Time
	followUps  []dispatchTask
	done       chan struct{}
	// operationKey indexes the item while it is live.
	operationKey string
}

func newCommandDispatcher(parent context.Context, stream transport.Stream, limit int) *commandDispatcher {
	if limit <= 0 {
		limit = defaultContextDispatchLimit
	}
	ctx, cancel := context.WithCancel(parent)
	c := &commandDispatcher{
		stream: stream, ctx: ctx, cancel: cancel, slots: make(chan struct{}, limit),
		queues:     make(map[string]*dispatchQueue),
		live:       make(map[*dispatchItem]struct{}),
		operations: make(map[string]*dispatchItem),
	}
	c.idle = sync.NewCond(&c.mu)
	return c
}

func contextDispatchKey(command protocol.Command) string {
	return command.TenantID + "\x00" + command.ExecutionContextKey
}

func operationDispatchKey(command protocol.Command) string {
	return command.TenantID + "\x00" + command.OperationID
}

// route runs a command inline when it has no execution Context. Otherwise it
// queues the command on that Context. The receive loop never runs the handler
// of a queued command.
func (c *commandDispatcher) route(command protocol.Command, run func() error) error {
	if command.ExecutionContextKey == "" {
		return run()
	}
	c.submit(command, run)
	return nil
}

func (c *commandDispatcher) submit(command protocol.Command, run func() error) {
	item := &dispatchItem{
		dispatchTask: dispatchTask{command: command, run: run},
		receivedAt:   time.Now(),
		done:         make(chan struct{}),
	}
	key := contextDispatchKey(command)
	c.mu.Lock()
	defer c.mu.Unlock()
	c.live[item] = struct{}{}
	switch command.Type {
	case protocol.CommandOperationStart, protocol.CommandOperationPrepare:
		item.operationKey = operationDispatchKey(command)
		c.operations[item.operationKey] = item
	}
	queue := c.queues[key]
	if queue == nil {
		queue = &dispatchQueue{}
		c.queues[key] = queue
		c.workers++
		go c.runQueue(key)
	}
	queue.items = append(queue.items, item)
}

// followOperation attaches a cancel or input command to the queued or running
// start or prepare of the same Operation. The worker runs it right after that
// item's handler returns, so it cannot overtake the admission it targets.
func (c *commandDispatcher) followOperation(command protocol.Command, run func() error) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	item := c.operations[operationDispatchKey(command)]
	if item == nil {
		return false
	}
	item.followUps = append(item.followUps, dispatchTask{command: command, run: run})
	return true
}

// awaitAgent blocks until every item already received for the Agent has
// finished. Runner lifecycle commands and CLI credential writes wait here so
// they never interleave with an in-flight apply or start of that Agent.
func (c *commandDispatcher) awaitAgent(tenantID, agentID string) error {
	c.mu.Lock()
	var waits []chan struct{}
	for item := range c.live {
		if item.command.TenantID == tenantID && item.command.AgentID == agentID {
			waits = append(waits, item.done)
		}
	}
	c.mu.Unlock()
	return c.await(waits)
}

// awaitAll blocks until every item already received has finished.
func (c *commandDispatcher) awaitAll() error {
	c.mu.Lock()
	waits := make([]chan struct{}, 0, len(c.live))
	for item := range c.live {
		waits = append(waits, item.done)
	}
	c.mu.Unlock()
	return c.await(waits)
}

func (c *commandDispatcher) await(waits []chan struct{}) error {
	for _, done := range waits {
		select {
		case <-done:
		case <-c.ctx.Done():
			return c.ctx.Err()
		}
	}
	return nil
}

// activeCount counts queued and executing items for the DrainIfIdle check.
func (c *commandDispatcher) activeCount() int {
	if c == nil {
		return 0
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.live)
}

// waitWorkers blocks until every worker has exited.
func (c *commandDispatcher) waitWorkers() {
	if c == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	for c.workers > 0 {
		c.idle.Wait()
	}
}

// shutdown ends the connection's dispatch. It cancels pending work, closes the
// stream to unblock Receive, and waits for all workers before returning the
// first handler error that ended the connection.
func (c *commandDispatcher) shutdown() error {
	c.cancel()
	c.closeStream()
	c.waitWorkers()
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.err
}

func (c *commandDispatcher) closeStream() {
	c.closeOnce.Do(func() { _ = c.stream.Close() })
}

func (c *commandDispatcher) runQueue(key string) {
	defer c.exitWorker()
	for {
		c.mu.Lock()
		queue := c.queues[key]
		if len(queue.items) == 0 {
			delete(c.queues, key)
			c.mu.Unlock()
			return
		}
		item := queue.items[0]
		queue.items[0] = nil
		queue.items = queue.items[1:]
		c.mu.Unlock()
		c.execute(item)
	}
}

func (c *commandDispatcher) exitWorker() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.workers--
	if c.workers == 0 {
		c.idle.Broadcast()
	}
}

func (c *commandDispatcher) execute(item *dispatchItem) {
	if !c.acquireSlot() {
		c.drop(item)
		return
	}
	defer func() { <-c.slots }()
	slog.Info("runner.command.dispatch", "type", item.command.Type, "command_id", item.command.CommandID,
		"operation_id", item.command.OperationID, "agent_id", item.command.AgentID,
		"execution_context_key", item.command.ExecutionContextKey,
		"queued_ms", time.Since(item.receivedAt).Milliseconds())
	c.handleError(item.command, item.run())
	// Follow-ups run even after cancellation: they only update state that the
	// executing item already owns and need no stream of their own.
	for {
		c.mu.Lock()
		if len(item.followUps) == 0 {
			c.retireLocked(item)
			c.mu.Unlock()
			return
		}
		next := item.followUps[0]
		item.followUps = item.followUps[1:]
		c.mu.Unlock()
		c.handleError(next.command, next.run())
	}
}

func (c *commandDispatcher) acquireSlot() bool {
	select {
	case c.slots <- struct{}{}:
	case <-c.ctx.Done():
		return false
	}
	if c.ctx.Err() != nil {
		<-c.slots
		return false
	}
	return true
}

// drop retires an item that never ran, along with its follow-ups.
func (c *commandDispatcher) drop(item *dispatchItem) {
	c.mu.Lock()
	followUps := len(item.followUps)
	c.retireLocked(item)
	c.mu.Unlock()
	slog.Info("runner.command.dropped", "type", item.command.Type, "command_id", item.command.CommandID,
		"follow_up_count", followUps, "reason", "connection_ending")
}

// retireLocked removes a finished item from every index and wakes its waiters.
// The caller holds c.mu and must not retire an item twice.
func (c *commandDispatcher) retireLocked(item *dispatchItem) {
	delete(c.live, item)
	if item.operationKey != "" && c.operations[item.operationKey] == item {
		delete(c.operations, item.operationKey)
	}
	close(item.done)
}

// handleError makes a handler error connection-fatal, unless the connection is
// already ending. A fatal error stops the dispatch and closes the stream so
// Receive returns.
func (c *commandDispatcher) handleError(command protocol.Command, err error) {
	if err == nil {
		return
	}
	c.mu.Lock()
	ending := c.ctx.Err() != nil
	if !ending && c.err == nil {
		c.err = err
	}
	c.mu.Unlock()
	if ending {
		slog.Info("runner.command.ended_after_disconnect", "type", command.Type, "command_id", command.CommandID,
			"error", redact.Text(err.Error()))
		return
	}
	c.cancel()
	c.closeStream()
}
