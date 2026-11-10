package app

import (
	"encoding/base64"
	"io"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
	teamhubagentapi "github.com/simplexai-labs/linger/contracts-go/teamhubagentapi"
)

// Agents upload an image or a file as an Asset of a native Document they can edit,
// then place it with an image or file edit through document-semantic-mutations.
func (a *App) publicUploadAgentCLIDocumentAsset(c *gin.Context) {
	documentID := c.Param("documentId")
	params := contractParams[teamhubagentapi.PublicUploadAgentCLIDocumentAssetParams](c)
	p, ok := a.authenticatePublicAgentFile(c)
	if !ok {
		return
	}
	result, err := a.documents.CreateAgentAsset(c.Request.Context(), document.CreateAgentAssetInput{
		TenantID: p.TenantID, AgentID: p.AgentID, DocumentID: documentID,
		Filename: params.Filename, OperationID: params.OperationId,
		Contents: http.MaxBytesReader(c.Writer, c.Request.Body, document.MaxAgentAssetBytes+1),
	})
	if a.writeAgentCLIFileError(c, err) {
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"asset_id": result.Asset.ID, "media_type": result.Asset.MediaType,
		"size_bytes": result.Asset.SizeBytes, "sha256": result.Asset.SHA256, "replayed": result.Replayed,
	})
}

func (a *App) publicDownloadAgentCLIDocumentAsset(c *gin.Context) {
	assetID := c.Param("assetId")
	documentID := c.Param("documentId")
	p, ok := a.authenticatePublicAgentFile(c)
	if !ok {
		return
	}
	content, err := a.documents.OpenAgentAssetContent(c.Request.Context(), p.TenantID, p.AgentID, documentID, assetID)
	if a.writeAgentCLIFileError(c, err) {
		return
	}
	defer func() { _ = content.Reader.Close() }()
	c.Header("X-Content-Sha256", content.Asset.SHA256)
	c.Header("X-Document-Filename", base64.RawURLEncoding.EncodeToString([]byte(content.Asset.Filename)))
	c.Status(http.StatusOK)
	c.Header("Content-Type", "application/octet-stream")
	_, _ = io.Copy(c.Writer, content.Reader)
}
