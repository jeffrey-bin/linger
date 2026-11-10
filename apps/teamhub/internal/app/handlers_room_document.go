package app

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

func (a *App) createRoomDocument(c *gin.Context) {
	var request httpapi.ContextDocumentCreateRequest
	if decodeJSON(c, &request) != nil || len(request) != 0 {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Room Document create input must be an empty object")
		return
	}
	result, err := a.documents.Create(c.Request.Context(), document.CreateDocumentInput{
		AccountID: currentPrincipal(c).Session.AccountID, RoomID: c.Param("roomId"),
	})
	if a.writeUnifiedDocumentError(c, "create Room Document", err) {
		return
	}
	c.JSON(http.StatusCreated, documentModel(result.Document))
}

func (a *App) openDocument(c *gin.Context) {
	principal := currentPrincipal(c)
	opened, err := a.documents.Open(c.Request.Context(), document.IssueCollaborationCredentialInput{
		AccountID: principal.Session.AccountID, DocumentID: c.Param("documentId"),
		ExpiresAt: principal.Session.ExpiresAt.Time,
	})
	c.Header("Cache-Control", "private, no-store")
	if a.writeUnifiedDocumentError(c, "open Document", err) {
		return
	}
	result := httpapi.DocumentOpenResult{Document: documentModel(opened.Document)}
	if credential := opened.Credential; credential != nil {
		result.CollaborationCredential = &httpapi.RoomDocumentCollaborationCredential{
			DocumentId: credential.DocumentID, CollaborationCredential: credential.CollaborationCredential,
			ExpiresAt: credential.ExpiresAt,
		}
	}
	if version := opened.CurrentVersion; version != nil {
		model := documentVersionModel(*version)
		result.CurrentVersion = &model
	}
	c.JSON(http.StatusOK, result)
}

func (a *App) createRoomDocumentCollaborationCredential(c *gin.Context) {
	principal := currentPrincipal(c)
	credential, err := a.documents.IssueCollaborationCredential(c.Request.Context(), document.IssueCollaborationCredentialInput{
		AccountID: principal.Session.AccountID, DocumentID: c.Param("documentId"),
		ExpiresAt: principal.Session.ExpiresAt.Time,
	})
	if a.writeUnifiedDocumentError(c, "issue Document collaboration credential", err) {
		return
	}
	c.JSON(http.StatusCreated, httpapi.RoomDocumentCollaborationCredential{
		DocumentId: credential.DocumentID, CollaborationCredential: credential.CollaborationCredential,
		ExpiresAt: credential.ExpiresAt,
	})
}

func (a *App) createDocumentReadSessionCredential(c *gin.Context) {
	principal := currentPrincipal(c)
	credential, err := a.documents.IssueReadCollaborationCredential(c.Request.Context(), document.IssueCollaborationCredentialInput{
		AccountID: principal.Session.AccountID, DocumentID: c.Param("documentId"),
		ExpiresAt: principal.Session.ExpiresAt.Time,
	})
	if a.writeUnifiedDocumentError(c, "issue Document read session credential", err) {
		return
	}
	c.JSON(http.StatusCreated, httpapi.RoomDocumentCollaborationCredential{
		DocumentId: credential.DocumentID, CollaborationCredential: credential.CollaborationCredential,
		ExpiresAt: credential.ExpiresAt,
	})
}
