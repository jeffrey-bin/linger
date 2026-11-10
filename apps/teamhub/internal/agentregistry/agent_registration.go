package agentregistry

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/collaboration"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/idempotency"
	idgen "github.com/simplexai-labs/linger/apps/teamhub/internal/ids"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/roomagent"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/skill"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/tenantmembership"
	"github.com/simplexai-labs/linger/contracts-go/teamhubinternal"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

func (s *Service) agentRepresentedHumanIdentity(
	ctx context.Context,
	registration store.AgentRegistration,
) (*teamhubinternal.AgentRepresentedHumanRef, error) {
	if registration.AgentType != "anotherme" {
		return nil, nil
	}
	human, err := s.queries.GetAnotherMeRepresentedHumanIdentityByExternalID(ctx, registration.AgentManagementID)
	if err != nil {
		return nil, err
	}
	if human.ActorID == "" || human.DisplayName == "" || human.ActorID == registration.ActorID {
		return nil, errors.New("active AnotherMe represented Human identity is invalid")
	}
	identity := &teamhubinternal.AgentRepresentedHumanRef{
		Id:          human.ActorID,
		DisplayName: human.DisplayName,
	}
	if human.MemoryVersion > 0 {
		identity.Memory = &teamhubinternal.UserMemoryRevision{
			Version:  int(human.MemoryVersion),
			Markdown: human.MemoryMarkdown,
		}
	}
	return identity, nil
}

func listedTenantAgentAvailability(row store.ListTenantAgentsForAccountRow) httpapi.TenantAgentAvailability {
	return httpapi.TenantAgentAvailability{
		Status: httpapi.TenantAgentAvailabilityStatusOnline, Label: "Online", ActiveTaskCount: row.ActiveTaskCount,
	}
}

func unavailableLocalAgentRuntimeStatus(row store.ListTenantAgentsForAccountRow) roomagent.LocalAgentRuntimeStatus {
	return roomagent.LocalAgentRuntimeStatus{
		AgentID: row.AgentManagementID.String, ComputerID: row.ComputerID.String,
		DisplayName: row.ComputerID.String, ComputerStatus: "unknown",
		RuntimeType: row.LocalRuntimeType.String, Status: "unknown",
		ConnectionStatus: "unknown",
		ErrorCode:        "RUNTIME_DIAGNOSTIC_FAILED", Message: "Local Runtime status is temporarily unavailable",
	}
}

func localAgentRuntimeStatusModel(status roomagent.LocalAgentRuntimeStatus) httpapi.LocalAgentRuntimeStatus {
	model := httpapi.LocalAgentRuntimeStatus{
		ComputerId: status.ComputerID, DisplayName: status.DisplayName,
		ComputerStatus: httpapi.LocalAgentRuntimeStatusComputerStatus(status.ComputerStatus),
		RuntimeType:    httpapi.LocalRuntimeType(status.RuntimeType),
		Status:         httpapi.LocalRuntimeDiagnosticStatus(status.Status),
	}
	if !status.ObservedAt.IsZero() {
		model.ObservedAt = &status.ObservedAt
	}
	if status.ConnectionStatus != "" {
		connection := httpapi.LocalAgentRuntimeStatusConnectionStatus(status.ConnectionStatus)
		model.ConnectionStatus = &connection
	}
	if status.Version != "" {
		model.Version = &status.Version
	}
	if status.ErrorCode != "" {
		code := httpapi.LocalRuntimeDiagnosticErrorCode(status.ErrorCode)
		model.ErrorCode = &code
	}
	if status.Message != "" {
		model.Message = &status.Message
	}
	return model
}

