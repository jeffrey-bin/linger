package agentruntimestate

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

// Errors returned when recording Runtime presentation output.
var (
	ErrPresentationConflict = errors.New("Runtime presentation output conflicts with an existing fact")
	ErrPresentationInvalid  = errors.New("Runtime presentation output is invalid")

	executionRunPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)
	invocationPattern   = regexp.MustCompile(`^agent-invocation-sha256:[a-f0-9]{64}$`)
)

// PresentationOutput is one Runtime presentation output to record.
type PresentationOutput struct {
	LocalRunID   string
	TenantID     string
	RoomID       string
	AgentActorID string
	InvocationID string
	OutputID     string
	OutputKind   string
	Surface      string
	MessageID    string
	// Continues records the Agent's declaration that more work in the same
	// turn follows this output, so clients do not treat it as the final reply.
	Continues bool
}

// PresentationRecordResult reports the facts recorded for one output.
type PresentationRecordResult struct {
	Recorded     bool
	SegmentID    string
	EventOrdinal int64
}

type outputCreatedEvent struct {
	Type       string `json:"type"`
	OutputID   string `json:"output_id"`
	OutputKind string `json:"output_kind"`
	Surface    string `json:"surface"`
	Continues  bool   `json:"continues,omitempty"`
}

// RecordPresentationOutput records one Runtime presentation output in its
// Run's event log. The caller has locked the output's Room; the Run's status
// Room is the same Room or its parent or Thread.
func RecordPresentationOutput(ctx context.Context, queries *store.Queries, input PresentationOutput) (PresentationRecordResult, error) {
	// Independent Agent operations have no internal execution log to update.
	if input.LocalRunID == "" {
		return PresentationRecordResult{}, nil
	}
	if queries == nil || !validOutput(input) {
		return PresentationRecordResult{}, ErrPresentationInvalid
	}
	log, err := openRunStatusLog(ctx, queries, input.LocalRunID)
	if err != nil || log == nil {
		return PresentationRecordResult{}, err
	}
	if log.run.TenantID != input.TenantID || log.run.AgentActorID != input.AgentActorID {
		return PresentationRecordResult{}, nil
	}

	// A Run's output anywhere in its Room or that Room's Threads belongs to
	// its log, whichever of them shows the status.
	if log.run.StatusRoomID != input.RoomID {
		same, err := queries.InSameCollaborationRoom(ctx, store.InSameCollaborationRoomParams{RoomID: input.RoomID, OtherRoomID: log.run.StatusRoomID})
		if err != nil {
			return PresentationRecordResult{}, err
		}
		if !same {
			return PresentationRecordResult{}, nil
		}
	}

	existing, err := queries.GetAgentRuntimePresentationOutputEvent(ctx, store.GetAgentRuntimePresentationOutputEventParams{
		LocalRunID: input.LocalRunID,
		OutputID:   input.OutputID,
	})
	if err == nil {
		if !sameOutput(existing, input) {
			return PresentationRecordResult{}, ErrPresentationConflict
		}
		return PresentationRecordResult{SegmentID: existing.SegmentID, EventOrdinal: existing.EventOrdinal}, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return PresentationRecordResult{}, err
	}
	if log.stopped() {
		return PresentationRecordResult{}, nil
	}
	payload, err := json.Marshal(outputCreatedEvent{
		Type: "presentation.output_created", OutputID: input.OutputID,
		OutputKind: input.OutputKind, Surface: input.Surface, Continues: input.Continues,
	})
	if err != nil {
		return PresentationRecordResult{}, err
	}
	inserted, err := log.append(ctx, queries, store.InsertAgentRuntimePresentationEventParams{
		CommandID: outputCommandID(input), EventType: "presentation.output_created", Payload: payload,
		MessageID: optionalText(input.MessageID), InvocationID: optionalText(input.InvocationID),
	})
	if err != nil {
		return PresentationRecordResult{}, err
	}
	if err := log.publish(ctx, queries); err != nil {
		return PresentationRecordResult{}, err
	}
	return PresentationRecordResult{Recorded: true, SegmentID: inserted.SegmentID, EventOrdinal: inserted.EventOrdinal}, nil
}

func validOutput(input PresentationOutput) bool {
	if !executionRunPattern.MatchString(input.LocalRunID) ||
		!invocationPattern.MatchString(input.InvocationID) ||
		strings.TrimSpace(input.TenantID) == "" || strings.TrimSpace(input.RoomID) == "" ||
		strings.TrimSpace(input.AgentActorID) == "" || strings.TrimSpace(input.OutputID) == "" ||
		len(input.OutputID) > 256 || input.OutputKind != "message" && input.OutputKind != "card" ||
		input.Surface != "room_timeline" && input.Surface != "workspace" {
		return false
	}
	return input.OutputKind != "message" || input.MessageID != ""
}

func sameOutput(row store.AgentRuntimeStatusEvent, input PresentationOutput) bool {
	var event outputCreatedEvent
	return json.Unmarshal(row.Payload, &event) == nil && event.Type == "presentation.output_created" &&
		event.OutputID == input.OutputID && event.OutputKind == input.OutputKind && event.Surface == input.Surface &&
		event.Continues == input.Continues &&
		row.InvocationID.Valid && row.InvocationID.String == input.InvocationID &&
		row.MessageID.Valid == (input.MessageID != "") && (!row.MessageID.Valid || row.MessageID.String == input.MessageID)
}

func deriveSegmentID(localRunID string, ordinal int64) string {
	digest := sha256.Sum256([]byte(fmt.Sprintf("%s\x00%d", localRunID, ordinal)))
	return "runtime_segment_" + hex.EncodeToString(digest[:16])
}

func outputCommandID(input PresentationOutput) string {
	digest := sha256.Sum256([]byte(strings.Join([]string{
		input.LocalRunID, input.InvocationID, input.OutputID,
	}, "\x00")))
	return "runtime-output-" + hex.EncodeToString(digest[:])
}
