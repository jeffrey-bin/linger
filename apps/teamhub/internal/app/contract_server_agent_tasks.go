package app

import (
	"errors"
	"fmt"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentauth"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/taskdelegation"
	teamhubagentapi "github.com/simplexai-labs/linger/contracts-go/teamhubagentapi"
)

const agentTaskRequestMaxBytes = 128 << 10

// createAgentTask starts a Task for the calling Meta's own AlterEgo.
func (a *App) createAgentTask(c *gin.Context) {
	token, ok := a.agentCommandBearer(c)
	if !ok {
		return
	}
	var request teamhubagentapi.AgentCreateTaskRequest
	body := http.MaxBytesReader(c.Writer, c.Request.Body, agentTaskRequestMaxBytes)
	if err := decodeStrictJSON(body, &request, "request body must contain one JSON object"); err != nil {
		a.writeInvalidAgentTask(c)
		return
	}
	result, err := a.taskDelegation.Create(c.Request.Context(), token, taskdelegation.CreateInput{
		InvocationID: request.InvocationId, Name: request.Name, Requirement: request.Requirement,
	})
	if a.writeAgentTaskError(c, err) {
		return
	}
	c.JSON(http.StatusOK, teamhubagentapi.AgentCreateTaskResponse{
		Accepted: true, TaskId: result.TaskID, Status: "running", DuplicateRequest: result.Replay,
	})
}

// checkAgentTask shows one delegated Task, or lists those the caller's Room
// delegated.
func (a *App) checkAgentTask(c *gin.Context) {
	token, ok := a.agentCommandBearer(c)
	if !ok {
		return
	}
	var request teamhubagentapi.AgentCheckTaskRequest
	body := http.MaxBytesReader(c.Writer, c.Request.Body, agentTaskRequestMaxBytes)
	if err := decodeStrictJSON(body, &request, "request body must contain one JSON object"); err != nil ||
		request.TaskId != nil && *request.TaskId == "" {
		a.writeInvalidAgentTask(c)
		return
	}
	taskID := ""
	if request.TaskId != nil {
		taskID = *request.TaskId
	}
	result, err := a.taskDelegation.Check(c.Request.Context(), token, taskID)
	if a.writeAgentTaskError(c, err) {
		return
	}
	var response teamhubagentapi.AgentCheckTaskResponse
	if result.Task != nil {
		response.Task = agentTaskDetail(*result.Task)
	} else {
		tasks := make([]teamhubagentapi.AgentTaskSummary, 0, len(result.Tasks))
		for _, task := range result.Tasks {
			tasks = append(tasks, teamhubagentapi.AgentTaskSummary{
				TaskId: task.TaskID, Name: task.Name, Status: teamhubagentapi.AgentTaskStatus(task.Status),
				Reason: optionalTaskReason(task.ReasonCode), CreatedAt: task.CreatedAt, UpdatedAt: task.UpdatedAt,
			})
		}
		response.Tasks = &tasks
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, response)
}

func agentTaskDetail(task taskdelegation.TaskDetail) *teamhubagentapi.AgentTaskDetail {
	detail := &teamhubagentapi.AgentTaskDetail{
		TaskId: task.TaskID, Name: task.Name, Status: teamhubagentapi.AgentTaskStatus(task.Status),
		Reason: optionalTaskReason(task.ReasonCode), OriginRoomId: task.OriginRoomID, WorkRoomId: task.WorkRoomID,
		CreatedAt: task.CreatedAt, StatusSince: task.StatusSince, QueuedMessageCount: task.QueuedMessageCount,
		RecentActivity:   make([]teamhubagentapi.AgentTaskActivity, 0, len(task.RecentActivity)),
		PendingApprovals: make([]teamhubagentapi.AgentTaskPendingApproval, 0, len(task.PendingApprovals)),
	}
	for _, activity := range task.RecentActivity {
		detail.RecentActivity = append(detail.RecentActivity, teamhubagentapi.AgentTaskActivity{
			At: activity.At, Kind: activity.Kind, Summary: activity.Summary,
		})
	}
	for _, approval := range task.PendingApprovals {
		detail.PendingApprovals = append(detail.PendingApprovals, teamhubagentapi.AgentTaskPendingApproval{
			Kind: teamhubagentapi.AgentTaskPendingApprovalKind(approval.Kind), Id: approval.ID, Title: approval.Title,
			CreatedAt: approval.CreatedAt, ExpiresAt: approval.ExpiresAt,
		})
	}
	if task.LastReport != nil {
		detail.LastReport = &teamhubagentapi.AgentTaskReport{At: task.LastReport.At, Body: task.LastReport.Body}
	}
	return detail
}

// A running or idle Task has no reason.
func optionalTaskReason(reason string) *string {
	if reason == "" {
		return nil
	}
	return &reason
}

