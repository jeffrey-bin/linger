package app

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"path"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
	"github.com/simplexai-labs/linger/contracts-go/teamhubinternal"
)

func (a *App) getPersonalWikiDocumentRevision(c *gin.Context) {
	actorID := c.Param("actorId")
	revision, err := a.documents.GetCurrentWikiDocumentRevision(c.Request.Context(), actorID)
	if a.writeWikiDocumentQueryError(c, "get current Personal Wiki Document Revision", err) {
		return
	}
	pages := make([]teamhubinternal.PersonalWikiDocumentPage, 0, len(revision.Pages))
	for _, page := range revision.Pages {
		pages = append(pages, teamhubinternal.PersonalWikiDocumentPage{
			PageKey: page.PageKey, DocumentId: page.DocumentID,
			DocumentVersionId: page.DocumentVersionID,
			MediaType:         page.MediaType, SizeBytes: page.SizeBytes, Sha256: page.SHA256,
		})
	}
	state := teamhubinternal.PersonalWikiDocumentRevisionWikiState(revision.State)
	representation := teamhubinternal.PersonalWikiDocumentRevision{
		WikiRevisionId: revision.ID, PublishedAt: revision.PublishedAt, Pages: pages,
		IsCurrent: &revision.IsCurrent, WikiState: &state,
	}
	body, err := json.Marshal(representation)
	if err != nil {
		a.internalError(c, "serialize Wiki representation", err)
		return
	}
	digest := sha256.Sum256(body)
	etag := `"` + hex.EncodeToString(digest[:]) + `"`
	c.Header("ETag", etag)
	c.Header("Cache-Control", "private, no-cache")
	if matchesIfNoneMatch(c.GetHeader("If-None-Match"), etag) {
		c.Status(http.StatusNotModified)
		return
	}
	c.Data(http.StatusOK, "application/json; charset=utf-8", body)
}

func (a *App) downloadPersonalWikiDocumentVersion(c *gin.Context) {
	actorID := c.Param("actorId")
	documentID := c.Param("documentId")
	documentVersionID := c.Param("documentVersionId")
	wikiRevisionID := c.Param("wikiRevisionId")
	revision, err := a.documents.GetCurrentWikiDocumentRevision(c.Request.Context(), actorID)
	if a.writeWikiDocumentQueryError(c, "authorize Personal Wiki Document Version", err) {
		return
	}
	var selected *document.WikiDocumentPage
	if revision.ID == wikiRevisionID {
		for index := range revision.Pages {
			page := &revision.Pages[index]
			if page.DocumentID == documentID && page.DocumentVersionID == documentVersionID {
				selected = page
				break
			}
		}
	}
	if selected == nil {
		a.writeError(c, http.StatusNotFound, "NOT_FOUND", "Personal Wiki Document Version was not found")
		return
	}
	content, err := a.documents.OpenWikiDocumentVersion(c.Request.Context(), actorID,
		wikiRevisionID, documentID, documentVersionID)
	if a.writeWikiDocumentQueryError(c, "open Personal Wiki Document Version", err) {
		return
	}
	defer content.Close()
	c.Header("ETag", `"`+selected.SHA256+`"`)
	c.Header("Content-Type", selected.MediaType)
	c.Header("Content-Disposition", fmt.Sprintf(`attachment; filename=%q`,
		strings.ReplaceAll(path.Base(selected.PageKey), `"`, "")))
	c.Header("Content-Length", fmt.Sprintf("%d", selected.SizeBytes))
	c.Status(http.StatusOK)
	_, _ = io.Copy(c.Writer, content)
}

func (a *App) fetchSession(c *gin.Context) {
	documentVersionID := c.Param("documentVersionId")
	tenantID := c.Param("tenantId")
	content, err := a.documents.GetTenantVersionContent(
		c.Request.Context(), tenantID, documentVersionID,
	)
	if a.writeWikiDocumentQueryError(c, "resolve Memory Document Version", err) {
		return
	}
	object, err := a.artifacts.Open(c.Request.Context(), content.ObjectKey)
	if err != nil {
		err = errors.Join(document.ErrObjectStoreUnavailable, err)
	}
	if a.writeWikiDocumentQueryError(c, "open Memory Document Version", err) {
		return
	}
	defer object.Close()
	c.Header("ETag", `"`+content.Version.SHA256+`"`)
	c.Header("X-Content-SHA256", content.Version.SHA256)
	c.Header("Content-Type", content.Version.MediaType)
	c.Header("Content-Disposition", fmt.Sprintf(`attachment; filename=%q`,
		strings.ReplaceAll(path.Base(content.Version.Filename), `"`, "")))
	c.Header("Content-Length", fmt.Sprintf("%d", content.Version.SizeBytes))
	c.Status(http.StatusOK)
	if _, err := io.Copy(c.Writer, object); err != nil {
		a.logger.Error("stream Memory Document Version", "error", err)
	}
}