func availabilityWithLocalRuntimeStatus(
	availability httpapi.TenantAgentAvailability,
	status roomagent.LocalAgentRuntimeStatus,
) httpapi.TenantAgentAvailability {
	connectionUncertain := status.ConnectionStatus == "reconnecting" || status.ConnectionStatus == "unknown"
	if availability.Status != httpapi.TenantAgentAvailabilityStatusError &&
		(status.Status == "unknown" || (status.Status == "ready" && connectionUncertain)) {
		label := "Status unavailable"
		if status.ConnectionStatus == "reconnecting" {
			label = "Reconnecting"
		}
		return httpapi.TenantAgentAvailability{
			Status: httpapi.TenantAgentAvailabilityStatusUnknown,
			Label:  label, ActiveTaskCount: availability.ActiveTaskCount,
			CurrentActivity: availability.CurrentActivity,
		}
	}
	if status.Status == "authentication_required" {
		projected := offlineAgentAvailability("Authentication required")
		projected.ActiveTaskCount = availability.ActiveTaskCount
		return projected
	}
	if availability.Status == httpapi.TenantAgentAvailabilityStatusError ||
		status.Status == "ready" {
		return availability
	}
	if status.ComputerStatus == "offline" || status.ErrorCode == "LOCAL_COMPUTER_OFFLINE" {
		// The Agent waits for its Computer and runs there once it connects.
		projected := offlineAgentAvailability("Waiting for the computer to connect")
		projected.ActiveTaskCount = availability.ActiveTaskCount
		return projected
	}
	summary := strings.TrimSpace(status.Message)
	if summary == "" {
		summary = "Local Runtime needs attention"
	}
	return httpapi.TenantAgentAvailability{
		Status: httpapi.TenantAgentAvailabilityStatusError,
		Label:  "Needs attention", ActiveTaskCount: availability.ActiveTaskCount,
		CurrentActivity: &httpapi.TenantAgentCurrentActivity{
			Summary: truncateActivity(summary),
		},
	}
}

// NormalizeAgentDescription trims a description and reports whether it fits the Unicode rune limit.
func NormalizeAgentDescription(description string) (string, bool) {
	description = strings.TrimSpace(description)
	return description, len([]rune(description)) <= 1000
}

// AgentPlacementTargetUnavailableMessage explains a refused placement. The
// Computer may be offline; the Agent then waits for it.
const AgentPlacementTargetUnavailableMessage = "The selected computer must be owned by you and offer the chosen writable workspace"

func tenantAgentModelWithBindings(
	actor, creator store.Actor,
	registration store.AgentRegistration,
	skillBindings []httpapi.AgentSkillRegistration,
) httpapi.TenantAgent {
	var avatarKey *string
	if registration.AvatarKey.Valid {
		avatarKey = &registration.AvatarKey.String
	}
	return httpapi.TenantAgent{
		Actor:                 collaboration.ActorModel(actor),
		AgentManagementId:     registration.AgentManagementID.String,
		AgentType:             httpapi.AgentType(registration.AgentType),
		Description:           registration.Description,
		AvatarKey:             avatarKey,
		ConfigurationRevision: registration.ConfigurationRevision,
		Instructions:          registration.Instructions,
		Runtime:               agentRuntimeConfig(registration),
		SkillBindings:         cloneSlice(skillBindings),
		CreatedBy:             collaboration.ActorRef(creator),
		CreatedAt:             registration.CreatedAt.Time,
		UpdatedAt:             registration.UpdatedAt.Time,
		VisibilityScope:       httpapi.AgentVisibilityScope(registration.VisibilityScope),
	}
}

func validAgentRuntimePlacement(placement *httpapi.AgentRuntimePlacement) bool {
	return placement != nil && placement.Type == httpapi.Local &&
		placement.ComputerId != nil && localComputerIDPattern.MatchString(*placement.ComputerId) &&
		placement.RuntimeType != nil && validLocalRuntimeType(*placement.RuntimeType) &&
		placement.WorkspaceGrantId != nil && localComputerIDPattern.MatchString(*placement.WorkspaceGrantId)
}

