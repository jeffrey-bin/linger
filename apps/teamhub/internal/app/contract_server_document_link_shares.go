package app

import (
	"encoding/base64"
	"errors"
	"net/http"
	"net/url"
	"strconv"

	"github.com/gin-gonic/gin"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

func (a *App) downloadSharedDocument(c *gin.Context) {
	var request httpapi.ResolveDocumentLinkShare
	if err := decodeStrictJSON(http.MaxBytesReader(c.Writer, c.Request.Body, 4096), &request, "invalid link"); err != nil {
		a.writeLinkShareError(c, document.ErrInvalidInput)
		return
	}
	result, err := a.documents.DownloadLinkFile(c.Request.Context(), request.Token)
	if a.writeAgentCLIFileError(c, err) {
		return
	}
	c.Header("X-Document-Id", result.DocumentID)
	c.Header("X-Document-Version-Id", result.VersionID)
	c.Header("X-Document-Read-Only", strconv.FormatBool(result.ReadOnly))
	c.Header("X-Content-Sha256", result.SHA256)
	c.Header("X-Document-Filename", base64.RawURLEncoding.EncodeToString([]byte(result.Filename)))
	c.Header("X-Document-Representation-Format", result.RepresentationFormat)
	writeLatestContentCacheHeaders(c)
	a.writeLatestObjectContent(c, immutableObjectContent{filename: result.Filename, mediaType: result.MediaType, objectKey: result.ObjectKey, sha256: result.SHA256, sizeBytes: result.SizeBytes})
}

func (a *App) getDocumentLinkShare(c *gin.Context) {
	documentID := c.Param("documentId")
	result, err := a.documents.GetLinkShare(c.Request.Context(), document.LinkSharePrincipal{AccountID: currentPrincipal(c).Session.AccountID}, documentID)
	if a.writeLinkShareError(c, err) {
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, a.linkShareModel(result))
}
func (a *App) setDocumentLinkShare(c *gin.Context) {
	documentID := c.Param("documentId")
	var request httpapi.SetDocumentLinkShare
	if err := decodeStrictJSON(http.MaxBytesReader(c.Writer, c.Request.Body, 4096), &request, "invalid link policy"); err != nil {
		a.writeLinkShareError(c, document.ErrInvalidInput)
		return
	}
	result, err := a.documents.SetLinkShare(c.Request.Context(), document.SetLinkShareInput{
		Principal: document.LinkSharePrincipal{AccountID: currentPrincipal(c).Session.AccountID}, DocumentID: documentID,
		Role: string(request.Role), ExpectedVersion: request.ExpectedVersion, Reset: request.Reset != nil && *request.Reset,
	})
	if a.writeLinkShareError(c, err) {
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, a.linkShareModel(result))
}
func (a *App) revokeDocumentLinkShare(c *gin.Context) {
	documentID := c.Param("documentId")
	var request httpapi.RevokeDocumentLinkShare
	if err := decodeStrictJSON(http.MaxBytesReader(c.Writer, c.Request.Body, 4096), &request, "invalid link revocation"); err != nil {
		a.writeLinkShareError(c, document.ErrInvalidInput)
		return
	}
	if a.writeLinkShareError(c, a.documents.RevokeLinkShare(c.Request.Context(), document.RevokeLinkShareInput{
		Principal: document.LinkSharePrincipal{AccountID: currentPrincipal(c).Session.AccountID}, DocumentID: documentID, ExpectedVersion: request.ExpectedVersion,
	})) {
		return
	}
	c.Status(http.StatusNoContent)
}
func (a *App) resolveDocumentLinkShare(c *gin.Context) {
	var request httpapi.ResolveDocumentLinkShare
	if err := decodeStrictJSON(http.MaxBytesReader(c.Writer, c.Request.Body, 4096), &request, "invalid link"); err != nil {
		a.writeLinkShareError(c, document.ErrInvalidInput)
		return
	}
	result, err := a.documents.ResolveLinkShare(c.Request.Context(), request.Token)
	if a.writeLinkShareError(c, err) {
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, httpapi.DocumentLinkAccess{LinkId: result.LinkID, TenantId: result.TenantID, DocumentId: result.DocumentID, Role: httpapi.DocumentLinkAccessRole(result.Role), Version: result.Version})
}
func (a *App) linkShareModel(value document.LinkShare) httpapi.DocumentLinkShare {
	result := httpapi.DocumentLinkShare{Id: value.ID, DocumentId: value.DocumentID, Role: httpapi.DocumentLinkShareRole(value.Role), Status: httpapi.DocumentLinkShareStatus(value.Status), Version: value.Version}
	if value.Token != "" {
		result.Token = &value.Token
		if target, err := url.Parse(a.cfg.PublicWebURL + "/shared-documents"); err == nil {
			target.Fragment = value.Token
			linkURL := target.String()
			result.Url = &linkURL
		}
	}
	return result
}
func (a *App) writeLinkShareError(c *gin.Context, err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, document.ErrLinkShareForbidden) {
		a.writeError(c, http.StatusForbidden, "FORBIDDEN", "Only an Owner or Manager can manage link sharing")
		return true
	}
	return a.writeUnifiedDocumentError(c, "manage Document link sharing", err)
}