// requestMemoryWikiRefresh admits Memory's nightly refresh of the Human's
// Wiki, or with a capture ID the refresh of one meeting; TeamHub reads the
// Sessions from the index.
func (a *App) requestMemoryWikiRefresh(c *gin.Context) {
	actorID := c.Param("actorId")
	var request teamhubinternal.MemoryWikiRefreshRequest
	if err := decodeStrictJSON(http.MaxBytesReader(c.Writer, c.Request.Body, 1<<20), &request, "request body must contain one JSON object"); err != nil ||
		request.TenantId == "" || request.Date.IsZero() {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Memory Wiki refresh request is invalid")
		return
	}
	input := document.RequestMemoryWikiRefreshInput{
		TenantID: request.TenantId, OwnerActorID: actorID, Date: request.Date.String(),
	}
	if request.CaptureId != nil {
		input.CaptureID = *request.CaptureId
	}
	result, err := a.documents.RequestMemoryWikiRefresh(c.Request.Context(), input)
	if a.writeMemoryWikiRefreshError(c, "request Memory Wiki refresh", err) {
		return
	}
	refresh := result.Refresh
	response := teamhubinternal.MemoryWikiRefreshResponse{
		RefreshStatus: teamhubinternal.MemoryWikiRefreshResponseRefreshStatus(refresh.Status),
		WikiId:        result.WikiID,
	}
	if refresh.ID != "" {
		refreshID := refresh.ID
		response.RefreshId = &refreshID
	}
	status := http.StatusAccepted
	if refresh.Status == document.WikiRefreshAlreadyLatest || refresh.Status == document.WikiRefreshNoSources {
		status = http.StatusOK
	}
	c.JSON(status, response)
}

func (a *App) writeMemoryWikiRefreshError(c *gin.Context, action string, err error) bool {
	if err == nil {
		return false
	}
	var oversizedRefresh *document.WikiRefreshTooLargeError
	switch {
	case errors.As(err, &oversizedRefresh):
		a.writeError(c, http.StatusBadRequest, "WIKI_REFRESH_TOO_LARGE", oversizedRefresh.Error())
	case errors.Is(err, document.ErrInvalidInput):
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Memory Wiki refresh request is invalid")
	case errors.Is(err, document.ErrNotFound):
		a.writeError(c, http.StatusNotFound, "NOT_FOUND", "Memory Wiki owner was not found")
	case errors.Is(err, document.ErrVersionConflict), errors.Is(err, document.ErrIdempotencyConflict):
		a.writeError(c, http.StatusConflict, "CONFLICT", "Memory Wiki refresh conflicts with current state")
	case errors.Is(err, document.ErrObjectStoreUnavailable), errors.Is(err, document.ErrRuntimeUnavailable):
		a.writeError(c, http.StatusServiceUnavailable, "SERVICE_UNAVAILABLE", "Memory Wiki refresh is unavailable")
	default:
		a.internalError(c, action, err)
	}
	return true
}

func (a *App) writeWikiDocumentQueryError(
	c *gin.Context,
	action string,
	err error,
) bool {
	if err == nil {
		return false
	}
	switch {
	case errors.Is(err, document.ErrInvalidInput):
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Personal Wiki Document request is invalid")
	case errors.Is(err, document.ErrWikiGenerationFailed):
		a.writeError(c, http.StatusConflict, "WIKI_GENERATION_FAILED", "Personal Wiki generation failed")
	case errors.Is(err, document.ErrNotFound), errors.Is(err, document.ErrRevisionUnavailable):
		a.writeError(c, http.StatusNotFound, "NOT_FOUND", "Personal Wiki Document resource was not found")
	case errors.Is(err, document.ErrObjectStoreUnavailable), errors.Is(err, document.ErrRuntimeUnavailable):
		a.writeError(c, http.StatusServiceUnavailable, "SERVICE_UNAVAILABLE", "Personal Wiki Document content is unavailable")
	default:
		a.internalError(c, action, err)
	}
	return true
}

// If-None-Match uses weak comparison for GET, including lists and wildcard.
func matchesIfNoneMatch(header, etag string) bool {
	for _, candidate := range strings.Split(header, ",") {
		candidate = strings.TrimSpace(candidate)
		if candidate == "*" || strings.TrimPrefix(candidate, "W/") == etag {
			return true
		}
	}
	return false
}
