package app

import (
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/workitem"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

func (a *App) listWorkItemComments(c *gin.Context) {
	params := contractParams[httpapi.ListWorkItemCommentsParams](c)
	cursor, limit := "", int32(50)
	if params.Cursor != nil {
		cursor = *params.Cursor
	}
	if params.Limit != nil {
		limit = int32(*params.Limit)
	}
	page, err := a.workItems.ListCommentsForHuman(c.Request.Context(), currentPrincipal(c).Session.AccountID, c.Param("workItemId"), cursor, limit)
	if a.writeWorkItemError(c, "list Work Item Comments", err) {
		return
	}
	items, err := humanCommentModels(page.Items)
	if err != nil {
		a.internalError(c, "project Work Item Comments", err)
		return
	}
	c.JSON(http.StatusOK, httpapi.WorkItemCommentPage{Items: items, Page: pageMeta(page.HasMore, page.NextCursor)})
}

func (a *App) createWorkItemComment(c *gin.Context) {
	key, ok := a.requireIdempotencyKey(c)
	if !ok {
		return
	}
	var request httpapi.WorkItemCommentCreateRequest
	if decodeJSON(c, &request) != nil {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Work Item Comment input is invalid")
		return
	}
	input, err := humanCommentInput(request.Body, request.Segments)
	if err != nil {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Work Item Comment input is invalid")
		return
	}
	result, err := a.workItems.CreateCommentForHuman(c.Request.Context(), currentPrincipal(c).Session.AccountID, c.Param("workItemId"), key, input)
	if a.writeWorkItemError(c, "create Work Item Comment", err) {
		return
	}
	model, err := humanCommentModel(result.Value)
	if err != nil {
		a.internalError(c, "project Work Item Comment", err)
		return
	}
	writeWorkItemResult(c, http.StatusCreated, result.Replay, model)
}

func (a *App) updateWorkItemComment(c *gin.Context) {
	key, ok := a.requireIdempotencyKey(c)
	if !ok {
		return
	}
	var request httpapi.WorkItemCommentUpdateRequest
	if decodeJSON(c, &request) != nil {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Work Item Comment update is invalid")
		return
	}
	content, err := humanCommentInput(request.Body, request.Segments)
	if err != nil {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Work Item Comment update is invalid")
		return
	}
	result, err := a.workItems.UpdateCommentForHuman(c.Request.Context(), currentPrincipal(c).Session.AccountID, c.Param("workItemId"), c.Param("commentId"), key, workitem.CommentUpdateInput{
		ExpectedVersion: request.ExpectedVersion, Content: content,
	})
	if a.writeWorkItemError(c, "update Work Item Comment", err) {
		return
	}
	model, err := humanCommentModel(result.Value)
	if err != nil {
		a.internalError(c, "project Work Item Comment", err)
		return
	}
	writeWorkItemResult(c, http.StatusOK, result.Replay, model)
}

func (a *App) deleteWorkItemComment(c *gin.Context) {
	key, ok := a.requireIdempotencyKey(c)
	if !ok {
		return
	}
	var request httpapi.WorkItemVersionRequest
	if decodeJSON(c, &request) != nil {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Work Item Comment version is invalid")
		return
	}
	result, err := a.workItems.DeleteCommentForHuman(c.Request.Context(), currentPrincipal(c).Session.AccountID, c.Param("workItemId"), c.Param("commentId"), key, workitem.VersionInput{ExpectedVersion: request.ExpectedVersion})
	if a.writeWorkItemError(c, "delete Work Item Comment", err) {
		return
	}
	model, err := humanCommentModel(result.Value)
	if err != nil {
		a.internalError(c, "project Work Item Comment", err)
		return
	}
	writeWorkItemResult(c, http.StatusOK, result.Replay, model)
}

func (a *App) listWorkItemTimeline(c *gin.Context) {
	params := contractParams[httpapi.ListWorkItemTimelineParams](c)
	cursor, limit := "", int32(50)
	if params.Cursor != nil {
		cursor = *params.Cursor
	}
	if params.Limit != nil {
		limit = int32(*params.Limit)
	}
	page, err := a.workItems.ListTimelineForHuman(c.Request.Context(), currentPrincipal(c).Session.AccountID, c.Param("workItemId"), cursor, limit)
	if a.writeWorkItemError(c, "list Work Item timeline", err) {
		return
	}
	items := make([]httpapi.WorkItemTimelineEntry, 0, len(page.Items))
	for _, entry := range page.Items {
		var model httpapi.WorkItemTimelineEntry
		switch entry.Type {
		case "comment":
			comment, err := humanCommentModel(*entry.Comment)
			if err != nil {
				a.internalError(c, "project Work Item timeline Comment", err)
				return
			}
			err = model.FromWorkItemCommentTimelineEntry(httpapi.WorkItemCommentTimelineEntry{Type: "comment", Comment: comment})
			if err != nil {
				a.internalError(c, "project Work Item timeline Comment", err)
				return
			}
		case "activity":
			err := model.FromWorkItemActivityTimelineEntry(httpapi.WorkItemActivityTimelineEntry{Type: "activity", Activity: humanActivityModel(*entry.Activity)})
			if err != nil {
				a.internalError(c, "project Work Item timeline activity", err)
				return
			}
		default:
			a.internalError(c, "project Work Item timeline", errors.New("unknown timeline entry type"))
			return
		}
		items = append(items, model)
	}
	c.JSON(http.StatusOK, httpapi.WorkItemTimelinePage{Items: items, Page: pageMeta(page.HasMore, page.NextCursor)})
}

func humanCommentInput(body string, segments []httpapi.WorkItemCommentSegment) (workitem.CommentInput, error) {
	values := make([]workitem.CommentSegment, 0, len(segments))
	for _, segment := range segments {
		discriminator, err := segment.Discriminator()
		if err != nil {
			return workitem.CommentInput{}, err
		}
		switch discriminator {
		case "text":
			value, err := segment.AsWorkItemCommentTextSegment()
			if err != nil {
				return workitem.CommentInput{}, err
			}
			values = append(values, workitem.CommentSegment{Type: "text", Content: value.Content})
		case "reference":
			value, err := segment.AsWorkItemCommentReferenceSegment()
			if err != nil {
				return workitem.CommentInput{}, err
			}
			values = append(values, workitem.CommentSegment{Type: "reference", Content: value.Content, ActorID: value.ActorId})
		default:
			return workitem.CommentInput{}, workitem.ErrInvalid
		}
	}
	return workitem.CommentInput{Body: body, Segments: values}, nil
}

func humanCommentModels(comments []workitem.Comment) ([]httpapi.WorkItemComment, error) {
	models := make([]httpapi.WorkItemComment, 0, len(comments))
	for _, comment := range comments {
		model, err := humanCommentModel(comment)
		if err != nil {
			return nil, err
		}
		models = append(models, model)
	}
	return models, nil
}

func humanCommentModel(comment workitem.Comment) (httpapi.WorkItemComment, error) {
	segments := make([]httpapi.WorkItemCommentSegment, 0, len(comment.Segments))
	for _, segment := range comment.Segments {
		var model httpapi.WorkItemCommentSegment
		var err error
		if segment.Type == "reference" {
			err = model.FromWorkItemCommentReferenceSegment(httpapi.WorkItemCommentReferenceSegment{Type: "reference", Content: segment.Content, ActorId: segment.ActorID})
		} else {
			err = model.FromWorkItemCommentTextSegment(httpapi.WorkItemCommentTextSegment{Type: "text", Content: segment.Content})
		}
		if err != nil {
			return httpapi.WorkItemComment{}, err
		}
		segments = append(segments, model)
	}
	model := httpapi.WorkItemComment{
		Id: comment.ID, TenantId: comment.TenantID, WorkItemId: comment.WorkItemID,
		Author: workItemActorModel(comment.Author), Body: comment.Body, Segments: segments,
		Version: comment.Version, CreatedAt: comment.CreatedAt, UpdatedAt: comment.UpdatedAt,
	}
	model.DeletedAt = comment.DeletedAt
	return model, nil
}

func humanActivityModel(activity workitem.Activity) httpapi.WorkItemActivity {
	model := httpapi.WorkItemActivity{
		Id: activity.ID, WorkItemId: activity.WorkItemID,
		Kind: httpapi.WorkItemActivityKind(activity.Kind), Actor: workItemActorModel(activity.Actor),
		Details: activity.Details, OccurredAt: activity.OccurredAt,
	}
	if activity.FromState != nil {
		value := httpapi.WorkItemState(*activity.FromState)
		model.FromState = &value
	}
	if activity.ToState != nil {
		value := httpapi.WorkItemState(*activity.ToState)
		model.ToState = &value
	}
	if activity.TargetActorID != nil {
		value := *activity.TargetActorID
		model.TargetActorId = &value
	}
	if activity.CommentID != nil {
		value := *activity.CommentID
		model.CommentId = &value
	}
	if activity.RoomID != nil {
		value := *activity.RoomID
		model.RoomId = &value
	}
	return model
}
