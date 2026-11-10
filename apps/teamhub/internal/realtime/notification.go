package realtime

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"

	"github.com/jackc/pgx/v5/pgconn"
)

const (
	ChannelName                 = "teamhub_realtime"
	MaxNotificationPayloadBytes = 7900
	maxNotificationFieldBytes   = 512
)

type Notification struct {
	Topic      string `json:"topic"`
	Kind       string `json:"kind"`
	ResourceID string `json:"resource_id"`
	Sequence   int64  `json:"sequence"`
	Revision   int64  `json:"revision"`
}

func DecodeNotification(payload []byte) (Notification, error) {
	if len(payload) == 0 || len(payload) > MaxNotificationPayloadBytes {
		return Notification{}, errors.New("realtime notification payload size is invalid")
	}
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	var notification Notification
	if err := decoder.Decode(&notification); err != nil {
		return Notification{}, fmt.Errorf("decode realtime notification: %w", err)
	}
	if err := ensureJSONEnd(decoder); err != nil {
		return Notification{}, err
	}
	if len(notification.Topic) > maxNotificationFieldBytes ||
		len(notification.Kind) > maxNotificationFieldBytes ||
		len(notification.ResourceID) > maxNotificationFieldBytes {
		return Notification{}, errors.New("realtime notification field is too large")
	}
	if notification.ResourceID == "" || notification.Sequence < 0 || notification.Revision < 0 {
		return Notification{}, errors.New("realtime notification identity or cursor is invalid")
	}
	prefix, _, found := strings.Cut(notification.Topic, ":")
	if !found || strings.TrimPrefix(notification.Topic, prefix+":") == "" {
		return Notification{}, errors.New("realtime notification topic is invalid")
	}
	switch prefix {
	case "room":
		if notification.Kind != "room.event" {
			return Notification{}, errors.New("realtime room notification kind is invalid")
		}
	case "voicetasks":
		if notification.Kind != "voice.tasks.changed" || notification.Sequence != 0 || notification.Revision != 0 {
			return Notification{}, errors.New("realtime Live task notification is invalid")
		}
		return notification, nil
	case "voice":
		// voice.changed is a cursorless wake: the trigger commits no cursor and
		// the voice event stream rereads PostgreSQL from its own cursor.
		if notification.Kind == "voice.changed" {
			if notification.Sequence != 0 || notification.Revision != 0 {
				return Notification{}, errors.New("realtime voice change notification is invalid")
			}
			return notification, nil
		}
		if notification.Kind != "voice.partial" {
			return Notification{}, errors.New("realtime voice notification kind is invalid")
		}
	case "tenant":
		// An invalidation hint is not persisted and carries no replay cursor;
		// Sequence is the Room's room_seq for a Room hint and zero otherwise.
		resource, found := strings.CutPrefix(notification.Kind, InvalidationKindPrefix)
		if !found || !ValidInvalidationResource(resource) || notification.Revision != 0 ||
			(resource != InvalidateRoom && notification.Sequence != 0) {
			return Notification{}, errors.New("realtime invalidation notification is invalid")
		}
		return notification, nil
	case "work":
		if notification.Topic != WorkRiverDueTopic || notification.Kind != WorkReadyKind ||
			notification.ResourceID != workResourceID || notification.Sequence != 0 || notification.Revision != 0 {
			return Notification{}, errors.New("realtime work notification is invalid")
		}
		return notification, nil
	case "agent-inbox":
		if notification.Topic == AgentInboxWakeTopic && notification.Kind == TaskClaimableKind {
			if notification.ResourceID != taskClaimableResourceID || notification.Sequence != 0 || notification.Revision != 0 {
				return Notification{}, errors.New("realtime Task claimable notification is invalid")
			}
			return notification, nil
		}
		if notification.Topic != AgentInboxWakeTopic || !isContextHintKind(notification.Kind) {
			return Notification{}, errors.New("realtime Agent Inbox notification identity is invalid")
		}
	default:
		return Notification{}, errors.New("realtime notification topic prefix is invalid")
	}
	if notification.Kind == ContextPrepareKind || notification.Kind == RunQueuedKind || notification.Kind == RunSteeredKind {
		if notification.Sequence != 0 || notification.Revision != 0 || strings.ContainsAny(notification.ResourceID, "\r\n") {
			return Notification{}, errors.New("realtime Context hint cursor is invalid")
		}
		return notification, nil
	}
	if notification.Kind == "context.changed" {
		// Revision is the Context's committed state_revision.
		if notification.Sequence != 0 || notification.Revision < 1 || strings.ContainsAny(notification.ResourceID, "\r\n") {
			return Notification{}, errors.New("realtime Context notification cursor is invalid")
		}
		return notification, nil
	}
	if notification.Kind == "voice.partial" {
		if notification.Sequence != 0 || notification.Revision < 1 {
			return Notification{}, errors.New("realtime revision notification is invalid")
		}
	} else if notification.Sequence < 1 || notification.Revision != 0 {
		return Notification{}, errors.New("realtime event notification cursor is invalid")
	}
	return notification, nil
}

