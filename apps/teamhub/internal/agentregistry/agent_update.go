package agentregistry

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentruntimestate"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/collaboration"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

var (
	// ErrAgentConfigurationConflict reports an Agent configuration revision that changed since the caller read it.
	ErrAgentConfigurationConflict = errors.New("Agent configuration revision changed")
	// ErrAgentUpdateUnavailable reports an Agent that cannot be edited from its current state.
	ErrAgentUpdateUnavailable = errors.New("Agent update is unavailable")
)

// ExecuteTenantAgentUpdate replaces an Agent's Runtime, and possibly moves it
// to another Computer or workspace grant, in one transaction. The target
// Computer may be offline: the Agent waits for it, and Agent Service places it
// there at its next Run. The previous Computer's CLI credentials end in the
// same transaction.
func (s *Service) ExecuteTenantAgentUpdate(
	ctx context.Context,
	accountID, tenantID, actorID string,
	request httpapi.TenantAgentUpdateRequest,
) (httpapi.TenantAgent, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return httpapi.TenantAgent{}, err
	}
	defer tx.Rollback(ctx)
	queries := s.queries.WithTx(tx)
	// The same lock the profile-only update takes.
	if err := queries.AcquireAdvisoryTransactionLock(ctx, tenantID+"|agent-update|"+actorID); err != nil {
		return httpapi.TenantAgent{}, err
	}
	creator, err := queries.GetHumanActor(ctx, store.GetHumanActorParams{TenantID: tenantID, AccountID: textValue(accountID)})
	if err != nil {
		return httpapi.TenantAgent{}, err
	}
	if err := queries.AcquireAdvisoryTransactionLock(ctx, "agent-skill-bindings|"+actorID); err != nil {
		return httpapi.TenantAgent{}, err
	}
	row, err := queries.GetAgentRegistrationForUpdate(ctx, store.GetAgentRegistrationForUpdateParams{ActorID: actorID, TenantID: tenantID})
	if err != nil {
		return httpapi.TenantAgent{}, err
	}
	switch {
	case row.CreatedByActorID != creator.ID:
		return httpapi.TenantAgent{}, collaboration.ErrAgentSponsorRequired
	case row.Status != "active",
		// Another Me keeps its product-owned description and instructions; its
		// Sponsor may only rename it or change its Runtime.
		row.AgentType == "anotherme" && (request.Description != nil || request.Instructions != nil):
		return httpapi.TenantAgent{}, ErrAgentUpdateUnavailable
	case row.ConfigurationRevision != request.ExpectedConfigurationRevision:
		return httpapi.TenantAgent{}, ErrAgentConfigurationConflict
	}
	runtime := *request.Runtime
	placement := runtime.Placement
	computerChanged := *placement.ComputerId != row.ComputerID.String
	if computerChanged || *placement.WorkspaceGrantId != row.WorkspaceGrantID.String {
		if err := requireAgentPlacementTarget(ctx, queries, tenantID, creator.ID, *placement.ComputerId, *placement.WorkspaceGrantId); err != nil {
			return httpapi.TenantAgent{}, err
		}
		// Work held by a Computer that is not online can never finish there.
		// End it before the pending-work gate so the move can proceed.
		previousOnline, err := agentComputerOnline(ctx, queries, row.ComputerID.String)
		if err != nil {
			return httpapi.TenantAgent{}, err
		}
		if !previousOnline {
			if _, err := agentruntimestate.TerminateLocalWorkForUnreachableComputer(ctx, queries, tenantID, actorID); err != nil {
				return httpapi.TenantAgent{}, err
			}
		}
	}
	pendingLocalWork, err := queries.HasPendingAgentLocalWork(ctx, store.HasPendingAgentLocalWorkParams{TenantID: tenantID, AgentActorID: actorID})
	if err != nil {
		return httpapi.TenantAgent{}, err
	}
	if pendingLocalWork {
		return httpapi.TenantAgent{}, ErrAgentHasActiveRuns
	}
	description, instructions := row.Description, row.Instructions
	if request.Description != nil {
		description = *request.Description
	}
	if request.Instructions != nil {
		instructions = *request.Instructions
	}
	updated, err := queries.ApplyAgentConfigurationUpdate(ctx, store.ApplyAgentConfigurationUpdateParams{
		ActorID: actorID, TenantID: tenantID,
		ExpectedRevision:       row.ConfigurationRevision,
		NextRevision:           row.ConfigurationRevision + 1,
		Description:            description,
		Instructions:           instructions,
		RuntimeModel:           runtime.Model,
		RuntimeReasoningEffort: optionalAgentReasoningEffort(runtime.ReasoningEffort),
		ComputerID:             *placement.ComputerId,
		LocalRuntimeType:       string(*placement.RuntimeType),
		WorkspaceGrantID:       *placement.WorkspaceGrantId,
	})
	if err != nil {
		return httpapi.TenantAgent{}, err
	}
	if updated != 1 {
		return httpapi.TenantAgent{}, ErrAgentConfigurationConflict
	}
	if request.Name != nil {
		if updated, err := queries.UpdateAgentActorDisplayName(ctx, store.UpdateAgentActorDisplayNameParams{
			ID: actorID, TenantID: tenantID, DisplayName: *request.Name,
		}); err != nil || updated != 1 {
			if err == nil {
				err = errors.New("Agent Actor was not updated")
			}
			return httpapi.TenantAgent{}, err
		}
	}
	if err := createTenantAgentDirectoryDeliveries(ctx, queries, tenantID); err != nil {
		return httpapi.TenantAgent{}, err
	}
	current, err := queries.GetAgentRegistrationForUpdate(ctx, store.GetAgentRegistrationForUpdateParams{ActorID: actorID, TenantID: tenantID})
	if err != nil {
		return httpapi.TenantAgent{}, err
	}
	agent, err := tenantAgentUpdateResponse(ctx, tx, queries, tenantID, actorID, current)
	if err != nil {
		return httpapi.TenantAgent{}, err
	}
	s.NotifyAgentRegistrationChanged(ctx, row.AgentManagementID.String)
	return agent, nil
}

