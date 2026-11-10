package app

import (
	"errors"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentregistry"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

func (a *App) listAgentSkillBindings(c *gin.Context) {
	list, err := a.agents.ListAgentSkillBindings(c.Request.Context(), currentPrincipal(c).Session.AccountID, c.Param("tenantId"), c.Param("agentId"))
	if a.notFoundOrError(c, "authorize Agent Skill bindings", err) {
		return
	}
	c.JSON(http.StatusOK, list)
}

func (a *App) getAgentSkillBinding(c *gin.Context) {
	binding, err := a.agents.GetAgentSkillBinding(c.Request.Context(), currentPrincipal(c).Session.AccountID, c.Param("tenantId"), c.Param("agentId"), c.Param("skillId"))
	if a.notFoundOrError(c, "get Agent Skill binding", err) {
		return
	}
	c.JSON(http.StatusOK, binding)
}

func (a *App) putAgentSkillBinding(c *gin.Context) {
	var request httpapi.AgentSkillBindingPutRequest
	if decodeJSON(c, &request) != nil || !agentregistry.SkillManifestVersionPattern.MatchString(request.ManifestVersion) || request.ExpectedBindingVersion < 1 {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Agent Skill binding is invalid")
		return
	}
	binding, err := a.agents.PutAgentSkillBindingTx(
		c.Request.Context(), currentPrincipal(c).Session.AccountID, c.Param("tenantId"),
		c.Param("agentId"), c.Param("skillId"), request,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		a.writeError(c, http.StatusNotFound, "NOT_FOUND", "Agent or sealed Skill Package was not found")
		return
	}
	if errors.Is(err, agentregistry.ErrSkillInvalid) {
		a.writeError(c, http.StatusBadRequest, "INVALID_SKILL_CONFIG", "config does not match the manifest or contains a forbidden field")
		return
	}
	if errors.Is(err, agentregistry.ErrSkillManifestInactive) {
		a.writeError(c, http.StatusConflict, "SKILL_MANIFEST_INACTIVE", "disabled or deleted Skill Manifest cannot be selected")
		return
	}
	if errors.Is(err, agentregistry.ErrSkillManifestNotCurrent) {
		a.writeError(c, http.StatusBadRequest, "SKILL_MANIFEST_NOT_CURRENT", "platform Skill accepts only its current latest version")
		return
	}
	if errors.Is(err, agentregistry.ErrAgentSkillEffectiveSetInvalid) {
		a.writeError(c, http.StatusConflict, "SKILL_SET_CONFLICT", "the effective Skill set has an identity, name, availability, or capacity conflict")
		return
	}
	if errors.Is(err, agentregistry.ErrAgentSkillBindingConflict) {
		a.writeError(c, http.StatusConflict, "SKILL_BINDING_CONFLICT", "Skill configuration changed; reload before saving")
		return
	}
	if err != nil {
		a.internalError(c, "put Agent Skill binding", err)
		return
	}
	c.JSON(http.StatusOK, binding)
}

func (a *App) deleteAgentSkillBinding(c *gin.Context) {
	expected, parseErr := strconv.ParseInt(c.Query("expected_binding_version"), 10, 64)
	if parseErr != nil || expected < 1 {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "expected_binding_version is required")
		return
	}
	err := a.agents.DeleteAgentSkillBinding(c.Request.Context(), currentPrincipal(c).Session.AccountID,
		c.Param("tenantId"), c.Param("agentId"), c.Param("skillId"), expected)
	if errors.Is(err, agentregistry.ErrAgentSkillBindingConflict) {
		a.writeError(c, http.StatusConflict, "SKILL_BINDING_CONFLICT", "Skill configuration changed; reload before saving")
		return
	}
	if a.writeSkillError(c, "delete Agent Skill binding", err) {
		return
	}
	c.Status(http.StatusNoContent)
}
