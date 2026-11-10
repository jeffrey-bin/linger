package realtime

import (
	"context"
	"testing"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

type recordingNotifier struct {
	sent []store.PublishInvalidationParams
}

func (n *recordingNotifier) PublishInvalidation(_ context.Context, arg store.PublishInvalidationParams) error {
	n.sent = append(n.sent, arg)
	return nil
}

func TestInvalidatePublishesOnTheTenantTopic(t *testing.T) {
	notifier := &recordingNotifier{}
	if err := Invalidate(context.Background(), notifier, Invalidation{
		TenantID: "tenant_1", Resource: InvalidateRoom, ID: "room_1", RoomSeq: 9,
	}); err != nil {
		t.Fatal(err)
	}
	want := store.PublishInvalidationParams{Topic: "tenant:tenant_1", Kind: "invalidate.room", ResourceID: "room_1", Sequence: 9}
	if len(notifier.sent) != 1 || notifier.sent[0] != want {
		t.Fatalf("sent=%+v want %+v", notifier.sent, want)
	}
	for name, hint := range map[string]Invalidation{
		"unknown resource":           {TenantID: "tenant_1", Resource: "secrets", ID: "x"},
		"missing tenant":             {Resource: InvalidateDocument, ID: "document_1"},
		"missing id":                 {TenantID: "tenant_1", Resource: InvalidateDocument},
		"room_seq on a Tenant hint":  {TenantID: "tenant_1", Resource: InvalidateDirectory, ID: "tenant_1", RoomSeq: 1},
		"line break in the identity": {TenantID: "tenant_1", Resource: InvalidateDocument, ID: "a\nb"},
	} {
		if err := Invalidate(context.Background(), notifier, hint); err == nil {
			t.Fatalf("%s accepted", name)
		}
	}
	if len(notifier.sent) != 1 {
		t.Fatalf("rejected hints were sent: %+v", notifier.sent)
	}
}

func TestDecodeInvalidationNotification(t *testing.T) {
	notification, err := DecodeNotification([]byte(`{"topic":"tenant:tenant_1","kind":"invalidate.document","resource_id":"document_1","sequence":0,"revision":0}`))
	if err != nil {
		t.Fatal(err)
	}
	hint, ok := InvalidationFromEvent(notification.Event())
	if !ok || hint != (Invalidation{TenantID: "tenant_1", Resource: InvalidateDocument, ID: "document_1"}) {
		t.Fatalf("hint=%+v ok=%t", hint, ok)
	}
	if _, err := DecodeNotification([]byte(`{"topic":"tenant:tenant_1","kind":"invalidate.room","resource_id":"room_1","sequence":4,"revision":0}`)); err != nil {
		t.Fatalf("Room hint with room_seq rejected: %v", err)
	}
	for _, payload := range []string{
		`{"topic":"tenant:tenant_1","kind":"invalidate.secrets","resource_id":"x","sequence":0,"revision":0}`,
		`{"topic":"tenant:tenant_1","kind":"voice.changed","resource_id":"x","sequence":1,"revision":0}`,
		`{"topic":"tenant:tenant_1","kind":"invalidate.document","resource_id":"document_1","sequence":3,"revision":0}`,
		`{"topic":"tenant:tenant_1","kind":"invalidate.room","resource_id":"room_1","sequence":0,"revision":2}`,
	} {
		if _, err := DecodeNotification([]byte(payload)); err == nil {
			t.Fatalf("accepted %s", payload)
		}
	}
}

func TestHumanEventsTopicFollowsRoomEventsAndHints(t *testing.T) {
	broker := NewBroker(8)
	subscription := broker.Subscribe(HumanEventsTopic)
	defer subscription.Close()
	broker.Publish(Event{Topic: "room:room_1", Kind: "message.draft.changed", ResourceID: "draft_1", Revision: 2})
	broker.Publish(Event{Topic: "voice:voice_1", Kind: "voice.changed", ResourceID: "voice_1", Sequence: 1})
	broker.Publish(Event{Topic: "room:room_1", Kind: "room.event", ResourceID: "event_1", Sequence: 3})
	broker.Publish(Event{Topic: "tenant:tenant_1", Kind: "invalidate.computers", ResourceID: "tenant_1"})
	burst := subscription.Drain(<-subscription.Events())
	if len(burst) != 2 || burst[0].Topic != "room:room_1" || burst[0].Sequence != 3 ||
		burst[1].Topic != "tenant:tenant_1" || burst[1].Kind != "invalidate.computers" {
		t.Fatalf("burst=%+v", burst)
	}
}

func TestHumanEventsSubscriberThatFallsBehindGetsOneReconcile(t *testing.T) {
	broker := NewBroker(2)
	subscription := broker.Subscribe(HumanEventsTopic)
	defer subscription.Close()
	for sequence := int64(1); sequence <= 5; sequence++ {
		broker.Publish(Event{Topic: "room:room_1", Kind: "room.event", ResourceID: "event", Sequence: sequence})
	}
	select {
	case <-subscription.Done():
		t.Fatal("a slow browser stream was disconnected")
	default:
	}
	burst := subscription.Drain(<-subscription.Events())
	reconciles := 0
	for _, event := range burst {
		if event.Kind == ReconcileKind {
			reconciles++
		}
	}
	if reconciles != 1 || len(burst) > 2 {
		t.Fatalf("burst=%+v", burst)
	}
}