// ValidAgentRuntimeConfig reports whether a Runtime configuration names a model and a complete placement.
func ValidAgentRuntimeConfig(runtime httpapi.AgentRuntimeConfig) bool {
	if strings.TrimSpace(runtime.Model) == "" || len(runtime.Model) > 120 ||
		!validAgentRuntimePlacement(runtime.Placement) {
		return false
	}
	if runtime.ReasoningEffort != nil && !runtime.ReasoningEffort.Valid() {
		return false
	}
	return true
}

func validLocalRuntimeType(runtimeType httpapi.LocalRuntimeType) bool {
	return runtimeType == httpapi.LocalRuntimeTypeCodex ||
		runtimeType == httpapi.LocalRuntimeTypeClaude ||
		runtimeType == httpapi.LocalRuntimeTypePi
}

func agentRuntimeConfig(registration store.AgentRegistration) httpapi.AgentRuntimeConfig {
	computerID := registration.ComputerID.String
	localRuntimeType := httpapi.LocalRuntimeType(registration.LocalRuntimeType.String)
	workspaceGrantID := registration.WorkspaceGrantID.String
	placement := &httpapi.AgentRuntimePlacement{
		Type: httpapi.Local, ComputerId: &computerID, RuntimeType: &localRuntimeType,
		WorkspaceGrantId: &workspaceGrantID,
	}
	runtime := httpapi.AgentRuntimeConfig{Model: registration.RuntimeModel, Placement: placement}
	if registration.RuntimeReasoningEffort.Valid {
		effort := httpapi.AgentReasoningEffort(registration.RuntimeReasoningEffort.String)
		runtime.ReasoningEffort = &effort
	}
	return runtime
}

func listedTenantAgentModel(
	row store.ListTenantAgentsForAccountRow,
	skillBindings []httpapi.AgentSkillRegistration,
) httpapi.TenantAgent {
	return tenantAgentModelWithBindings(
		store.Actor{
			ID: row.ActorID, TenantID: row.TenantID, Kind: row.AgentKind,
			DisplayName: row.AgentDisplayName, AccountID: row.AgentAccountID,
			Handle: row.AgentHandle, CreatedAt: row.AgentCreatedAt,
		},
		store.Actor{
			ID: row.CreatedByActorID, TenantID: row.TenantID, Kind: row.CreatorKind,
			DisplayName: row.CreatorDisplayName, AccountID: row.CreatorAccountID,
			Handle: row.CreatorHandle, CreatedAt: row.CreatorCreatedAt,
		},
		store.AgentRegistration{
			ActorID: row.ActorID, TenantID: row.TenantID,
			AgentManagementID: row.AgentManagementID, Status: row.Status,
			Description: row.Description, AvatarKey: row.AvatarKey,
			ConfigurationRevision: row.ConfigurationRevision,
			Instructions:          row.Instructions, RuntimeModel: row.RuntimeModel,
			RuntimeReasoningEffort: row.RuntimeReasoningEffort,
			ComputerID:             row.ComputerID,
			LocalRuntimeType:       row.LocalRuntimeType, WorkspaceGrantID: row.WorkspaceGrantID,
			CreatedByActorID: row.CreatedByActorID,
			VisibilityScope:  row.VisibilityScope,
			AgentType:        row.AgentType,
			CreatedAt:        row.CreatedAt, UpdatedAt: row.UpdatedAt,
		},
		skillBindings,
	)
}

func offlineAgentAvailability(summary string) httpapi.TenantAgentAvailability {
	return httpapi.TenantAgentAvailability{
		Status: httpapi.TenantAgentAvailabilityStatusOffline,
		Label:  "Offline",
		CurrentActivity: &httpapi.TenantAgentCurrentActivity{
			Summary: summary,
		},
	}
}

func truncateActivity(value string) string {
	runes := []rune(strings.TrimSpace(value))
	if len(runes) <= 240 {
		return string(runes)
	}
	return string(runes[:237]) + "..."
}

