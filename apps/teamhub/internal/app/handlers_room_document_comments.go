package app

import (
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

func (a *App) createRoomDocumentCommentThread(c *gin.Context) {
	var request httpapi.DocumentCommentThreadCreateRequest
	if decodeJSON(c, &request) != nil {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Document Comment Thread input is invalid")
		return
	}
	segments, err := documentCommentSegments(request.InitialComment.Segments)
	if err != nil {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Document Comment Thread input is invalid")
		return
	}
	var anchor *document.AnchorInput
	if request.Anchor != nil {
		anchor = &document.AnchorInput{
			QuotedText: request.Anchor.QuotedText, BlockID: request.Anchor.BlockId,
			ContextBefore: request.Anchor.ContextBefore, ContextAfter: request.Anchor.ContextAfter,
		}
	}
	documentVersionID := ""
	if request.DocumentVersionId != nil {
		documentVersionID = *request.DocumentVersionId
	}
	result, err := a.documentComments.CreateThread(c.Request.Context(), document.CreateThreadInput{
		AccountID: currentPrincipal(c).Session.AccountID, DocumentID: c.Param("documentId"),
		Anchor: anchor, DocumentVersionID: documentVersionID,
		Segments: segments, DurableHead: documentCommentDurableHead(request.DurableHead),
		CurrentContext: documentCommentCurrentContext(request.CurrentContext),
	})
	if a.writeDocumentCommentError(c, "create Document Comment Thread", err) {
		return
	}
	c.Data(result.Status, "application/json; charset=utf-8", result.Body)
}

func (a *App) listRoomDocumentCommentThreads(c *gin.Context) {
	params := contractParams[httpapi.ListRoomDocumentCommentThreadsParams](c)
	cursor, limit := "", int32(50)
	if params.Cursor != nil {
		cursor = *params.Cursor
	}
	if params.Limit != nil {
		limit = int32(*params.Limit)
	}
	page, err := a.documentComments.ListThreads(
		c.Request.Context(), currentPrincipal(c).Session.AccountID, c.Param("documentId"), cursor, limit,
	)
	if a.writeDocumentCommentError(c, "list Document Comment Threads", err) {
		return
	}
	c.JSON(http.StatusOK, gin.H{"items": page.Items, "page": pageMeta(page.HasMore, page.NextCursor)})
}

func (a *App) getRoomDocumentCommentThread(c *gin.Context) {
	thread, err := a.documentComments.GetThread(
		c.Request.Context(), currentPrincipal(c).Session.AccountID, c.Param("documentCommentThreadId"),
	)
	if a.writeDocumentCommentError(c, "get Document Comment Thread", err) {
		return
	}
	c.JSON(http.StatusOK, thread)
}

func (a *App) updateRoomDocumentCommentThread(c *gin.Context) {
	var request httpapi.DocumentCommentThreadResolutionRequest
	if decodeJSON(c, &request) != nil {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Document Comment Thread resolution input is invalid")
		return
	}
	input := document.ResolutionInput{
		AccountID: currentPrincipal(c).Session.AccountID, ThreadID: c.Param("documentCommentThreadId"),
	}
	var result document.Result
	var err error
	if request.Resolved {
		result, err = a.documentComments.Resolve(c.Request.Context(), input)
	} else {
		result, err = a.documentComments.Reopen(c.Request.Context(), input)
	}
	if a.writeDocumentCommentError(c, "update Document Comment Thread resolution", err) {
		return
	}
	c.Data(result.Status, "application/json; charset=utf-8", result.Body)
}

func (a *App) createRoomDocumentCommentReply(c *gin.Context) {
	var request httpapi.DocumentCommentReplyCreateRequest
	if decodeJSON(c, &request) != nil {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Document Comment reply input is invalid")
		return
	}
	segments, err := documentCommentSegments(request.Segments)
	if err != nil {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Document Comment reply input is invalid")
		return
	}
	var parentCommentID *string
	if request.ParentCommentId != nil {
		value := *request.ParentCommentId
		parentCommentID = &value
	}
	result, err := a.documentComments.Reply(c.Request.Context(), document.ReplyInput{
		AccountID: currentPrincipal(c).Session.AccountID, ThreadID: c.Param("documentCommentThreadId"),
		ParentCommentID: parentCommentID, Segments: segments,
		DurableHead:    documentCommentDurableHead(request.DurableHead),
		CurrentContext: documentCommentCurrentContext(request.CurrentContext),
	})
	if a.writeDocumentCommentError(c, "create Document Comment reply", err) {
		return
	}
	c.Data(result.Status, "application/json; charset=utf-8", result.Body)
}

func (a *App) reanchorRoomDocumentCommentThread(c *gin.Context) {
	var request httpapi.DocumentCommentAnchorInput
	if decodeJSON(c, &request) != nil {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Document Comment Anchor input is invalid")
		return
	}
	result, err := a.documentComments.Reanchor(c.Request.Context(), document.ReanchorInput{
		AccountID: currentPrincipal(c).Session.AccountID, ThreadID: c.Param("documentCommentThreadId"),
		Anchor: document.AnchorInput{
			QuotedText: request.QuotedText, BlockID: request.BlockId,
			ContextBefore: request.ContextBefore, ContextAfter: request.ContextAfter,
		},
	})
	if a.writeDocumentCommentError(c, "re-anchor Document Comment Thread", err) {
		return
	}
	c.Data(result.Status, "application/json; charset=utf-8", result.Body)
}

func (a *App) attachDocumentCommentSelectionAnchor(c *gin.Context) {
	var request httpapi.DocumentCommentAnchorAttachmentRequest
	if decodeJSON(c, &request) != nil {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Document Comment Anchor attachment input is invalid")
		return
	}
	result, err := a.documentComments.AttachSelectionAnchor(c.Request.Context(), document.AnchorAttachmentInput{
		AccountID: currentPrincipal(c).Session.AccountID, ThreadID: c.Param("documentCommentThreadId"),
		ExpectedPersistedSeq:         request.ExpectedPersistedSeq,
		ExpectedFullStateFingerprint: request.ExpectedFullStateFingerprint,
	})
	if a.writeDocumentCommentError(c, "attach Document Comment selection Anchor", err) {
		return
	}
	c.JSON(http.StatusOK, gin.H{"status": result.Status, "revision_id": result.RevisionID, "thread": result.Thread})
}

func (a *App) updateRoomDocumentComment(c *gin.Context) {
	var request httpapi.DocumentCommentUpdateRequest
	if decodeJSON(c, &request) != nil {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Document Comment update input is invalid")
		return
	}
	segments, err := documentCommentSegments(request.Segments)
	if err != nil {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Document Comment update input is invalid")
		return
	}
	result, err := a.documentComments.Update(c.Request.Context(), document.UpdateInput{
		AccountID: currentPrincipal(c).Session.AccountID, CommentID: c.Param("documentCommentId"),
		ExpectedVersion: request.ExpectedVersion, Segments: segments,
		DurableHead:    documentCommentDurableHead(request.DurableHead),
		CurrentContext: documentCommentCurrentContext(request.CurrentContext),
	})
	if a.writeDocumentCommentError(c, "update Document Comment", err) {
		return
	}
	c.Data(result.Status, "application/json; charset=utf-8", result.Body)
}

func (a *App) deleteRoomDocumentComment(c *gin.Context) {
	var request httpapi.DocumentCommentVersionRequest
	if decodeJSON(c, &request) != nil {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Document Comment version is invalid")
		return
	}
	result, err := a.documentComments.Delete(c.Request.Context(), document.DeleteInput{
		AccountID: currentPrincipal(c).Session.AccountID, CommentID: c.Param("documentCommentId"),
		ExpectedVersion: request.ExpectedVersion,
	})
	if a.writeDocumentCommentError(c, "delete Document Comment", err) {
		return
	}
	c.Data(result.Status, "application/json; charset=utf-8", result.Body)
}

func (a *App) putRoomDocumentCommentReaction(c *gin.Context) {
	err := a.documentComments.PutReaction(c.Request.Context(), document.ReactionInput{
		AccountID: currentPrincipal(c).Session.AccountID,
		CommentID: c.Param("documentCommentId"), Emoji: c.Param("emoji"),
	})
	if a.writeDocumentCommentError(c, "put Document Comment reaction", err) {
		return
	}
	c.Status(http.StatusNoContent)
}

func (a *App) deleteRoomDocumentCommentReaction(c *gin.Context) {
	err := a.documentComments.DeleteReaction(c.Request.Context(), document.ReactionInput{
		AccountID: currentPrincipal(c).Session.AccountID,
		CommentID: c.Param("documentCommentId"), Emoji: c.Param("emoji"),
	})
	if a.writeDocumentCommentError(c, "delete Document Comment reaction", err) {
		return
	}
	c.Status(http.StatusNoContent)
}

func documentCommentSegments(values []httpapi.DocumentCommentSegment) ([]document.Segment, error) {
	segments := make([]document.Segment, 0, len(values))
	for _, value := range values {
		discriminator, err := value.Discriminator()
		if err != nil {
			return nil, err
		}
		switch discriminator {
		case "text":
			segment, err := value.AsDocumentCommentTextSegment()
			if err != nil {
				return nil, err
			}
			segments = append(segments, document.Segment{Type: "text", Content: segment.Content})
		case "reference":
			segment, err := value.AsDocumentCommentReferenceSegment()
			if err != nil {
				return nil, err
			}
			segments = append(segments, document.Segment{
				Type: "reference", Content: segment.Content, ActorID: segment.ActorId,
			})
		default:
			return nil, document.ErrCommentInvalidInput
		}
	}
	return segments, nil
}

func documentCommentDurableHead(value *httpapi.DocumentCommentDurableHeadSelector) *document.DurableHeadSelector {
	if value == nil {
		return nil
	}
	return &document.DurableHeadSelector{
		PersistedSeq: value.PersistedSeq, StateHash: value.StateHash,
		StateHashVersion: int32(value.StateHashVersion),
	}
}

func documentCommentCurrentContext(value *httpapi.DocumentCommentCurrentContextSelector) *document.CurrentContextSelector {
	if value == nil {
		return nil
	}
	return &document.CurrentContextSelector{
		BindingKind: value.BindingKind,
		ContextID:   value.ContextId,
	}
}

func (a *App) writeDocumentCommentError(c *gin.Context, action string, err error) bool {
	if err == nil {
		return false
	}
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		a.writeError(c, http.StatusNotFound, "NOT_FOUND", "Document Comment resource was not found")
	case errors.Is(err, document.ErrCommentInvalidInput):
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Document Comment input is invalid")
	case errors.Is(err, document.ErrCommentForbidden):
		a.writeError(c, http.StatusForbidden, "FORBIDDEN", "Document Comment mutation is not allowed")
	case errors.Is(err, document.ErrCommentConflict):
		a.writeError(c, http.StatusConflict, "VERSION_CONFLICT", "Document Comment version changed")
	case errors.Is(err, document.ErrCommentCapacity):
		a.writeError(c, http.StatusConflict, "COMMENT_CAPACITY_REACHED", "Document Comment capacity was reached")
	case errors.Is(err, document.ErrCommentRecoveryBudgetExceeded):
		a.writeError(c, http.StatusRequestEntityTooLarge, "PAYLOAD_TOO_LARGE", "Document content exceeds the recovery limit")
	case errors.Is(err, document.ErrCommentRuntimeUnavailable):
		a.writeError(c, http.StatusServiceUnavailable, "DOCUMENT_RUNTIME_UNAVAILABLE", "Document Runtime is unavailable")
	default:
		a.internalError(c, action, err)
	}
	return true
}
