package agentregistry

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

// ErrAgentPlacementTargetUnavailable reports a Computer or workspace grant the Sponsor cannot place an Agent on.
var ErrAgentPlacementTargetUnavailable = errors.New("Agent placement target is unavailable")

// AgentRegistrationSpec is the Actor and registration one creation path writes.
type AgentRegistrationSpec struct {
	store.CreateAgentRegistrationParams
	DisplayName string
}

// CreateAgentRegistration writes the Agent Actor and its active registration
// in the caller's transaction. When they already exist it reads the
// registration back and returns it if it is the same Agent.
func CreateAgentRegistration(ctx context.Context, queries *store.Queries, spec AgentRegistrationSpec) (store.AgentRegistration, error) {
	created, err := queries.CreateAgentActor(ctx, store.CreateAgentActorParams{
		ID: spec.ActorID, TenantID: spec.TenantID, DisplayName: spec.DisplayName,
		Handle: pgtype.Text{String: "@" + spec.ActorID, Valid: true},
	})
	if err != nil {
		return store.AgentRegistration{}, err
	}
	if created == 0 {
		actor, err := queries.GetActor(ctx, store.GetActorParams{ID: spec.ActorID, TenantID: spec.TenantID})
		if err != nil {
			return store.AgentRegistration{}, err
		}
		if actor.Kind != "agent" {
			return store.AgentRegistration{}, errors.New("Agent Actor ID belongs to another Actor")
		}
	}
	inserted, err := queries.CreateAgentRegistration(ctx, spec.CreateAgentRegistrationParams)
	if !errors.Is(err, pgx.ErrNoRows) {
		return AgentRegistrationFromRecord(store.GetAgentRegistrationRow(inserted)), err
	}
	record, err := queries.GetAgentRegistration(ctx, store.GetAgentRegistrationParams{ActorID: spec.ActorID, TenantID: spec.TenantID})
	if err != nil {
		return store.AgentRegistration{}, err
	}
	registration := AgentRegistrationFromRecord(record)
	if registration.Status != "active" || registration.AgentType != spec.AgentType ||
		registration.CreatedByActorID != spec.CreatedByActorID || registration.RepresentedHumanActorID != spec.RepresentedHumanActorID {
		return store.AgentRegistration{}, errors.New("Agent registration belongs to another Agent")
	}
	return registration, nil
}

// requireAgentPlacementTarget locks the Computer an Agent is placed on for the
// rest of the caller's transaction and checks that the Sponsor owns it, that
// it was not removed, and that the workspace grant is one of its writable
// grants. A concurrent removal of the Computer waits behind this lock and then
// finds the Agent there. The Computer may be offline.
func requireAgentPlacementTarget(ctx context.Context, queries *store.Queries, tenantID, sponsorActorID, computerID, workspaceGrantID string) error {
	target, err := queries.LockAgentRuntimeLocalComputer(ctx, computerID)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && target.Status == "removed") {
		return ErrAgentPlacementTargetUnavailable
	}
	if err != nil {
		return err
	}
	if target.OwnerTenantID != tenantID || target.OwnerActorID != sponsorActorID ||
		!writableWorkspaceGrantExists(target.WorkspaceGrants, workspaceGrantID) {
		return ErrAgentPlacementTargetUnavailable
	}
	return nil
}

func writableWorkspaceGrantExists(raw []byte, grantID string) bool {
	var grants []struct {
		GrantID string `json:"grant_id"`
		Mode    string `json:"mode"`
	}
	if grantID == "" || json.Unmarshal(raw, &grants) != nil {
		return false
	}
	for _, grant := range grants {
		if grant.GrantID == grantID && grant.Mode == "workspace-write" {
			return true
		}
	}
	return false
}

// NotifyAgentRegistrationChanged wakes Agent Service after a committed
// registration change. The row is already authoritative: Agent Service reads
// it again at the Agent's next Run, so a lost wake-up only delays stopping
// stale Contexts and removing a revoked Agent's Runner.
func (s *Service) NotifyAgentRegistrationChanged(ctx context.Context, agentManagementID string) {
	if s.agentManagement == nil || agentManagementID == "" {
		return
	}
	notifyCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer cancel()
	if err := s.agentManagement.NotifyAgentRegistrationChanged(notifyCtx, agentManagementID); err != nil {
		s.logger.Warn("agent_registration.notify_failed", "agent_management_id", agentManagementID, "error", err)
	}
}

// AgentRegistrationFromRecord copies a generic registration read, which names
// every column except the avatar image and template installation, into the
// registration value the Agent flows pass around.
func AgentRegistrationFromRecord(row store.GetAgentRegistrationRow) store.AgentRegistration {
	return store.AgentRegistration{
		ActorID: row.ActorID, TenantID: row.TenantID, AgentManagementID: row.AgentManagementID,
		Status: row.Status, Instructions: row.Instructions, RuntimeModel: row.RuntimeModel,
		CreatedByActorID: row.CreatedByActorID,
		CreatedAt:        row.CreatedAt, UpdatedAt: row.UpdatedAt,
		ComputerID: row.ComputerID, LocalRuntimeType: row.LocalRuntimeType, WorkspaceGrantID: row.WorkspaceGrantID,
		VisibilityScope: row.VisibilityScope, Description: row.Description,
		ConfigurationRevision: row.ConfigurationRevision, AgentType: row.AgentType,
		RepresentedHumanActorID:  row.RepresentedHumanActorID,
		UserArtifactOwnerActorID: row.UserArtifactOwnerActorID, RuntimeReasoningEffort: row.RuntimeReasoningEffort,
		AvatarKey:                    row.AvatarKey,
		RuntimeConfigurationRevision: row.RuntimeConfigurationRevision,
	}
}
