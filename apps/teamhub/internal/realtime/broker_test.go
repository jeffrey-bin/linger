package realtime

import (
	"fmt"
	"testing"
	"time"
)

func TestBrokerDisconnectsSlowSubscriberWhenQueueIsFull(t *testing.T) {
	broker := NewBroker(1)
	subscriber := broker.Subscribe("room_1")
	defer subscriber.Close()

	broker.Publish(Event{Topic: "room_1", Sequence: 1})
	broker.Publish(Event{Topic: "room_1", Sequence: 2})

	select {
	case <-subscriber.Done():
	case <-time.After(time.Second):
		t.Fatal("slow subscriber was not disconnected")
	}
	broker.mu.Lock()
	remaining := len(broker.topics["room_1"])
	broker.mu.Unlock()
	if remaining != 0 {
		t.Fatalf("subscriber count=%d want=0", remaining)
	}
}

func TestBrokerDeliversTheSameOrderToRoomSubscribers(t *testing.T) {
	broker := NewBroker(4)
	first := broker.Subscribe("room_1")
	second := broker.Subscribe("room_1")
	defer first.Close()
	defer second.Close()

	for sequence := int64(1); sequence <= 2; sequence++ {
		broker.Publish(Event{Topic: "room_1", Sequence: sequence})
	}
	for name, subscriber := range map[string]*Subscription{"first": first, "second": second} {
		for expected := int64(1); expected <= 2; expected++ {
			select {
			case event := <-subscriber.Events():
				if event.Sequence != expected {
					t.Fatalf("%s received sequence=%d want=%d", name, event.Sequence, expected)
				}
			case <-time.After(time.Second):
				t.Fatalf("%s timed out waiting for room_seq=%d", name, expected)
			}
		}
	}
}

func TestBrokerPublishAllWakesEveryActiveTopic(t *testing.T) {
	broker := NewBroker(2)
	room := broker.Subscribe("room:room_1")
	voice := broker.Subscribe("voice:voice_1")
	defer room.Close()
	defer voice.Close()

	broker.PublishAll()

	for topic, subscriber := range map[string]*Subscription{
		"room:room_1":   room,
		"voice:voice_1": voice,
	} {
		select {
		case event := <-subscriber.Events():
			if event.Topic != topic || event.Kind != ReconcileKind {
				t.Fatalf("topic=%s event=%+v", topic, event)
			}
		case <-time.After(time.Second):
			t.Fatalf("topic=%s did not receive reconciliation wake", topic)
		}
	}
}

func TestBrokerAgentWakesReachSubscribersWithoutRoomResolution(t *testing.T) {
	broker := NewBroker(4)
	subscription := broker.Subscribe(AgentInboxWakeTopic)
	defer subscription.Close()
	// A committed Room event no longer fans out into Agent hints: the Message
	// transaction queued the work and published run.queued itself.
	broker.Publish(Event{Topic: "room:room_1", Kind: "room.event", ResourceID: "event_1", Sequence: 8})
	broker.Publish(Event{Topic: AgentInboxWakeTopic, Kind: RunQueuedKind, ContextKey: "context-1"})
	broker.Publish(Event{Topic: AgentInboxWakeTopic, Kind: RunSteeredKind, ContextKey: "context-2"})
	// Pending hints may merge out of order; each still arrives once.
	pending := map[Event]bool{
		{Topic: AgentInboxWakeTopic, Kind: RunQueuedKind, ContextKey: "context-1"}:  true,
		{Topic: AgentInboxWakeTopic, Kind: RunSteeredKind, ContextKey: "context-2"}: true,
	}
	for len(pending) > 0 {
		select {
		case actual := <-subscription.Events():
			if !pending[actual] {
				t.Fatalf("unexpected or duplicate wake=%+v", actual)
			}
			delete(pending, actual)
		case <-time.After(time.Second):
			t.Fatalf("wakes %+v were not delivered", pending)
		}
	}
	select {
	case actual := <-subscription.Events():
		t.Fatalf("unexpected extra wake=%+v", actual)
	default:
	}
	broker.PublishAll()
	if actual := <-subscription.Events(); actual != (Event{Topic: AgentInboxWakeTopic, Kind: ReconcileKind}) {
		t.Fatalf("reconnect wake=%+v", actual)
	}
}

func TestBrokerAgentWakeBurstCoalescesDuplicateContexts(t *testing.T) {
	broker := NewBroker(4)
	subscription := broker.Subscribe(AgentInboxWakeTopic)
	defer subscription.Close()
	for range 5 {
		broker.Publish(Event{Topic: AgentInboxWakeTopic, Kind: RunQueuedKind, ContextKey: "context-1"})
	}
	for _, revision := range []int64{3, 9, 2} {
		broker.Publish(Event{Topic: AgentInboxWakeTopic, Kind: "context.changed", ContextKey: "context-1", Revision: revision})
	}
	select {
	case <-subscription.Done():
		t.Fatal("duplicate hints disconnected the Agent subscription")
	default:
	}
	if pending := len(subscription.events); pending != 2 {
		t.Fatalf("coalesced hints=%d want=2", pending)
	}
	for range 2 {
		switch event := <-subscription.Events(); event.Kind {
		case RunQueuedKind:
			if event.ContextKey != "context-1" {
				t.Fatalf("coalesced run wake=%+v", event)
			}
		case "context.changed":
			if event.Revision != 9 {
				t.Fatalf("coalesced Context change=%+v", event)
			}
		default:
			t.Fatalf("unexpected wake=%+v", event)
		}
	}
}

