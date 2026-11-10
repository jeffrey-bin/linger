package app

import (
	"net/http"
	"regexp"
	"strings"

	"github.com/gin-gonic/gin"
)

var agentCLIOperationPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)

// The CLI packs local bytes; TeamHub keeps the same Sponsor-owned immutable
// package publication and live Agent binding transaction as the Human API.
func (a *App) publishAgentSkillPackage(c *gin.Context) {
	p, ok := a.authenticatePublicAgentFile(c)
	if !ok {
		return
	}
	if p.AgentType != "general" && p.AgentType != "anotherme" {
		a.writeError(c, http.StatusForbidden, "FORBIDDEN", "Agent type cannot publish Skill packages")
		return
	}
	operationID := c.GetHeader("X-TeamHub-Operation-Id")
	if operationID == "" {
		operationID = c.GetHeader("Idempotency-Key")
	}
	if !agentCLIOperationPattern.MatchString(operationID) || !regexpAgentSkillDigest(c.GetHeader("X-Package-SHA256")) {
		a.writeError(c, http.StatusBadRequest, "INVALID_INPUT", "A stable operation ID and archive SHA256 are required")
		return
	}
	a.publishAgentCLISkillPackage(c, p.TenantID, p.AgentID, operationID, c.GetHeader("X-Package-SHA256"))
}

// getAgentSkillPackage lets the Agent's Computer fetch the Skill packages its
// Context View names with the Agent credential it already holds.
func (a *App) getAgentSkillPackage(c *gin.Context) {
	manifestID := c.Param("manifestId")
	p, ok := a.authenticatePublicAgentFile(c)
	if !ok {
		return
	}
	a.writeAgentSkillManifestPackage(c, p.AgentID, manifestID)
}

func regexpAgentSkillDigest(value string) bool {
	return len(value) == 64 && strings.Trim(value, "0123456789abcdef") == ""
}
