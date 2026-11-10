package app

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentauth"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentdocument"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
	teamhubagentapi "github.com/simplexai-labs/linger/contracts-go/teamhubagentapi"
)

const agentDocumentCommentRequestMaxBytes = 256 << 10
const agentCurrentDocumentProjectionMaxBytes = 32 << 20

type agentDocumentCommentService interface {
	GetThread(context.Context, string, string) (agentdocument.ThreadResult, error)
	Reply(context.Context, string, agentdocument.ReplyInput) (agentdocument.ReplyResult, error)
	ReplaceText(context.Context, string, agentdocument.ReplaceInput) (agentdocument.ReplaceResult, error)
}

func (a *App) getAgentDocumentCommentThread(c *gin.Context) {
	token, ok := strictAgentBearer(c)
	if !ok {
		a.writeAgentDocumentCommentError(c, agentauth.ErrCredentialInvalid)
		return
	}
	var request teamhubagentapi.AgentDocumentCommentThreadRequest
	if err := decodeAgentDocumentCommentRequest(c, &request); err != nil {
		a.writeAgentDocumentCommentError(c, document.ErrCommentInvalidInput)
		return
	}
	result, err := a.agentDocumentComments.GetThread(
		c.Request.Context(), token, request.ThreadId,
	)
	if a.writeAgentDocumentCommentError(c, err) {
		return
	}
	response, err := agentDocumentCommentThreadToContract(result)
	if err != nil {
		a.writeAgentDocumentCommentProjectionError(c, err)
		return
	}
	c.JSON(http.StatusOK, response)
}

func (a *App) replyAgentDocumentComment(c *gin.Context) {
	token, ok := strictAgentBearer(c)
	if !ok {
		a.writeAgentDocumentCommentError(c, agentauth.ErrCredentialInvalid)
		return
	}
	var request teamhubagentapi.AgentDocumentCommentReplyRequest
	if err := decodeAgentDocumentCommentRequest(c, &request); err != nil {
		a.writeAgentDocumentCommentError(c, document.ErrCommentInvalidInput)
		return
	}
	segments, err := agentDocumentCommentSegmentsFromContract(request.Segments)
	if err != nil {
		a.writeAgentDocumentCommentError(c, document.ErrCommentInvalidInput)
		return
	}
	parentCommentID := ""
	if request.ParentCommentId != nil {
		parentCommentID = *request.ParentCommentId
	}
	result, err := a.agentDocumentComments.Reply(
		c.Request.Context(), token, agentdocument.ReplyInput{
			ThreadID: request.ThreadId, ParentCommentID: parentCommentID,
			Segments: segments, InvocationID: request.InvocationId,
		},
	)
	if a.writeAgentDocumentCommentError(c, err) {
		return
	}
	c.JSON(http.StatusOK, teamhubagentapi.AgentDocumentCommentReplyResponse{
		ThreadId:  result.ThreadID,
		CommentId: result.CommentID,
		Replayed:  result.Replayed,
	})
}

func (a *App) replaceAgentDocumentCommentText(c *gin.Context) {
	token, ok := strictAgentBearer(c)
	if !ok {
		a.writeAgentDocumentCommentError(c, agentauth.ErrCredentialInvalid)
		return
	}
	var request teamhubagentapi.AgentDocumentCommentTextReplacementRequest
	if err := decodeAgentDocumentCommentRequest(c, &request); err != nil {
		a.writeAgentDocumentCommentError(c, document.ErrInvalidInput)
		return
	}
	result, err := a.agentDocumentComments.ReplaceText(
		c.Request.Context(), token, agentdocument.ReplaceInput{
			ThreadID: request.ThreadId, Replacement: request.ReplaceStr,
			InvocationID: request.InvocationId,
		},
	)
	if a.writeAgentDocumentCommentError(c, err) {
		return
	}
	response := teamhubagentapi.AgentDocumentCommentTextReplacementResponse{
		ThreadId: result.ThreadID,
		Status:   teamhubagentapi.AgentDocumentCommentTextReplacementResponseStatus(result.Status),
		Replayed: result.Replayed, Observation: result.Observation,
	}
	if result.RevisionID != "" {
		revisionID := result.RevisionID
		response.RevisionId = &revisionID
	}
	if result.HistoryEntryID != "" {
		historyEntryID := result.HistoryEntryID
		response.HistoryEntryId = &historyEntryID
	}
	if result.ConflictReason != "" {
		response.ConflictReason = &result.ConflictReason
	}
	if result.Status == string(document.SemanticMutationApplied) {
		digest := fmt.Sprintf("%x", sha256.Sum256(result.CurrentMarkdown))
		if result.RevisionID == "" || result.HistoryEntryID == "" ||
			len(result.CurrentMarkdown) > agentCurrentDocumentProjectionMaxBytes ||
			result.CurrentMarkdownSHA256 != digest {
			a.writeAgentDocumentCommentProjectionError(c, errors.New("invalid current Document projection"))
			return
		}
		response.CurrentDocumentProjection = &teamhubagentapi.AgentCurrentDocumentProjection{
			ContentBase64: append([]byte(nil), result.CurrentMarkdown...),
			SizeBytes:     int64(len(result.CurrentMarkdown)),
			Sha256:        result.CurrentMarkdownSHA256,
		}
	} else if len(result.CurrentMarkdown) != 0 || result.CurrentMarkdownSHA256 != "" {
		a.writeAgentDocumentCommentProjectionError(c, errors.New("unexpected current Document projection"))
		return
	}
	c.JSON(http.StatusOK, response)
}

