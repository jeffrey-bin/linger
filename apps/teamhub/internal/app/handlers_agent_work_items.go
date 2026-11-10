package app

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/workitem"
	"github.com/simplexai-labs/linger/contracts-go/teamhubinternal"
)

func (a *App) listAgentWorkItems(c *gin.Context) {
	params := contractParams[teamhubinternal.ListAgentWorkItemsParams](c)
	filter := workitem.ListFilter{Limit: 50}
	if params.Cursor != nil {
		filter.Cursor = *params.Cursor
	}
	if params.Limit != nil {
		filter.Limit = int32(*params.Limit)
	}
	if params.State != nil {
		filter.State = string(*params.State)
	}
	if params.Archived != nil {
		filter.IncludeArchived = *params.Archived
	}
	if params.WorkRoomId != nil {
		filter.WorkRoomID = *params.WorkRoomId
	}
	page, err := a.workItems.ListForAgent(c.Request.Context(), c.Param("agentId"), filter)
	if a.writeWorkItemError(c, "list Agent Work Items", err) {
		return
	}
	items := make([]teamhubinternal.AgentWorkItem, 0, len(page.Items))
	for _, item := range page.Items {
		items = append(items, agentWorkItemModel(item))
	}
	c.JSON(http.StatusOK, teamhubinternal.AgentWorkItemPage{Items: items, Page: agentPageMeta(page.HasMore, page.NextCursor)})
}

func (a *App) createAgentWorkItem(c *gin.Context) {
	key, ok := a.requireIdempotencyKey(c)
	if !ok {
		return
	}
	var request teamhubinternal.AgentWorkItemCreateRequest
	if decodeJSON(c, &request) != nil {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Agent Work Item input is invalid")
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
		input.ReferencedActorIDs = agentIDsToStrings(*request.ReferencedActorIds)
	}
	if request.AssigneeActorIds != nil {
		input.AssigneeActorIDs = agentIDsToStrings(*request.AssigneeActorIds)
		input.AssigneeActorIDsSet = true
	}
	if request.OriginRoomId != nil {
		input.OriginRoomID = *request.OriginRoomId
	}
	result, err := a.workItems.CreateForAgent(c.Request.Context(), c.Param("agentId"), key, input)
	if a.writeWorkItemError(c, "create Agent Work Item", err) {
		return
	}
	writeWorkItemResult(c, http.StatusCreated, result.Replay, agentWorkItemModel(result.Value))
}

func (a *App) getAgentWorkItem(c *gin.Context) {
	item, err := a.workItems.GetForAgent(c.Request.Context(), c.Param("agentId"), c.Param("workItemId"))
	if a.writeWorkItemError(c, "get Agent Work Item", err) {
		return
	}
	c.JSON(http.StatusOK, agentWorkItemModel(item))
}

func (a *App) transitionAgentWorkItem(c *gin.Context) {
	key, ok := a.requireIdempotencyKey(c)
	if !ok {
		return
	}
	var request teamhubinternal.WorkItemTransitionRequest
	if decodeJSON(c, &request) != nil {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Agent Work Item transition is invalid")
		return
	}
	input := workitem.TransitionInput{ExpectedVersion: request.ExpectedVersion, State: string(request.State)}
	if request.Resolution != nil {
		value := string(*request.Resolution)
		input.Resolution = &value
	}
	result, err := a.workItems.TransitionForAgent(c.Request.Context(), c.Param("agentId"), c.Param("workItemId"), key, input)
	if a.writeWorkItemError(c, "transition Agent Work Item", err) {
		return
	}
	writeWorkItemResult(c, http.StatusOK, result.Replay, agentWorkItemModel(result.Value))
}

func (a *App) listAgentWorkItemComments(c *gin.Context) {
	params := contractParams[teamhubinternal.ListAgentWorkItemCommentsParams](c)
	cursor, limit := "", int32(50)
	if params.Cursor != nil {
		cursor = *params.Cursor
	}
	if params.Limit != nil {
		limit = int32(*params.Limit)
	}
	page, err := a.workItems.ListCommentsForAgent(c.Request.Context(), c.Param("agentId"), c.Param("workItemId"), cursor, limit)
	if a.writeWorkItemError(c, "list Agent Work Item Comments", err) {
		return
	}
	items, err := agentCommentModels(page.Items)
	if err != nil {
		a.internalError(c, "project Agent Work Item Comments", err)
		return
	}
	c.JSON(http.StatusOK, teamhubinternal.AgentWorkItemCommentPage{Items: items, Page: agentPageMeta(page.HasMore, page.NextCursor)})
}