// ExecuteTenantAgentRegistration creates an active Agent in one transaction.
// The chosen Computer may be offline; the Agent runs there once it connects.
// A non-empty key replays an earlier creation with that key; a Human
// creation passes none.
func (s *Service) ExecuteTenantAgentRegistration(ctx context.Context, accountID, tenantID string, request httpapi.TenantAgentCreateRequest, key string) (idempotency.Result, error) {
	idempotencyKey := idempotency.AccountKey(accountID, "createTenantAgent:"+tenantID, key)
	requestHash := idempotency.HashRequest(request)
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return idempotency.Result{}, err
	}
	defer tx.Rollback(ctx)
	queries := s.queries.WithTx(tx)
	if err := idempotency.Lock(ctx, tx, idempotencyKey); err != nil {
		return idempotency.Result{}, err
	}
	creator, err := queries.GetHumanActor(ctx, store.GetHumanActorParams{TenantID: tenantID, AccountID: textValue(accountID)})
	if err != nil {
		return idempotency.Result{}, err
	}
	// Concurrent creations by one Sponsor serialize so the Agent cap below holds.
	if err := queries.AcquireAdvisoryTransactionLock(ctx, "agent-sponsor|"+creator.ID); err != nil {
		return idempotency.Result{}, err
	}
	record, found, err := idempotency.Lookup(ctx, tx, idempotencyKey, requestHash)
	switch {
	case errors.Is(err, idempotency.ErrConflict):
		return idempotency.Result{}, idempotency.ErrConflict
	case err != nil:
		return idempotency.Result{}, err
	case found:
		if err := tx.Commit(ctx); err != nil {
			return idempotency.Result{}, err
		}
		return idempotency.Result{Status: record.Status, Body: append([]byte(nil), record.Body...), Replay: true}, nil
	}

	actorID, body, err := insertTenantAgent(ctx, tx, queries, tenantID, creator.ID, request)
	if err != nil {
		return idempotency.Result{}, err
	}
	if err := idempotency.Save(ctx, tx, idempotencyKey, requestHash, idempotency.Record{
		ResourceID: actorID, Status: http.StatusCreated, Body: body,
	}); err != nil {
		return idempotency.Result{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return idempotency.Result{}, err
	}
	return idempotency.Result{Status: http.StatusCreated, Body: body}, nil
}

