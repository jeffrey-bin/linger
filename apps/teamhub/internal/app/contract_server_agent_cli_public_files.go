package app

import (
	"encoding/base64"
	"errors"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentcredential"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
	teamhubagentapi "github.com/simplexai-labs/linger/contracts-go/teamhubagentapi"
)

func (a *App) authenticatePublicAgentFile(c *gin.Context) (agentcredential.Principal, bool) {
	token, ok := strictAgentBearer(c)
	if !ok {
		a.writeError(c, http.StatusUnauthorized, "UNAUTHENTICATED", "Agent credential is required")
		return agentcredential.Principal{}, false
	}
	p, err := a.agentCredentials.Authenticate(c.Request.Context(), token)
	if errors.Is(err, agentcredential.ErrForbidden) {
		a.writeError(c, http.StatusForbidden, "FORBIDDEN", "Configured Agent identity does not match credential")
		return p, false
	}
	if err != nil {
		a.writeError(c, http.StatusUnauthorized, "UNAUTHENTICATED", "Agent credential is invalid")
		return p, false
	}
	c.Request = c.Request.WithContext(agentcredential.WithPrincipal(c.Request.Context(), p))
	return p, true
}

func (a *App) publicListAgentCLIFiles(c *gin.Context) {
	params := contractParams[teamhubagentapi.PublicListAgentCLIFilesParams](c)
	p, ok := a.authenticatePublicAgentFile(c)
	if !ok {
		return
	}
	limit := 100
	if params.Limit != nil {
		limit = *params.Limit
	}
	after := ""
	if params.AfterId != nil {
		after = *params.AfterId
	}
	sharedOnly := params.SharedWithMe != nil && *params.SharedWithMe
	files, err := a.documents.ListAgentFiles(c.Request.Context(), p.TenantID, p.AgentID, after, limit, sharedOnly)
	if a.writeAgentCLIFileError(c, err) {
		return
	}
	items := make([]teamhubagentapi.AgentCLIFile, 0, len(files))
	for _, file := range files {
		item := teamhubagentapi.AgentCLIFile{
			DocumentId:    file.DocumentID,
			Name:          file.Name,
			VersionId:     file.VersionID,
			VersionNumber: file.VersionNumber,
			Role:          teamhubagentapi.AgentCLIFileRole(file.Role),
			Editable:      file.Editable,
			ReadOnly:      file.ReadOnly,
			SharedWithMe:  file.SharedWithMe,
		}
		items = append(items, item)
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, gin.H{"files": items})
}
func (a *App) publicDownloadAgentCLIFile(c *gin.Context) {
	documentID := c.Param("documentId")
	params := contractParams[teamhubagentapi.PublicDownloadAgentCLIFileParams](c)
	p, ok := a.authenticatePublicAgentFile(c)
	if !ok {
		return
	}
	format := "markdown"
	if params.Format != nil {
		format = string(*params.Format)
	}
	result, err := a.documents.DownloadAgentFileConditional(c.Request.Context(), p.TenantID, p.AgentID, documentID, format, c.GetHeader("If-None-Match"))
	if a.writeAgentCLIFileError(c, err) {
		return
	}
	c.Header("X-Document-Version-Id", result.VersionID)
	c.Header("X-Document-Read-Only", strconv.FormatBool(result.ReadOnly))
	c.Header("X-Content-Sha256", result.SHA256)
	c.Header("X-Document-Filename", base64.RawURLEncoding.EncodeToString([]byte(result.Filename)))
	writeLatestContentCacheHeaders(c)
	if tag := result.CacheTag(); tag != "" {
		c.Header("ETag", tag)
	}
	if result.NotModified {
		c.Status(http.StatusNotModified)
		return
	}
	a.writeImmutableObjectContentWithHeaders(c, immutableObjectContent{filename: result.Filename, mediaType: result.MediaType, objectKey: result.ObjectKey, sha256: result.SHA256, sizeBytes: result.SizeBytes}, func(c *gin.Context, content immutableObjectContent) {
		a.writeLatestObjectContentHeaders(c, content)
		if tag := result.CacheTag(); tag != "" {
			c.Header("ETag", tag)
		} else {
			c.Writer.Header().Del("ETag")
		}
	})
}
func (a *App) publicReplaceAgentCLIDocumentBody(c *gin.Context) {
	documentID := c.Param("documentId")
	params := contractParams[teamhubagentapi.PublicReplaceAgentCLIDocumentBodyParams](c)
	p, ok := a.authenticatePublicAgentFile(c)
	if !ok {
		return
	}
	format := "html"
	if params.Format != nil {
		format = string(*params.Format)
	}
	result, err := a.documents.ReplaceAgentDocumentBody(c.Request.Context(), document.ReplaceAgentDocumentBodyInput{
		Principal: &p, DocumentID: documentID, BaseRevisionID: params.BaseRevisionId, OperationID: params.OperationId,
		Content: http.MaxBytesReader(c.Writer, c.Request.Body, (1<<20)+1), Format: format,
	})
	if errors.Is(err, document.ErrConflict) {
		err = document.ErrVersionConflict
	}
	if a.writeAgentCLIFileError(c, err) {
		return
	}
	c.JSON(http.StatusOK, gin.H{"document_id": documentID, "revision_id": result.RevisionID, "history_entry_id": result.HistoryEntryID, "sha256": result.SHA256, "replayed": result.Replayed})
}
func (a *App) publicShareAgentCLIFile(c *gin.Context) {
	documentID := c.Param("documentId")
	p, ok := a.authenticatePublicAgentFile(c)
	if !ok {
		return
	}
	var request teamhubagentapi.AgentCLIFileShare
	if err := decodeStrictJSON(http.MaxBytesReader(c.Writer, c.Request.Body, 4096), &request, "invalid share request"); err != nil {
		a.writeAgentCLIFileError(c, document.ErrInvalidInput)
		return
	}
	if a.writeAgentCLIFileError(c, a.documents.ShareAgentFile(c.Request.Context(), document.ShareAgentFileInput{
		AgentID: p.AgentID, DocumentID: documentID, TargetKind: string(request.TargetKind), TargetID: request.TargetId, Role: string(request.Role),
	})) {
		return
	}
	c.Status(http.StatusNoContent)
}
func (a *App) publicManageAgentCLIFileLink(c *gin.Context) {
	documentID := c.Param("documentId")
	p, ok := a.authenticatePublicAgentFile(c)
	if !ok {
		return
	}
	var request teamhubagentapi.AgentCLIFileLinkCommand
	if err := decodeStrictJSON(http.MaxBytesReader(c.Writer, c.Request.Body, 4096), &request, "invalid link request"); err != nil {
		a.writeAgentCLIFileError(c, document.ErrInvalidInput)
		return
	}
	principal := document.LinkSharePrincipal{AgentID: p.AgentID}
	var result document.LinkShare
	var err error
	switch string(request.Operation) {
	case "read":
		result, err = a.documents.GetLinkShare(c.Request.Context(), principal, documentID)
	case "set":
		if request.Role == nil || request.ExpectedVersion == nil {
			a.writeAgentCLIFileError(c, document.ErrInvalidInput)
			return
		}
		result, err = a.documents.SetLinkShare(c.Request.Context(), document.SetLinkShareInput{Principal: principal, DocumentID: documentID, Role: string(*request.Role), ExpectedVersion: *request.ExpectedVersion, Reset: request.Reset != nil && *request.Reset})
	case "revoke":
		if request.ExpectedVersion == nil {
			a.writeAgentCLIFileError(c, document.ErrInvalidInput)
			return
		}
		err = a.documents.RevokeLinkShare(c.Request.Context(), document.RevokeLinkShareInput{Principal: principal, DocumentID: documentID, ExpectedVersion: *request.ExpectedVersion})
		if !a.writeAgentCLIFileError(c, err) {
			c.Status(http.StatusNoContent)
		}
		return
	default:
		err = document.ErrInvalidInput
	}
	if a.writeAgentCLIFileError(c, err) {
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, a.linkShareModel(result))
}
