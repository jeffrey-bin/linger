package app

import (
	"errors"
	"fmt"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentauth"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentsendmessage"
	teamhubagentapi "github.com/simplexai-labs/linger/contracts-go/teamhubagentapi"
)

const agentPresentationSequenceRequestMaxBytes = 512 << 10

func (a *App) sendAgentPresentationSequence(c *gin.Context) {
	token, ok := strictAgentBearer(c)
	if !ok {
		a.writeAgentPresentationSequenceError(c, agentauth.ErrCredentialInvalid)
		return
	}
	var request teamhubagentapi.AgentSendPresentationSequenceRequest
	body := http.MaxBytesReader(c.Writer, c.Request.Body, agentPresentationSequenceRequestMaxBytes)
	if err := decodeStrictJSON(body, &request, "request body must contain one JSON object"); err != nil {
		a.writeAgentPresentationSequenceError(c, agentsendmessage.ErrPresentationSequenceInvalid)
		return
	}
	messages := make([]agentsendmessage.PresentationItem, 0, len(request.Messages))
	for _, message := range request.Messages {
		messages = append(messages, agentsendmessage.PresentationItem{
			Content:     message.Content,
			PauseBefore: agentsendmessage.PresentationPause(message.PauseBefore),
		})
	}
	if len(messages) == 0 || messages[0].PauseBefore != agentsendmessage.PresentationPauseNone {
		a.writeAgentPresentationSequenceError(c, agentsendmessage.ErrPresentationSequenceInvalid)
		return
	}
	result, err := a.presentationSequences.CreateForAgent(c.Request.Context(), a.agentAuth, token, agentsendmessage.AgentPresentationSequence{
		InboxID: request.InboxId, InvocationID: request.InvocationId,
		SourceMessageID: optionalString(request.SourceMessageId), Items: messages,
	})
	if err != nil {
		a.writeAgentPresentationSequenceError(c, err)
		return
	}
	c.JSON(http.StatusOK, agentMessageReceipt(gin.H{"accepted": true, "inbox_id": request.InboxId, "sequence_id": result.SequenceID}, result.Replay, "This sequence was already accepted. The original sequence is returned; no new sequence was queued."))
}

func (a *App) writeAgentPresentationSequenceError(c *gin.Context, err error) {
	switch {
	case errors.Is(err, agentsendmessage.ErrPresentationSequenceInvalid), errors.Is(err, agentauth.ErrInvalid):
		a.writeAgentAPIError(c, http.StatusBadRequest, teamhubagentapi.AgentApiErrorCodeInvalidRequest, "Agent presentation sequence request is invalid")
	case errors.Is(err, agentauth.ErrCredentialInvalid):
		a.writeAgentAPIError(c, http.StatusUnauthorized, teamhubagentapi.AgentApiErrorCodeAgentCredentialInvalid, "Agent credential is invalid or expired")
	case errors.Is(err, agentauth.ErrForbidden):
		a.writeAgentAPIError(c, http.StatusForbidden, teamhubagentapi.AgentApiErrorCodeOperationForbidden, agentForbiddenMessage(err, "send_message_sequence is not allowed for this Context"))
	case errors.Is(err, agentsendmessage.ErrPresentationSequenceReplySourceUnavailable):
		a.writeAgentAPIError(c, http.StatusForbidden, teamhubagentapi.AgentApiErrorCodeForbidden, "Reply source is unavailable or not authorized. Check the source_message_id passed with --reply-to; after correcting it, start a new operation with a new operation ID.")
	case errors.Is(err, agentsendmessage.ErrPresentationSequenceNotFound):
		a.writeAgentAPIError(c, http.StatusForbidden, teamhubagentapi.AgentApiErrorCodeForbidden, "Room is unavailable or not authorized")
	case errors.Is(err, agentsendmessage.ErrPresentationSequenceIdempotencyConflict):
		a.writeAgentAPIError(c, http.StatusConflict, teamhubagentapi.AgentApiErrorCodeIdempotencyConflict, "Agent presentation sequence invocation conflicts with an existing request")
	default:
		if a.logger != nil {
			a.logger.Error("send Agent presentation sequence", "request_id", c.GetString("request_id"), "error_type", fmt.Sprintf("%T", err))
		}
		a.writeAgentAPIError(c, http.StatusServiceUnavailable, teamhubagentapi.AgentApiErrorCodeDependencyUnavailable, "Agent presentation sequence service is unavailable")
	}
}
