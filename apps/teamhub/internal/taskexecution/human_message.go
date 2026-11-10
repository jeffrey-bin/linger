package taskexecution

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/roomevent"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

// HumanTaskRoomInputTarget is an opaque Task snapshot locked before the
// caller writes any Room Event. Keeping it opaque prevents the HTTP boundary
// from reproducing Task eligibility or fencing rules.
type HumanTaskRoomInputTarget struct {
	taskID                 string
	tenantID               string
	roomID                 string
	workItemVersion        int64
	generation             int64
	executionStatus        string
	executionRevision      int64
	desiredControl         string
	controlRevision        int64
	controlSettledRevision int64
	archived               bool
	attemptID              string
	attemptStatus          string
	currentInputRevision   int64
}

type HumanTaskRoomMessageInput struct {
	TenantID      string
	RoomID        string
	AuthorActorID string
	MessageKind   string
	Message       TurnMessageInput
}

type HumanTaskRoomMessagePromotion struct {
	Promoted          bool
	TaskID            string
	Generation        int64
	AttemptID         string
	InputRevision     int64
	ExecutionRevision int64
	EffectID          string
	RoomSeq           int64
}

// LockHumanTaskRoomInputTarget establishes Task -> Room lock order for Human
// createMessage transactions. A nil target means the Room is not the exact
// work Room of a managed Task.
func LockHumanTaskRoomInputTarget(
	ctx context.Context,
	queries *store.Queries,
	tenantID, roomID string,
) (*HumanTaskRoomInputTarget, error) {
	if queries == nil || strings.TrimSpace(tenantID) == "" || strings.TrimSpace(roomID) == "" {
		return nil, ErrInvalid
	}
	row, err := queries.LockHumanTaskInputTargetByWorkRoom(ctx, store.LockHumanTaskInputTargetByWorkRoomParams{
		RoomID: roomID, TenantID: tenantID,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &HumanTaskRoomInputTarget{
		taskID: row.TaskID, tenantID: row.TenantID, roomID: roomID,
		workItemVersion: row.Version, generation: row.Generation,
		executionStatus: row.ExecutionStatus, executionRevision: row.ExecutionRevision,
		desiredControl: row.DesiredControl, controlRevision: row.ControlRevision,
		controlSettledRevision: row.ControlSettledRevision, archived: row.Archived,
		attemptID: row.AttemptID, attemptStatus: row.AttemptStatus,
		currentInputRevision: row.CurrentInputRevision,
	}, nil
}

// PromoteLockedHumanTaskRoomMessage converts one executable public Human
// conversation Message into the next immutable PG InputRevision. Non-running
// Task states intentionally keep the public Message but produce no execution
// mutation.
func PromoteLockedHumanTaskRoomMessage(
	ctx context.Context,
	queries *store.Queries,
	target *HumanTaskRoomInputTarget,
	input HumanTaskRoomMessageInput,
) (HumanTaskRoomMessagePromotion, error) {
	if target == nil {
		return HumanTaskRoomMessagePromotion{}, nil
	}
	if queries == nil || input.TenantID != target.tenantID || input.RoomID != target.roomID ||
		strings.TrimSpace(input.AuthorActorID) == "" {
		return HumanTaskRoomMessagePromotion{}, ErrInvalid
	}
	if input.MessageKind != "conversation" {
		return HumanTaskRoomMessagePromotion{}, nil
	}
	if target.archived || target.executionStatus != "running" || target.desiredControl != "run" ||
		target.attemptStatus != "running" || target.attemptID == "" || target.currentInputRevision < 1 {
		return HumanTaskRoomMessagePromotion{}, nil
	}
	publicMessage, err := normalizeTurnMessage(input.Message)
	if err != nil {
		return HumanTaskRoomMessagePromotion{}, err
	}
	participants, err := queries.ListTaskExecutionParticipants(ctx, store.ListTaskExecutionParticipantsParams{
		TaskID: target.taskID, Generation: target.generation,
	})
	if err != nil {
		return HumanTaskRoomMessagePromotion{}, err
	}
	recipients := make([]string, len(participants))
	for index, participant := range participants {
		recipients[index] = participant.ActorID
	}
	recipients, err = normalizedUniqueIDs(recipients)
	if err != nil {
		return HumanTaskRoomMessagePromotion{}, err
	}
	wakes, err := AppendParticipantMetaWakes(
		ctx, queries, target.taskID, target.tenantID, input.AuthorActorID,
		recipients, publicMessage,
	)
	if err != nil {
		return HumanTaskRoomMessagePromotion{}, err
	}
	baseManifest, _, err := canonicalHash(map[string]any{
		"room_id": target.roomID, "source": "human_task_room_message",
		"source_message_id": publicMessage.MessageID,
	})
	if err != nil {
		return HumanTaskRoomMessagePromotion{}, err
	}
	manifest, err := FreezeParticipantWakeManifest(baseManifest, publicMessage, wakes)
	if err != nil {
		return HumanTaskRoomMessagePromotion{}, err
	}
	capability, err := randomToken(32)
	if err != nil {
		return HumanTaskRoomMessagePromotion{}, err
	}
	nextInputRevision := target.currentInputRevision + 1
	nextExecutionRevision := target.executionRevision + 1
	effectID := newID("task_effect_")
	recipientJSON, _ := json.Marshal(recipients)
	effectIDs, _ := json.Marshal([]string{effectID})
	if _, err := queries.InsertHumanTaskInputRevision(ctx, store.InsertHumanTaskInputRevisionParams{
		TaskID: target.taskID, TenantID: target.tenantID, Generation: target.generation,
		AttemptID: target.attemptID, InputRevision: nextInputRevision,
		RecipientActorIds: recipientJSON, InputManifest: manifest,
		MessageEffectIds: effectIDs, CapabilityHash: tokenHash(capability),
		SourceMessageID: publicMessage.MessageID, AuthorActorID: input.AuthorActorID,
	}); err != nil {
		return HumanTaskRoomMessagePromotion{}, err
	}
	effectPayload, err := NewRoutedSubmitTurnEffectPayload(
		target.attemptID, nextInputRevision, recipients, manifest,
		publicMessage, wakes, capability,
	)
	if err != nil {
		return HumanTaskRoomMessagePromotion{}, err
	}
	effectJSON, effectHash, err := canonicalHash(effectPayload)
	if err != nil {
		return HumanTaskRoomMessagePromotion{}, err
	}
	rootOperationID := taskInputOperationID(
		target.taskID, target.generation, target.attemptID, nextInputRevision,
	)
	if _, err := queries.InsertTaskEffect(ctx, store.InsertTaskEffectParams{
		ID: effectID, TaskID: target.taskID, TenantID: target.tenantID,
		Generation: target.generation, RootOperationID: rootOperationID,
		EffectKey: rootOperationID + ":submit", Operation: "submit_agent_turn",
		OwnerID: target.taskID, Payload: effectJSON,
		PayloadHash: effectHash, RootPayloadHash: effectHash,
		DispatchSequence: 1, Status: "pending",
	}); err != nil {
		return HumanTaskRoomMessagePromotion{}, err
	}
	updated, err := queries.AdvanceRunningTaskAttemptInput(ctx, store.AdvanceRunningTaskAttemptInputParams{
		NextInputRevision: nextInputRevision, AttemptID: target.attemptID,
		TaskID: target.taskID, Generation: target.generation,
		ExpectedInputRevision: target.currentInputRevision,
	})
	if err != nil {
		return HumanTaskRoomMessagePromotion{}, err
	}
	if updated != 1 {
		return HumanTaskRoomMessagePromotion{}, ErrConflict
	}
	sourceOperationID := fmt.Sprintf(
		"task:%s:g:%d:human-message:%s",
		target.taskID, target.generation, publicMessage.MessageID,
	)
	if err := insertFact(ctx, queries, factInput{
		TaskID: target.taskID, TenantID: target.tenantID, Generation: target.generation,
		Revision: nextExecutionRevision, Kind: "TASK_EXECUTION_CHANGED", Status: "running",
		ControlSettledRevision: target.controlSettledRevision,
		SourceOperationID:      sourceOperationID, CausedByActorID: input.AuthorActorID,
		Payload: map[string]any{
			"attempt_id": target.attemptID, "input_revision": nextInputRevision,
			"effect_id": effectID, "source_message_id": publicMessage.MessageID,
			"recipient_actor_ids": recipients, "recipient_wakes": wakes,
		},
	}); err != nil {
		return HumanTaskRoomMessagePromotion{}, err
	}
	updated, err = queries.AdvanceTaskForHumanMessageInput(ctx, store.AdvanceTaskForHumanMessageInputParams{
		TaskID: target.taskID, TenantID: target.tenantID, Generation: target.generation,
		ExpectedExecutionRevision: target.executionRevision,
		ExpectedControlRevision:   target.controlRevision,
	})
	if err != nil {
		return HumanTaskRoomMessagePromotion{}, err
	}
	if updated != 1 {
		return HumanTaskRoomMessagePromotion{}, ErrConflict
	}
	roomSeq, err := roomevent.Append(ctx, queries, roomevent.Input{
		TenantID: target.tenantID, RoomID: target.roomID,
		EventType: "work_item.changed", ActorID: input.AuthorActorID,
		ResourceID: target.taskID,
		Payload: map[string]any{
			"kind": "work_item.changed", "work_item_id": target.taskID,
			"version":                 target.workItemVersion,
			"task_execution_revision": nextExecutionRevision,
			"task_execution_status":   "running",
		},
	})
	if err != nil {
		return HumanTaskRoomMessagePromotion{}, err
	}
	return HumanTaskRoomMessagePromotion{
		Promoted: true, TaskID: target.taskID, Generation: target.generation,
		AttemptID: target.attemptID, InputRevision: nextInputRevision,
		ExecutionRevision: nextExecutionRevision, EffectID: effectID, RoomSeq: roomSeq,
	}, nil
}
