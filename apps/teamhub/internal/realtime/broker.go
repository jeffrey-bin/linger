package realtime

import (
	"maps"
	"slices"
	"strings"
	"sync"
)

// Event is a Topic wake-up hint for a committed persisted event; it does not carry recoverable event content.
type Event struct {
	Topic      string
	Kind       string
	ResourceID string
	Sequence   int64
	Revision   int64
	ContextKey string
}

const (
	// ReconcileKind tells a subscriber that hints may have been lost and it
	// must read PostgreSQL state again.
	ReconcileKind = "reconcile"
	// AgentInboxWakeTopic is service-only. Payloads name a Context and what
	// changed for it; the Agent Service reads the work itself.
	AgentInboxWakeTopic = "agent-inbox:all"
	// HumanEventsTopic feeds every browser /v0/events stream of this process:
	// each committed Room Event wake and each Tenant invalidation hint, with
	// its original Topic. Streams authorize what they forward.
	HumanEventsTopic = "human-events:all"
)

// Broker broadcasts non-persisted wake-up hints to in-process Topic subscribers. Hints come only from Listener
// commit notifications, and each committed row is delivered at most once.
// Publishing must not wait for slow subscribers; after a normal Topic disconnect, SSE cursors and PostgreSQL restore state,
// and Agent Inbox hints collapse into a bounded reread hint when the queue is full.
type Broker struct {
	mu            sync.Mutex
	queueCapacity int
	nextID        uint64
	topics        map[string]map[uint64]*Subscription
	workWakes     map[string]func(reconnect bool)
}

// Subscription provides a Topic's wake-up queue and an independent lifecycle signal.
type Subscription struct {
	broker *Broker
	topic  string
	id     uint64
	events chan Event
	done   chan struct{}
	once   sync.Once
}

// NewBroker creates a Broker; each subscriber keeps at least one pending wake-up hint.
func NewBroker(queueCapacity int) *Broker {
	if queueCapacity < 1 {
		queueCapacity = 1
	}
	return &Broker{queueCapacity: queueCapacity, topics: make(map[string]map[uint64]*Subscription), workWakes: make(map[string]func(reconnect bool))}
}

// SetWorkWake routes a service-only work topic to wake instead of to
// subscribers. wake must not block or do I/O; it runs on the Listener's
// goroutine for each notification and, with reconnect set, after each
// reconnect.
func (b *Broker) SetWorkWake(topic string, wake func(reconnect bool)) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.workWakes[topic] = wake
}

// Subscribe registers an in-process subscription to the given Topic.
func (b *Broker) Subscribe(topic string) *Subscription {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.nextID++
	subscription := &Subscription{
		broker: b, topic: topic, id: b.nextID,
		events: make(chan Event, b.queueCapacity), done: make(chan struct{}),
	}
	if b.topics[topic] == nil {
		b.topics[topic] = make(map[uint64]*Subscription)
	}
	b.topics[topic][subscription.id] = subscription
	return subscription
}

// Publish notifies the Topic's current subscribers without waiting for them to consume.
func (b *Broker) Publish(event Event) {
	b.mu.Lock()
	wake, work := b.workWakes[event.Topic]
	b.mu.Unlock()
	if work {
		wake(false)
		return
	}
	b.publishDirect(event)
	if humanEvent(event) {
		b.publishTo(HumanEventsTopic, event)
	}
}

// PublishAll asks every active local topic to reconcile against PostgreSQL.
// It is used after a LISTEN session reconnects because notifications may have
// been lost while the session was unavailable. It also calls every work wake.
func (b *Broker) PublishAll() {
	b.mu.Lock()
	wakes := slices.Collect(maps.Values(b.workWakes))
	for topic, subscriptions := range b.topics {
		for id, subscription := range subscriptions {
			if !subscription.enqueueLocked(Event{Topic: topic, Kind: ReconcileKind}) {
				subscription.closeLocked()
				delete(subscriptions, id)
			}
		}
		if len(subscriptions) == 0 {
			delete(b.topics, topic)
		}
	}
	b.mu.Unlock()
	for _, wake := range wakes {
		wake(true)
	}
}

// humanEvent selects what browsers follow: committed Room Events and Tenant
// invalidation hints. Draft and voice wakes keep their own streams.
func humanEvent(event Event) bool {
	if strings.HasPrefix(event.Topic, "room:") {
		return event.Kind == "room.event" && event.Sequence > 0
	}
	_, hint := InvalidationFromEvent(event)
	return hint
}

