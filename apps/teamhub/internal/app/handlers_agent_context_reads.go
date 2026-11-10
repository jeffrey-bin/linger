package app

import (
	"errors"
	"net/http"
	"regexp"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentcredential"
	api "github.com/simplexai-labs/linger/contracts-go/teamhubagentapi"
)

var agentReadResourceID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$`)

func (a *App) writeAgentContextRead(c *gin.Context, result any, err error) {
	switch {
	case errors.Is(err, agentcredential.ErrForbidden):
		a.writeError(c, http.StatusForbidden, "FORBIDDEN", "Agent identity does not match credential")
	case errors.Is(err, agentcredential.ErrInvalid):
		a.writeError(c, http.StatusUnauthorized, "UNAUTHENTICATED", "Agent credential is invalid")
	case a.notFoundOrError(c, "read Agent collaboration state", err):
	default:
		c.Header("Cache-Control", "no-store")
		c.JSON(http.StatusOK, result)
	}
}

func (a *App) roomReadRequest(c *gin.Context) (string, bool) {
	var request api.AgentRoomMembersRequest
	if decodeStrictJSON(http.MaxBytesReader(c.Writer, c.Request.Body, 2048), &request, "one JSON object required") != nil {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Invalid Room read")
		return "", false
	}
	inboxID := request.InboxId
	roomID := strings.TrimPrefix(strings.TrimPrefix(inboxID, "room:"), "thread:")
	if !agentReadResourceID.MatchString(roomID) {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Invalid Room or Thread Inbox")
		return "", false
	}
	if !strings.HasPrefix(inboxID, "thread:") && !strings.HasPrefix(inboxID, "room:") {
		inboxID = "room:" + inboxID
	}
	return inboxID, true
}

func (a *App) getAgentRoomMembers(c *gin.Context) {
	inboxID, ok := a.roomReadRequest(c)
	if !ok {
		return
	}
	token, ok := strictAgentBearer(c)
	if !ok {
		a.writeError(c, http.StatusUnauthorized, "UNAUTHENTICATED", "Agent credential is required")
		return
	}
	result, err := a.collaboration.AgentRoomMembers(c.Request.Context(), token, inboxID)
	a.writeAgentContextRead(c, result, err)
}

func (a *App) getAgentTeamMd(c *gin.Context) {
	inboxID, ok := a.roomReadRequest(c)
	if !ok {
		return
	}
	token, ok := strictAgentBearer(c)
	if !ok {
		a.writeError(c, http.StatusUnauthorized, "UNAUTHENTICATED", "Agent credential is required")
		return
	}
	result, err := a.collaboration.AgentTeamMd(c.Request.Context(), token, inboxID)
	a.writeAgentContextRead(c, result, err)
}
