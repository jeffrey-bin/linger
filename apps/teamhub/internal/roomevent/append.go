// Package roomevent is the only writer of Room Events. Every room_seq is
// allocated here, so each Room's sequence stays contiguous for the clients
// that detect gaps and backfill.
package roomevent

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/ids"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

// Allocation selects the Room states that may allocate the next room_seq.
type Allocation int

const (
	// ActiveRoomSeq allocates only before Room deletion starts.
	ActiveRoomSeq Allocation = iota
	// DeletingRoomSeq allocates only after Room deletion started; Room
	// deletion finalization records room.deleted with it.
	DeletingRoomSeq
	// LifecycleRoomSeq allocates until the Room is deleted; a membership
	// fence can finalize while its Room is being deleted.
	LifecycleRoomSeq
)

type Input struct {
	TenantID   string
	RoomID     string
	EventType  string
	ActorID    string
	ResourceID string
	Payload    any
	Allocation Allocation
	// EventID names the event deterministically for writers that retry the
	// same fact; empty draws a random ID.
	EventID string
}

// Append allocates the next room_seq and records the event through
// transaction-bound queries, so the business fact, the sequence and the event
// commit together.
func Append(ctx context.Context, queries *store.Queries, input Input) (int64, error) {
	seq, err := allocate(ctx, queries, input)
	if err != nil {
		return 0, err
	}
	payload, err := json.Marshal(input.Payload)
	if err != nil {
		return 0, err
	}
	eventID := input.EventID
	if eventID == "" {
		eventID = ids.New("event")
	}
	event, err := queries.CreateRoomEvent(ctx, store.CreateRoomEventParams{
		EventID: eventID, TenantID: input.TenantID, RoomID: input.RoomID, RoomSeq: seq,
		EventType: input.EventType, ActorID: input.ActorID, ResourceID: input.ResourceID, Payload: payload,
	})
	if err != nil {
		return 0, err
	}
	return event.RoomSeq, nil
}

// ErrMessagePublished rejects announcing a Message that is missing or already
// carries its Room sequence.
var ErrMessagePublished = errors.New("message is missing or already published")

// AppendMessageCreated records message.created for the persisted Message
// input.ResourceID and, in the same statement, stamps that Message with its
// room_seq and the Actors it mentions. input.EventType is not read.
func AppendMessageCreated(ctx context.Context, queries *store.Queries, input Input, mentionedActorIDs []string) (int64, error) {
	seq, err := allocate(ctx, queries, input)
	if err != nil {
		return 0, err
	}
	payload, err := json.Marshal(input.Payload)
	if err != nil {
		return 0, err
	}
	eventID := input.EventID
	if eventID == "" {
		eventID = ids.New("event")
	}
	if mentionedActorIDs == nil {
		// A nil slice would encode as SQL NULL.
		mentionedActorIDs = []string{}
	}
	created, err := queries.CreateMessageCreatedRoomEvent(ctx, store.CreateMessageCreatedRoomEventParams{
		EventID: eventID, TenantID: input.TenantID, RoomID: input.RoomID, RoomSeq: seq,
		ActorID: input.ActorID, MessageID: input.ResourceID, Payload: payload,
		MentionedActorIds: mentionedActorIDs,
	})
	if err != nil {
		return 0, err
	}
	if created.PublishedMessages != 1 {
		return 0, ErrMessagePublished
	}
	return created.RoomSeq, nil
}

func allocate(ctx context.Context, queries *store.Queries, input Input) (int64, error) {
	switch input.Allocation {
	case DeletingRoomSeq:
		return queries.AllocateDeletingRoomSeq(ctx, input.RoomID)
	case LifecycleRoomSeq:
		return queries.AllocateRoomLifecycleSeq(ctx, input.RoomID)
	default:
		return queries.AllocateRoomSeq(ctx, input.RoomID)
	}
}

// MemberRemoved is the one room.member.removed payload; both a direct
// removal and a Document Runtime fence acknowledgement describe the removed
// member with the public RoomMember shape.
func MemberRemoved(member httpapi.RoomMember) any {
	return struct {
		Kind   string             `json:"kind"`
		Member httpapi.RoomMember `json:"member"`
	}{Kind: "room.member.removed", Member: member}
}

func AppendCaptureSessionChanged(
	ctx context.Context,
	queries *store.Queries,
	tenantID, roomID, actorID, sessionID, status string,
) error {
	if roomID == "" {
		return nil
	}
	_, err := Append(ctx, queries, Input{
		TenantID: tenantID, RoomID: roomID, EventType: "capture.session.changed",
		ActorID: actorID, ResourceID: sessionID,
		Payload: map[string]any{
			"kind": "capture.session.changed", "session_id": sessionID, "status": status,
		},
	})
	return err
}