// ContextPrepareKind is a best-effort hint, not a data wake: it
// commits nothing, carries no cursor, and asks the Agent Service to activate
// an idle Context without input. A dropped hint only means the next input
// starts the Runtime as usual.
const ContextPrepareKind = "context.prepare"

// NotifyContextPrepare sends a context.prepare hint through the existing
// LISTEN channel. Call it outside a transaction; PostgreSQL delivers it to
// the Listener like a committed notification, and nothing records it.
func NotifyContextPrepare(ctx context.Context, db interface {
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
}, contextKey string) error {
	if contextKey == "" || len(contextKey) > maxNotificationFieldBytes || strings.ContainsAny(contextKey, "\r\n") {
		return errors.New("realtime Context prepare identity is invalid")
	}
	payload, err := json.Marshal(Notification{Topic: AgentInboxWakeTopic, Kind: ContextPrepareKind, ResourceID: contextKey})
	if err != nil {
		return fmt.Errorf("encode Context prepare notification: %w", err)
	}
	if _, err := db.Exec(ctx, "SELECT pg_notify($1, $2)", ChannelName, string(payload)); err != nil {
		return fmt.Errorf("notify Context prepare: %w", err)
	}
	return nil
}

// RunQueuedKind says a Message transaction queued or extended a Local Run of
// the Context; RunSteeredKind says it added a steer for the running Run. Both
// carry only the Context key and commit nothing beyond the hint.
const (
	RunQueuedKind  = "run.queued"
	RunSteeredKind = "run.steered"
)

// TaskClaimableKind says a commit may have made some Task claimable by the
// Task Worker. It names no Context or Task, so its payload is constant and
// PostgreSQL sends one per transaction; the Worker rereads PostgreSQL.
const TaskClaimableKind = "task.claimable"

// taskClaimableResourceID is the constant resource of every task.claimable
// notification; it never becomes a Context key.
const taskClaimableResourceID = "all"

// WorkRiverDueTopic is service-only: a commit gave some River job a future or
// changed due time. Its payload is constant, so PostgreSQL sends one per
// transaction, and its hook rereads PostgreSQL.
const (
	WorkRiverDueTopic = "work:river-due"
	WorkReadyKind     = "work.ready"
	workResourceID    = "all"
)

func isContextHintKind(kind string) bool {
	switch kind {
	case "context.changed", ContextPrepareKind, RunQueuedKind, RunSteeredKind:
		return true
	default:
		return false
	}
}

func ensureJSONEnd(decoder *json.Decoder) error {
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("realtime notification contains multiple JSON values")
		}
		return fmt.Errorf("decode realtime notification suffix: %w", err)
	}
	return nil
}

func (notification Notification) Event() Event {
	event := Event{
		Topic: notification.Topic, Kind: notification.Kind, ResourceID: notification.ResourceID,
		Sequence: notification.Sequence, Revision: notification.Revision,
	}
	if notification.Topic == AgentInboxWakeTopic && notification.Kind == TaskClaimableKind {
		event.ResourceID = ""
	} else if notification.Topic == AgentInboxWakeTopic {
		event.ContextKey = notification.ResourceID
		event.ResourceID = ""
	}
	return event
}
