package app

import (
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentruntimestate"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/taskexecution"
	"github.com/simplexai-labs/linger/contracts-go/teamhubinternal"
)

// The Agent's task-progress feature reads how the Tasks a Meta coordinates
// are going; whether to remind the Meta to tell the user is the Agent's call.

func (a *App) getTaskProgress(c *gin.Context) {
	roomID := c.Param("roomId")
	agentManagementID := c.Param("agentId")
	contextKey, err := agentruntimestate.EncodeContextRef(agentruntimestate.ContextRef{Kind: "meta", AgentID: agentManagementID, RoomID: roomID})
	if err != nil {
		a.writeError(c, http.StatusNotFound, "META_CONTEXT_NOT_FOUND", "The Agent has no Meta Context in this Room")
		return
	}
	progress, err := a.readTaskProgress(c.Request.Context(), contextKey)
	if errors.Is(err, taskexecution.ErrNotFound) {
		a.writeError(c, http.StatusNotFound, "META_CONTEXT_NOT_FOUND", "The Agent has no Meta Context in this Room")
		return
	}
	if err != nil {
		a.internalError(c, "read Task progress", err)
		return
	}
	response := teamhubinternal.TaskProgressSnapshot{
		LiveForeground: progress.LiveForeground, AgentLastSpokeAt: progress.AgentLastSpokeAt,
		Tasks: make([]teamhubinternal.TaskProgressTask, 0, len(progress.Tasks)),
	}
	for _, task := range progress.Tasks {
		item := teamhubinternal.TaskProgressTask{
			TaskId: task.TaskID, Title: task.Title, Status: teamhubinternal.TaskProgressTaskStatus(task.Status),
			StatusSince: task.StatusSince, PendingApprovals: task.PendingApprovals, LastReportAt: task.LastReportAt,
		}
		if task.LatestStep != nil {
			item.LatestStep = &teamhubinternal.TaskProgressStep{Title: task.LatestStep.Title, At: task.LatestStep.At}
		}
		response.Tasks = append(response.Tasks, item)
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, response)
}
