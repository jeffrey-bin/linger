package app

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

func (a *App) bindDocumentToRoom(c *gin.Context) {
	result, err := a.documents.BindToRoom(c.Request.Context(), document.BindDocumentToRoomInput{
		AccountID: currentPrincipal(c).Session.AccountID, DocumentID: c.Param("documentId"),
		RoomID: c.Param("roomId"),
	})
	a.writeDocumentBindingResult(c, result, err)
}

func (a *App) bindDocumentToWorkItem(c *gin.Context) {
	idempotencyKey := contractParams[httpapi.BindDocumentToWorkItemParams](c).IdempotencyKey
	result, err := a.documents.BindToWorkItem(c.Request.Context(), document.BindDocumentToWorkItemInput{
		AccountID: currentPrincipal(c).Session.AccountID, DocumentID: c.Param("documentId"),
		WorkItemID: c.Param("workItemId"), IdempotencyKey: idempotencyKey,
	})
	a.writeDocumentBindingResult(c, result, err)
}

func (a *App) bindDocumentToPersonalWiki(c *gin.Context) {
	result, err := a.documents.BindToPersonalWiki(c.Request.Context(), document.BindDocumentToPersonalWikiInput{
		AccountID: currentPrincipal(c).Session.AccountID, DocumentID: c.Param("documentId"),
		TenantID: c.Param("tenantId"),
	})
	a.writeDocumentBindingResult(c, result, err)
}

func (a *App) writeDocumentBindingResult(c *gin.Context, result document.BindDocumentResult, err error) {
	if a.writeUnifiedDocumentError(c, "bind Document", err) {
		return
	}
	if result.Replayed {
		c.Header("Idempotent-Replay", "true")
	}
	c.JSON(http.StatusOK, documentModel(result.Document))
}

func (a *App) duplicateDocument(c *gin.Context) {
	var request httpapi.DocumentDuplicateRequest
	if decodeJSON(c, &request) != nil {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Document duplicate input is invalid")
		return
	}
	result, err := a.documents.Duplicate(c.Request.Context(), document.DuplicateDocumentInput{
		AccountID: currentPrincipal(c).Session.AccountID, DocumentID: c.Param("documentId"),
		TargetFolderID: unifiedDocumentStringIDPointer(request.TargetFolderId),
	})
	if a.writeUnifiedDocumentError(c, "duplicate Document", err) {
		return
	}
	c.JSON(http.StatusCreated, documentModel(result.Document))
}
