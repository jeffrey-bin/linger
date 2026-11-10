package document

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/messagecreation"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

// notifySharedAgent tells an Agent that a Document was shared with it. A
// share grants nothing, since an Agent already has its Human's access; it
// only asks the Agent to look. The notice is a hidden Agent Runtime Message
// in the Agent's direct Room with the Space's Human, which wakes the Agent
// there. An Agent without such a Room still finds the Document with
// `docs list --shared`.
func notifySharedAgent(ctx context.Context, tx pgx.Tx, tenantID, documentID, title, sharerActorID, agentActorID string) error {
	queries := store.New(tx)
	var humanID string
	err := tx.QueryRow(ctx, `SELECT id FROM actors
		WHERE tenant_id=$1 AND kind='human' AND account_id IS NOT NULL
		ORDER BY created_at,id LIMIT 1`, tenantID).Scan(&humanID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	roomID, err := queries.GetCurrentDirectRoom(ctx, store.GetCurrentDirectRoomParams{
		TenantID: tenantID, HumanActorID: humanID, AgentActorID: agentActorID,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	human, err := queries.GetActor(ctx, store.GetActorParams{ID: humanID, TenantID: tenantID})
	if err != nil {
		return err
	}
	agent, err := queries.GetActor(ctx, store.GetActorParams{ID: agentActorID, TenantID: tenantID})
	if err != nil {
		return err
	}
	sharer, err := queries.GetActor(ctx, store.GetActorParams{ID: sharerActorID, TenantID: tenantID})
	if err != nil {
		return err
	}
	content, err := messagecreation.Normalize([]messagecreation.Segment{
		{Type: "reference", Content: "@" + agent.DisplayName, Target: agent.ID, TargetType: "agent"},
		{Type: "text", Content: " " + sharer.DisplayName + " shared the Document “" + title +
			"” (" + documentID + ") with you. Read it with `teamhub docs get " + documentID + "`."},
	})
	if err != nil {
		return err
	}
	_, err = messagecreation.Create(ctx, queries, messagecreation.Draft{
		TenantID: tenantID, RoomID: roomID, Author: human, Content: content, Kind: "agent_runtime",
	})
	return err
}
