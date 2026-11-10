package collaboration

import (
	"context"
	"net/http"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/roomcreation"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

// DirectRoom is an opened Direct Room; Status is 201 when this call created it.
type DirectRoom struct {
	Status int
	Room   httpapi.Room
}

// OpenDirectRoom opens the Human's Direct Room with a visible Agent, creating it with its opening when there is none.
func (s *Service) OpenDirectRoom(ctx context.Context, accountID, tenantID, agentActorID string) (DirectRoom, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return DirectRoom{}, err
	}
	defer tx.Rollback(ctx)
	queries := s.queries.WithTx(tx)
	human, err := queries.GetHumanActor(ctx, store.GetHumanActorParams{
		TenantID: tenantID, AccountID: textValue(accountID),
	})
	if err != nil {
		return DirectRoom{}, err
	}
	visible, err := queries.GetVisibleActiveAgentForDirectRoom(ctx, store.GetVisibleActiveAgentForDirectRoomParams{
		TenantID: tenantID, AgentActorID: agentActorID, HumanActorID: human.ID,
	})
	if err != nil {
		return DirectRoom{}, err
	}
	agent := store.Actor{
		ID: visible.ID, TenantID: visible.TenantID, Kind: visible.Kind,
		DisplayName: visible.DisplayName, AccountID: visible.AccountID,
		Handle: visible.Handle, CreatedAt: visible.CreatedAt,
	}
	direct, err := roomcreation.OpenOrCreateDirectRoom(ctx, queries, roomcreation.DirectSpec{
		TenantID: tenantID, Human: human, Agent: agent, Name: agent.DisplayName,
	})
	if err != nil {
		return DirectRoom{}, err
	}
	if direct.Created {
		if err := postBlankAgentOpening(ctx, queries, tenantID, direct.Room.ID, human, agent); err != nil {
			return DirectRoom{}, err
		}
		if err := tx.Commit(ctx); err != nil {
			return DirectRoom{}, err
		}
		return DirectRoom{Status: http.StatusCreated, Room: directRoomModel(direct.Room, human, agent, true)}, nil
	}
	creator, err := queries.GetActor(ctx, store.GetActorParams{ID: direct.Room.CreatedByActorID, TenantID: tenantID})
	if err != nil {
		return DirectRoom{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return DirectRoom{}, err
	}
	return DirectRoom{Status: http.StatusOK, Room: directRoomModel(direct.Room, creator, agent, true)}, nil
}
