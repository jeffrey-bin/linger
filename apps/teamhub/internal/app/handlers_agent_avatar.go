package app

import (
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentregistry"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/collaboration"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

// updateTenantAgentAvatar replaces the avatar every Human sees for one Agent.
// Only its Sponsor may change it, as with profile edits, but the avatar is not
// Agent configuration: it needs no revision and succeeds while the Agent works.
func (a *App) updateTenantAgentAvatar(c *gin.Context) {
	var request httpapi.TenantAgentAvatarUpdateRequest
	if decodeJSON(c, &request) != nil || !agentregistry.ValidAgentAvatarKey(request.AvatarKey) ||
		(request.AvatarImage != nil && !agentregistry.ValidAgentAvatarImage(*request.AvatarImage)) {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "avatar_key or avatar_image is invalid")
		return
	}
	model, err := a.agents.UpdateTenantAgentAvatarTx(
		c.Request.Context(), currentPrincipal(c).Session.AccountID,
		c.Param("tenantId"), c.Param("agentId"), request,
	)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		a.writeError(c, http.StatusNotFound, "AGENT_NOT_FOUND", "Agent was not found")
	case errors.Is(err, collaboration.ErrAgentSponsorRequired):
		a.writeError(c, http.StatusForbidden, "AGENT_SPONSOR_REQUIRED", "only the Agent Sponsor can edit this Agent")
	case errors.Is(err, agentregistry.ErrAgentUpdateUnavailable):
		a.writeError(c, http.StatusConflict, "AGENT_UPDATE_UNAVAILABLE", "Agent cannot be edited from its current state")
	case err != nil:
		a.internalError(c, "update Agent avatar", err)
	default:
		c.JSON(http.StatusOK, model)
	}
}

// getTenantAgentAvatarImage serves an uploaded avatar to any Human who can see
// the Agent. The URL names a version, so the current version is immutable;
// a stale version still answers with the current image but is not cached.
func (a *App) getTenantAgentAvatarImage(c *gin.Context) {
	params := contractParams[httpapi.GetTenantAgentAvatarImageParams](c)
	requestedVersion, ifNoneMatch := stringValue(params.V), stringValue(params.IfNoneMatch)
	ctx := c.Request.Context()
	accountID, tenantID := currentPrincipal(c).Session.AccountID, c.Param("tenantId")
	if !a.requireSpace(c, tenantID) {
		return
	}
	image, err := a.agents.AgentAvatarImage(ctx, accountID, tenantID, c.Param("agentId"))
	if errors.Is(err, agentregistry.ErrAvatarImageNotFound) {
		a.writeError(c, http.StatusNotFound, "AGENT_AVATAR_IMAGE_NOT_FOUND", "Agent avatar image was not found")
		return
	}
	if a.notFoundOrError(c, "read Agent avatar image", err) {
		return
	}
	version := image.Version
	etag := `"` + version + `"`
	if requestedVersion == version {
		c.Header("Cache-Control", "private, max-age=31536000, immutable")
	} else {
		c.Header("Cache-Control", "private, no-cache")
	}
	c.Header("ETag", etag)
	c.Header("X-Content-Type-Options", "nosniff")
	if ifNoneMatch == etag {
		c.Status(http.StatusNotModified)
		return
	}
	c.Data(http.StatusOK, image.ContentType, image.Body)
}
