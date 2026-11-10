package app

import (
	"errors"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentruntimestate"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/roomagent"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

func (a *App) getTenantRoomActivity(c *gin.Context) {
	tenantID := c.Param("tenantId")
	if !a.requireSpace(c, tenantID) {
		return
	}
	activity, err := a.collaboration.TenantRoomActivity(c.Request.Context(), currentPrincipal(c).Session.AccountID, tenantID)
	if a.notFoundOrError(c, "load Room activity", err) {
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, activity)
}

// listRoomBackgroundTasks lists the background Tasks this Room's Meta
// delegated that are still running, for the indicator above the composer.
func (a *App) listRoomBackgroundTasks(c *gin.Context) {
	items, err := a.collaboration.RoomBackgroundTasks(c.Request.Context(), currentPrincipal(c).Session.AccountID, c.Param("roomId"))
	if a.notFoundOrError(c, "authorize Room execution control", err) {
		return
	}
	c.JSON(http.StatusOK, httpapi.RoomBackgroundTaskList{Items: items})
}

func (a *App) cancelRoomRun(c *gin.Context) {
	roomID := c.Param("roomId")
	runID := c.Param("runId")
	row, err := a.collaboration.RoomRunForControl(c.Request.Context(), currentPrincipal(c).Session.AccountID, roomID, runID)
	if a.notFoundOrError(c, "authorize Room execution control", err) {
		return
	}
	var request httpapi.RoomRunCancelRequest
	if err := c.ShouldBindJSON(&request); err != nil || strings.TrimSpace(request.RequestId) == "" || len(request.RequestId) > 256 {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "A request ID is required")
		return
	}
	if row.Status != "queued" && row.Status != "running" {
		c.JSON(http.StatusOK, httpapi.RoomRunCancelResult{RunId: runID, Status: "already_terminal", AgentActorId: row.AgentActorID, MessageIds: row.MessageIds})
		return
	}
	gateway, ok := a.agentManagement.(roomagent.RunManagement)
	if !ok {
		a.writeError(c, http.StatusServiceUnavailable, "RUN_CANCEL_UNAVAILABLE", "Cancellation is not confirmed; check the execution status")
		return
	}
	result, err := gateway.CancelRun(c.Request.Context(), roomagent.RunCancelCommand{RequestID: request.RequestId, RunID: runID, AgentID: row.AgentManagementID, RoomID: row.ContextRoomID.String})
	if err != nil || (result.Status != "cancel_requested" && result.Status != "canceled" && result.Status != "already_terminal") {
		a.writeError(c, http.StatusServiceUnavailable, "RUN_CANCEL_UNCONFIRMED", "Cancellation is not confirmed; check the execution status")
		return
	}
	c.JSON(http.StatusOK, httpapi.RoomRunCancelResult{RunId: runID, Status: httpapi.RoomRunCancelResultStatus(result.Status), AgentActorId: row.AgentActorID, MessageIds: row.MessageIds})
}

// redeliverRoomRunUnconfirmedInputs resends a finished Run's follow-ups whose
// delivery ended unconfirmed to the same Agent, without a new Message.
func (a *App) redeliverRoomRunUnconfirmedInputs(c *gin.Context) {
	roomID := c.Param("roomId")
	runID := c.Param("runId")
	row, err := a.collaboration.RoomRunForControl(c.Request.Context(), currentPrincipal(c).Session.AccountID, roomID, runID)
	if a.notFoundOrError(c, "authorize Room execution control", err) {
		return
	}
	result := httpapi.RoomRunRedeliverResult{RunId: runID, Status: httpapi.NothingToRedeliver}
	if row.Status == "queued" || row.Status == "running" {
		c.JSON(http.StatusOK, result)
		return
	}
	count, err := a.agentRuntimeState.RedeliverUnconfirmedRunInputs(c.Request.Context(), runID)
	if errors.Is(err, agentruntimestate.ErrNotFound) {
		a.writeError(c, http.StatusNotFound, "NOT_FOUND", "resource was not found")
		return
	}
	if err != nil {
		a.internalError(c, "redeliver unconfirmed Run inputs", err)
		return
	}
	if count > 0 {
		result.Status = httpapi.Redelivered
		result.RedeliveredCount = count
	}
	c.JSON(http.StatusOK, result)
}
