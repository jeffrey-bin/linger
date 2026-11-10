package app

import (
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/workitem"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

func (a *App) listWorkItems(c *gin.Context) {
	params := contractParams[httpapi.ListWorkItemsParams](c)
	filter := workitem.ListFilter{Limit: 50}
	if params.Cursor != nil {
		filter.Cursor = *params.Cursor
	}
	if params.Limit != nil {
		filter.Limit = int32(*params.Limit)
	}
	if params.Scope != nil {
		filter.Scope = string(*params.Scope)
	}
	if params.Kind != nil {
		filter.Kind = string(*params.Kind)
	}
	if params.State != nil {
		filter.State = string(*params.State)
	}
	if params.Priority != nil {
		filter.Priority = string(*params.Priority)
	}
	if params.ExecutionStatus != nil {
		filter.ExecutionStatus = string(*params.ExecutionStatus)
	}
	if params.PendingControl != nil {
		filter.PendingControl = params.PendingControl
	}
	if params.AssigneeActorId != nil {
		filter.AssigneeActorID = *params.AssigneeActorId
	}
	if params.OriginRoomId != nil {
		filter.OriginRoomID = *params.OriginRoomId
	}
	if params.WorkRoomId != nil {
		filter.WorkRoomID = *params.WorkRoomId
	}
	if params.Archived != nil {
		filter.IncludeArchived = *params.Archived
	}
	page, err := a.workItems.ListForHuman(c.Request.Context(), currentPrincipal(c).Session.AccountID, c.Param("tenantId"), filter)
	if a.writeWorkItemError(c, "list Work Items", err) {
		return
	}
	items := make([]httpapi.WorkItem, 0, len(page.Items))
	for _, item := range page.Items {
		items = append(items, workItemModel(item))
	}
	c.JSON(http.StatusOK, httpapi.WorkItemPage{Items: items, Page: pageMeta(page.HasMore, page.NextCursor)})
}

func (a *App) createWorkItem(c *gin.Context) {
	key, ok := a.requireIdempotencyKey(c)
	if !ok {
		return
	}
	var request httpapi.WorkItemCreateRequest
	if decodeJSON(c, &request) != nil {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Work Item input is invalid")
		return
	}
	input := workitem.CreateInput{Kind: string(request.Kind), Title: request.Title, Priority: "medium"}
	if request.Description != nil {
		input.Description = *request.Description
	}
	if request.Priority != nil {
		input.Priority = string(*request.Priority)
	}
	if request.ReferencedActorIds != nil {
		input.ReferencedActorIDs = idsToStrings(*request.ReferencedActorIds)
	}
	if request.AssigneeActorIds != nil {
		input.AssigneeActorIDs = idsToStrings(*request.AssigneeActorIds)
	}
	if request.OriginRoomId != nil {
		input.OriginRoomID = *request.OriginRoomId
	}
	result, err := a.workItems.CreateForHuman(c.Request.Context(), currentPrincipal(c).Session.AccountID, c.Param("tenantId"), key, input)
	if a.writeWorkItemError(c, "create Work Item", err) {
		return
	}
	writeWorkItemResult(c, http.StatusCreated, result.Replay, workItemModel(result.Value))
}

func (a *App) getWorkItem(c *gin.Context) {
	item, err := a.workItems.GetForHuman(c.Request.Context(), currentPrincipal(c).Session.AccountID, c.Param("workItemId"))
	if a.writeWorkItemError(c, "get Work Item", err) {
		return
	}
	c.JSON(http.StatusOK, workItemModel(item))
}

func (a *App) updateWorkItem(c *gin.Context) {
	key, ok := a.requireIdempotencyKey(c)
	if !ok {
		return
	}
	var request httpapi.WorkItemUpdateRequest
	if decodeJSON(c, &request) != nil {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Work Item update is invalid")
		return
	}
	input := workitem.UpdateInput{
		ExpectedVersion: request.ExpectedVersion, Title: request.Title, Description: request.Description,
	}
	if request.Priority != nil {
		value := string(*request.Priority)
		input.Priority = &value
	}
	if request.ReferencedActorIds != nil {
		values := idsToStrings(*request.ReferencedActorIds)
		input.ReferencedActorIDs = &values
	}
	result, err := a.workItems.UpdateForHuman(c.Request.Context(), currentPrincipal(c).Session.AccountID, c.Param("workItemId"), key, input)
	if a.writeWorkItemError(c, "update Work Item", err) {
		return
	}
	writeWorkItemResult(c, http.StatusOK, result.Replay, workItemModel(result.Value))
}

func (a *App) transitionWorkItem(c *gin.Context) {
	key, ok := a.requireIdempotencyKey(c)
	if !ok {
		return
	}
	var request httpapi.WorkItemTransitionRequest
	if decodeJSON(c, &request) != nil {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Work Item transition is invalid")
		return
	}
	input := workitem.TransitionInput{ExpectedVersion: request.ExpectedVersion, State: string(request.State)}
	if request.Resolution != nil {
		value := string(*request.Resolution)
		input.Resolution = &value
	}
	result, err := a.workItems.TransitionForHuman(c.Request.Context(), currentPrincipal(c).Session.AccountID, c.Param("workItemId"), key, input)
	if a.writeWorkItemError(c, "transition Work Item", err) {
		return
	}
	writeWorkItemResult(c, http.StatusOK, result.Replay, workItemModel(result.Value))
}

func (a *App) setWorkItemArchived(c *gin.Context, archived bool) {
	key, ok := a.requireIdempotencyKey(c)
	if !ok {
		return
	}
	var request httpapi.WorkItemVersionRequest
	if decodeJSON(c, &request) != nil {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Work Item version is invalid")
		return
	}
	result, err := a.workItems.SetArchivedForHuman(c.Request.Context(), currentPrincipal(c).Session.AccountID, c.Param("workItemId"), key, workitem.VersionInput{ExpectedVersion: request.ExpectedVersion}, archived)
	if a.writeWorkItemError(c, "change Work Item archive state", err) {
		return
	}
	writeWorkItemResult(c, http.StatusOK, result.Replay, workItemModel(result.Value))
}

func (a *App) putWorkItemAssignment(c *gin.Context) {
	key, ok := a.requireIdempotencyKey(c)
	if !ok {
		return
	}
	result, err := a.workItems.PutAssignmentForHuman(c.Request.Context(), currentPrincipal(c).Session.AccountID, c.Param("workItemId"), c.Param("actorId"), key)
	if a.writeWorkItemError(c, "put Work Item Assignment", err) {
		return
	}
	writeWorkItemResult(c, http.StatusOK, result.Replay, workItemAssignmentModel(result.Value))
}

func (a *App) deleteWorkItemAssignment(c *gin.Context) {
	key, ok := a.requireIdempotencyKey(c)
	if !ok {
		return
	}
	result, err := a.workItems.DeleteAssignmentForHuman(c.Request.Context(), currentPrincipal(c).Session.AccountID, c.Param("workItemId"), c.Param("actorId"), key)
	if a.writeWorkItemError(c, "delete Work Item Assignment", err) {
		return
	}
	writeWorkItemNoContent(c, result.Replay)
}

func (a *App) putWorkItemAccessGrant(c *gin.Context) {
	key, ok := a.requireIdempotencyKey(c)
	if !ok {
		return
	}
	result, err := a.workItems.PutAccessGrantForHuman(c.Request.Context(), currentPrincipal(c).Session.AccountID, c.Param("workItemId"), c.Param("actorId"), key)
	if a.writeWorkItemError(c, "put Work Item access grant", err) {
		return
	}
	writeWorkItemResult(c, http.StatusOK, result.Replay, workItemAccessGrantModel(result.Value))
}

func (a *App) deleteWorkItemAccessGrant(c *gin.Context) {
	key, ok := a.requireIdempotencyKey(c)
	if !ok {
		return
	}
	result, err := a.workItems.DeleteAccessGrantForHuman(c.Request.Context(), currentPrincipal(c).Session.AccountID, c.Param("workItemId"), c.Param("actorId"), key)
	if a.writeWorkItemError(c, "delete Work Item access grant", err) {
		return
	}
	writeWorkItemNoContent(c, result.Replay)
}

func (a *App) writeWorkItemError(c *gin.Context, action string, err error) bool {
	if err == nil {
		return false
	}
	switch {
	case errors.Is(err, workitem.ErrNotFound):
		a.writeError(c, http.StatusNotFound, "NOT_FOUND", "resource was not found")
	case errors.Is(err, workitem.ErrInvalid):
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Work Item command is invalid")
	case errors.Is(err, workitem.ErrIdempotencyConflict):
		a.writeError(c, http.StatusConflict, "IDEMPOTENCY_KEY_REUSED", "idempotency key was used with different input")
	case errors.Is(err, workitem.ErrConflict):
		a.writeError(c, http.StatusConflict, "WORK_ITEM_CONFLICT", "Work Item state conflicts with the request")
	case errors.Is(err, workitem.ErrForbidden):
		a.writeError(c, http.StatusForbidden, "WORK_ITEM_FORBIDDEN", "the acting Actor cannot perform this Work Item command")
	case errors.Is(err, workitem.ErrUnavailable):
		a.writeError(c, http.StatusServiceUnavailable, "WORK_ITEMS_UNAVAILABLE", "Work Item capability is not available")
	default:
		a.internalError(c, action, err)
	}
	return true
}

func workItemModel(item workitem.Item) httpapi.WorkItem {
	model := httpapi.WorkItem{
		Id: item.ID, TenantId: item.TenantID, Number: item.Number, Kind: httpapi.WorkItemKind(item.Kind),
		Title: item.Title, Description: item.Description, Priority: httpapi.WorkItemPriority(item.Priority),
		State: httpapi.WorkItemState(item.State), Version: item.Version,
		CreatedBy: workItemActorModel(item.CreatedBy), UpdatedBy: workItemActorModel(item.UpdatedBy),
		ReferencedActors:     make([]httpapi.ActorRef, 0, len(item.ReferencedActors)),
		Assignees:            make([]httpapi.WorkItemAssignment, 0, len(item.Assignees)),
		ExplicitAccessGrants: make([]httpapi.WorkItemAccessGrant, 0, len(item.ExplicitAccessGrants)),
		CreatedAt:            item.CreatedAt, UpdatedAt: item.UpdatedAt,
	}
	for _, actor := range item.ReferencedActors {
		model.ReferencedActors = append(model.ReferencedActors, workItemActorModel(actor))
	}
	for _, assignment := range item.Assignees {
		model.Assignees = append(model.Assignees, workItemAssignmentModel(assignment))
	}
	for _, grant := range item.ExplicitAccessGrants {
		model.ExplicitAccessGrants = append(model.ExplicitAccessGrants, workItemAccessGrantModel(grant))
	}
	if item.Resolution != nil {
		value := httpapi.WorkItemResolution(*item.Resolution)
		model.Resolution = &value
	}
	model.OriginRoomId = item.OriginRoomID
	model.OriginMessageId = item.OriginMessageID
	model.WorkRoomId = item.WorkRoomID
	if item.TaskExecution != nil {
		summary := httpapi.WorkItemTaskExecutionSummary{
			Generation:             item.TaskExecution.Generation,
			Status:                 httpapi.TaskExecutionStatus(item.TaskExecution.Status),
			ExecutionRevision:      item.TaskExecution.ExecutionRevision,
			DesiredControl:         httpapi.WorkItemTaskExecutionSummaryDesiredControl(item.TaskExecution.DesiredControl),
			ControlRevision:        item.TaskExecution.ControlRevision,
			ControlSettledRevision: item.TaskExecution.ControlSettledRevision,
			PendingControl:         item.TaskExecution.PendingControl,
			ExecutionUpdatedAt:     item.TaskExecution.ExecutionUpdatedAt,
		}
		if item.TaskExecution.ReasonCode != "" {
			summary.ReasonCode = &item.TaskExecution.ReasonCode
		}
		if item.TaskExecution.ControlOutcome != "" {
			value := httpapi.WorkItemTaskExecutionSummaryControlOutcome(item.TaskExecution.ControlOutcome)
			summary.ControlOutcome = &value
		}
		model.TaskExecution = &summary
	}
	model.ArchivedAt = item.ArchivedAt
	return model
}

func workItemActorModel(actor workitem.Actor) httpapi.ActorRef {
	return httpapi.ActorRef{Id: actor.ID, TenantId: actor.TenantID, Kind: httpapi.ActorKind(actor.Kind), DisplayName: actor.DisplayName}
}

func workItemAssignmentModel(assignment workitem.Assignment) httpapi.WorkItemAssignment {
	return httpapi.WorkItemAssignment{
		Actor: workItemActorModel(assignment.Actor), AssignedBy: workItemActorModel(assignment.AssignedBy),
		AssignedAt: assignment.AssignedAt,
	}
}

func workItemAccessGrantModel(grant workitem.AccessGrant) httpapi.WorkItemAccessGrant {
	return httpapi.WorkItemAccessGrant{
		Actor: workItemActorModel(grant.Actor), GrantedBy: workItemActorModel(grant.GrantedBy),
		GrantedAt: grant.GrantedAt,
	}
}

func idsToStrings(ids []httpapi.Id) []string {
	values := make([]string, 0, len(ids))
	values = append(values, ids...)
	return values
}

func writeWorkItemResult(c *gin.Context, status int, replay bool, value any) {
	if replay {
		c.Header("Idempotent-Replay", "true")
	}
	c.JSON(status, value)
}

func writeWorkItemNoContent(c *gin.Context, replay bool) {
	if replay {
		c.Header("Idempotent-Replay", "true")
	}
	c.Status(http.StatusNoContent)
}
