package app

import (
	"context"
	"errors"
	"fmt"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentauth"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentdocument"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
	teamhubagentapi "github.com/simplexai-labs/linger/contracts-go/teamhubagentapi"
)

const agentDocumentCreateRequestMaxBytes = 1052672

type agentDocumentCreateService interface {
	Create(context.Context, string, agentdocument.CreateInput) (agentdocument.CreateResult, error)
}

func (a *App) createAgentDocument(c *gin.Context) {
	token, ok := strictAgentBearer(c)
	if !ok {
		a.writeAgentDocumentCreateError(c, agentauth.ErrCredentialInvalid)
		return
	}
	var request teamhubagentapi.AgentDocumentCreateRequest
	if err := decodeStrictJSON(
		http.MaxBytesReader(c.Writer, c.Request.Body, agentDocumentCreateRequestMaxBytes),
		&request,
		"request body must contain one JSON object",
	); err != nil {
		a.writeAgentDocumentCreateError(c, document.ErrInvalidInput)
		return
	}
	result, err := a.agentDocumentCreations.Create(
		c.Request.Context(), token,
		agentdocument.CreateInput{
			InvocationID: request.InvocationId,
			Title:        request.Title, Markdown: request.Markdown,
		},
	)
	if a.writeAgentDocumentCreateError(c, err) {
		return
	}
	c.JSON(http.StatusOK, teamhubagentapi.AgentDocumentCreateResponse{
		DocumentId: result.DocumentID, RevisionId: result.RevisionID,
		Status: "created", Replayed: result.Replayed,
	})
}

func (a *App) writeAgentDocumentCreateError(c *gin.Context, err error) bool {
	if err == nil {
		return false
	}
	switch {
	case errors.Is(err, document.ErrInvalidInput), errors.Is(err, agentauth.ErrInvalid):
		a.writeAgentAPIError(c, http.StatusBadRequest, teamhubagentapi.AgentApiErrorCodeInvalidRequest, "Document creation request is invalid")
	case errors.Is(err, agentauth.ErrCredentialInvalid):
		a.writeAgentAPIError(c, http.StatusUnauthorized, teamhubagentapi.AgentApiErrorCodeAgentCredentialInvalid, "Agent credential is invalid or expired")
	case errors.Is(err, agentauth.ErrForbidden), errors.Is(err, agentdocument.ErrCreateForbidden):
		a.writeAgentAPIError(c, http.StatusForbidden, teamhubagentapi.AgentApiErrorCodeOperationForbidden, agentForbiddenMessage(err, "Document creation is not allowed for this Context"))
	case errors.Is(err, document.ErrNotFound):
		a.writeAgentAPIError(c, http.StatusNotFound, teamhubagentapi.AgentApiErrorCodeNotFound, "Document creation authority was not found")
	case errors.Is(err, document.ErrIdempotencyConflict), errors.Is(err, document.ErrConflict):
		a.writeAgentAPIError(c, http.StatusConflict, teamhubagentapi.AgentApiErrorCodeIdempotencyConflict, "Document creation invocation was reused or terminated")
	case errors.Is(err, document.ErrRecoveryBudgetExceeded):
		a.writeAgentAPIError(c, http.StatusRequestEntityTooLarge, teamhubagentapi.AgentApiErrorCodePayloadTooLarge, "Document content exceeds the recovery limit")
	case errors.Is(err, document.ErrRuntimeUnavailable), errors.Is(err, agentdocument.ErrCreateDependency):
		a.writeAgentAPIError(c, http.StatusServiceUnavailable, teamhubagentapi.AgentApiErrorCodeDependencyUnavailable, "Document creation dependency is unavailable")
	default:
		if a.logger != nil {
			a.logger.Error("create Agent Document", "request_id", c.GetString("request_id"), "error_type", fmt.Sprintf("%T", err))
		}
		a.writeAgentAPIError(c, http.StatusInternalServerError, teamhubagentapi.AgentApiErrorCodeInternalError, "Document creation could not complete the request")
	}
	return true
}