// insertTenantAgent creates an active Agent for its Sponsor in the caller's
// transaction and returns its Actor ID and the created Agent's response body.
func insertTenantAgent(ctx context.Context, tx pgx.Tx, queries *store.Queries, tenantID, creatorID string, request httpapi.TenantAgentCreateRequest) (string, []byte, error) {
	if *request.AgentType == httpapi.CreatableAgentTypeGeneral {
		// The cap counts Agents created on the Web and by Agents alike.
		count, err := queries.CountSponsorGeneralAgents(ctx, store.CountSponsorGeneralAgentsParams{
			TenantID: tenantID, SponsorActorID: creatorID,
		})
		if err != nil {
			return "", nil, err
		}
		if count >= MaxSponsorGeneralAgents {
			return "", nil, ErrAgentLimitReached
		}
	}
	placement := request.Runtime.Placement
	if err := requireAgentPlacementTarget(ctx, queries, tenantID, creatorID, *placement.ComputerId, *placement.WorkspaceGrantId); err != nil {
		return "", nil, err
	}
	if err := queries.AcquireUnifiedSkillPolicyExclusiveLock(ctx); err != nil {
		return "", nil, err
	}
	actorID := idgen.New("actor")
	if err := tenantmembership.LockAgent(ctx, queries, actorID); err != nil {
		return "", nil, err
	}
	registration, err := CreateAgentRegistration(ctx, queries, AgentRegistrationSpec{
		CreateAgentRegistrationParams: agentRegistrationParams(actorID, tenantID, creatorID, idgen.New("agent"), request),
		DisplayName:                   request.Name,
	})
	if err != nil {
		return "", nil, err
	}
	if err := reserveAgentTemplateInstallation(ctx, queries, actorID, request); err != nil {
		return "", nil, err
	}
	if err := storeAgentRegistrationBindings(ctx, queries, actorID, tenantID, creatorID, request); err != nil {
		return "", nil, err
	}
	if err := skill.ValidateEffectiveInTx(ctx, tx, skill.Identity{
		AgentActorID: actorID, TenantID: tenantID, AgentType: string(*request.AgentType),
	}); err != nil {
		if errors.Is(err, skill.ErrConflict) || errors.Is(err, skill.ErrDependency) {
			return "", nil, fmt.Errorf("%w: %v", ErrInvalidAgentSkillRegistration, err) //nolint:errorlint // inner Skill errors must not match the effective-set sentinel branches ahead of this sentinel
		}
		return "", nil, err
	}
	actor, err := queries.GetActor(ctx, store.GetActorParams{ID: actorID, TenantID: tenantID})
	if err != nil {
		return "", nil, err
	}
	creatorActor, err := queries.GetActor(ctx, store.GetActorParams{ID: creatorID, TenantID: tenantID})
	if err != nil {
		return "", nil, err
	}
	if err := completeAgentTemplateInstallation(ctx, tx, queries, tenantID, actor, creatorActor); err != nil {
		return "", nil, err
	}
	skills, err := listAgentRegistrationBindings(ctx, queries, []string{actorID})
	if err != nil {
		return "", nil, err
	}
	body, err := json.Marshal(tenantAgentModelWithBindings(actor, creatorActor, registration, skills[actorID]))
	if err != nil {
		return "", nil, err
	}
	if err := createTenantAgentDirectoryDeliveries(ctx, queries, tenantID); err != nil {
		return "", nil, err
	}
	return actorID, body, nil
}

func agentRegistrationParams(actorID, tenantID, creatorID, agentManagementID string, request httpapi.TenantAgentCreateRequest) store.CreateAgentRegistrationParams {
	return store.CreateAgentRegistrationParams{
		ActorID: actorID, TenantID: tenantID, AgentManagementID: agentManagementID, Description: optionalString(request.Description),
		AvatarKey: optionalText(request.AvatarKey), Instructions: request.Instructions,
		RuntimeModel:           request.Runtime.Model,
		RuntimeReasoningEffort: optionalAgentReasoningEffort(request.Runtime.ReasoningEffort),
		CreatedByActorID:       creatorID,
		VisibilityScope:        string(*request.VisibilityScope),
		AgentType:              string(*request.AgentType),
		ComputerID:             *request.Runtime.Placement.ComputerId,
		LocalRuntimeType:       string(*request.Runtime.Placement.RuntimeType),
		WorkspaceGrantID:       *request.Runtime.Placement.WorkspaceGrantId,
	}
}

func optionalString(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func agentRegistrationFromRow(row store.GetAgentRegistrationByActorRow) store.AgentRegistration {
	return store.AgentRegistration{
		ActorID: row.ActorID, TenantID: row.TenantID,
		AgentManagementID: row.AgentManagementID, Status: row.Status,
		Description: row.Description, AvatarKey: row.AvatarKey, ConfigurationRevision: row.ConfigurationRevision,
		Instructions: row.Instructions, RuntimeModel: row.RuntimeModel,
		RuntimeReasoningEffort: row.RuntimeReasoningEffort,
		ComputerID:             row.ComputerID,
		LocalRuntimeType:       row.LocalRuntimeType, WorkspaceGrantID: row.WorkspaceGrantID,
		CreatedByActorID: row.CreatedByActorID,
		VisibilityScope:  row.VisibilityScope,
		AgentType:        row.AgentType,
		CreatedAt:        row.CreatedAt, UpdatedAt: row.UpdatedAt,
	}
}

func optionalAgentReasoningEffort(value *httpapi.AgentReasoningEffort) pgtype.Text {
	if value == nil {
		return pgtype.Text{}
	}
	return textValue(string(*value))
}
