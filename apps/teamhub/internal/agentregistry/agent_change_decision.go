package agentregistry

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"

	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/collaboration"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/idempotency"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/messagecreation"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/typedcard"
)

// RunAgentChangeDecision runs an approved change idempotently per decision.
// A created Agent is announced in the card's Room by the transaction that
// records the result, so a retried job announces it once; an error means the
// job should retry.
func (s *Service) RunAgentChangeDecision(ctx context.Context, decision typedcard.ClaimedDecision) (typedcard.DecisionResult, error) {
	var stored struct {
		TargetActorID    string             `json:"target_actor_id"`
		ExpectedRevision int64              `json:"expected_revision"`
		Change           AgentChangeRequest `json:"change"`
	}
	if err := json.Unmarshal(decision.Request, &stored); err != nil {
		return typedcard.DecisionResult{}, err
	}
	actorID, failure, err := s.applyAgentChangeDecision(ctx, decision, stored.TargetActorID, stored.ExpectedRevision, stored.Change)
	if err != nil {
		return typedcard.DecisionResult{}, err
	}
	if failure != "" {
		return typedcard.DecisionResult{Status: "failed", Outcome: failure}, nil
	}
	result := typedcard.DecisionResult{Status: "succeeded", Data: map[string]string{"actor_id": actorID}}
	if stored.TargetActorID == "" {
		result.Announce = func(ctx context.Context, queries *store.Queries) error {
			actors := make([]store.Actor, 0, 3)
			for _, id := range []string{decision.RequestedByActorID, actorID, decision.DeciderActorID} {
				actor, err := queries.GetActor(ctx, store.GetActorParams{ID: id, TenantID: decision.TenantID})
				if err != nil {
					return err
				}
				actors = append(actors, actor)
			}
			_, err := messagecreation.CreateNotice(ctx, queries, decision.TenantID, decision.RoomID, actors[0], messagecreation.AgentCreated(actors[1], &actors[2]))
			return err
		}
	}
	return result, nil
}

// applyAgentChangeDecision runs the stored change. It returns the created or
// changed Agent, or why the change could not run.
func (s *Service) applyAgentChangeDecision(ctx context.Context, decision typedcard.ClaimedDecision, targetActorID string, expectedRevision int64, request AgentChangeRequest) (string, string, error) {
	sponsor, err := s.queries.GetActor(ctx, store.GetActorParams{ID: decision.DeciderActorID, TenantID: decision.TenantID})
	if err != nil {
		return "", "", err
	}
	if !sponsor.AccountID.Valid {
		return "", "the Sponsor no longer has an account.", nil
	}
	accountID := sponsor.AccountID.String
	if targetActorID == "" {
		actorID, err := s.CreateSponsorAgent(ctx, accountID, decision.TenantID, decision.RequestedByActorID, request.Change(), "agent-change:"+decision.ID)
		switch {
		case errors.Is(err, ErrAgentLimitReached):
			return "", "the Sponsor already has 50 Agents.", nil
		case errors.Is(err, collaboration.ErrAgentSponsorRequired), errors.Is(err, pgx.ErrNoRows):
			return "", "the requesting Agent is no longer active.", nil
		case err != nil:
			return "", "", err
		}
		// The sidebar lists Agents by their direct Room. A retried job replays
		// the creation by its key and reopens the same Room. ErrNoRows means
		// the Sponsor left the Tenant or the Agent is no longer active, which
		// no retry can fix.
		if _, err := s.collaboration.OpenDirectRoom(ctx, accountID, decision.TenantID, actorID); errors.Is(err, pgx.ErrNoRows) {
			s.logger.Warn("agent_change.direct_room_skipped", "decision_id", decision.ID, "tenant_id", decision.TenantID,
				"sponsor_actor_id", decision.DeciderActorID, "agent_actor_id", actorID, "error", err)
		} else if err != nil {
			return "", "", err
		}
		return actorID, "", nil
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return "", "", err
	}
	defer tx.Rollback(ctx)
	queries := s.queries.WithTx(tx)
	operation := "agentChangeConfirmation:" + decision.ID
	key := idempotency.AccountKey(accountID, operation, decision.ID)
	if err := lockAgentProfileTarget(ctx, queries, decision.TenantID, targetActorID); err != nil {
		return "", "", err
	}
	if err := idempotency.Lock(ctx, tx, key); err != nil {
		return "", "", err
	}
	hash := idempotency.HashRequest(decision.ID)
	if _, found, err := idempotency.Lookup(ctx, tx, key, hash); err != nil || found {
		return targetActorID, "", err
	}
	target, err := lockSponsorAgent(ctx, queries, decision.TenantID, decision.DeciderActorID, targetActorID)
	if errors.Is(err, collaboration.ErrAgentSponsorRequired) || errors.Is(err, pgx.ErrNoRows) {
		return "", "the Agent no longer exists or is not active.", nil
	}
	if err != nil {
		return "", "", err
	}
	if target.registration.ConfigurationRevision != expectedRevision {
		return "", "the Agent changed after this card was opened. Read it again with teamhub agent get and submit the change again.", nil
	}
	// The card's Room announces the change; its lock precedes the change's Accounts.
	if err := queries.LockTenantDeliveryRooms(ctx, store.LockTenantDeliveryRoomsParams{TenantID: decision.TenantID, RoomIds: []string{decision.RoomID}}); err != nil {
		return "", "", err
	}
	if _, err := ApplyAgentProfileChange(ctx, tx, queries, target.registration, request.Change()); err != nil {
		return "", "", err
	}
	if err := PostAgentProfileNotice(ctx, queries, decision.TenantID, decision.RoomID, decision.RequestedByActorID, target, request.Change()); err != nil {
		return "", "", err
	}
	if err := idempotency.Save(ctx, tx, key, hash, idempotency.Record{ResourceID: targetActorID, Status: http.StatusOK, Body: []byte("{}")}); err != nil {
		return "", "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", "", err
	}
	return targetActorID, "", nil
}
