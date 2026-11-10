package app

import (
	"errors"
	"mime"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	artifactstore "github.com/simplexai-labs/linger/apps/teamhub/internal/artifact"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

func (a *App) planRoomDocumentAsset(c *gin.Context) {
	key, ok := a.requireIdempotencyKey(c)
	if !ok {
		return
	}
	var request httpapi.DocumentAssetUploadRequest
	if decodeJSON(c, &request) != nil {
		return
	}
	result, err := a.documents.PlanAsset(c.Request.Context(), document.PlanAssetInput{
		AccountID: currentPrincipal(c).Session.AccountID, DocumentID: c.Param("documentId"),
		Filename: request.Filename, MediaType: request.MediaType, SizeBytes: request.SizeBytes,
		SHA256: request.Sha256, IdempotencyKey: key,
	})
	if a.writeRoomDocumentAssetError(c, "plan Room Document Asset", err) {
		return
	}
	if result.Replay {
		c.Header("Idempotent-Replay", "true")
	}
	c.Data(http.StatusCreated, "application/json", result.Body)
}

func (a *App) getRoomDocumentAsset(c *gin.Context) {
	asset, err := a.documents.GetAsset(
		c.Request.Context(), currentPrincipal(c).Session.AccountID, c.Param("documentAssetId"),
	)
	if a.writeRoomDocumentAssetError(c, "get Room Document Asset", err) {
		return
	}
	c.JSON(http.StatusOK, asset)
}

func (a *App) uploadRoomDocumentAssetContent(c *gin.Context) {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, a.documents.MaxAssetBytes()+1)
	result, err := a.documents.UploadAsset(c.Request.Context(), document.UploadAssetInput{
		AccountID: currentPrincipal(c).Session.AccountID,
		AssetID:   c.Param("documentAssetId"),
		Contents:  c.Request.Body,
	})
	if a.writeRoomDocumentAssetError(c, "upload Room Document Asset content", err) {
		return
	}
	if result.Replay {
		c.Header("Idempotent-Replay", "true")
	}
	c.Data(http.StatusOK, "application/json", result.Body)
}

func (a *App) downloadRoomDocumentAssetContent(c *gin.Context) {
	content, err := a.documents.OpenAssetContent(
		c.Request.Context(), currentPrincipal(c).Session.AccountID, c.Param("documentAssetId"),
	)
	if a.writeRoomDocumentAssetError(c, "download Room Document Asset content", err) {
		return
	}
	defer content.Reader.Close()
	c.Header("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": content.Asset.Filename}))
	c.Header("X-Content-Type-Options", "nosniff")
	c.DataFromReader(http.StatusOK, content.Asset.SizeBytes, content.Asset.MediaType, content.Reader, map[string]string{
		"Content-Length": strconv.FormatInt(content.Asset.SizeBytes, 10),
	})
}

func (a *App) writeRoomDocumentAssetError(c *gin.Context, action string, err error) bool {
	if err == nil {
		return false
	}
	switch {
	case errors.Is(err, document.ErrInvalidInput), errors.Is(err, document.ErrAssetContentMismatch):
		a.writeError(c, http.StatusUnprocessableEntity, "DOCUMENT_ASSET_INVALID", "Document Asset input failed validation")
	case errors.Is(err, artifactstore.ErrTooLarge), errors.As(err, new(*http.MaxBytesError)):
		a.writeError(c, http.StatusRequestEntityTooLarge, "DOCUMENT_ASSET_TOO_LARGE", "Document Asset exceeds the configured limit")
	case errors.Is(err, document.ErrAssetQuotaExceeded):
		a.writeError(c, http.StatusRequestEntityTooLarge, "DOCUMENT_ASSET_QUOTA_EXCEEDED", "Document Asset quota was exceeded")
	case errors.Is(err, document.ErrAssetStorageCapacity):
		a.writeError(c, http.StatusInsufficientStorage, "DOCUMENT_ASSET_STORAGE_CAPACITY", "Document Asset storage capacity is temporarily unavailable")
	case errors.Is(err, document.ErrAssetUnavailable):
		a.writeError(c, http.StatusConflict, "DOCUMENT_ASSET_UNAVAILABLE", "Document Asset content is not available")
	case errors.Is(err, document.ErrAssetQuarantined):
		a.writeError(c, http.StatusConflict, "DOCUMENT_ASSET_QUARANTINED", "Document Asset content is quarantined")
	case errors.Is(err, document.ErrIdempotencyConflict):
		a.writeError(c, http.StatusConflict, "IDEMPOTENCY_KEY_REUSED", "Idempotency-Key was already used for different Asset input")
	case errors.Is(err, pgx.ErrNoRows), errors.Is(err, document.ErrNotFound):
		a.writeError(c, http.StatusNotFound, "DOCUMENT_ASSET_NOT_FOUND", "Document Asset was not found")
	default:
		a.internalError(c, action, err)
	}
	return true
}