func decodeAgentDocumentCommentRequest(c *gin.Context, target any) error {
	return decodeStrictJSON(
		http.MaxBytesReader(c.Writer, c.Request.Body, agentDocumentCommentRequestMaxBytes),
		target, "request body must contain one JSON object",
	)
}

func agentDocumentCommentThreadToContract(
	result agentdocument.ThreadResult,
) (teamhubagentapi.AgentDocumentCommentThreadResponse, error) {
	comments := make([]teamhubagentapi.AgentDocumentComment, len(result.Comments))
	for index, source := range result.Comments {
		segments, err := agentDocumentCommentSegmentsToContract(source.Segments)
		if err != nil {
			return teamhubagentapi.AgentDocumentCommentThreadResponse{}, err
		}
		comment := teamhubagentapi.AgentDocumentComment{
			CommentId: source.CommentID,
			Author: teamhubagentapi.AgentDocumentCommentAuthor{
				DisplayName: source.Author.DisplayName,
				Kind:        teamhubagentapi.AgentDocumentCommentAuthorKind(source.Author.Kind),
			},
			Segments: segments, CreatedAt: source.CreatedAt.UTC(),
		}
		if source.ParentCommentID != "" {
			parentCommentID := source.ParentCommentID
			comment.ParentCommentId = &parentCommentID
		}
		comments[index] = comment
	}
	return teamhubagentapi.AgentDocumentCommentThreadResponse{
		ThreadId: result.ThreadID,
		Selection: teamhubagentapi.AgentDocumentCommentThreadSelection{
			QuotedText: result.Selection.QuotedText, ContextBefore: result.Selection.ContextBefore,
			ContextAfter: result.Selection.ContextAfter,
		},
		Comments: comments,
	}, nil
}

func agentDocumentCommentSegmentsFromContract(
	values []teamhubagentapi.DocumentCommentSegment,
) ([]agentdocument.Segment, error) {
	segments := make([]agentdocument.Segment, 0, len(values))
	for _, value := range values {
		raw, err := value.MarshalJSON()
		if err != nil {
			return nil, err
		}
		discriminator, err := value.Discriminator()
		if err != nil {
			return nil, err
		}
		switch discriminator {
		case "text":
			var segment teamhubagentapi.DocumentCommentTextSegment
			if err := decodeStrictJSON(bytes.NewReader(raw), &segment, "segment must contain one JSON object"); err != nil || segment.Type != "text" {
				return nil, document.ErrCommentInvalidInput
			}
			segments = append(segments, agentdocument.Segment{Type: "text", Content: segment.Content})
		case "reference":
			var segment teamhubagentapi.DocumentCommentReferenceSegment
			if err := decodeStrictJSON(bytes.NewReader(raw), &segment, "segment must contain one JSON object"); err != nil || segment.Type != "reference" {
				return nil, document.ErrCommentInvalidInput
			}
			segments = append(segments, agentdocument.Segment{
				Type: "reference", Content: segment.Content, ActorID: segment.ActorId,
			})
		default:
			return nil, document.ErrCommentInvalidInput
		}
	}
	return segments, nil
}