func TestBrokerTaskClaimableCoalescesAndStaysServiceOnly(t *testing.T) {
	broker := NewBroker(4)
	agent := broker.Subscribe(AgentInboxWakeTopic)
	defer agent.Close()
	human := broker.Subscribe(HumanEventsTopic)
	defer human.Close()
	claimable := Event{Topic: AgentInboxWakeTopic, Kind: TaskClaimableKind}
	for range 5 {
		broker.Publish(claimable)
	}
	broker.Publish(Event{Topic: AgentInboxWakeTopic, Kind: RunQueuedKind, ContextKey: "context-1"})
	broker.Publish(claimable)
	if pending := len(agent.events); pending != 2 {
		t.Fatalf("coalesced hints=%d want=2", pending)
	}
	pending := map[Event]bool{claimable: true, {Topic: AgentInboxWakeTopic, Kind: RunQueuedKind, ContextKey: "context-1"}: true}
	for range 2 {
		event := <-agent.Events()
		if !pending[event] {
			t.Fatalf("unexpected or duplicate wake=%+v", event)
		}
		delete(pending, event)
	}
	select {
	case event := <-human.Events():
		t.Fatalf("browser stream received service hint %+v", event)
	default:
	}
}

func TestBrokerAgentWakeDistinctBurstRetainsBoundedReconcile(t *testing.T) {
	broker := NewBroker(4)
	subscription := broker.Subscribe(AgentInboxWakeTopic)
	defer subscription.Close()
	published := make(chan struct{})
	go func() {
		defer close(published)
		for index := 0; index < 5000; index++ {
			broker.Publish(Event{Topic: AgentInboxWakeTopic, Kind: RunQueuedKind, ContextKey: fmt.Sprintf("context-%d", index)})
			if index%13 == 0 {
				// A slow consumer may take earlier reconciliation hints during the burst.
				select {
				case <-subscription.Events():
				default:
				}
			}
		}
		// Leave another burst pending after the slow consumer stops. Its final
		// recovery hint must survive even when individual hints cannot fit.
		for index := 5000; index < 5005; index++ {
			broker.Publish(Event{Topic: AgentInboxWakeTopic, Kind: RunQueuedKind, ContextKey: fmt.Sprintf("context-%d", index)})
		}
	}()
	select {
	case <-published:
	case <-time.After(time.Second):
		t.Fatal("hint burst publication waited for the slow subscriber")
	}
	select {
	case <-subscription.Done():
		t.Fatal("distinct hint burst disconnected the Agent subscription")
	default:
	}
	if pending := len(subscription.events); pending > 4 {
		t.Fatalf("hint queue exceeded its bound: %d", pending)
	}
	reconciles := 0
	for len(subscription.events) > 0 {
		if event := <-subscription.Events(); event.Kind == ReconcileKind {
			reconciles++
		}
	}
	if reconciles != 1 {
		t.Fatalf("pending reconciliation hints=%d want=1", reconciles)
	}
	broker.Publish(Event{Topic: AgentInboxWakeTopic, Kind: RunQueuedKind, ContextKey: "context-after-burst"})
	if event := <-subscription.Events(); event.ContextKey != "context-after-burst" {
		t.Fatalf("Agent subscription did not recover after the burst: %+v", event)
	}
}

func TestSubscriptionDrainReturnsTheQueuedBurst(t *testing.T) {
	broker := NewBroker(4)
	subscription := broker.Subscribe("voice:voice_1")
	defer subscription.Close()
	for sequence := int64(1); sequence <= 3; sequence++ {
		broker.Publish(Event{Topic: "voice:voice_1", Kind: "voice.changed", ResourceID: "voice_1", Sequence: sequence})
	}
	burst := subscription.Drain(<-subscription.Events())
	if len(burst) != 3 || burst[0].Sequence != 1 || burst[2].Sequence != 3 {
		t.Fatalf("drained burst=%+v", burst)
	}
	select {
	case event := <-subscription.Events():
		t.Fatalf("hint left after drain: %+v", event)
	default:
	}
}

func TestBrokerWorkWakeBypassesSubscribers(t *testing.T) {
	broker := NewBroker(4)
	wakes, reconnects := 0, 0
	broker.SetWorkWake(WorkRiverDueTopic, func(reconnect bool) {
		wakes++
		if reconnect {
			reconnects++
		}
	})
	direct := broker.Subscribe(WorkRiverDueTopic)
	defer direct.Close()
	human := broker.Subscribe(HumanEventsTopic)
	defer human.Close()
	agent := broker.Subscribe(AgentInboxWakeTopic)
	defer agent.Close()
	broker.Publish(Event{Topic: WorkRiverDueTopic, Kind: WorkReadyKind, ResourceID: "all"})
	if wakes != 1 || reconnects != 0 {
		t.Fatalf("wakes=%d reconnects=%d want=1,0", wakes, reconnects)
	}
	for name, subscription := range map[string]*Subscription{"direct": direct, "human": human, "agent": agent} {
		select {
		case event := <-subscription.Events():
			t.Fatalf("%s subscriber received work wake %+v", name, event)
		default:
		}
	}
	broker.PublishAll()
	if wakes != 2 || reconnects != 1 {
		t.Fatalf("wakes=%d reconnects=%d want=2,1", wakes, reconnects)
	}
}
