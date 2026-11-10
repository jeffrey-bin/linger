package typedcard

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

// HydrateCards projects a Message page with a fixed set of batch queries.
func (s *Service) HydrateCards(ctx context.Context, messageIDs []string) (map[string]json.RawMessage, error) {
	return hydrateCards(ctx, store.New(s.pool), messageIDs)
}

func hydrateCards(ctx context.Context, queries *store.Queries, messageIDs []string) (map[string]json.RawMessage, error) {
	result := make(map[string]json.RawMessage, len(messageIDs))
	if len(messageIDs) == 0 {
		return result, nil
	}
	records, err := queries.ListMessageCards(ctx, messageIDs)
	if err != nil {
		return nil, err
	}
	if len(records) != len(messageIDs) {
		return nil, errors.New("Message page references a missing Typed Card")
	}
	tenantID := records[0].TenantID
	actorIDs := make([]string, 0, len(records)*2)
	for _, record := range records {
		if record.TenantID != tenantID {
			return nil, errors.New("Message page spans multiple Typed Card Tenants")
		}
		actorIDs = appendUniqueString(actorIDs, record.DecisionOwnerActorID)
	}

	decisions, err := queries.ListDecisionsByMessages(ctx, messageIDs)
	if err != nil {
		return nil, err
	}
	decisionByMessage := make(map[string]decisionRecord, len(decisions))
	for _, decision := range decisions {
		decisionByMessage[decision.MessageID] = decision
		actorIDs = appendUniqueString(actorIDs, decision.RequestedByActorID)
		if decision.DecidedByActorID.Valid {
			actorIDs = appendUniqueString(actorIDs, decision.DecidedByActorID.String)
		}
	}
	actors, err := queries.ListActorsByTenantIDs(ctx, store.ListActorsByTenantIDsParams{
		TenantID: tenantID, ActorIds: actorIDs,
	})
	if err != nil {
		return nil, err
	}
	actorByID := make(map[string]store.Actor, len(actors))
	for _, actor := range actors {
		actorByID[actor.ID] = actor
	}
	if len(actorByID) != len(actorIDs) {
		return nil, errors.New("Typed Card projection references a missing Actor")
	}

	for _, record := range records {
		owner, found := actorByID[record.DecisionOwnerActorID]
		if !found {
			return nil, errors.New("Typed Card Decision Owner projection is missing")
		}
		decision, found := decisionByMessage[record.MessageID]
		if !found || record.Intent != "decision_requested" {
			return nil, errors.New("decision Typed Card projection is missing")
		}
		requester, requesterFound := actorByID[decision.RequestedByActorID]
		if !requesterFound {
			return nil, errors.New("decision requester projection is missing")
		}
		encoded, err := encodeDecisionCard(record, owner, requester,
			optionalActor(actorByID, decision.DecidedByActorID.String, decision.DecidedByActorID.Valid), decision)
		if err != nil {
			return nil, err
		}
		result[record.MessageID] = encoded
	}
	return result, nil
}

func appendUniqueString(values []string, value string) []string {
	for _, existing := range values {
		if existing == value {
			return values
		}
	}
	return append(values, value)
}

func optionalActor(actors map[string]store.Actor, actorID string, valid bool) *store.Actor {
	if !valid {
		return nil
	}
	actor, found := actors[actorID]
	if !found {
		return nil
	}
	return &actor
}
