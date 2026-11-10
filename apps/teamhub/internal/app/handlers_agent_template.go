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

func (a *App) listAgentTemplates(c *gin.Context) {
	if _, ok := a.spaceHuman(c, c.Param("tenantId")); !ok {
		return
	}
	items, err := a.agents.ListAgentTemplates(c.Request.Context())
	if a.notFoundOrError(c, "list Agent templates", err) {
		return
	}
	c.JSON(http.StatusOK, httpapi.AgentTemplatePage{Items: items})
}

func (a *App) publishAgentTemplate(c *gin.Context) {
	tenantID := c.Param("tenantId")
	if _, ok := a.spaceHuman(c, tenantID); !ok {
		return
	}
	var request httpapi.AgentTemplatePublishRequest
	if err := decodeJSON(c, &request); err != nil {
		// A body this handler cannot read is not the same failure as a body it
		// read and rejected. Reporting both as "name and instructions are
		// required" sends the caller looking at fields that were in fact sent,
		// which is exactly what an unknown field from a newer client looks like.
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Agent template request could not be read: "+err.Error())
		return
	}
	request.Name = strings.TrimSpace(request.Name)
	request.Instructions = strings.TrimSpace(request.Instructions)
	if request.Name == "" || len([]rune(request.Name)) > 120 ||
		request.Instructions == "" || len(request.Instructions) > 50000 {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Agent template name and instructions are required")
		return
	}
	if request.Description != nil {
		description, valid := agentregistry.NormalizeAgentDescription(*request.Description)
		if !valid {
			a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Agent template description is invalid")
			return
		}
		request.Description = &description
	}
	if request.AvatarKey != nil && !agentregistry.ValidAgentAvatarKey(*request.AvatarKey) {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Agent template avatar is invalid")
		return
	}
	skills, err := agentregistry.NormalizeAgentSkillRegistrations(pointerSlice(request.SkillBindings))
	if err != nil {
		a.writeError(c, http.StatusBadRequest, "INVALID_SKILL_REGISTRATION", "template Skill selection is invalid")
		return
	}
	connectors, err := agentregistry.NormalizeAgentTemplateConnectors(pointerSlice(request.ConnectorBindings))
	if err != nil {
		a.writeError(c, http.StatusBadRequest, "INVALID_CONNECTOR_BINDING", "template Connector selection is invalid")
		return
	}
	request.SkillBindings = &skills
	request.ConnectorBindings = &connectors
	template, err := a.agents.ExecuteAgentTemplatePublication(
		c.Request.Context(), currentPrincipal(c).Session.AccountID, tenantID, request,
	)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		a.writeError(c, http.StatusNotFound, "TENANT_NOT_FOUND", "tenant was not found")
	case errors.Is(err, collaboration.ErrAgentSponsorRequired):
		a.writeError(c, http.StatusForbidden, "AGENT_SPONSOR_REQUIRED", "only the source Agent Sponsor may publish its Routines")
	case err != nil:
		a.internalError(c, "publish Agent template", err)
	default:
		c.JSON(http.StatusCreated, template)
	}
}

func (a *App) deleteAgentTemplate(c *gin.Context) {
	tenantID, templateID := c.Param("tenantId"), c.Param("templateId")
	if _, ok := a.spaceHuman(c, tenantID); !ok {
		return
	}
	err := a.agents.DeleteAgentTemplate(c.Request.Context(), tenantID, templateID)
	if errors.Is(err, agentregistry.ErrAgentTemplateNotOwned) {
		a.writeError(c, http.StatusForbidden, "AGENT_TEMPLATE_NOT_OWNED",
			"only templates published from this Space can be removed")
		return
	}
	if a.notFoundOrError(c, "delete Agent template", err) {
		return
	}
	c.Status(http.StatusNoContent)
}