func (a *App) createAgentWorkItemComment(c *gin.Context) {
	key, ok := a.requireIdempotencyKey(c)
	if !ok {
		return
	}
	var request teamhubinternal.WorkItemCommentCreateRequest
	if decodeJSON(c, &request) != nil {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Agent Work Item Comment input is invalid")
		return
	}
	input, err := agentCommentInput(request.Body, request.Segments)
	if err != nil {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Agent Work Item Comment input is invalid")
		return
	}
	result, err := a.workItems.CreateCommentForAgent(c.Request.Context(), c.Param("agentId"), c.Param("workItemId"), key, input)
	if a.writeWorkItemError(c, "create Agent Work Item Comment", err) {
		return
	}
	model, err := agentCommentModel(result.Value)
	if err != nil {
		a.internalError(c, "project Agent Work Item Comment", err)
		return
	}
	writeWorkItemResult(c, http.StatusCreated, result.Replay, model)
}

func (a *App) updateAgentWorkItemComment(c *gin.Context) {
	key, ok := a.requireIdempotencyKey(c)
	if !ok {
		return
	}
	var request teamhubinternal.WorkItemCommentUpdateRequest
	if decodeJSON(c, &request) != nil {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Agent Work Item Comment update is invalid")
		return
	}
	content, err := agentCommentInput(request.Body, request.Segments)
	if err != nil {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Agent Work Item Comment update is invalid")
		return
	}
	result, err := a.workItems.UpdateCommentForAgent(c.Request.Context(), c.Param("agentId"), c.Param("workItemId"), c.Param("commentId"), key, workitem.CommentUpdateInput{
		ExpectedVersion: request.ExpectedVersion, Content: content,
	})
	if a.writeWorkItemError(c, "update Agent Work Item Comment", err) {
		return
	}
	model, err := agentCommentModel(result.Value)
	if err != nil {
		a.internalError(c, "project Agent Work Item Comment", err)
		return
	}
	writeWorkItemResult(c, http.StatusOK, result.Replay, model)
}

func (a *App) deleteAgentWorkItemComment(c *gin.Context) {
	key, ok := a.requireIdempotencyKey(c)
	if !ok {
		return
	}
	var request teamhubinternal.WorkItemVersionRequest
	if decodeJSON(c, &request) != nil {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Agent Work Item Comment version is invalid")
		return
	}
	result, err := a.workItems.DeleteCommentForAgent(c.Request.Context(), c.Param("agentId"), c.Param("workItemId"), c.Param("commentId"), key, workitem.VersionInput{ExpectedVersion: request.ExpectedVersion})
	if a.writeWorkItemError(c, "delete Agent Work Item Comment", err) {
		return
	}
	model, err := agentCommentModel(result.Value)
	if err != nil {
		a.internalError(c, "project Agent Work Item Comment", err)
		return
	}
	writeWorkItemResult(c, http.StatusOK, result.Replay, model)
}

func agentWorkItemModel(item workitem.Item) teamhubinternal.AgentWorkItem {
	model := teamhubinternal.AgentWorkItem{
		Id: item.ID, Number: item.Number,
		Kind: teamhubinternal.WorkItemKind(item.Kind), Title: item.Title, Description: item.Description,
		Priority: teamhubinternal.WorkItemPriority(item.Priority), State: teamhubinternal.WorkItemState(item.State), Version: item.Version,
		CreatedBy: agentActorModel(item.CreatedBy), UpdatedBy: agentActorModel(item.UpdatedBy),
		ReferencedActors:     make([]teamhubinternal.AgentActorRef, 0, len(item.ReferencedActors)),
		Assignees:            make([]teamhubinternal.AgentWorkItemAssignment, 0, len(item.Assignees)),
		ExplicitAccessGrants: make([]teamhubinternal.AgentWorkItemAccessGrant, 0, len(item.ExplicitAccessGrants)),
		CreatedAt:            item.CreatedAt, UpdatedAt: item.UpdatedAt,
	}
	for _, actor := range item.ReferencedActors {
		model.ReferencedActors = append(model.ReferencedActors, agentActorModel(actor))
	}
	for _, assignment := range item.Assignees {
		model.Assignees = append(model.Assignees, teamhubinternal.AgentWorkItemAssignment{
			Actor: agentActorModel(assignment.Actor), AssignedBy: agentActorModel(assignment.AssignedBy), AssignedAt: assignment.AssignedAt,
		})
	}
	for _, grant := range item.ExplicitAccessGrants {
		model.ExplicitAccessGrants = append(model.ExplicitAccessGrants, teamhubinternal.AgentWorkItemAccessGrant{
			Actor: agentActorModel(grant.Actor), GrantedBy: agentActorModel(grant.GrantedBy), GrantedAt: grant.GrantedAt,
		})
	}
	if item.Resolution != nil {
		value := teamhubinternal.WorkItemResolution(*item.Resolution)
		model.Resolution = &value
	}
	model.OriginRoomId = agentIDPointer(item.OriginRoomID)
	model.OriginMessageId = agentIDPointer(item.OriginMessageID)
	model.WorkRoomId = agentIDPointer(item.WorkRoomID)
	model.ArchivedAt = item.ArchivedAt
	return model
}