func (b *Broker) publishDirect(event Event) {
	b.publishTo(event.Topic, event)
}

// publishTo delivers event unchanged to the subscribers of topic.
func (b *Broker) publishTo(topic string, event Event) {
	b.mu.Lock()
	defer b.mu.Unlock()
	for id, subscription := range b.topics[topic] {
		if !subscription.enqueueLocked(event) {
			// A full queue means the subscriber cannot keep up. Disconnecting it protects the publish path, and the client replays from its last cursor.
			subscription.closeLocked()
			delete(b.topics[topic], id)
		}
	}
	if len(b.topics[topic]) == 0 {
		delete(b.topics, topic)
	}
}

func (s *Subscription) enqueueLocked(event Event) bool {
	if s.topic == AgentInboxWakeTopic {
		s.coalesceInboxWakeLocked(event)
		return true
	}
	if s.topic == HumanEventsTopic {
		s.collapseWhenFullLocked(event)
		return true
	}
	select {
	case s.events <- event:
		return true
	default:
		return false
	}
}

// Only pending hints are merged, without retaining a history or waiting for
// the consumer. A reconciliation covers every discarded Context hint.
func (s *Subscription) coalesceInboxWakeLocked(event Event) {
	capacity := cap(s.events)
	merged := make([]Event, 0, capacity)
	reconcile := false
	merge := func(hint Event) {
		if hint.Kind == ReconcileKind {
			reconcile = true
		}
		if reconcile {
			return
		}
		for index, queued := range merged {
			if queued.ContextKey == hint.ContextKey && queued.ResourceID == hint.ResourceID && queued.Kind == hint.Kind {
				// Context hints keep the newest revision.
				if hint.Revision > queued.Revision {
					merged[index] = hint
				}
				return
			}
		}
		if len(merged) == capacity {
			reconcile = true
			return
		}
		merged = append(merged, hint)
	}
	merge(event)
	for {
		select {
		case queued := <-s.events:
			merge(queued)
		default:
			// broker.mu excludes other publishers and the consumer only frees
			// capacity, so these bounded buffered sends cannot wait.
			if reconcile {
				s.events <- Event{Topic: s.topic, Kind: ReconcileKind}
			} else {
				for _, hint := range merged {
					s.events <- hint
				}
			}
			return
		}
	}
}

// A browser stream that falls behind the instance-wide feed is not
// disconnected: its pending hints collapse into one reconciliation, which the
// stream answers by rereading its Room cursors and sending stream.resync.
func (s *Subscription) collapseWhenFullLocked(event Event) {
	select {
	case s.events <- event:
		return
	default:
	}
	for {
		select {
		case <-s.events:
		default:
			// broker.mu excludes other publishers, so the emptied queue has room.
			s.events <- Event{Topic: s.topic, Kind: ReconcileKind}
			return
		}
	}
}

// Events returns the wake-up hint channel; callers must read the event body from PostgreSQL.
func (s *Subscription) Events() <-chan Event { return s.events }

// Drain returns first followed by every hint already queued behind it, so a
// stream answers one burst of commits with one read.
func (s *Subscription) Drain(first Event) []Event {
	events := []Event{first}
	for {
		select {
		case event := <-s.events:
			events = append(events, event)
		default:
			return events
		}
	}
}

// Done returns the subscription close signal.
func (s *Subscription) Done() <-chan struct{} { return s.done }

// Close unregisters the subscription and closes Done; it is safe to call repeatedly.
func (s *Subscription) Close() {
	s.once.Do(func() {
		s.broker.mu.Lock()
		defer s.broker.mu.Unlock()
		if subscriptions := s.broker.topics[s.topic]; subscriptions != nil {
			delete(subscriptions, s.id)
			if len(subscriptions) == 0 {
				delete(s.broker.topics, s.topic)
			}
		}
		close(s.done)
	})
}

func (s *Subscription) closeLocked() {
	// The caller already holds broker.mu, so it cannot reuse Close, which locks again. Close only closes done,
	// events carries only wake-up hints; closing it would make receivers read zero values forever, so the subscription lifecycle must be expressed only by Done.
	s.once.Do(func() { close(s.done) })
}
