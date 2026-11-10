package app

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	"github.com/simplexai-labs/linger/contracts-go/teamhubinternal"
)

func (a *App) getAgentRuntimeConfigSnapshotRoute(c *gin.Context) {
	params := contractParams[teamhubinternal.GetAgentRuntimeConfigSnapshotParams](c)
	var requestedRevision int64
	if params.Revision != nil {
		var ok bool
		requestedRevision, ok = a.parseAgentRuntimePositiveInt64(c, *params.Revision)
		if !ok {
			return
		}
	}
	response, err := a.agents.RuntimeConfigSnapshot(c.Request.Context(), params.AgentId, requestedRevision, a.permissionReviewEnabled())
	if a.writeAgentRuntimeStateError(c, "get Agent Runtime configuration", err) {
		return
	}
	c.JSON(http.StatusOK, response)
}

// listAnotherMePlacements lets the Agent Service run a Human's background model
// calls on the Computer of that Human's Another Me.
func (a *App) listAnotherMePlacements(c *gin.Context) {
	params := contractParams[teamhubinternal.ListAnotherMePlacementsParams](c)
	var filter store.ListAnotherMePlacementsParams
	if params.TenantId != nil {
		filter.TenantID = *params.TenantId
	}
	if params.OwnerActorId != nil {
		filter.OwnerActorID = *params.OwnerActorId
	}
	response, err := a.agents.AnotherMePlacements(c.Request.Context(), filter)
	if a.writeAgentRuntimeStateError(c, "list Another Me placements", err) {
		return
	}
	c.JSON(http.StatusOK, response)
}
