package app

import (
	"errors"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/proactive"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/reminder"
	"github.com/simplexai-labs/linger/contracts-go/teamhubinternal"
)

func (a *App) memoryTrackingOwner(c *gin.Context, actorID string) (reminder.TrackingOwner, bool) {
	owner, err := a.tracking.HumanOwner(c.Request.Context(), actorID)
	if errors.Is(err, pgx.ErrNoRows) {
		c.JSON(404, gin.H{"error": "tracking_owner_not_found"})
		return owner, false
	}
	if err != nil {
		a.internalError(c, "resolve tracking owner", err)
		return owner, false
	}
	return owner, true
}
func (a *App) memoryTrackingError(c *gin.Context, err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, reminder.ErrTrackingInvalid) {
		c.JSON(400, gin.H{"error": "invalid_tracking_command"})
		return true
	}
	if errors.Is(err, reminder.ErrTrackingConflict) {
		c.JSON(409, gin.H{"error": "tracking_item_conflict"})
		return true
	}
	a.internalError(c, "tracking items", err)
	return true
}
func (a *App) listMemoryTrackingItems(c *gin.Context) {
	actorID := c.Param("actorId")
	owner, ok := a.memoryTrackingOwner(c, actorID)
	if !ok {
		return
	}
	input := trackingListInput{Limit: 100}
	if a.memoryTrackingError(c, readTrackingInput(c, &input)) {
		return
	}
	result, err := a.tracking.List(c.Request.Context(), owner, input.Cursor, input.Limit, input.IncludeClosed)
	if !a.memoryTrackingError(c, err) {
		c.JSON(200, result)
	}
}
func (a *App) applyMemoryTrackingItems(c *gin.Context) {
	actorID := c.Param("actorId")
	owner, ok := a.memoryTrackingOwner(c, actorID)
	if !ok {
		return
	}
	var input reminder.TrackingChanges
	if a.memoryTrackingError(c, readTrackingInput(c, &input)) {
		return
	}
	result, err := a.tracking.Apply(c.Request.Context(), owner, input)
	if !a.memoryTrackingError(c, err) {
		c.JSON(200, result)
	}
}

func (a *App) planMemoryTrackingItems(c *gin.Context) {
	actorID := c.Param("actorId")
	owner, ok := a.memoryTrackingOwner(c, actorID)
	if !ok {
		return
	}
	var input teamhubinternal.TrackingItemPlanRequest
	if a.memoryTrackingError(c, readTrackingInput(c, &input)) {
		return
	}
	if len(input.ItemIds) == 0 || len(input.ItemIds) > 200 {
		a.memoryTrackingError(c, reminder.ErrTrackingInvalid)
		return
	}
	err := a.proactive.QueuePlanWake(c.Request.Context(), proactive.Owner{TenantID: owner.TenantID, ActorID: owner.ActorID}, input.ItemIds)
	if !a.memoryTrackingError(c, err) {
		c.Status(204)
	}
}
