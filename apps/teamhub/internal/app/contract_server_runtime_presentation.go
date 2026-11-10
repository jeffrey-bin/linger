package app

import (
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

func (a *App) listRoomRunStatuses(c *gin.Context) {
	items, err := a.collaboration.RoomRunStatuses(c.Request.Context(), currentPrincipal(c).Session.AccountID, c.Param("roomId"))
	if a.notFoundOrError(c, "list Run statuses", err) {
		return
	}
	c.JSON(http.StatusOK, httpapi.RoomRunStatusList{Items: items})
}

func (a *App) listRoomRuntimePresentationRuns(c *gin.Context) {
	params := contractParams[httpapi.ListRoomRuntimePresentationRunsParams](c)
	roomID := c.Param("roomId")
	accountID := currentPrincipal(c).Session.AccountID
	messageIDs := make([]string, 0)
	if params.MessageId != nil {
		if len(*params.MessageId) > 100 {
			a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "at most 100 Message IDs are allowed")
			return
		}
		messageIDs = make([]string, len(*params.MessageId))
		copy(messageIDs, *params.MessageId)
	}
	items, err := a.collaboration.RuntimePresentationRuns(c.Request.Context(), accountID, roomID, messageIDs, stringValue(params.RunId))
	if a.notFoundOrError(c, "authorize Runtime presentation Run list", err) {
		return
	}
	c.JSON(http.StatusOK, httpapi.RoomRunStatusList{Items: items})
}

const (
	runtimePresentationDefaultLimit = 50
	runtimePresentationMaxLimit     = 200
)

func (a *App) listRoomRuntimePresentationEvents(c *gin.Context) {
	params := contractParams[httpapi.ListRoomRuntimePresentationEventsParams](c)
	run, err := a.collaboration.RoomRun(c.Request.Context(), currentPrincipal(c).Session.AccountID, c.Param("roomId"), c.Param("runId"))
	if a.notFoundOrError(c, "authorize Runtime presentation event list", err) {
		return
	}
	after := int64(0)
	if params.After != nil {
		after, err = strconv.ParseInt(*params.After, 10, 64)
		if err != nil || after < 0 {
			a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Runtime presentation event cursor is invalid")
			return
		}
	}
	limit := runtimePresentationDefaultLimit
	if params.Limit != nil {
		limit = *params.Limit
	}
	if limit < 1 || limit > runtimePresentationMaxLimit {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Runtime presentation event limit is invalid")
		return
	}
	page, err := a.collaboration.RuntimePresentationEvents(c.Request.Context(), run, after, limit)
	if a.notFoundOrError(c, "list Runtime presentation events", err) {
		return
	}
	c.JSON(http.StatusOK, page)
}
