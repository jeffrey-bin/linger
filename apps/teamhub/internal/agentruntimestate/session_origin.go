package agentruntimestate

import (
	"context"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

// A cold native runtime has no resumable Session until its first Run is sealed.
// A profile-only change may advance the registration during that Run. Only
// the Run this epoch claimed under the older revision can store that first
// Session at it.
func validateFirstSessionAfterProfileChange(
	owner contextRecord,
	registration store.GetMaterializableAgentRuntimeRegistrationByManagementIDRow,
	epoch string, checkpoint RuntimeSessionCheckpoint, run *store.AgentLocalRun,
) error {
	_, nativeProvider := runtimeSessionProviderIdentity(registration)
	if run == nil || run.Status != "running" || run.ContextKey != owner.ContextKey || run.Epoch.String != epoch ||
		!run.ClaimConfigurationRevision.Valid || run.ClaimConfigurationRevision.Int64 != checkpoint.ConfigurationRevision ||
		nativeProvider == "" || owner.TargetResidency != "active" ||
		!profileOnlySince(owner, registration, checkpoint.ProviderKind, checkpoint.ConfigurationRevision) {
		return ErrConflict
	}
	return nil
}

// profileOnlySince reports whether every change after previousRevision only
// changed the profile: a Session of that revision on the same
// provider stays valid, and the Agent learns the new profile from a claim.
func profileOnlySince(
	owner contextRecord,
	registration store.GetMaterializableAgentRuntimeRegistrationByManagementIDRow,
	providerKind string, previousRevision int64,
) bool {
	sessionProvider, _ := runtimeSessionProviderIdentity(registration)
	return registration.Status == "active" &&
		registration.TenantID == owner.TenantID && registration.ActorID == owner.AgentActorID &&
		registration.AgentManagementID.Valid && registration.AgentManagementID.String == owner.AgentManagementID &&
		sessionProvider != "" && sessionProvider == providerKind &&
		registration.RuntimeConfigurationRevision <= previousRevision && previousRevision < registration.ConfigurationRevision
}

// claimProfileUpdate hands a Session the Agent's current profile once when it
// started under an older one and the Runtime has not changed since; a Runtime
// change instead discards the Session at activation. A Context without a
// Session starts its first one under the profile it loaded.
func claimProfileUpdate(
	ctx context.Context, queries *store.Queries, contextKey string,
	registration store.GetMaterializableAgentRuntimeRegistrationByManagementIDRow,
) (*ProfileUpdate, error) {
	session, err := queries.GetAgentRuntimeSession(ctx, contextKey)
	if isNoRows(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if registration.Status != "active" || session.SessionProfileRevision.Int64 >= registration.ConfigurationRevision ||
		registration.RuntimeConfigurationRevision > session.SessionConfigurationRevision.Int64 {
		return nil, nil
	}
	if _, err := queries.AdvanceAgentRuntimeSessionProfileRevision(ctx, store.AdvanceAgentRuntimeSessionProfileRevisionParams{
		ContextKey: contextKey, ProfileRevision: registration.ConfigurationRevision,
	}); err != nil {
		return nil, err
	}
	return &ProfileUpdate{
		ConfigurationRevision: registration.ConfigurationRevision,
		Name:                  registration.DisplayName, Instructions: registration.Instructions,
	}, nil
}

// RuntimeSession identifies the transport; the claim receipt identifies the
// native provider. A Computer can execute several providers through "local".
// Derive both from persisted placement, never from opaque Session JSON.
func runtimeSessionProviderIdentity(registration store.GetMaterializableAgentRuntimeRegistrationByManagementIDRow) (string, string) {
	if !registration.ComputerID.Valid || registration.ComputerID.String == "" ||
		!registration.WorkspaceGrantID.Valid || registration.WorkspaceGrantID.String == "" || !registration.LocalRuntimeType.Valid {
		return "", ""
	}
	native := registration.LocalRuntimeType.String
	if !IsSupportedLocalRuntimeType(native) {
		return "", ""
	}
	return "local", native
}
