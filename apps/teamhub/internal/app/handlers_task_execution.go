package app

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/taskexecution"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

func (a *App) getTaskExecutionProjection(c *gin.Context) {
	execution, err := a.taskExecutions.GetExecutionForHuman(
		c.Request.Context(), currentPrincipal(c).Session.AccountID, c.Param("taskId"),
	)
	if a.writeTaskExecutionError(c, "get Task execution projection", err) {
		return
	}
	model, err := taskExecutionProjectionModel(execution)
	if err != nil {
		a.internalError(c, "project Task execution", err)
		return
	}
	c.JSON(http.StatusOK, model)
}

func taskExecutionProjectionModel(execution taskexecution.Execution) (httpapi.TaskExecutionProjection, error) {
	runSpec, err := convertJSON[httpapi.TaskRunSpecV1](execution.Spec)
	if err != nil {
		return httpapi.TaskExecutionProjection{}, err
	}
	model := httpapi.TaskExecutionProjection{
		TaskId: execution.Snapshot.TaskID, Generation: execution.Snapshot.Generation,
		Status: httpapi.TaskExecutionStatus(execution.Snapshot.Status), ExecutionRevision: execution.Snapshot.Revision,
		DesiredControl:  httpapi.TaskExecutionProjectionDesiredControl(execution.Snapshot.DesiredControl),
		ControlRevision: execution.Snapshot.ControlRevision, ControlSettledRevision: execution.Snapshot.ControlSettledRevision,
		RunSpec: runSpec, ExecutionUpdatedAt: execution.Snapshot.UpdatedAt,
	}
	model.ReasonCode = taskStringPointer(execution.Snapshot.ReasonCode)
	if len(execution.Attempts) > 0 {
		attempt := execution.Attempts[len(execution.Attempts)-1]
		model.CurrentAttempt = &httpapi.TaskAttemptSummary{
			Id: attempt.ID, AttemptNumber: attempt.Number,
			Status: httpapi.TaskAttemptSummaryStatus(attempt.Status), CurrentInputRevision: attempt.CurrentInputRevision,
			DeadlineAt: attempt.DeadlineAt, StopReasonCode: taskStringPointer(attempt.StopReasonCode),
			CreatedAt: attempt.CreatedAt, FinishedAt: attempt.FinishedAt,
		}
	}
	return model, nil
}
