package app

import (
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"
	artifactstore "github.com/simplexai-labs/linger/apps/teamhub/internal/artifact"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/roomdocument"
)

func (a *App) writeAgentCLIFileError(c *gin.Context, err error) bool {
	if err == nil {
		return false
	}
	code, message, httpStatus := "unavailable", "File operation could not be completed", http.StatusServiceUnavailable
	switch {
	case errors.Is(err, document.ErrLatestProjectionNotReady):
		code, message, httpStatus = "latest_not_ready", "Document latest changed during rendering; retry", http.StatusAccepted
		writeLatestContentCacheHeaders(c)
		c.Header("Retry-After", "1")
	case errors.Is(err, document.ErrVersionConflict):
		code, message, httpStatus = "version_conflict", "Document has a newer version", http.StatusConflict
	case errors.Is(err, document.ErrAgentTreePathConflict):
		code, message, httpStatus = "path_conflict", "One or more Document tree paths already exist", http.StatusConflict
	case errors.Is(err, document.ErrFilePublicationForbidden), errors.Is(err, document.ErrLinkShareForbidden):
		code, message, httpStatus = "forbidden", "Current permissions do not allow this file operation", http.StatusForbidden
	case errors.Is(err, document.ErrNotFound):
		code, message, httpStatus = "not_found", "File or active authority was not found", http.StatusNotFound
	case errors.Is(err, document.ErrInvalidInput):
		code, message, httpStatus = "invalid_input", "File request is invalid", http.StatusBadRequest
		var failure *roomdocument.RuntimeError
		if errors.As(err, &failure) {
			message = failure.Message
		}
	case errors.Is(err, document.ErrIdempotencyConflict):
		code, message, httpStatus = "idempotency_conflict", "Operation ID was reused for different content", http.StatusConflict
	case errors.Is(err, document.ErrConflict):
		code, message, httpStatus = "sharing_conflict", "Sharing changed; retry to read its current policy", http.StatusConflict
	case errors.Is(err, document.ErrAssetQuotaExceeded), errors.Is(err, document.ErrAssetStorageCapacity):
		code, message, httpStatus = "too_large", "Image exceeds the size or storage limit", http.StatusRequestEntityTooLarge
	case errors.Is(err, document.ErrAssetUnavailable), errors.Is(err, document.ErrAssetQuarantined):
		code, message, httpStatus = "asset_unavailable", "Document Asset is unavailable", http.StatusConflict
	case errors.Is(err, document.ErrRecoveryBudgetExceeded), errors.Is(err, artifactstore.ErrTooLarge):
		code, message, httpStatus = "too_large", "File exceeds the size limit", http.StatusRequestEntityTooLarge
	}
	value := gin.H{"code": code, "message": message}
	if code == "latest_not_ready" {
		value["details"] = gin.H{"retry_after_seconds": 1}
	}
	c.JSON(httpStatus, gin.H{"error": value})
	return true
}
