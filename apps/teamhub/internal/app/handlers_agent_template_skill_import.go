package app

import (
	"net/http"

	"github.com/gin-gonic/gin"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

func (a *App) listAgentTemplateSkillImports(c *gin.Context) {
	tenantID, templateID := c.Param("tenantId"), c.Param("templateId")
	callerID, ok := a.spaceHuman(c, tenantID)
	if !ok {
		return
	}
	items, err := a.agents.ListAgentTemplateSkillImports(c.Request.Context(), tenantID, callerID, templateID)
	if a.notFoundOrError(c, "plan Agent template Skill imports", err) {
		return
	}
	c.JSON(http.StatusOK, httpapi.AgentTemplateSkillImportPage{Items: items})
}

func (a *App) importAgentTemplateSkills(c *gin.Context) {
	tenantID, templateID := c.Param("tenantId"), c.Param("templateId")
	if _, ok := a.spaceHuman(c, tenantID); !ok {
		return
	}
	page, err := a.agents.ExecuteAgentTemplateSkillImport(
		c.Request.Context(), currentPrincipal(c).Session.AccountID, tenantID, templateID,
	)
	if a.notFoundOrError(c, "import Agent template Skills", err) {
		return
	}
	c.JSON(http.StatusOK, page)
}
