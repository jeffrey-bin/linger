package app

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"regexp"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentauth"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentcredential"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/messagecreation"
)

var agentRunIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)

// agentExecutionClaimKeys are execution facts an Agent command body must
// never assert, in JSON or in multipart metadata.
var agentExecutionClaimKeys = []string{"execution_run_ref", "execution_run_id", "context_session_id", "context_generation_id", "mcp_context_token", "expected_manifest_version", "expected_manifest_digest", "source_inbox_ids"}

func agentExecutionClaim(fields map[string]json.RawMessage) string {
	for _, key := range agentExecutionClaimKeys {
		if _, supplied := fields[key]; supplied {
			return key
		}
	}
	return ""
}

// A CLI profile chooses the requested resource; domain authorization still
// checks the authenticated Agent's current rights in its transaction.
func (a *App) agentAPITarget(c *gin.Context) {
	if strings.HasPrefix(c.Request.URL.Path, "/api/agent/v1/") {
		token, ok := strictAgentBearer(c)
		if !ok || !strings.HasPrefix(token, "th_agent_") {
			a.writeError(c, http.StatusUnauthorized, "UNAUTHENTICATED", "An Agent identity credential is required")
			c.Abort()
			return
		}
	}
	if !a.rejectAgentExecutionClaims(c) {
		return
	}
	// The CLI names the Run it serves; Messages keep that Run only after the
	// message core checks it, and it authorizes nothing.
	if runIDs := c.Request.Header.Values("X-TeamHub-Run-Id"); strings.HasPrefix(c.Request.URL.Path, "/api/agent/v1/") && len(runIDs) != 0 {
		if len(runIDs) != 1 || !agentRunIDPattern.MatchString(runIDs[0]) {
			a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Specify one Run identifier")
			c.Abort()
			return
		}
		c.Request = c.Request.WithContext(messagecreation.WithRunClaim(c.Request.Context(), runIDs[0]))
	}
	tenants, agents := c.Request.Header.Values("X-TeamHub-Expected-Tenant-Id"), c.Request.Header.Values("X-TeamHub-Expected-Agent-Id")
	if len(tenants) != 0 || len(agents) != 0 {
		if len(tenants) != 1 || len(agents) != 1 || tenants[0] == "" || agents[0] == "" || len(tenants[0]) > 128 || len(agents[0]) > 128 || strings.ContainsAny(tenants[0]+agents[0], " ,\t\r\n") {
			a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Expected Agent identity requires one tenant and Agent identifier")
			c.Abort()
			return
		}
		c.Request = c.Request.WithContext(agentcredential.WithExpectedIdentity(c.Request.Context(), tenants[0], agents[0]))
	}

	kinds, ids := c.Request.Header.Values("X-TeamHub-Context-Kind"), c.Request.Header.Values("X-TeamHub-Context-Id")
	if len(kinds) == 0 && len(ids) == 0 {
		c.Next()
		return
	}
	if len(kinds) != 1 || len(ids) != 1 || ids[0] == "" || len(ids[0]) > 256 || strings.ContainsAny(ids[0], " ,\t\r\n") {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Specify one business context kind and identifier")
		c.Abort()
		return
	}
	switch kinds[0] {
	case "room", "task", "document", "thread":
		c.Request = c.Request.WithContext(agentauth.WithTarget(c.Request.Context(), kinds[0], ids[0]))
		c.Next()
	default:
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Unsupported business context kind")
		c.Abort()
	}
}

// An Agent command must never assert a Run's provenance.
// File endpoints have their own principal-only contracts and accept raw bytes.
func (a *App) rejectAgentExecutionClaims(c *gin.Context) bool {
	if !strings.HasPrefix(c.Request.URL.Path, "/api/agent/v1/") ||
		strings.HasPrefix(c.Request.URL.Path, "/api/agent/v1/files") ||
		!strings.HasPrefix(strings.TrimSpace(c.GetHeader("Authorization")), "Bearer th_agent_") ||
		c.ContentType() != "application/json" || c.Request.Body == nil {
		return true
	}
	body, err := io.ReadAll(http.MaxBytesReader(c.Writer, c.Request.Body, agentSendMessageRequestMaxBytes))
	if err != nil {
		a.writeError(c, http.StatusRequestEntityTooLarge, "INVALID_REQUEST", "Cannot read Agent command body within the size limit")
		c.Abort()
		return false
	}
	c.Request.Body = io.NopCloser(bytes.NewReader(body))
	var envelope map[string]json.RawMessage
	if err := json.Unmarshal(body, &envelope); err != nil {
		// The domain decoder owns validation and its existing error contract.
		return true
	}
	if key := agentExecutionClaim(envelope); key != "" {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Agent commands cannot supply execution authority: "+key)
		c.Abort()
		return false
	}
	return true
}