// sendAgentTask gives a delegated Task's AlterEgo one Meta message.
func (a *App) sendAgentTask(c *gin.Context) {
	token, ok := a.agentCommandBearer(c)
	if !ok {
		return
	}
	var request teamhubagentapi.AgentSendTaskRequest
	body := http.MaxBytesReader(c.Writer, c.Request.Body, agentTaskRequestMaxBytes)
	if err := decodeStrictJSON(body, &request, "request body must contain one JSON object"); err != nil {
		a.writeInvalidAgentTask(c)
		return
	}
	result, err := a.taskDelegation.Send(c.Request.Context(), token, taskdelegation.SendInput{
		InvocationID: request.InvocationId, TaskID: request.TaskId, Message: request.Message,
		Steer: request.Steer != nil && *request.Steer,
	})
	if a.writeAgentTaskError(c, err) {
		return
	}
	c.JSON(http.StatusOK, teamhubagentapi.AgentSendTaskResponse{
		Accepted: true, TaskId: result.TaskID, Status: result.Status,
		Delivery: teamhubagentapi.AgentSendTaskResponseDelivery(result.Delivery), DuplicateRequest: result.Replay,
	})
}

// stopAgentTask cancels a delegated Task's current turn.
func (a *App) stopAgentTask(c *gin.Context) {
	token, ok := a.agentCommandBearer(c)
	if !ok {
		return
	}
	var request teamhubagentapi.AgentStopTaskRequest
	body := http.MaxBytesReader(c.Writer, c.Request.Body, agentTaskRequestMaxBytes)
	if err := decodeStrictJSON(body, &request, "request body must contain one JSON object"); err != nil {
		a.writeInvalidAgentTask(c)
		return
	}
	result, err := a.taskDelegation.Stop(c.Request.Context(), token, request.InvocationId, request.TaskId)
	if a.writeAgentTaskError(c, err) {
		return
	}
	c.JSON(http.StatusOK, teamhubagentapi.AgentStopTaskResponse{
		Accepted: true, TaskId: result.TaskID, Status: result.Status, DuplicateRequest: result.Replay,
	})
}

func (a *App) writeInvalidAgentTask(c *gin.Context) {
	a.writeAgentAPIError(c, http.StatusBadRequest, teamhubagentapi.AgentApiErrorCodeInvalidRequest, "Task request is invalid")
}

func (a *App) writeAgentTaskError(c *gin.Context, err error) bool {
	if err == nil {
		return false
	}
	switch {
	case errors.Is(err, taskdelegation.ErrInvalid), errors.Is(err, agentauth.ErrInvalid):
		a.writeInvalidAgentTask(c)
	case errors.Is(err, agentauth.ErrCredentialInvalid):
		a.writeAgentAPIError(c, http.StatusUnauthorized, teamhubagentapi.AgentApiErrorCodeAgentCredentialInvalid, "Agent credential is invalid or expired")
	case errors.Is(err, agentauth.ErrForbidden), errors.Is(err, taskdelegation.ErrForbidden):
		a.writeAgentAPIError(c, http.StatusForbidden, teamhubagentapi.AgentApiErrorCodeOperationForbidden,
			agentForbiddenMessage(err, "Only a Room's Meta can create and manage Tasks, from its Room Context"))
	case errors.Is(err, taskdelegation.ErrNotFound):
		a.writeAgentAPIError(c, http.StatusNotFound, teamhubagentapi.AgentApiErrorCodeNotFound, "No Task with this ID was delegated from this Room; run task check to list this Room's Tasks")
	case errors.Is(err, taskdelegation.ErrConflict):
		a.writeAgentAPIError(c, http.StatusConflict, teamhubagentapi.AgentApiErrorCodeVersionConflict, "The Task changed at the same time; retry")
	case errors.Is(err, taskdelegation.ErrLimitReached):
		a.writeAgentAPIError(c, http.StatusConflict, teamhubagentapi.AgentApiErrorCodeTaskLimitReached, fmt.Sprintf("This Agent already has %d running Tasks; check them, send to an idle one, or stop one first", taskdelegation.MaxRunningTasks))
	case errors.Is(err, taskdelegation.ErrIdempotencyConflict):
		a.writeAgentAPIError(c, http.StatusConflict, teamhubagentapi.AgentApiErrorCodeIdempotencyConflict, "Task invocation was reused with different input")
	case errors.Is(err, taskdelegation.ErrUnavailable):
		a.writeAgentAPIError(c, http.StatusServiceUnavailable, teamhubagentapi.AgentApiErrorCodeDependencyUnavailable, "Task service is unavailable")
	default:
		if a.logger != nil {
			a.logger.Error("Task delegation", "request_id", c.GetString("request_id"), "error_type", fmt.Sprintf("%T", err))
		}
		a.writeAgentAPIError(c, http.StatusInternalServerError, teamhubagentapi.AgentApiErrorCodeInternalError, "Task service could not complete the request")
	}
	return true
}
