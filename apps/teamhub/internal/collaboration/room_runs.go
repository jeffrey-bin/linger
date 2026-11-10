package collaboration

import (
	"context"
	"encoding/json"
	"strconv"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentruntimestate"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

// RoomRunStatuses lists the Run statuses of a Room the Account can see. It
// reports pgx.ErrNoRows without Room access.
func (s *Service) RoomRunStatuses(ctx context.Context, accountID, roomID string) ([]httpapi.RoomRunStatus, error) {
	if _, err := s.AuthorizedRoom(ctx, accountID, roomID); err != nil {
		return nil, err
	}
	rows, err := s.queries.ListVisibleRoomRunStatusesForAccount(ctx, store.ListVisibleRoomRunStatusesForAccountParams{AccountID: accountID, RoomID: roomID})
	if err != nil {
		return nil, err
	}
	items := make([]httpapi.RoomRunStatus, 0, len(rows))
	for _, row := range rows {
		items = append(items, agentruntimestate.RoomRunStatus(agentruntimestate.RoomRunStatusFields{
			RunID: row.RunID, RoomID: roomID, RunStatus: row.Status, Replied: row.Replied,
			AgentActorID: row.AgentActorID, AgentKind: row.AgentKind, AgentDisplayName: row.AgentDisplayName,
			EventOrdinal: row.EventOrdinal, StopReason: row.StopReason, CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt,
		}))
	}
	return items, nil
}

// RuntimePresentationRuns lists the Room's Runs with Runtime presentation,
// limited to the listed Messages or the one Run when given. It reports
// pgx.ErrNoRows without Room access.
func (s *Service) RuntimePresentationRuns(ctx context.Context, accountID, roomID string, messageIDs []string, runID string) ([]httpapi.RoomRunStatus, error) {
	if _, err := s.AuthorizedRoom(ctx, accountID, roomID); err != nil {
		return nil, err
	}
	rows, err := s.queries.ListRuntimePresentationRunsForAccountByRoom(ctx, store.ListRuntimePresentationRunsForAccountByRoomParams{
		AccountID: accountID, RoomID: roomID, MessageIds: messageIDs, RunID: runID,
	})
	if err != nil {
		return nil, internal("list Runtime presentation Runs", err)
	}
	items := make([]httpapi.RoomRunStatus, 0, len(rows))
	for _, row := range rows {
		items = append(items, agentruntimestate.RoomRunStatus(agentruntimestate.RoomRunStatusFields{
			RunID: row.RunID, RoomID: roomID, RunStatus: row.Status, Replied: row.Replied,
			AgentActorID: row.AgentActorID, AgentKind: row.AgentKind, AgentDisplayName: row.AgentDisplayName,
			EventOrdinal: row.EventOrdinal, StopReason: row.StopReason, CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt,
		}))
	}
	return items, nil
}

// RoomRun reads a Room Run the Account can see. It reports pgx.ErrNoRows
// otherwise.
func (s *Service) RoomRun(ctx context.Context, accountID, roomID, runID string) (store.GetRoomRunStatusForAccountRow, error) {
	return s.queries.GetRoomRunStatusForAccount(ctx, store.GetRoomRunStatusForAccountParams{
		AccountID: accountID, RoomID: roomID, RunID: runID,
	})
}

// RuntimePresentationEvents reads up to limit published presentation events
// of a Run after an ordinal.
func (s *Service) RuntimePresentationEvents(ctx context.Context, run store.GetRoomRunStatusForAccountRow, after int64, limit int) (httpapi.RuntimePresentationEventPage, error) {
	rows, err := s.queries.ListPublishedAgentRuntimePresentationEvents(ctx, store.ListPublishedAgentRuntimePresentationEventsParams{
		LocalRunID: run.RunID, AfterOrdinal: after,
		PublishedThroughOrdinal: run.EventOrdinal, ResultLimit: int32(limit + 1),
	})
	if err != nil {
		return httpapi.RuntimePresentationEventPage{}, internal("list Runtime presentation events", err)
	}
	hasMore := len(rows) > limit
	if hasMore {
		rows = rows[:limit]
	}
	items := make([]httpapi.RuntimePresentationEventRecord, 0, len(rows))
	for _, row := range rows {
		var event httpapi.AgentRuntimePersistedPresentationEvent
		if err := json.Unmarshal(row.Payload, &event); err != nil {
			return httpapi.RuntimePresentationEventPage{}, internal("decode Runtime presentation event", err)
		}
		record := httpapi.RuntimePresentationEventRecord{
			EventOrdinal: strconv.FormatInt(row.EventOrdinal, 10), SegmentId: row.SegmentID, Event: event,
		}
		if row.MessageID.Valid {
			messageID := row.MessageID.String
			record.MessageId = &messageID
		}
		items = append(items, record)
	}
	return httpapi.RuntimePresentationEventPage{
		Items: items, HasMore: hasMore,
		PublishedThroughOrdinal: strconv.FormatInt(run.EventOrdinal, 10),
	}, nil
}
