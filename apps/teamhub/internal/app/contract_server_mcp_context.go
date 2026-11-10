package app

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/mcpcontext"
	"github.com/simplexai-labs/linger/contracts-go/teamhubinternal"
)

const mcpContextRequestMaxBytes = 64 << 10

type mcpContextService interface {
	Resolve(context.Context, string, mcpcontext.ContextRef) (mcpcontext.ResolveResult, error)
}

func (a *App) resolveMcpContext(c *gin.Context) {
	agentID := c.Param("agentId")
	if !a.authenticateMcpAgentService(c) {
		return
	}
	var request teamhubinternal.McpContextResolveRequest
	if err := decodeMcpContextBody(c, &request); err != nil {
		a.writeMcpContextError(c, http.StatusBadRequest, teamhubinternal.McpContextErrorCodeInvalidRequest, "MCP Context resolution request is invalid")
		return
	}
	contextRef, err := mcpContextRefFromContract(request.Context)
	if err != nil {
		a.writeMcpContextError(c, http.StatusBadRequest, teamhubinternal.McpContextErrorCodeInvalidRequest, "MCP Context resolution request is invalid")
		return
	}
	result, err := a.mcpContexts.Resolve(c.Request.Context(), agentID, contextRef)
	if a.writeMcpContextServiceError(c, "resolve MCP Context", err) {
		return
	}
	response, err := mcpContextResolveResponseToContract(result)
	if err != nil {
		a.writeMcpContextProjectionError(c, "project resolved MCP Context", err)
		return
	}
	c.JSON(http.StatusOK, response)
}

func decodeMcpContextBody(c *gin.Context, target any) error {
	body := http.MaxBytesReader(c.Writer, c.Request.Body, mcpContextRequestMaxBytes)
	return decodeStrictJSON(body, target, "request body must contain one JSON object")
}

func mcpContextRefFromContract(value teamhubinternal.McpContextReference) (mcpcontext.ContextRef, error) {
	raw, err := value.MarshalJSON()
	if err != nil {
		return mcpcontext.ContextRef{}, err
	}
	discriminator, err := value.Discriminator()
	if err != nil {
		return mcpcontext.ContextRef{}, err
	}
	switch discriminator {
	case "meta":
		var reference teamhubinternal.MetaMcpContextReference
		if err := decodeStrictJSON(bytes.NewReader(raw), &reference, "context must contain one JSON object"); err != nil || reference.Kind != "meta" || reference.RoomId == "" {
			return mcpcontext.ContextRef{}, errors.New("invalid meta MCP Context reference")
		}
		return mcpcontext.ContextRef{Kind: "meta", RoomID: reference.RoomId}, nil
	case "alter_ego":
		var reference teamhubinternal.AlterEgoMcpContextReference
		if err := decodeStrictJSON(bytes.NewReader(raw), &reference, "context must contain one JSON object"); err != nil || reference.Kind != "alter_ego" || reference.TaskId == "" {
			return mcpcontext.ContextRef{}, errors.New("invalid alterEgo MCP Context reference")
		}
		return mcpcontext.ContextRef{Kind: "alter_ego", TaskID: reference.TaskId}, nil
	case "document":
		var reference teamhubinternal.DocumentMcpContextReference
		if err := decodeStrictJSON(bytes.NewReader(raw), &reference, "context must contain one JSON object"); err != nil || reference.Kind != "document" || reference.DocumentId == "" {
			return mcpcontext.ContextRef{}, errors.New("invalid Document MCP Context reference")
		}
		return mcpcontext.ContextRef{Kind: "document", DocumentID: reference.DocumentId}, nil
	default:
		return mcpcontext.ContextRef{}, errors.New("unknown MCP Context kind")
	}
}

