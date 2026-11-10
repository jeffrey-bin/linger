package agentruntimestate

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/account"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/roomevent"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

// runStatusLog appends to one Run's event log. It holds the Run's status Room
// row, which every writer of the log takes first, so ordinals, segments and
// the agent_run.status_changed Room Events announcing them stay in one order.
// Writers that also lock Contexts or Runs take those before the Room.
type runStatusLog struct {
	run         store.GetAgentRunStatusRow
	publishable bool
	last        int64
	segmentID   string
	segments    int64
}

// openRunStatusLog locks the status Room of runID and reads the log tail. It
// returns nil when the Run shows no status.
func openRunStatusLog(ctx context.Context, queries *store.Queries, runID string) (*runStatusLog, error) {
	run, err := queries.GetAgentRunStatus(ctx, runID)
	if isNoRows(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	publishable, err := queries.LockAgentRunStatusRoom(ctx, run.StatusRoomID)
	if isNoRows(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	// The Run may have stopped while this writer waited for the Room.
	run, err = queries.GetAgentRunStatus(ctx, runID)
	if err != nil {
		return nil, err
	}
	log := &runStatusLog{run: run, publishable: publishable, segments: -1}
	tail, err := queries.GetAgentRunStatusTail(ctx, runID)
	if err != nil && !isNoRows(err) {
		return nil, err
	}
	if err == nil {
		log.last = tail.EventOrdinal
		if !tail.ClosesSegment {
			log.segmentID = tail.SegmentID
		}
	}
	return log, nil
}

func (l *runStatusLog) stopped() bool {
	return l.run.Status != "queued" && l.run.Status != "running"
}

func (l *runStatusLog) taskRun() bool {
	return l.run.TaskID.Valid
}

// append writes the next event, opening a segment when none is open. An
// output or the stopped event closes the segment it ends.
func (l *runStatusLog) append(ctx context.Context, queries *store.Queries, params store.InsertAgentRuntimePresentationEventParams) (store.AgentRuntimeStatusEvent, error) {
	if l.segmentID == "" {
		if l.segments < 0 {
			count, err := queries.CountAgentRunStatusSegments(ctx, l.run.RunID)
			if err != nil {
				return store.AgentRuntimeStatusEvent{}, err
			}
			l.segments = count
		}
		l.segments++
		l.segmentID = deriveSegmentID(l.run.RunID, l.segments)
	}
	params.LocalRunID = l.run.RunID
	params.EventOrdinal = l.last + 1
	params.SegmentID = l.segmentID
	inserted, err := queries.InsertAgentRuntimePresentationEvent(ctx, params)
	if err != nil {
		return store.AgentRuntimeStatusEvent{}, err
	}
	l.last = inserted.EventOrdinal
	if closesSegment(params.EventType, params.Payload) {
		l.segmentID = ""
	}
	return inserted, nil
}

func closesSegment(eventType string, payload json.RawMessage) bool {
	if eventType == "presentation.output_created" {
		return true
	}
	if eventType != "status.changed" {
		return false
	}
	var status struct {
		Status string `json:"status"`
	}
	return json.Unmarshal(payload, &status) == nil && status.Status == "stopped"
}

// publish records agent_run.status_changed with the Run's current status and
// last ordinal. A Room being deleted announces nothing. When the events made
// the Run reply, or took its reply back, every browser of the Tenant refetches
// the Room list and Agent status, which leave a replied Run out.
func (l *runStatusLog) publish(ctx context.Context, queries *store.Queries) error {
	if !l.publishable {
		return nil
	}
	run, err := queries.GetAgentRunStatus(ctx, l.run.RunID)
	if err != nil {
		return err
	}
	if run.Replied != l.run.Replied {
		if err := account.PublishTenantChange(ctx, queries, run.TenantID, "tenant.agent-availability.changed"); err != nil {
			return err
		}
		l.run.Replied = run.Replied
	}
	_, err = roomevent.Append(ctx, queries, roomevent.Input{
		TenantID: run.TenantID, RoomID: run.StatusRoomID, EventType: "agent_run.status_changed",
		ActorID: run.AgentActorID, ResourceID: run.RunID,
		Payload: struct {
			Kind string                `json:"kind"`
			Run  httpapi.RoomRunStatus `json:"run"`
		}{Kind: "agent_run.status_changed", Run: RoomRunStatus(RoomRunStatusFields{
			RunID: run.RunID, RoomID: run.StatusRoomID, RunStatus: run.Status, Replied: run.Replied,
			AgentActorID: run.AgentActorID, AgentKind: run.AgentKind, AgentDisplayName: run.AgentDisplayName,
			EventOrdinal: run.EventOrdinal, StopReason: run.StopReason, CreatedAt: run.CreatedAt, UpdatedAt: run.UpdatedAt,
		})},
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	return err
}

// RoomRunStatusFields are the stored facts of one Run status.
type RoomRunStatusFields struct {
	RunID            string
	RoomID           string
	RunStatus        string
	Replied          bool
	AgentActorID     string
	AgentKind        string
	AgentDisplayName string
	EventOrdinal     int64
	StopReason       string
	CreatedAt        pgtype.Timestamptz
	UpdatedAt        pgtype.Timestamptz
}

// RoomRunStatus is the public status of a Run shown in a Room.
func RoomRunStatus(fields RoomRunStatusFields) httpapi.RoomRunStatus {
	status := httpapi.RoomRunStatus{
		RunId: fields.RunID, RoomId: fields.RoomID,
		Agent: httpapi.RoomRunStatusAgentRef{
			Id: fields.AgentActorID, Kind: httpapi.RoomRunStatusAgentRefKind(fields.AgentKind),
			DisplayName: fields.AgentDisplayName,
		},
		Status:       PublicRunStatus(fields.RunStatus),
		Replied:      fields.Replied,
		EventOrdinal: fields.EventOrdinal,
		CreatedAt:    fields.CreatedAt.Time, UpdatedAt: fields.UpdatedAt.Time,
	}
	if fields.StopReason != "" {
		status.StopReason = &fields.StopReason
	}
	return status
}

// PublicRunStatus maps a Run status to the state clients show.
func PublicRunStatus(status string) httpapi.RoomRunStatusState {
	switch status {
	case "succeeded":
		return httpapi.RoomRunStatusStateCompleted
	case "failed", "canceled":
		return httpapi.RoomRunStatusStateAborted
	default:
		return httpapi.RoomRunStatusStateActive
	}
}

// showRunStatus makes roomID show the Run's status and announces it. A Run
// keeps the first Room it shows in.
func showRunStatus(ctx context.Context, queries *store.Queries, runID, roomID string) (*runStatusLog, error) {
	if strings.TrimSpace(roomID) == "" {
		return nil, ErrInvalid
	}
	if _, err := queries.SetAgentRunStatusRoom(ctx, store.SetAgentRunStatusRoomParams{RunID: runID, RoomID: roomID}); err != nil {
		return nil, err
	}
	log, err := openRunStatusLog(ctx, queries, runID)
	if err != nil || log == nil {
		return log, err
	}
	if log.run.StatusRoomID != roomID {
		return nil, ErrConflict
	}
	return log, nil
}