func agentActorModel(actor workitem.Actor) teamhubinternal.AgentActorRef {
	return teamhubinternal.AgentActorRef{Id: actor.ID, Kind: teamhubinternal.ActorKind(actor.Kind), DisplayName: actor.DisplayName}
}

func agentCommentInput(body string, segments []teamhubinternal.WorkItemCommentSegment) (workitem.CommentInput, error) {
	values := make([]workitem.CommentSegment, 0, len(segments))
	for _, segment := range segments {
		discriminator, err := segment.Discriminator()
		if err != nil {
			return workitem.CommentInput{}, err
		}
		if discriminator == "reference" {
			value, err := segment.AsWorkItemCommentReferenceSegment()
			if err != nil {
				return workitem.CommentInput{}, err
			}
			values = append(values, workitem.CommentSegment{Type: "reference", Content: value.Content, ActorID: value.ActorId})
			continue
		}
		if discriminator != "text" {
			return workitem.CommentInput{}, workitem.ErrInvalid
		}
		value, err := segment.AsWorkItemCommentTextSegment()
		if err != nil {
			return workitem.CommentInput{}, err
		}
		values = append(values, workitem.CommentSegment{Type: "text", Content: value.Content})
	}
	return workitem.CommentInput{Body: body, Segments: values}, nil
}

func agentCommentModels(comments []workitem.Comment) ([]teamhubinternal.AgentWorkItemComment, error) {
	models := make([]teamhubinternal.AgentWorkItemComment, 0, len(comments))
	for _, comment := range comments {
		model, err := agentCommentModel(comment)
		if err != nil {
			return nil, err
		}
		models = append(models, model)
	}
	return models, nil
}

func agentCommentModel(comment workitem.Comment) (teamhubinternal.AgentWorkItemComment, error) {
	segments := make([]teamhubinternal.WorkItemCommentSegment, 0, len(comment.Segments))
	for _, segment := range comment.Segments {
		var model teamhubinternal.WorkItemCommentSegment
		var err error
		if segment.Type == "reference" {
			err = model.FromWorkItemCommentReferenceSegment(teamhubinternal.WorkItemCommentReferenceSegment{Type: "reference", Content: segment.Content, ActorId: segment.ActorID})
		} else {
			err = model.FromWorkItemCommentTextSegment(teamhubinternal.WorkItemCommentTextSegment{Type: "text", Content: segment.Content})
		}
		if err != nil {
			return teamhubinternal.AgentWorkItemComment{}, err
		}
		segments = append(segments, model)
	}
	model := teamhubinternal.AgentWorkItemComment{
		Id: comment.ID, WorkItemId: comment.WorkItemID,
		Author: agentActorModel(comment.Author), Body: comment.Body, Segments: segments,
		Version: comment.Version, CreatedAt: comment.CreatedAt, UpdatedAt: comment.UpdatedAt,
	}
	model.DeletedAt = comment.DeletedAt
	return model, nil
}

func agentPageMeta(hasMore bool, cursor string) teamhubinternal.PageMeta {
	meta := teamhubinternal.PageMeta{HasMore: hasMore}
	if cursor != "" {
		value := cursor
		meta.NextCursor = &value
	}
	return meta
}

func agentIDPointer(value *string) *teamhubinternal.Id {
	if value == nil {
		return nil
	}
	result := *value
	return &result
}

func agentIDsToStrings(ids []teamhubinternal.Id) []string {
	values := make([]string, 0, len(ids))
	values = append(values, ids...)
	return values
}
