package app

import (
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentregistry"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/skill"
)

func (a *App) getAgentEffectiveResources(c *gin.Context) {
	result, err := a.agents.EffectiveResources(c.Request.Context(), c.Param("agentId"), a.connectedAppsConfigured())
	switch {
	case errors.Is(err, skill.ErrConflict), errors.Is(err, skill.ErrDependency):
		a.writeError(c, http.StatusConflict, "SKILL_SET_CONFLICT", "the Agent Skill configuration could not be loaded")
	case errors.Is(err, agentregistry.ErrAgentResourceForbidden):
		a.writeError(c, http.StatusForbidden, "FORBIDDEN", "Agent resource identity is invalid")
	case a.notFoundOrError(c, "resolve active Agent resource identity", err):
	default:
		c.JSON(http.StatusOK, result)
	}
}

// writeAgentSkillManifestPackage serves one immutable Skill package the Agent
// may read to the Agent's Computer, under the Agent credential it holds.
func (a *App) writeAgentSkillManifestPackage(c *gin.Context, agentID, manifestID string) {
	download, err := a.agents.AgentSkillManifestPackage(c.Request.Context(), agentID, manifestID)
	switch {
	case errors.Is(err, agentregistry.ErrAgentResourceForbidden):
		a.writeError(c, http.StatusForbidden, "FORBIDDEN", "Agent resource identity is invalid")
	case errors.Is(err, agentregistry.ErrSkillPackageForbidden):
		a.writeError(c, http.StatusForbidden, "FORBIDDEN", "the Agent cannot download this Skill package")
	case a.notFoundOrError(c, "read immutable Skill manifest", err):
	default:
		c.Header("ETag", `"`+hex.EncodeToString(download.ContentHash)+`"`)
		c.Header("Content-Disposition", fmt.Sprintf(`attachment; filename=%q`, download.Name+".zip"))
		c.Data(http.StatusOK, "application/zip", download.Archive)
	}
}
