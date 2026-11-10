package app

import (
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/memoryclient"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

func (a *App) getPersonalWikiPreview(c *gin.Context) {
	wiki, err := a.currentPersonalWiki(c)
	if a.writePersonalWikiError(c, "get Personal Wiki", err) {
		return
	}
	params := contractParams[httpapi.GetPersonalWikiPreviewParams](c)
	pages, err := a.documents.PersonalWikiPreview(c.Request.Context(), wiki, params.RefreshId)
	if a.writePersonalWikiError(c, "get Wiki preview", err) {
		return
	}
	c.Header("Cache-Control", "private, no-store")
	c.JSON(http.StatusOK, pages)
}

func (a *App) getPersonalWiki(c *gin.Context) {
	wiki, err := a.currentPersonalWiki(c)
	if a.writePersonalWikiError(c, "get Personal Wiki", err) {
		return
	}
	c.JSON(http.StatusOK, personalWikiModel(wiki))
}

func (a *App) getPersonalKnowledgeGraphVisualization(c *gin.Context) {
	wiki, err := a.currentPersonalWiki(c)
	if a.writePersonalWikiError(c, "authorize Personal Knowledge Graph", err) {
		return
	}
	if a.memory == nil {
		a.writeError(c, http.StatusServiceUnavailable, "GRAPH_UNAVAILABLE", "Personal Knowledge Graph is unavailable")
		return
	}
	html, err := a.memory.GetPersonalKnowledgeGraphVisualization(
		c.Request.Context(),
		wiki.TenantID,
		wiki.OwnerActorID,
	)
	if errors.Is(err, memoryclient.ErrVisualizationNotFound) {
		a.writeError(c, http.StatusNotFound, "GRAPH_NOT_FOUND", "Personal Knowledge Graph has not been generated yet")
		return
	}
	if err != nil {
		requestID, _ := c.Get("request_id")
		a.logger.Error("get Personal Knowledge Graph visualization", "request_id", requestID, "error", err)
		a.writeError(c, http.StatusServiceUnavailable, "GRAPH_UNAVAILABLE", "Personal Knowledge Graph is unavailable")
		return
	}
	c.Header("Content-Security-Policy", "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'")
	c.Header("X-Content-Type-Options", "nosniff")
	c.Data(http.StatusOK, "text/html; charset=utf-8", html)
}

func (a *App) listPersonalMemoryEntries(c *gin.Context) {
	params := contractParams[httpapi.ListPersonalMemoryEntriesParams](c)
	wiki, err := a.currentPersonalWiki(c)
	if a.writePersonalWikiError(c, "authorize Personal Memory", err) {
		return
	}
	if a.memory == nil {
		a.writeError(c, http.StatusServiceUnavailable, "MEMORY_UNAVAILABLE", "Personal Memory is unavailable")
		return
	}
	var kind, cursor *string
	if params.Kind != nil {
		value := string(*params.Kind)
		kind = &value
	}
	if params.Cursor != nil {
		value := *params.Cursor
		cursor = &value
	}
	var limit *int
	if params.Limit != nil {
		value := *params.Limit
		limit = &value
	}
	page, err := a.memory.ListPersonalMemoryEntries(c.Request.Context(), wiki.TenantID, wiki.OwnerActorID, kind, cursor, limit)
	if errors.Is(err, memoryclient.ErrMemoryEntryNotFound) {
		a.writeError(c, http.StatusNotFound, "MEMORY_NOT_FOUND", "Personal Memory was not found")
		return
	}
	if err != nil {
		a.internalError(c, "list Personal Memory entries", err)
		return
	}
	c.JSON(http.StatusOK, personalMemoryEntryPageModel(page))
}

// hideMeeting removes a meeting from the caller's own Meetings only. The
// Capture, its Documents and what Memory already took in are kept.
func (a *App) hideMeeting(c *gin.Context) {
	captureSessionID := c.Param("captureSessionId")
	wiki, err := a.currentPersonalWiki(c)
	if a.writePersonalWikiError(c, "authorize meeting hide", err) {
		return
	}
	found, err := a.voice.HideMeeting(c.Request.Context(), wiki.TenantID, captureSessionID)
	if err != nil {
		a.internalError(c, "hide meeting", err)
		return
	}
	if !found {
		a.writeError(c, http.StatusNotFound, "MEETING_NOT_FOUND", "Meeting was not found")
		return
	}
	c.Status(http.StatusNoContent)
}

func (a *App) getPersonalMemoryEntry(c *gin.Context) {
	wiki, err := a.currentPersonalWiki(c)
	if a.writePersonalWikiError(c, "authorize Personal Memory", err) {
		return
	}
	if a.memory == nil {
		a.writeError(c, http.StatusServiceUnavailable, "MEMORY_UNAVAILABLE", "Personal Memory is unavailable")
		return
	}
	entry, err := a.memory.GetPersonalMemoryEntry(c.Request.Context(), wiki.TenantID, wiki.OwnerActorID, c.Param("entryId"))
	if errors.Is(err, memoryclient.ErrMemoryEntryNotFound) {
		a.writeError(c, http.StatusNotFound, "MEMORY_NOT_FOUND", "Personal Memory entry was not found")
		return
	}
	if err != nil {
		a.internalError(c, "get Personal Memory entry", err)
		return
	}
	c.JSON(http.StatusOK, personalMemoryEntryModel(entry))
}

func personalMemoryEntryPageModel(page memoryclient.MemoryEntryPage) httpapi.MemoryEntryPage {
	model := httpapi.MemoryEntryPage{Items: make([]httpapi.MemoryEntry, 0, len(page.Items))}
	for _, entry := range page.Items {
		model.Items = append(model.Items, personalMemoryEntryModel(entry))
	}
	if page.NextCursor != nil {
		value := *page.NextCursor
		model.NextCursor = &value
	}
	return model
}

func personalMemoryEntryModel(entry memoryclient.MemoryEntry) httpapi.MemoryEntry {
	model := httpapi.MemoryEntry{
		Content: entry.Content,
		Date:    entry.Date,
		Id:      entry.Id,
		Kind:    httpapi.MemoryEntryKind(entry.Kind),

		Path:      entry.Path,
		Summary:   entry.Summary,
		Title:     entry.Title,
		UpdatedAt: entry.UpdatedAt,
	}
	if entry.Meeting != nil {
		model.Meeting = &httpapi.MeetingFiles{
			CaptureId:            entry.Meeting.CaptureId,
			StartedAt:            entry.Meeting.StartedAt,
			RecordingDocumentId:  entry.Meeting.RecordingDocumentId,
			RecordingVersionId:   entry.Meeting.RecordingVersionId,
			RecordingFilename:    entry.Meeting.RecordingFilename,
			TranscriptDocumentId: entry.Meeting.TranscriptDocumentId,
			TranscriptVersionId:  entry.Meeting.TranscriptVersionId,
			SummaryReady:         entry.Meeting.SummaryReady,
			SummaryPath:          entry.Meeting.SummaryPath,
		}
	}
	return model
}

// currentPersonalWiki reads the signed-in Human's Wiki in the path's Tenant;
// Memory routes read it to authorize the Human and name the owner.
func (a *App) currentPersonalWiki(c *gin.Context) (document.PersonalWiki, error) {
	return a.documents.GetPersonalWiki(c.Request.Context(), currentPrincipal(c).Session.AccountID,
		c.Param("tenantId"))
}

func personalWikiModel(wiki document.PersonalWiki) httpapi.PersonalWiki {
	model := httpapi.PersonalWiki{
		TenantId: wiki.TenantID, OwnerActorId: wiki.OwnerActorID,
		PublishedGeneration: wiki.PublishedGeneration, State: httpapi.PersonalWikiState(wiki.State),
	}
	if wiki.ID != "" {
		model.Id, model.CreatedAt, model.UpdatedAt = &wiki.ID, &wiki.CreatedAt, &wiki.UpdatedAt
	}
	if wiki.PreviewRevision > 0 {
		model.PreviewRevision = &wiki.PreviewRevision
	}
	if wiki.LatestRefreshID != "" {
		model.LatestRefreshId = &wiki.LatestRefreshID
	}
	if wiki.CurrentRevisionID != "" {
		model.CurrentRevisionId = &wiki.CurrentRevisionID
	}
	return model
}

func (a *App) writePersonalWikiError(c *gin.Context, action string, err error) bool {
	if err == nil {
		return false
	}
	switch {
	case errors.Is(err, document.ErrInvalidInput):
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Personal Wiki request is invalid")
	case errors.Is(err, document.ErrNotFound):
		a.writeError(c, http.StatusNotFound, "NOT_FOUND", "Personal Wiki resource was not found")
	default:
		a.internalError(c, action, err)
	}
	return true
}
