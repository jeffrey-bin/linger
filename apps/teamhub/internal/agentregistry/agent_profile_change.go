package agentregistry

import (
	"context"

	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/collaboration"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/messagecreation"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

// AgentProfileChange is a profile-only change. Nil fields are kept.
type AgentProfileChange struct {
	Name, Description, Instructions *string
}

// Empty reports a change that names no field.
func (change AgentProfileChange) Empty() bool {
	return change.Name == nil && change.Description == nil && change.Instructions == nil
}

// executeTenantAgentProfileUpdate applies a Sponsor's change of only name,
// description, or instructions. Unlike a Runtime change it neither waits for
// an idle Agent nor replaces the execution definition.
func (s *Service) ExecuteTenantAgentProfileUpdate(
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
	if err := lockAgentProfileTarget(ctx, queries, tenantID, actorID); err != nil {
		return httpapi.TenantAgent{}, err
	}
	// The same lock the Runtime update saga takes for its reservation.
	if err := queries.AcquireAdvisoryTransactionLock(ctx, tenantID+"|agent-update|"+actorID); err != nil {
		return httpapi.TenantAgent{}, err
	}
	creator, err := queries.GetHumanActor(ctx, store.GetHumanActorParams{TenantID: tenantID, AccountID: textValue(accountID)})
	if err != nil {
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
		// Another Me keeps its system description and instructions; only its name changes.
		row.AgentType == "anotherme" && (request.Description != nil || request.Instructions != nil):
		return httpapi.TenantAgent{}, ErrAgentUpdateUnavailable
	case row.ConfigurationRevision != request.ExpectedConfigurationRevision:
		return httpapi.TenantAgent{}, ErrAgentConfigurationConflict
	}
	if _, err := ApplyAgentProfileChange(ctx, tx, queries, row, AgentProfileChange{
		Name: request.Name, Description: request.Description, Instructions: request.Instructions,
	}); err != nil {
		return httpapi.TenantAgent{}, err
	}
	updated, err := queries.GetAgentRegistrationForUpdate(ctx, store.GetAgentRegistrationForUpdateParams{ActorID: actorID, TenantID: tenantID})
	if err != nil {
		return httpapi.TenantAgent{}, err
	}
	return tenantAgentUpdateResponse(ctx, tx, queries, tenantID, actorID, updated)
}

// ApplyAgentProfileChange writes a profile-only change to a registration the
// caller locked with GetAgentRegistrationForUpdate. It advances the revision
// without replacing the execution definition in AgentManagement, so the Agent
// need not be idle: each Context reads the new profile on its next turn.
func ApplyAgentProfileChange(
	ctx context.Context,
	tx pgx.Tx,
	queries *store.Queries,
	row store.GetAgentRegistrationForUpdateRow,
	change AgentProfileChange,
) (int64, error) {
	instructions, description := row.Instructions, row.Description
	if change.Instructions != nil {
		instructions = *change.Instructions
	}
	if change.Description != nil {
		description = *change.Description
	}
	changed, err := queries.ApplyAgentProfileUpdate(ctx, store.ApplyAgentProfileUpdateParams{
		Instructions: instructions, Description: description,
		ActorID: row.ActorID, TenantID: row.TenantID, ExpectedRevision: row.ConfigurationRevision,
	})
	if err != nil {
		return 0, err
	}
	if changed != 1 {
		return 0, ErrAgentConfigurationConflict
	}
	nextRevision := row.ConfigurationRevision + 1
	if change.Name != nil {
		changed, err := queries.UpdateAgentActorDisplayName(ctx, store.UpdateAgentActorDisplayNameParams{
			ID: row.ActorID, TenantID: row.TenantID, DisplayName: *change.Name,
		})
		if err != nil {
			return 0, err
		}
		if changed != 1 {
			return 0, ErrAgentConfigurationConflict
		}
	}
	if err := createTenantAgentDirectoryDeliveries(ctx, queries, row.TenantID); err != nil {
		return 0, err
	}
	return nextRevision, nil
}

// PostAgentProfileNotice announces an Agent CLI identity change in roomID, in
// the change's transaction after ApplyAgentProfileChange. before is the Agent
// the change started from. Only a changed name or description is shown, and
// never the instruction text. The caller locked roomID before the change, as
// a Room lock precedes the delivery Accounts the change takes.
func PostAgentProfileNotice(ctx context.Context, queries *store.Queries, tenantID, roomID, authorID string, before sponsorAgent, change AgentProfileChange) error {
	changes := []messagecreation.FieldChange{}
	if change.Name != nil && *change.Name != before.name {
		changes = append(changes, messagecreation.FieldChange{Field: "name", Before: before.name, After: *change.Name})
	}
	if change.Description != nil && *change.Description != before.registration.Description {
		changes = append(changes, messagecreation.FieldChange{Field: "description", Before: before.registration.Description, After: *change.Description})
	}
	instructionsChanged := change.Instructions != nil && *change.Instructions != before.registration.Instructions
	author, err := queries.GetActor(ctx, store.GetActorParams{ID: authorID, TenantID: tenantID})
	if err != nil {
		return err
	}
	agent, err := queries.GetActor(ctx, store.GetActorParams{ID: before.registration.ActorID, TenantID: tenantID})
	if err != nil {
		return err
	}
	notice := messagecreation.AgentProfileChanged(agent, collaboration.IsUninitializedAgentProfile(before.registration.Instructions), changes, instructionsChanged)
	_, err = messagecreation.CreateNotice(ctx, queries, tenantID, roomID, author, notice)
	return err
}
