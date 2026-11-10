package app

import (
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentregistry"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/idempotency"
)

func (a *App) writeSkillPackageUploadError(c *gin.Context, err error) {
	if errors.Is(err, agentregistry.ErrSkillPackageTooLarge) {
		a.writeError(c, http.StatusRequestEntityTooLarge, "PAYLOAD_TOO_LARGE", "Skill Package exceeds the configured limits")
		return
	}
	a.logger.Warn("reject Skill Package upload", "request_id", c.GetString("request_id"), "error", err)
	a.writeError(c, http.StatusBadRequest, "INVALID_SKILL_PACKAGE", err.Error())
}

func (a *App) listSkillManifests(c *gin.Context) {
	cursor, limit, ok := parsePage(c)
	if !ok {
		a.writeError(c, http.StatusBadRequest, "INVALID_PAGE", "invalid pagination parameters")
		return
	}
	cursorSkill, cursorVersion, cursorOK := agentregistry.DecodeSkillCursor(cursor)
	if !cursorOK {
		a.writeError(c, http.StatusBadRequest, "INVALID_PAGE", "invalid pagination cursor")
		return
	}
	tenantID := c.Param("tenantId")
	callerID, ok := a.spaceHuman(c, tenantID)
	if !ok {
		return
	}
	page, err := a.agents.ListSkillManifests(c.Request.Context(), tenantID, callerID, cursorSkill, cursorVersion, limit)
	if a.notFoundOrError(c, "list skill manifests", err) {
		return
	}
	c.JSON(http.StatusOK, page)
}

func (a *App) writeSkillError(c *gin.Context, action string, err error) bool {
	if err == nil {
		return false
	}
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		a.writeError(c, http.StatusNotFound, "NOT_FOUND", "Skill resource was not found")
	case errors.Is(err, idempotency.ErrConflict):
		a.writeError(c, http.StatusConflict, "IDEMPOTENCY_KEY_REUSED", "idempotency key was used with different input")
	default:
		a.internalError(c, action, err)
	}
	return true
}
