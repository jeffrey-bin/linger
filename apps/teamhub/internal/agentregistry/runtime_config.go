package agentregistry

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentruntimestate"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	"github.com/simplexai-labs/linger/contracts-go/teamhubinternal"
)

// RuntimeConfigSnapshot projects an Agent's registration for Agent Service
// at the requested configuration revision, or the current one for 0. A
// serialization failure retries the whole snapshot.
func (s *Service) RuntimeConfigSnapshot(ctx context.Context, agentID string, requestedRevision int64, permissionReview bool) (teamhubinternal.AgentRuntimeConfigSnapshot, error) {
	if agentID == "" {
		return teamhubinternal.AgentRuntimeConfigSnapshot{}, agentruntimestate.ErrInvalid
	}
	for attempt := 0; ; attempt++ {
		response, err := s.runtimeConfigSnapshotOnce(ctx, agentID, requestedRevision, permissionReview)
		var postgresError *pgconn.PgError
		if err == nil || attempt == 2 || ctx.Err() != nil ||
			!errors.As(err, &postgresError) || postgresError.Code != "40001" {
			return response, err
		}
		// Retry the entire snapshot, including Context reconciliation and COMMIT,
		// after the failed transaction has rolled back and released its locks.
		timer := time.NewTimer(time.Duration(attempt+1) * 10 * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			return teamhubinternal.AgentRuntimeConfigSnapshot{}, ctx.Err()
		case <-timer.C:
		}
	}
}

func (s *Service) runtimeConfigSnapshotOnce(ctx context.Context, agentID string, requestedRevision int64, permissionReview bool) (teamhubinternal.AgentRuntimeConfigSnapshot, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead})
	if err != nil {
		return teamhubinternal.AgentRuntimeConfigSnapshot{}, err
	}
	defer tx.Rollback(ctx)
	queries := store.New(tx)
	registration, err := queries.GetMaterializableAgentRuntimeRegistrationByManagementID(ctx, agentID)
	if errors.Is(err, pgx.ErrNoRows) {
		return teamhubinternal.AgentRuntimeConfigSnapshot{}, agentruntimestate.ErrNotFound
	}
	if err != nil {
		return teamhubinternal.AgentRuntimeConfigSnapshot{}, err
	}
	if !registration.AgentManagementID.Valid || registration.AgentManagementID.String != agentID {
		return teamhubinternal.AgentRuntimeConfigSnapshot{}, agentruntimestate.ErrConflict
	}
	if requestedRevision != 0 && requestedRevision != registration.ConfigurationRevision {
		return teamhubinternal.AgentRuntimeConfigSnapshot{}, agentruntimestate.ErrConflict
	}
	if err := agentruntimestate.EnsurePerRoomMetaContexts(ctx, queries, registration.ActorID); err != nil {
		return teamhubinternal.AgentRuntimeConfigSnapshot{}, err
	}
	response, err := ProjectAgentRuntimeConfigSnapshot(registration)
	if err != nil {
		return teamhubinternal.AgentRuntimeConfigSnapshot{}, err
	}
	response.PermissionReview = permissionReview
	if err := tx.Commit(ctx); err != nil {
		return teamhubinternal.AgentRuntimeConfigSnapshot{}, err
	}
	return response, nil
}

