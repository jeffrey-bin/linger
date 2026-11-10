package app

import (
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/collaboration"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/messagereaction"
)

func (a *App) putMessageReaction(c *gin.Context) {
	a.mutateMessageReaction(c, true)
}

func (a *App) deleteMessageReaction(c *gin.Context) {
	a.mutateMessageReaction(c, false)
}

func (a *App) mutateMessageReaction(c *gin.Context, put bool) {
	reactionID := c.Param("reactionId")
	if !messagereaction.ValidReactionID(reactionID) {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Reaction is not in the official library")
		return
	}
	err := a.collaboration.MutateMessageReaction(c.Request.Context(), currentPrincipal(c).Session.AccountID,
		c.Param("roomId"), c.Param("messageId"), reactionID, put)
	switch {
	case errors.Is(err, collaboration.ErrMessageReactionUnsupported):
		a.writeError(c, http.StatusBadRequest, "MESSAGE_REACTION_UNSUPPORTED", "This Message does not support Reactions")
	case errors.Is(err, messagereaction.ErrCapacity):
		a.writeError(c, http.StatusConflict, "MESSAGE_REACTION_CAPACITY_REACHED", "This Message has reached its Reaction limit")
	case a.notFoundOrError(c, "authorize Message Reaction", err):
	default:
		c.Status(http.StatusNoContent)
	}
}
