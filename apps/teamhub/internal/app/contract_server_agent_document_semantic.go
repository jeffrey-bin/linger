package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentauth"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentdocument"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
	teamhubagentapi "github.com/simplexai-labs/linger/contracts-go/teamhubagentapi"
)

const agentDocumentSemanticRequestMaxBytes = 263168

type agentDocumentSemanticService interface {
	Apply(context.Context, string, agentdocument.SemanticInput) (agentdocument.SemanticResult, error)
}

func (a *App) applyAgentDocumentSemanticMutation(c *gin.Context) {
	token, ok := strictAgentBearer(c)
	if !ok {
		a.writeAgentDocumentSemanticError(c, agentauth.ErrCredentialInvalid)
		return
	}
	var request teamhubagentapi.AgentDocumentSemanticMutationRequest
	if err := decodeStrictJSON(
		http.MaxBytesReader(c.Writer, c.Request.Body, agentDocumentSemanticRequestMaxBytes),
		&request,
		"request body must contain one JSON object",
	); err != nil {
		a.writeAgentDocumentSemanticError(c, document.ErrInvalidInput)
		return
	}
	semanticChange, err := json.Marshal(request.SemanticChange)
	if err != nil {
		a.writeAgentDocumentSemanticError(c, document.ErrInvalidInput)
		return
	}
	result, err := a.agentDocumentSemanticMutations.Apply(
		c.Request.Context(), token,
		agentdocument.SemanticInput{
			DocumentID:     request.DocumentId,
			InvocationID:   request.InvocationId,
			SchemaVersion:  request.SchemaVersion,
			SemanticChange: semanticChange,
		},
	)
	if a.writeAgentDocumentSemanticError(c, err) {
		return
	}
	response := teamhubagentapi.AgentDocumentSemanticMutationResponse{
		SemanticMutationId: result.SemanticMutationID,
		Status:             teamhubagentapi.AgentDocumentSemanticMutationResponseStatus(result.Status),
		Replayed:           result.Replayed,
	}
	if result.RevisionID != "" {
		response.RevisionId = &result.RevisionID
	}
	if result.HistoryEntryID != "" {
		response.HistoryEntryId = &result.HistoryEntryID
	}
	if result.ConflictReason != "" {
		response.ConflictReason = &result.ConflictReason
	}
	c.JSON(http.StatusOK, response)
}

func (a *App) writeAgentDocumentSemanticError(c *gin.Context, err error) bool {
	if err == nil {
		return false
	}
	switch {
	case errors.Is(err, document.ErrInvalidInput), errors.Is(err, agentauth.ErrInvalid):
		a.writeAgentAPIError(c, http.StatusBadRequest, teamhubagentapi.AgentApiErrorCodeInvalidRequest, "Document semantic mutation request is invalid")
	case errors.Is(err, agentauth.ErrCredentialInvalid):
		a.writeAgentAPIError(c, http.StatusUnauthorized, teamhubagentapi.AgentApiErrorCodeAgentCredentialInvalid, "Agent credential is invalid or expired")
	case errors.Is(err, agentauth.ErrForbidden), errors.Is(err, agentdocument.ErrSemanticForbidden):
		a.writeAgentAPIError(c, http.StatusForbidden, teamhubagentapi.AgentApiErrorCodeOperationForbidden, "Document semantic mutation is not allowed for this Context")
	case errors.Is(err, document.ErrNotFound):
		a.writeAgentAPIError(c, http.StatusNotFound, teamhubagentapi.AgentApiErrorCodeNotFound, "Document semantic mutation authority was not found")
	case errors.Is(err, document.ErrIdempotencyConflict):
		a.writeAgentAPIError(c, http.StatusConflict, teamhubagentapi.AgentApiErrorCodeIdempotencyConflict, "Document semantic mutation invocation was reused")
	case errors.Is(err, document.ErrConflict), errors.Is(err, document.ErrVersionConflict):
		a.writeAgentAPIError(c, http.StatusConflict, teamhubagentapi.AgentApiErrorCodeVersionConflict, "Document Draft head changed")
	case errors.Is(err, document.ErrRecoveryBudgetExceeded):
		a.writeAgentAPIError(c, http.StatusRequestEntityTooLarge, teamhubagentapi.AgentApiErrorCodePayloadTooLarge, "Document content exceeds the recovery limit")
	case errors.Is(err, document.ErrRuntimeUnavailable), errors.Is(err, document.ErrObjectStoreUnavailable),
		errors.Is(err, document.ErrRevisionUnavailable),
		errors.Is(err, agentdocument.ErrSemanticDependency):
		a.writeAgentAPIError(c, http.StatusServiceUnavailable, teamhubagentapi.AgentApiErrorCodeDependencyUnavailable, "Document semantic mutation dependency is unavailable")
	default:
		if a.logger != nil {
			a.logger.Error("apply Agent Document semantic mutation", "request_id", c.GetString("request_id"), "error_type", fmt.Sprintf("%T", err))
		}
		a.writeAgentAPIError(c, http.StatusInternalServerError, teamhubagentapi.AgentApiErrorCodeInternalError, "Document semantic mutation could not complete the request")
	}
	return true
}