func agentDocumentCommentSegmentsToContract(
	values []agentdocument.Segment,
) ([]teamhubagentapi.DocumentCommentSegment, error) {
	segments := make([]teamhubagentapi.DocumentCommentSegment, len(values))
	for index, source := range values {
		var err error
		switch source.Type {
		case "text":
			err = segments[index].FromDocumentCommentTextSegment(
				teamhubagentapi.DocumentCommentTextSegment{Type: "text", Content: source.Content},
			)
		case "reference":
			err = segments[index].FromDocumentCommentReferenceSegment(
				teamhubagentapi.DocumentCommentReferenceSegment{
					Type: "reference", Content: source.Content,
					ActorId: source.ActorID,
				},
			)
		default:
			return nil, errors.New("Document Comment segment kind is invalid")
		}
		if err != nil {
			return nil, err
		}
	}
	return segments, nil
}

func (a *App) writeAgentDocumentCommentError(c *gin.Context, err error) bool {
	if err == nil {
		return false
	}
	switch {
	case errors.Is(err, document.ErrCommentInvalidInput), errors.Is(err, document.ErrInvalidInput), errors.Is(err, agentauth.ErrInvalid):
		a.writeAgentAPIError(c, http.StatusBadRequest, teamhubagentapi.AgentApiErrorCodeInvalidRequest, "Document Comment request is invalid")
	case errors.Is(err, agentauth.ErrCredentialInvalid):
		a.writeAgentAPIError(c, http.StatusUnauthorized, teamhubagentapi.AgentApiErrorCodeAgentCredentialInvalid, "Agent credential is invalid or expired")
	case errors.Is(err, agentauth.ErrForbidden),
		errors.Is(err, agentdocument.ErrCommentToolForbidden), errors.Is(err, document.ErrCommentForbidden):
		a.writeAgentAPIError(c, http.StatusForbidden, teamhubagentapi.AgentApiErrorCodeOperationForbidden, "Document Comment operation is not allowed for this Context")
	case errors.Is(err, pgx.ErrNoRows), errors.Is(err, document.ErrNotFound):
		a.writeAgentAPIError(c, http.StatusNotFound, teamhubagentapi.AgentApiErrorCodeNotFound, "Document Comment authority was not found")
	case errors.Is(err, document.ErrCommentIdempotencyConflict), errors.Is(err, document.ErrIdempotencyConflict):
		a.writeAgentAPIError(c, http.StatusConflict, teamhubagentapi.AgentApiErrorCodeIdempotencyConflict, "Document Comment invocation was reused with different input")
	case errors.Is(err, document.ErrCommentConflict), errors.Is(err, document.ErrCommentCapacity),
		errors.Is(err, document.ErrConflict), errors.Is(err, document.ErrVersionConflict):
		a.writeAgentAPIError(c, http.StatusConflict, teamhubagentapi.AgentApiErrorCodeVersionConflict, "Document Comment state changed")
	case errors.Is(err, agentdocument.ErrCommentToolDependency),
		errors.Is(err, document.ErrRuntimeUnavailable), errors.Is(err, document.ErrObjectStoreUnavailable),
		errors.Is(err, document.ErrRevisionUnavailable):
		a.writeAgentAPIError(c, http.StatusServiceUnavailable, teamhubagentapi.AgentApiErrorCodeDependencyUnavailable, "Document Comment dependency is unavailable")
	default:
		if a.logger != nil {
			a.logger.Error("execute Agent Document Comment operation", "request_id", c.GetString("request_id"), "error_type", fmt.Sprintf("%T", err))
		}
		a.writeAgentAPIError(c, http.StatusInternalServerError, teamhubagentapi.AgentApiErrorCodeInternalError, "Document Comment operation could not complete the request")
	}
	return true
}

func (a *App) writeAgentDocumentCommentProjectionError(c *gin.Context, err error) {
	if a.logger != nil {
		a.logger.Error("project Agent Document Comment response", "request_id", c.GetString("request_id"), "error_type", fmt.Sprintf("%T", err))
	}
	a.writeAgentAPIError(c, http.StatusInternalServerError, teamhubagentapi.AgentApiErrorCodeInternalError, "Document Comment operation could not complete the request")
}
