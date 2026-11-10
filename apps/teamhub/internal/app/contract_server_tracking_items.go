package app

import (
	"errors"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentauth"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/reminder"
	teamhubapi "github.com/simplexai-labs/linger/contracts-go/teamhubagentapi"
)

type trackingListInput struct {
	Cursor        string `json:"cursor"`
	Limit         int    `json:"limit"`
	IncludeClosed bool   `json:"include_closed"`
}

func (a *App) trackingOwner(c *gin.Context, tool string) (reminder.TrackingOwner, bool) {
	auth, err := a.agentAuth.Authorize(c.Request.Context(), strings.TrimPrefix(c.GetHeader("Authorization"), "Bearer "), tool)
	if err == nil && (auth.Principal == nil || auth.UserArtifactOwnerActorID == "") {
		err = agentauth.ErrForbidden
	}
	if a.writeAgentAuthError(c, "authorize tracking items", err) {
		return reminder.TrackingOwner{}, false
	}
	return reminder.TrackingOwner{TenantID: auth.TenantID, ActorID: auth.UserArtifactOwnerActorID}, true
}

func (a *App) trackingError(c *gin.Context, err error) bool {
	if err == nil {
		return false
	}
	status, code := 503, teamhubapi.AgentApiErrorCodeDependencyUnavailable
	if errors.Is(err, reminder.ErrTrackingInvalid) {
		status, code = 400, teamhubapi.AgentApiErrorCodeInvalidInput
	}
	if errors.Is(err, reminder.ErrTrackingConflict) {
		status, code = 409, teamhubapi.AgentApiErrorCode("tracking_item_conflict")
	}
	if errors.Is(err, reminder.ErrTrackingNotFound) {
		status, code = 404, teamhubapi.AgentApiErrorCode("tracking_item_not_found")
	}
	a.writeAgentAPIError(c, status, code, "Tracking Item command could not complete")
	return true
}
func readTrackingInput(c *gin.Context, input any) error {
	if err := decodeStrictJSON(http.MaxBytesReader(c.Writer, c.Request.Body, 512<<10), input, "one command object is required"); err != nil {
		return reminder.ErrTrackingInvalid
	}
	return nil
}

func (a *App) listAgentTrackingItems(c *gin.Context) {
	owner, ok := a.trackingOwner(c, "list_tracking_items")
	if !ok {
		return
	}
	input := trackingListInput{Limit: 100}
	if a.trackingError(c, readTrackingInput(c, &input)) {
		return
	}
	result, err := a.tracking.List(c.Request.Context(), owner, input.Cursor, input.Limit, input.IncludeClosed)
	if !a.trackingError(c, err) {
		c.JSON(200, result)
	}
}
func (a *App) addAgentTrackingItem(c *gin.Context) {
	owner, ok := a.trackingOwner(c, "add_tracking_item")
	if !ok {
		return
	}
	var input reminder.TrackingCreate
	if a.trackingError(c, readTrackingInput(c, &input)) {
		return
	}
	result, err := a.tracking.Apply(c.Request.Context(), owner, reminder.TrackingChanges{Create: []reminder.TrackingCreate{input}})
	if !a.trackingError(c, err) {
		c.JSON(200, result.Items[0])
	}
}
func (a *App) updateAgentTrackingItem(c *gin.Context) {
	owner, ok := a.trackingOwner(c, "update_tracking_item")
	if !ok {
		return
	}
	var input reminder.TrackingUpdate
	if a.trackingError(c, readTrackingInput(c, &input)) {
		return
	}
	result, err := a.tracking.Apply(c.Request.Context(), owner, reminder.TrackingChanges{Update: []reminder.TrackingUpdate{input}})
	if !a.trackingError(c, err) {
		c.JSON(200, result.Items[0])
	}
}
func (a *App) completeAgentTrackingItem(c *gin.Context) {
	owner, ok := a.trackingOwner(c, "complete_tracking_item")
	if !ok {
		return
	}
	var input reminder.TrackingVersion
	if a.trackingError(c, readTrackingInput(c, &input)) {
		return
	}
	result, err := a.tracking.Done(c.Request.Context(), owner, input)
	if !a.trackingError(c, err) {
		c.JSON(200, result)
	}
}
