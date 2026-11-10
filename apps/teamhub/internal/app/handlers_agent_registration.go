package app

import (
	"errors"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentregistry"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/collaboration"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

func (a *App) getAgentIdentity(c *gin.Context) {
	identity, err := a.agents.AgentIdentity(c.Request.Context(), c.Param("agentId"))
	if a.notFoundOrError(c, "resolve Agent identity", err) {
		return
	}
	c.JSON(http.StatusOK, identity)
}

func (a *App) listTenantAgents(c *gin.Context) {
	page, ok := a.tenantAgentDirectoryPage(c)
	if !ok {
		return
	}
	result, err := a.agents.ListTenantAgents(c.Request.Context(), currentPrincipal(c).Session.AccountID, c.Param("tenantId"), page)
	if a.writeTenantAgentDirectoryError(c, err) {
		return
	}
	c.JSON(http.StatusOK, result)
}

func (a *App) listTenantAgentAvailability(c *gin.Context) {
	page, ok := a.tenantAgentDirectoryPage(c)
	if !ok {
		return
	}
	result, err := a.agents.ListTenantAgentAvailability(c.Request.Context(), currentPrincipal(c).Session.AccountID, c.Param("tenantId"), page)
	if a.writeTenantAgentDirectoryError(c, err) {
		return
	}
	c.JSON(http.StatusOK, result)
}

func (a *App) tenantAgentDirectoryPage(c *gin.Context) (agentregistry.DirectoryPage, bool) {
	cursor, limit, ok := parsePage(c)
	if !ok {
		a.writeError(c, http.StatusBadRequest, "INVALID_PAGE", "invalid pagination parameters")
		return agentregistry.DirectoryPage{}, false
	}
	if !a.requireSpace(c, c.Param("tenantId")) {
		return agentregistry.DirectoryPage{}, false
	}
	return agentregistry.DirectoryPage{Cursor: cursor, Limit: limit}, true
}

func (a *App) writeTenantAgentDirectoryError(c *gin.Context, err error) bool {
	if errors.Is(err, agentregistry.ErrInvalidAgentCursor) {
		a.writeError(c, http.StatusBadRequest, "INVALID_PAGE", "invalid pagination parameters")
		return true
	}
	return a.notFoundOrError(c, "list Tenant Agents", err)
}

func (a *App) createTenantAgent(c *gin.Context) {
	var request httpapi.TenantAgentCreateRequest
	if err := decodeJSON(c, &request); err != nil ||
		strings.TrimSpace(request.Name) == "" || len(request.Name) > 120 ||
		strings.TrimSpace(request.Instructions) == "" || len(request.Instructions) > 50000 ||
		!agentregistry.ValidAgentRuntimeConfig(request.Runtime) {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Agent name, instructions, and runtime model are required")
		return
	}
	request.Name = strings.TrimSpace(request.Name)
	if request.Description != nil {
		description, valid := agentregistry.NormalizeAgentDescription(*request.Description)
		if !valid {
			a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Agent name, instructions, and runtime model are required")
			return
		}
		request.Description = &description
	}
	if request.AvatarKey != nil && !agentregistry.ValidAgentAvatarKey(*request.AvatarKey) {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Agent avatar is invalid")
		return
	}
	request.Instructions = strings.TrimSpace(request.Instructions)
	request.Runtime.Model = strings.TrimSpace(request.Runtime.Model)
	agentType := httpapi.CreatableAgentTypeGeneral
	if request.AgentType != nil {
		agentType = *request.AgentType
	}
	if !agentType.Valid() {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Agent type is invalid")
		return
	}
	request.AgentType = &agentType
	visibility := httpapi.AgentVisibilityScopeSponsor
	if request.VisibilityScope != nil {
		visibility = *request.VisibilityScope
	}
	if !visibility.Valid() {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Agent visibility scope is invalid")
		return
	}
	request.VisibilityScope = &visibility
	if err := agentregistry.NormalizeAgentRegistrationBindings(&request); err != nil {
		a.writeError(c, http.StatusBadRequest, "INVALID_SKILL_REGISTRATION", "initial Skill registration is invalid")
		return
	}
	// A Human creation is not deduplicated: a repeated one creates another Agent.
	result, err := a.agents.ExecuteTenantAgentRegistration(c.Request.Context(), currentPrincipal(c).Session.AccountID, c.Param("tenantId"), request, "")
	switch {
	case errors.Is(err, agentregistry.ErrAgentTemplateUnavailable):
		a.writeError(c, http.StatusNotFound, "AGENT_TEMPLATE_NOT_FOUND", "Agent template was not found")
	case errors.Is(err, pgx.ErrNoRows):
		a.writeError(c, http.StatusNotFound, "TENANT_NOT_FOUND", "tenant was not found")
	case errors.Is(err, agentregistry.ErrAgentLimitReached):
		a.writeError(c, http.StatusConflict, "AGENT_LIMIT_REACHED", "you already have 50 Agents; delete one before creating another")
	case errors.Is(err, agentregistry.ErrAgentPlacementTargetUnavailable):
		a.writeError(c, http.StatusConflict, "AGENT_PLACEMENT_TARGET_UNAVAILABLE", agentregistry.AgentPlacementTargetUnavailableMessage)
	case errors.Is(err, agentregistry.ErrAgentRegistrationManifestNotFound):
		a.writeError(c, http.StatusNotFound, "REGISTRATION_MANIFEST_NOT_FOUND", "a referenced Skill Manifest was not found")
	case errors.Is(err, agentregistry.ErrSkillManifestNotCurrent):
		a.writeError(c, http.StatusBadRequest, "SKILL_MANIFEST_NOT_CURRENT", "platform Skill accepts only its current latest version")
	case errors.Is(err, agentregistry.ErrInvalidAgentSkillRegistration):
		a.writeError(c, http.StatusBadRequest, "INVALID_SKILL_REGISTRATION", "initial Skill registration is invalid")
	case err != nil:
		a.internalError(c, "register Agent", err)
	default:
		writeResultResponse(c, result)
	}
}

func (a *App) deleteTenantAgent(c *gin.Context) {
	result, err := a.agents.ExecuteTenantAgentDeletion(
		c.Request.Context(), currentPrincipal(c).Session.AccountID,
		c.Param("tenantId"), c.Param("agentId"),
	)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		a.writeError(c, http.StatusNotFound, "AGENT_NOT_FOUND", "Agent was not found")
	case errors.Is(err, collaboration.ErrAgentSponsorRequired):
		a.writeError(c, http.StatusForbidden, "AGENT_SPONSOR_REQUIRED", "only the Agent Sponsor can remove this Agent")
	case errors.Is(err, collaboration.ErrPendingCardDecision):
		a.writeError(c, http.StatusConflict, "PENDING_CARD_DECISION", "resolve pending card work before removing this Agent")
	case errors.Is(err, agentregistry.ErrAgentDeletionUnavailable):
		a.writeError(c, http.StatusConflict, "AGENT_DELETION_UNAVAILABLE", "Agent cannot be removed from its current state")
	case err != nil:
		a.internalError(c, "delete Agent", err)
	default:
		writeResultResponse(c, result)
	}
}