// ProjectAgentRuntimeConfigSnapshot projects an Agent registration for Agent
// Service. Skills resolve per Context generation through effective-resources,
// so the configuration carries no resources of its own.
func ProjectAgentRuntimeConfigSnapshot(
	registration store.GetMaterializableAgentRuntimeRegistrationByManagementIDRow,
) (teamhubinternal.AgentRuntimeConfigSnapshot, error) {
	response := teamhubinternal.AgentRuntimeConfigSnapshot{
		AgentId: registration.AgentManagementID.String, ActorId: registration.ActorID,
		TenantId: registration.TenantID, ConfigurationRevision: strconv.FormatInt(registration.ConfigurationRevision, 10),
		RuntimeConfigurationRevision: strconv.FormatInt(registration.RuntimeConfigurationRevision, 10),
	}
	response.Agent.Name = registration.DisplayName
	response.Agent.Instructions = registration.Instructions
	var effort *teamhubinternal.AgentReasoningEffort
	if registration.RuntimeReasoningEffort.Valid {
		value := teamhubinternal.AgentReasoningEffort(registration.RuntimeReasoningEffort.String)
		if !value.Valid() {
			return teamhubinternal.AgentRuntimeConfigSnapshot{}, agentruntimestate.ErrConflict
		}
		effort = &value
	}

	if !registration.ComputerID.Valid || !registration.LocalRuntimeType.Valid || !registration.WorkspaceGrantID.Valid {
		return teamhubinternal.AgentRuntimeConfigSnapshot{}, agentruntimestate.ErrDependency
	}
	runtime := &response.Runtime
	runtime.Type, runtime.Model, runtime.ReasoningEffort = "local", registration.RuntimeModel, effort
	runtime.Placement.TenantId = registration.TenantID
	runtime.Placement.OwnerActorId = registration.CreatedByActorID
	runtime.Placement.ComputerId = registration.ComputerID.String
	runtime.Placement.RuntimeType = teamhubinternal.LocalRuntimeType(registration.LocalRuntimeType.String)
	runtime.Placement.WorkspaceGrantId = registration.WorkspaceGrantID.String
	runtime.Placement.AssignmentRevision = strconv.FormatInt(registration.AssignmentRevision, 10)
	if !runtime.Placement.RuntimeType.Valid() {
		return teamhubinternal.AgentRuntimeConfigSnapshot{}, agentruntimestate.ErrConflict
	}

	response.Resources.Skills = make([]struct {
		Config          map[string]interface{} `json:"config"`
		ManifestVersion string                 `json:"manifest_version"`
		Name            string                 `json:"name"`
		PackageName     string                 `json:"package_name"`
		PackageSha256   string                 `json:"package_sha256"`
		SkillId         teamhubinternal.Id     `json:"skill_id"`
	}, 0)
	response.Resources.McpServers = make([]struct {
		AllowedTools    []string           `json:"allowed_tools"`
		ManifestVersion string             `json:"manifest_version"`
		McpId           teamhubinternal.Id `json:"mcp_id"`
		Name            string             `json:"name"`
		Transport       string             `json:"transport"`
		Url             string             `json:"url"`
	}, 0)

	encoded, err := json.Marshal(response)
	if err != nil {
		return teamhubinternal.AgentRuntimeConfigSnapshot{}, err
	}
	var hashInput map[string]json.RawMessage
	if err := json.Unmarshal(encoded, &hashInput); err != nil {
		return teamhubinternal.AgentRuntimeConfigSnapshot{}, err
	}
	delete(hashInput, "content_hash")
	delete(hashInput, "permission_review")
	canonical, err := json.Marshal(hashInput)
	if err != nil {
		return teamhubinternal.AgentRuntimeConfigSnapshot{}, err
	}
	digest := sha256.Sum256(canonical)
	response.ContentHash = hex.EncodeToString(digest[:])
	return response, nil
}

// AnotherMePlacements lists where each Human's Another Me runs, so Agent
// Service can run a Human's background model calls on that Computer.
func (s *Service) AnotherMePlacements(ctx context.Context, filter store.ListAnotherMePlacementsParams) (teamhubinternal.AnotherMePlacementList, error) {
	rows, err := s.queries.ListAnotherMePlacements(ctx, filter)
	if err != nil {
		return teamhubinternal.AnotherMePlacementList{}, err
	}
	response := teamhubinternal.AnotherMePlacementList{Items: make([]teamhubinternal.AnotherMePlacement, 0, len(rows))}
	for _, row := range rows {
		response.Items = append(response.Items, teamhubinternal.AnotherMePlacement{
			TenantId: row.TenantID, OwnerActorId: row.OwnerActorID, AgentId: row.AgentID,
			AgentActorId: row.AgentActorID, ComputerId: row.ComputerID,
			LocalRuntimeType: teamhubinternal.LocalRuntimeType(row.LocalRuntimeType),
			Status:           teamhubinternal.AnotherMePlacementStatus(row.Status),
		})
	}
	return response, nil
}
