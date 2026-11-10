package app

import (
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentmessages"
	teamhubagentapi "github.com/simplexai-labs/linger/contracts-go/teamhubagentapi"
)

func (a *App) agentHistoryReader(c *gin.Context) (agentmessages.Reader, bool) {
	principal, ok := a.authenticatePublicAgentFile(c)
	return agentmessages.Reader{TenantID: principal.TenantID, ActorID: principal.AgentActorID}, ok
}

func (a *App) searchAgentHistoryMessages(c *gin.Context) {
	reader, ok := a.agentHistoryReader(c)
	if !ok {
		return
	}
	var request teamhubagentapi.AgentMessageSearchRequest
	if decodeJSON(c, &request) != nil {
		a.writeAgentHistoryError(c, agentmessages.ErrInvalid)
		return
	}
	input := agentmessages.SearchInput{Query: request.Query}
	if request.Cursor != nil {
		input.Cursor = *request.Cursor
	}
	if request.Limit != nil {
		input.Limit = *request.Limit
	}
	if request.InboxIds != nil {
		input.InboxIDs = *request.InboxIds
	}
	result, err := a.agentMessages.Search(c.Request.Context(), reader, input)
	if a.writeSearchTimeout(c, err) || a.writeAgentHistoryError(c, err) {
		return
	}
	model, err := convertJSON[teamhubagentapi.AgentMessageSearchResponse](result)
	if a.writeAgentHistoryError(c, err) {
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, model)
}

func (a *App) writeAgentHistoryError(c *gin.Context, err error) bool {
	if err == nil {
		return false
	}
	switch {
	case errors.Is(err, agentmessages.ErrInvalid):
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Message history query is invalid")
	case errors.Is(err, agentmessages.ErrNotFound):
		a.writeError(c, http.StatusNotFound, "NOT_FOUND", "Message or Inbox is unavailable")
	default:
		a.internalError(c, "read Agent message history", err)
	}
	return true
}

// readAgentHistoryMessages is the single business read for all new CLI modes.
func (a *App) readAgentHistoryMessages(c *gin.Context) {
	reader, ok := a.agentHistoryReader(c)
	if !ok {
		return
	}
	type strictRequest teamhubagentapi.AgentMessageReadRequest
	var request strictRequest
	if decodeJSON(c, &request) != nil {
		a.writeAgentHistoryError(c, agentmessages.ErrInvalid)
		return
	}
	input := agentmessages.ReadInput{InboxID: optionalString(request.InboxId), ThreadID: optionalString(request.ThreadId), Cursor: optionalString(request.Cursor)}
	if request.MessageIds != nil {
		input.MessageIDs = append([]string{}, (*request.MessageIds)...)
	}
	if request.ListInboxes != nil {
		input.ListInboxes = *request.ListInboxes
	}
	if request.Limit != nil {
		input.Limit = *request.Limit
	}
	result, err := a.agentMessages.Read(c.Request.Context(), reader, input)
	if a.writeAgentHistoryError(c, err) {
		return
	}
	model, err := convertJSON[teamhubagentapi.AgentMessageReadResponse](result)
	if a.writeAgentHistoryError(c, err) {
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, model)
}

func agentMessageReceipt(fields gin.H, replay bool, reason string) gin.H {
	fields["duplicate_request"] = replay
	if replay {
		fields["reason"] = reason
	}
	return fields
}