func (a *App) updateTenantAgent(c *gin.Context) {
	var request httpapi.TenantAgentUpdateRequest
	if err := decodeJSON(c, &request); err != nil || request.ExpectedConfigurationRevision < 1 ||
		(request.Name == nil && request.Description == nil && request.Instructions == nil && request.Runtime == nil) {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "an expected revision and at least one Agent change are required")
		return
	}
	if request.Name != nil {
		name := strings.TrimSpace(*request.Name)
		if name == "" || len(name) > 120 {
			a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Agent name is invalid")
			return
		}
		request.Name = &name
	}
	if request.Description != nil {
		description, valid := agentregistry.NormalizeAgentDescription(*request.Description)
		if !valid {
			a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Agent description is too long")
			return
		}
		request.Description = &description
	}
	if request.Instructions != nil && (strings.TrimSpace(*request.Instructions) == "" || len([]rune(*request.Instructions)) > 50000) {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Agent instructions must contain between 1 and 50000 characters")
		return
	}
	if request.Runtime != nil {
		request.Runtime.Model = strings.TrimSpace(request.Runtime.Model)
		if !agentregistry.ValidAgentRuntimeConfig(*request.Runtime) {
			a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Agent runtime is invalid")
			return
		}
	}
	execute := a.agents.ExecuteTenantAgentUpdate
	if request.Runtime == nil {
		// A profile-only change keeps running work and every Session.
		execute = a.agents.ExecuteTenantAgentProfileUpdate
	}
	agent, err := execute(
		c.Request.Context(), currentPrincipal(c).Session.AccountID,
		c.Param("tenantId"), c.Param("agentId"), request,
	)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		a.writeError(c, http.StatusNotFound, "AGENT_NOT_FOUND", "Agent was not found")
	case errors.Is(err, collaboration.ErrAgentSponsorRequired):
		a.writeError(c, http.StatusForbidden, "AGENT_SPONSOR_REQUIRED", "only the Agent Sponsor can edit this Agent")
	case errors.Is(err, agentregistry.ErrAgentHasActiveRuns):
		a.writeError(c, http.StatusConflict, "AGENT_BUSY", "Agent has an active Run")
	case errors.Is(err, agentregistry.ErrAgentSkillBindingConflict), errors.Is(err, agentregistry.ErrAgentConfigurationConflict):
		a.writeError(c, http.StatusConflict, "AGENT_CONFIGURATION_CONFLICT", "Agent configuration changed; refresh and try again")
	case errors.Is(err, agentregistry.ErrAgentUpdateUnavailable):
		a.writeError(c, http.StatusConflict, "AGENT_UPDATE_UNAVAILABLE", "Agent cannot be edited from its current state")
	case errors.Is(err, agentregistry.ErrAgentPlacementTargetUnavailable):
		a.writeError(c, http.StatusConflict, "AGENT_PLACEMENT_TARGET_UNAVAILABLE", agentregistry.AgentPlacementTargetUnavailableMessage)
	case err != nil:
		a.internalError(c, "update Agent", err)
	default:
		c.JSON(http.StatusOK, agent)
	}
}