// agentComputerOnline reports whether the Computer is online. A Computer that
// no longer exists is not.
func agentComputerOnline(ctx context.Context, queries *store.Queries, computerID string) (bool, error) {
	if computerID == "" {
		return false, nil
	}
	computer, err := queries.GetAgentRuntimeLocalComputer(ctx, computerID)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return computer.Status == "online", nil
}

// tenantAgentUpdateResponse commits tx and returns the changed Agent.
func tenantAgentUpdateResponse(ctx context.Context, tx pgx.Tx, queries *store.Queries, tenantID, actorID string, row store.GetAgentRegistrationForUpdateRow) (httpapi.TenantAgent, error) {
	actor, err := queries.GetActor(ctx, store.GetActorParams{ID: actorID, TenantID: tenantID})
	if err != nil {
		return httpapi.TenantAgent{}, err
	}
	creator, err := queries.GetActor(ctx, store.GetActorParams{ID: row.CreatedByActorID, TenantID: tenantID})
	if err != nil {
		return httpapi.TenantAgent{}, err
	}
	bindings, err := listAgentRegistrationBindings(ctx, queries, []string{actorID})
	if err != nil {
		return httpapi.TenantAgent{}, err
	}
	images, err := AgentAvatarImageVersions(ctx, queries, tenantID, []string{actorID})
	if err != nil {
		return httpapi.TenantAgent{}, err
	}
	model := withAgentAvatarImage(tenantAgentModelWithBindings(actor, creator, agentRegistrationFromUpdateRow(row), bindings[actorID]), images)
	if err := tx.Commit(ctx); err != nil {
		return httpapi.TenantAgent{}, err
	}
	return model, nil
}

func agentRegistrationFromUpdateRow(row store.GetAgentRegistrationForUpdateRow) store.AgentRegistration {
	return store.AgentRegistration{
		ActorID: row.ActorID, TenantID: row.TenantID, AgentManagementID: row.AgentManagementID,
		Status: row.Status, Description: row.Description, AvatarKey: row.AvatarKey, ConfigurationRevision: row.ConfigurationRevision,
		RuntimeConfigurationRevision: row.RuntimeConfigurationRevision,
		Instructions:                 row.Instructions, RuntimeModel: row.RuntimeModel,
		RuntimeReasoningEffort: row.RuntimeReasoningEffort,
		ComputerID:             row.ComputerID, LocalRuntimeType: row.LocalRuntimeType, WorkspaceGrantID: row.WorkspaceGrantID,
		CreatedByActorID: row.CreatedByActorID, VisibilityScope: row.VisibilityScope, AgentType: row.AgentType,
		CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt,
	}
}
