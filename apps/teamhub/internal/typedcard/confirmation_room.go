package typedcard

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/messagecreation"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

// ConfirmationScope is where an Agent command that needs a Human decision
// came from.
type ConfirmationScope struct {
	TenantID, AgentActorID, RoomID, ParticipantTaskID string
}

// ConfirmationRoom picks the chat for a card one Human decides: the
// command's Room, or the Room that delegated a Task, when the Human
// and the Agent are members there; otherwise the Human's direct chat with the
// Agent. It returns "" when there is none.
func (s *Service) ConfirmationRoom(ctx context.Context, scope ConfirmationScope, humanActorID string) (string, error) {
	queries := store.New(s.pool)
	candidate := scope.RoomID
	if scope.ParticipantTaskID != "" {
		origin, err := queries.GetTaskOriginRoomID(ctx, store.GetTaskOriginRoomIDParams{
			WorkItemID: scope.ParticipantTaskID, TenantID: scope.TenantID,
		})
		if errors.Is(err, pgx.ErrNoRows) {
			candidate = ""
		} else if err != nil {
			return "", err
		} else {
			candidate = origin
		}
	}
	if candidate != "" {
		members, err := queries.HumanAndAgentShareRoom(ctx, store.HumanAndAgentShareRoomParams{
			RoomID: candidate, TenantID: scope.TenantID, HumanActorID: humanActorID, AgentActorID: scope.AgentActorID,
		})
		if err != nil {
			return "", err
		}
		if members {
			return candidate, nil
		}
	}
	roomID, err := queries.GetCurrentDirectRoom(ctx, store.GetCurrentDirectRoomParams{
		TenantID: scope.TenantID, HumanActorID: humanActorID, AgentActorID: scope.AgentActorID,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	return roomID, err
}

// RunClaim resolves the Run the request's claim names in the Agent's Room,
// checked against the command's source Room.
func (s *Service) RunClaim(ctx context.Context, tenantID, agentActorID, roomID string) (pgtype.Text, error) {
	return messagecreation.ResolveRunClaim(ctx, store.New(s.pool), tenantID, agentActorID, roomID)
}
