package app

import (
	"errors"
	"mime"
	"net/http"
	"path"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

const documentPreviewCSP = "sandbox allow-scripts; default-src 'none'; script-src 'self' 'unsafe-inline' https: data: blob:; style-src 'self' 'unsafe-inline' https:; img-src 'self' data: blob: https:; font-src 'self' data: https:; media-src 'self' blob: https:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'"

func (a *App) createDocumentPreviewSession(c *gin.Context) {
	link, err := a.documentPreviews.Create(
		c.Request.Context(), currentPrincipal(c).Session.AccountID, c.Param("documentVersionId"),
	)
	switch {
	case errors.Is(err, document.ErrPreviewNotFound):
		a.writeError(c, http.StatusNotFound, "NOT_FOUND", "Document Version was not found")
		return
	case errors.Is(err, document.ErrInvalidPath):
		a.writeError(c, http.StatusConflict, "DOCUMENT_PREVIEW_INVALID_PATH", "Document preview file name is an unsupported path")
		return
	case err != nil:
		a.internalError(c, "create Document preview link", err)
		return
	}
	c.JSON(http.StatusCreated, httpapi.DocumentPreviewSession{
		PreviewUrl: link.PreviewURL, ExpiresAt: link.ExpiresAt,
	})
}

func (a *App) serveDocumentPreview(c *gin.Context) {
	file, err := a.documentPreviews.Resolve(c.Request.Context(), c.Param("token"), c.Param("previewPath"))
	if err != nil {
		c.Status(http.StatusNotFound)
		return
	}
	a.writeImmutableObjectContentWithHeaders(c, immutableObjectContent{
		filename: file.Filename, mediaType: file.MediaType, objectKey: file.ObjectKey,
		sha256: file.SHA256, sizeBytes: file.SizeBytes,
	}, writeDocumentPreviewHeaders)
}

func (a *App) headDocumentPreview(c *gin.Context) {
	file, err := a.documentPreviews.Resolve(c.Request.Context(), c.Param("token"), c.Param("previewPath"))
	if err != nil {
		c.Status(http.StatusNotFound)
		return
	}
	writeDocumentPreviewHeaders(c, immutableObjectContent{
		filename: file.Filename, mediaType: file.MediaType, objectKey: file.ObjectKey,
		sha256: file.SHA256, sizeBytes: file.SizeBytes,
	})
	c.Status(http.StatusOK)
}

func writeDocumentPreviewHeaders(c *gin.Context, content immutableObjectContent) {
	disposition := mime.FormatMediaType("inline", map[string]string{"filename": content.filename})
	if disposition == "" {
		disposition = "inline"
	}
	c.Header("Accept-Ranges", "bytes")
	c.Header("ETag", `"`+content.sha256+`"`)
	previewMediaType := content.mediaType
	if mediaType, params, err := mime.ParseMediaType(previewMediaType); err == nil {
		// Match the Web preview policy for generic HTML uploads without changing downloads.
		extension := strings.ToLower(path.Ext(content.filename))
		if mediaType == "application/octet-stream" && (extension == ".html" || extension == ".htm") {
			mediaType = "text/html"
		}
		if mediaType == "text/html" {
			// HTML fragments may have neither a BOM nor an encoding declaration.
			if params["charset"] == "" {
				params["charset"] = "utf-8"
			}
			previewMediaType = mime.FormatMediaType(mediaType, params)
		}
	}
	c.Header("Content-Type", previewMediaType)
	c.Header("Content-Disposition", disposition)
	c.Header("Content-Length", strconv.FormatInt(content.sizeBytes, 10))
	c.Header("Content-Security-Policy", documentPreviewCSP)
	c.Header("Cache-Control", "private, no-store")
	c.Header("Access-Control-Allow-Origin", "null")
	c.Header("Cross-Origin-Resource-Policy", "cross-origin")
	c.Header("Permissions-Policy", "camera=(), microphone=(), geolocation=(), display-capture=(), payment=(), usb=()")
	c.Header("Referrer-Policy", "no-referrer")
	c.Header("X-Content-Type-Options", "nosniff")
}
