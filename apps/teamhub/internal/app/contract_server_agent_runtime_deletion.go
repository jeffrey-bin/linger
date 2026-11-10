package app

import (
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentregistry"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	"github.com/simplexai-labs/linger/contracts-go/teamhubinternal"
)

func (a *App) getAgentRuntimeDeletionSnapshot(c *gin.Context) {
	params := contractParams[teamhubinternal.GetAgentRuntimeDeletionSnapshotParams](c)
	snapshot, err := a.agentRuntimeState.ReadDeletionSnapshot(c.Request.Context(), params.AgentId)
	if a.writeAgentRuntimeStateError(c, "read Agent deletion identity", err) {
		return
	}
	// Reuse canonical runtime validation without reading policies/resources or
	// exposing the activation configuration, instructions or native Session.
	registration := store.GetMaterializableAgentRuntimeRegistrationByManagementIDRow(snapshot.Registration)
	config, err := agentregistry.ProjectAgentRuntimeConfigSnapshot(registration)
	if a.writeAgentRuntimeStateProjectionError(c, "project deletion runtime", err) {
		return
	}
	contexts, err := agentExecutionContextsToContract(snapshot.Contexts)
	if a.writeAgentRuntimeStateProjectionError(c, "project deletion Contexts", err) {
		return
	}
	c.JSON(http.StatusOK, teamhubinternal.AgentRuntimeDeletionSnapshot{
		AgentId: params.AgentId, ActorId: registration.ActorID, TenantId: registration.TenantID,
		ConfigurationRevision: strconv.FormatInt(registration.ConfigurationRevision, 10),
		Runtime:               config.Runtime, Contexts: contexts,
	})
}
