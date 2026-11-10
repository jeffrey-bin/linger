package agentruntimestate

import (
	"context"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

// inboxContextAgentType reads identity authority: the Agent's registration
// and a meta Context's Room membership epoch.
func inboxContextAgentType(ctx context.Context, queries *store.Queries, owner contextRecord) (string, error) {
	agentType, err := inboxRegistrationAgentType(ctx, queries, owner)
	if err != nil {
		return "", err
	}
	if owner.RoomID.Valid {
		if !owner.MembershipEpochID.Valid {
			return "", ErrFenced
		}
		authorized, err := queries.IsAgentExecutionContextRoomAuthorized(ctx, store.IsAgentExecutionContextRoomAuthorizedParams{
			TenantID: owner.TenantID, RoomID: owner.RoomID.String, AgentActorID: owner.AgentActorID, MembershipEpochID: owner.MembershipEpochID.String,
		})
		if err != nil {
			return "", err
		}
		if !authorized {
			return "", ErrFenced
		}
	}
	return agentType, nil
}

// inboxRegistrationAgentType reads only the registration, for a caller whose
// Context lock already established the Context's Room authority.
func inboxRegistrationAgentType(ctx context.Context, queries *store.Queries, owner contextRecord) (string, error) {
	registration, err := queries.GetMaterializableAgentRuntimeRegistrationByManagementID(ctx, owner.AgentManagementID)
	if isNoRows(err) {
		return "", ErrFenced
	}
	if err != nil {
		return "", err
	}
	if registration.TenantID != owner.TenantID || registration.ActorID != owner.AgentActorID || owner.TerminalReason.Valid {
		return "", ErrFenced
	}
	return registration.AgentType, nil
}
