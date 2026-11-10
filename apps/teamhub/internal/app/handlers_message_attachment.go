package app

import (
	"errors"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	artifactstore "github.com/simplexai-labs/linger/apps/teamhub/internal/artifact"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/collaboration"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/idempotency"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/secretbox"
)

func (a *App) uploadMessageAttachment(c *gin.Context) {
	key, ok := a.requireIdempotencyKey(c)
	if !ok {
		return
	}
	upload, err := a.parseMessageAttachmentUpload(c)
	if err != nil {
		if errors.Is(err, artifactstore.ErrTooLarge) || isMaxBytesError(err) {
			a.writeError(c, http.StatusRequestEntityTooLarge, "PAYLOAD_TOO_LARGE", "message attachment exceeds the configured limit")
		} else {
			a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "message attachment upload is invalid")
		}
		return
	}
	defer upload.Content.Close()
	object, err := a.artifacts.Put(c.Request.Context(), upload.Content)
	if err != nil {
		a.writeArtifactStorageError(c, err)
		return
	}
	keepObject := false
	defer func() {
		if !keepObject {
			if deleteErr := artifactstore.DeleteDetached(c.Request.Context(), a.artifacts, object.Key); deleteErr != nil {
				a.logger.Error("remove uncommitted message attachment", "object_key", object.Key, "error", deleteErr)
			}
		}
	}()
	result, replay, err := a.collaboration.UploadMessageAttachment(c.Request.Context(), currentPrincipal(c).Session.AccountID, c.Param("roomId"), upload, object, key)
	keepObject = collaboration.KeepMessageAttachmentObject(replay, err)
	if errors.Is(err, pgx.ErrNoRows) {
		a.writeError(c, http.StatusNotFound, "ROOM_NOT_FOUND", "room was not found")
		return
	}
	if errors.Is(err, idempotency.ErrConflict) {
		a.writeError(c, http.StatusConflict, "IDEMPOTENCY_KEY_REUSED", "idempotency key was used with different input")
		return
	}
	if errors.Is(err, secretbox.ErrTooLong) {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "message attachment filename and media type are too long")
		return
	}
	if err != nil {
		a.internalError(c, "upload message attachment", err)
		return
	}
	writeResultResponse(c, result)
}

func (a *App) parseMessageAttachmentUpload(c *gin.Context) (collaboration.MessageAttachmentUpload, error) {
	if err := extendUploadReadDeadline(c); err != nil {
		return collaboration.MessageAttachmentUpload{}, err
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, a.cfg.ArtifactMaxBytes+(1<<20))
	if err := c.Request.ParseMultipartForm(a.cfg.ArtifactMaxBytes + (1 << 20)); err != nil {
		return collaboration.MessageAttachmentUpload{}, err
	}
	defer c.Request.MultipartForm.RemoveAll()
	allowed := map[string]bool{"filename": true, "media_type": true}
	for name, values := range c.Request.MultipartForm.Value {
		if !allowed[name] || len(values) != 1 {
			return collaboration.MessageAttachmentUpload{}, collaboration.ErrInvalidMessageAttachment
		}
	}
	for name, files := range c.Request.MultipartForm.File {
		if name != "content" || len(files) != 1 {
			return collaboration.MessageAttachmentUpload{}, collaboration.ErrInvalidMessageAttachment
		}
	}
	filename := strings.TrimSpace(c.PostForm("filename"))
	mediaType := strings.TrimSpace(c.PostForm("media_type"))
	if mediaType == "" {
		mediaType = "application/octet-stream"
	}
	mediaType = collaboration.NormalizeMessageAttachmentMediaType(filename, mediaType)
	if filename == "" || len(filename) > 255 || len(mediaType) > 255 {
		return collaboration.MessageAttachmentUpload{}, collaboration.ErrInvalidMessageAttachment
	}
	file, header, err := c.Request.FormFile("content")
	if err != nil {
		return collaboration.MessageAttachmentUpload{}, err
	}
	if header.Size > a.cfg.ArtifactMaxBytes {
		_ = file.Close()
		return collaboration.MessageAttachmentUpload{}, artifactstore.ErrTooLarge
	}
	return collaboration.MessageAttachmentUpload{Filename: filename, MediaType: mediaType, Content: file}, nil
}

func (a *App) cancelMessageAttachmentUpload(c *gin.Context) {
	err := a.collaboration.CancelMessageAttachmentUpload(c.Request.Context(), currentPrincipal(c).Session.AccountID,
		c.Param("roomId"), c.Param("attachmentUploadId"))
	switch {
	case errors.Is(err, collaboration.ErrAttachmentUploadNotFound):
		a.writeError(c, http.StatusNotFound, "NOT_FOUND", "message attachment upload was not found")
	case errors.Is(err, collaboration.ErrAttachmentUploadUnavailable):
		a.writeError(c, http.StatusConflict, "ATTACHMENT_UPLOAD_UNAVAILABLE", "message attachment upload is unavailable")
	case a.notFoundOrError(c, "cancel message attachment", err):
	default:
		c.Status(http.StatusNoContent)
	}
}
