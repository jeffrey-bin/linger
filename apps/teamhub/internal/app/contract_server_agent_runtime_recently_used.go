package app

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/simplexai-labs/linger/contracts-go/teamhubinternal"
)

func (a *App) listRecentlyUsedAgentRuntimeContexts(c *gin.Context) {
	values, err := a.agentRuntimeState.ListRecentlyUsedContexts(c.Request.Context())
	if a.writeAgentRuntimeStateError(c, "list recently used Runtime Contexts", err) {
		return
	}
	response := teamhubinternal.ListRecentlyUsedAgentRuntimeContextsResult{Contexts: make([]teamhubinternal.RecentlyUsedAgentRuntimeContext, 0, len(values))}
	for _, value := range values {
		response.Contexts = append(response.Contexts, teamhubinternal.RecentlyUsedAgentRuntimeContext{ContextKey: value})
	}
	c.JSON(http.StatusOK, response)
}