func mcpContextResolveResponseToContract(
	result mcpcontext.ResolveResult,
) (teamhubinternal.McpContextResolveResponse, error) {
	contextRef, err := mcpContextRefToContract(result.Context)
	if err != nil {
		return teamhubinternal.McpContextResolveResponse{}, err
	}
	response := teamhubinternal.McpContextResolveResponse{AgentId: result.AgentID, Context: contextRef}
	if result.Context.Kind == "document" {
		if result.DocumentCommentRuntime == nil || result.DocumentCommentRuntime.CommentsMarkdown == "" ||
			result.DocumentCommentRuntime.CurrentDocument.DocumentID != result.Context.DocumentID ||
			result.DocumentCommentRuntime.CurrentDocument.Filename == "" {
			return teamhubinternal.McpContextResolveResponse{}, errors.New("resolved Document MCP Context is missing its Comment Runtime projection")
		}
		response.DocumentCommentRuntime = &teamhubinternal.McpDocumentCommentRuntimeProjection{
			CommentsMarkdown: result.DocumentCommentRuntime.CommentsMarkdown,
			CurrentDocument: teamhubinternal.McpDocumentLatestRuntimeProjection{
				DocumentId: result.DocumentCommentRuntime.CurrentDocument.DocumentID,
				Filename:   result.DocumentCommentRuntime.CurrentDocument.Filename,
				MediaType:  result.DocumentCommentRuntime.CurrentDocument.MediaType,
				Content:    append([]byte(nil), result.DocumentCommentRuntime.CurrentDocument.Bytes...),
				SizeBytes:  int64(len(result.DocumentCommentRuntime.CurrentDocument.Bytes)),
				Sha256:     result.DocumentCommentRuntime.CurrentDocument.SHA256,
			},
		}
	} else if result.DocumentCommentRuntime != nil {
		return teamhubinternal.McpContextResolveResponse{}, errors.New("non-Document MCP Context unexpectedly contains a Comment Runtime projection")
	}
	return response, nil
}

func mcpContextRefToContract(reference mcpcontext.ContextRef) (teamhubinternal.McpContextReference, error) {
	var result teamhubinternal.McpContextReference
	switch reference.Kind {
	case "meta":
		if reference.TaskID != "" {
			return result, errors.New("meta MCP Context unexpectedly contains a Task")
		}
		if reference.RoomID == "" {
			return result, errors.New("meta MCP Context is missing its Room")
		}
		err := result.FromMetaMcpContextReference(teamhubinternal.MetaMcpContextReference{RoomId: reference.RoomID})
		return result, err
	case "alter_ego":
		if reference.TaskID == "" {
			return result, errors.New("alterEgo MCP Context is missing its Task")
		}
		err := result.FromAlterEgoMcpContextReference(teamhubinternal.AlterEgoMcpContextReference{TaskId: reference.TaskID})
		return result, err
	case "document":
		if reference.DocumentID == "" || reference.TaskID != "" || reference.RoomID != "" {
			return result, errors.New("Document MCP Context is invalid")
		}
		err := result.FromDocumentMcpContextReference(teamhubinternal.DocumentMcpContextReference{
			Kind: "document", DocumentId: reference.DocumentID,
		})
		return result, err
	default:
		return result, errors.New("unknown MCP Context kind")
	}
}

func (a *App) writeMcpContextServiceError(c *gin.Context, action string, err error) bool {
	if err == nil {
		return false
	}
	switch {
	case errors.Is(err, mcpcontext.ErrInvalid):
		a.writeMcpContextError(c, http.StatusBadRequest, teamhubinternal.McpContextErrorCodeInvalidRequest, "MCP Context request is invalid")
	case errors.Is(err, mcpcontext.ErrIdentityInvalid):
		a.writeMcpContextError(c, http.StatusForbidden, teamhubinternal.McpContextErrorCodeContextIdentityInvalid, "MCP Context identity is invalid")
	case errors.Is(err, mcpcontext.ErrDependencyFailed):
		a.writeMcpContextError(c, http.StatusServiceUnavailable, teamhubinternal.McpContextErrorCodeDependencyUnavailable, "MCP Context dependency is unavailable")
	default:
		if a.logger != nil {
			a.logger.Error(action, "request_id", c.GetString("request_id"), "error_type", fmt.Sprintf("%T", err))
		}
		a.writeMcpContextError(c, http.StatusInternalServerError, teamhubinternal.McpContextErrorCodeInternalError, "MCP Context operation could not complete the request")
	}
	return true
}

func (a *App) writeMcpContextProjectionError(c *gin.Context, action string, err error) {
	if a.logger != nil {
		a.logger.Error(action, "request_id", c.GetString("request_id"), "error_type", fmt.Sprintf("%T", err))
	}
	a.writeMcpContextError(c, http.StatusInternalServerError, teamhubinternal.McpContextErrorCodeInternalError, "MCP Context operation could not complete the request")
}
