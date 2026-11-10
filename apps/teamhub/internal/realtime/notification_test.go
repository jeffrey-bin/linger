package realtime

import (
	"io"
	"log/slog"
	"testing"
)

func TestNewListenerConsumesPoolURLParameters(t *testing.T) {
	listener, err := NewListener(
		"postgres://teamhub:teamhub@127.0.0.1:5432/teamhub?sslmode=disable&pool_max_conns=1",
		NewBroker(1), slog.New(slog.NewTextHandler(io.Discard, nil)),
	)
	if err != nil {
		t.Fatal(err)
	}
	if _, found := listener.connectionConfig.RuntimeParams["pool_max_conns"]; found {
		t.Fatal("pool_max_conns leaked into PostgreSQL runtime parameters")
	}
}

func TestDecodeNotification(t *testing.T) {
	t.Run("accepts a Live task hint without a cursor", func(t *testing.T) {
		n, err := DecodeNotification([]byte(`{"topic":"voicetasks:room_1","kind":"voice.tasks.changed","resource_id":"task_1","sequence":0,"revision":0}`))
		if err != nil || n.ResourceID != "task_1" {
			t.Fatalf("Live wake=%+v error=%v", n, err)
		}
	})
	t.Run("accepts a voice change wake without a cursor", func(t *testing.T) {
		n, err := DecodeNotification([]byte(`{"topic" : "voice:voice_1", "kind" : "voice.changed", "resource_id" : "voice_1", "sequence" : 0, "revision" : 0}`))
		if err != nil || n.Kind != "voice.changed" || n.ResourceID != "voice_1" {
			t.Fatalf("voice wake=%+v error=%v", n, err)
		}
	})
	t.Run("rejects a voice change with a cursor", func(t *testing.T) {
		for _, payload := range []string{
			`{"topic":"voice:voice_1","kind":"voice.changed","resource_id":"voice_1","sequence":1,"revision":0}`,
			`{"topic":"voice:voice_1","kind":"voice.changed","resource_id":"voice_1","sequence":0,"revision":1}`,
		} {
			if _, err := DecodeNotification([]byte(payload)); err == nil {
				t.Fatalf("accepted %s", payload)
			}
		}
	})
	t.Run("requires a revision on a voice partial", func(t *testing.T) {
		if _, err := DecodeNotification([]byte(`{"topic":"voice:voice_1","kind":"voice.partial","resource_id":"voice_1","sequence":0,"revision":1}`)); err != nil {
			t.Fatal(err)
		}
		if _, err := DecodeNotification([]byte(`{"topic":"voice:voice_1","kind":"voice.partial","resource_id":"voice_1","sequence":0,"revision":0}`)); err == nil {
			t.Fatal("accepted a voice partial without a revision")
		}
	})
	t.Run("accepts bounded wake metadata", func(t *testing.T) {
		notification, err := DecodeNotification([]byte(`{"topic":"room:room_1","kind":"room.event","resource_id":"event_1","sequence":7,"revision":0}`))
		if err != nil {
			t.Fatal(err)
		}
		if notification.Topic != "room:room_1" || notification.Kind != "room.event" ||
			notification.ResourceID != "event_1" || notification.Sequence != 7 || notification.Revision != 0 {
			t.Fatalf("notification=%+v", notification)
		}
	})
	t.Run("accepts Context change with its revision and no Inbox cursor", func(t *testing.T) {
		notification, err := DecodeNotification([]byte(`{"topic":"agent-inbox:all","kind":"context.changed","resource_id":"context-1","sequence":0,"revision":3}`))
		if err != nil || notification.Event().ContextKey != "context-1" || notification.Event().Revision != 3 {
			t.Fatalf("Context wake=%+v err=%v", notification, err)
		}
	})
	t.Run("accepts best-effort Context prepare without a cursor", func(t *testing.T) {
		notification, err := DecodeNotification([]byte(`{"topic":"agent-inbox:all","kind":"context.prepare","resource_id":"context-1","sequence":0,"revision":0}`))
		if err != nil || notification.Event().ContextKey != "context-1" || notification.Event().ResourceID != "" {
			t.Fatalf("Context prepare=%+v err=%v", notification, err)
		}
	})
	t.Run("accepts body-free run hints", func(t *testing.T) {
		for _, kind := range []string{RunQueuedKind, RunSteeredKind} {
			notification, err := DecodeNotification([]byte(`{"topic":"agent-inbox:all","kind":"` + kind + `","resource_id":"context-1","sequence":0,"revision":0}`))
			if err != nil || notification.Event().ContextKey != "context-1" || notification.Event().Kind != kind {
				t.Fatalf("run hint=%+v err=%v", notification, err)
			}
		}
	})
	t.Run("accepts a Context-less Task claimable hint", func(t *testing.T) {
		notification, err := DecodeNotification([]byte(`{"topic":"agent-inbox:all","kind":"task.claimable","resource_id":"all","sequence":0,"revision":0}`))
		if err != nil || notification.Event() != (Event{Topic: AgentInboxWakeTopic, Kind: TaskClaimableKind}) {
			t.Fatalf("Task claimable=%+v err=%v", notification, err)
		}
	})

	t.Run("accepts the River due wake", func(t *testing.T) {
		notification, err := DecodeNotification([]byte(`{"topic":"work:river-due","kind":"work.ready","resource_id":"all","sequence":0,"revision":0}`))
		if err != nil || notification.Event() != (Event{Topic: WorkRiverDueTopic, Kind: WorkReadyKind, ResourceID: "all"}) {
			t.Fatalf("River due=%+v err=%v", notification, err)
		}
	})

	for name, payload := range map[string]string{
		"unknown work topic":          `{"topic":"work:other","kind":"work.ready","resource_id":"all","sequence":0,"revision":0}`,
		"work wrong kind":             `{"topic":"work:river-due","kind":"room.event","resource_id":"all","sequence":0,"revision":0}`,
		"work names a resource":       `{"topic":"work:river-due","kind":"work.ready","resource_id":"job_1","sequence":0,"revision":0}`,
		"work sequence":               `{"topic":"work:river-due","kind":"work.ready","resource_id":"all","sequence":1,"revision":0}`,
		"work revision":               `{"topic":"work:river-due","kind":"work.ready","resource_id":"all","sequence":0,"revision":1}`,
		"Task claimable names a Task": `{"topic":"agent-inbox:all","kind":"task.claimable","resource_id":"task_1","sequence":0,"revision":0}`,
		"Task claimable sequence":     `{"topic":"agent-inbox:all","kind":"task.claimable","resource_id":"all","sequence":1,"revision":0}`,
		"Task claimable revision":     `{"topic":"agent-inbox:all","kind":"task.claimable","resource_id":"all","sequence":0,"revision":1}`,
		"Task claimable wrong topic":  `{"topic":"agent-inbox:other","kind":"task.claimable","resource_id":"all","sequence":0,"revision":0}`,
		"unknown field":               `{"topic":"room:room_1","kind":"room.event","resource_id":"event_1","sequence":7,"revision":0,"body":"secret"}`,
		"unknown topic prefix":        `{"topic":"presence:room_1","kind":"room.event","resource_id":"event_1","sequence":7,"revision":0}`,
		"negative sequence":           `{"topic":"room:room_1","kind":"room.event","resource_id":"event_1","sequence":-1,"revision":0}`,
		"unknown Room hint kind":      `{"topic":"room:room_1","kind":"message.draft.changed","resource_id":"draft_1","sequence":0,"revision":4}`,
		"unknown status topic":        `{"topic":"agent-runtime-status:all","kind":"status.changed","resource_id":"work","sequence":0,"revision":0}`,
		"run hint wrong topic":        `{"topic":"agent-inbox:other","kind":"run.queued","resource_id":"context-1","sequence":0,"revision":0}`,
		"retired Inbox wake":          `{"topic":"agent-inbox:all","kind":"inbox.wake","resource_id":"room:room_1","sequence":7,"revision":0}`,
		"run hint sequence":           `{"topic":"agent-inbox:all","kind":"run.queued","resource_id":"context-1","sequence":7,"revision":0}`,
		"run hint newline":            `{"topic":"agent-inbox:all","kind":"run.steered","resource_id":"context-1\n","sequence":0,"revision":0}`,
		"Context prepare sequence":    `{"topic":"agent-inbox:all","kind":"context.prepare","resource_id":"context-1","sequence":1,"revision":0}`,
		"Context prepare revision":    `{"topic":"agent-inbox:all","kind":"context.prepare","resource_id":"context-1","sequence":0,"revision":1}`,
		"Context prepare newline":     `{"topic":"agent-inbox:all","kind":"context.prepare","resource_id":"context-1\n","sequence":0,"revision":0}`,
		"Context change sequence":     `{"topic":"agent-inbox:all","kind":"context.changed","resource_id":"context-1","sequence":1,"revision":1}`,
		"Context change no revision":  `{"topic":"agent-inbox:all","kind":"context.changed","resource_id":"context-1","sequence":0,"revision":0}`,
		"Context change newline":      `{"topic":"agent-inbox:all","kind":"context.changed","resource_id":"context-1\n","sequence":0,"revision":1}`,
		"oversized payload":           `{"topic":"room:room_1","kind":"room.event","resource_id":"` + string(make([]byte, MaxNotificationPayloadBytes)) + `","sequence":7,"revision":0}`,
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := DecodeNotification([]byte(payload)); err == nil {
				t.Fatal("DecodeNotification() error=nil")
			}
		})
	}
}
