package app

import (
	"net/http"
	"time"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voice"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

func (a *App) listPocketNotes(c *gin.Context) {
	params := contractParams[httpapi.ListPocketNotesParams](c)
	limit := voice.PocketNoteDefaultLimit
	if params.Limit != nil {
		limit = *params.Limit
	}
	var before pgtype.Date
	if params.Cursor != nil {
		day, err := time.Parse(voice.PocketNoteDateLayout, *params.Cursor)
		if err != nil {
			a.writeError(c, http.StatusBadRequest, "INVALID_CURSOR", "Pocket Note cursor is invalid")
			return
		}
		before = pgtype.Date{Time: day, Valid: true}
	}
	if limit < 1 || limit > 200 {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "limit must be between 1 and 200")
		return
	}
	ctx := c.Request.Context()
	tenantID, ownerID, ok := a.pocketNoteOwner(c)
	if !ok {
		return
	}
	page, err := a.voice.ListPocketNotes(ctx, tenantID, ownerID, before, limit)
	if err != nil {
		a.internalError(c, "list Pocket Notes", err)
		return
	}
	c.JSON(http.StatusOK, page)
}

// putTodayPocketNote replaces today's page. Clearing it deletes the row so the
// page list only ever holds days the Human actually wrote on.
func (a *App) putTodayPocketNote(c *gin.Context) {
	var request httpapi.PocketNoteUpdateRequest
	if decodeJSON(c, &request) != nil || utf8.RuneCountInString(request.Text) > voice.PocketNoteMaxRunes {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "text must be a string of at most 20000 characters")
		return
	}
	ctx := c.Request.Context()
	tenantID, ownerID, ok := a.pocketNoteOwner(c)
	if !ok {
		return
	}
	note, err := a.voice.PutTodayPocketNote(ctx, tenantID, ownerID, request.Text)
	if err != nil {
		a.internalError(c, "write Pocket Note", err)
		return
	}
	c.JSON(http.StatusOK, note)
}

// deletePocketNote hides a past day's page. Today's page stays editable, so
// only earlier days can be deleted; what Memory already took in is kept.
func (a *App) deletePocketNote(c *gin.Context) {
	noteDate := c.Param("noteDate")
	day, err := time.Parse(voice.PocketNoteDateLayout, noteDate)
	if err != nil || !day.Before(voice.PocketNoteDay(time.Now())) {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Only a day before today can be deleted")
		return
	}
	tenantID, ownerID, ok := a.pocketNoteOwner(c)
	if !ok {
		return
	}
	err = a.voice.HidePocketNote(c.Request.Context(), tenantID, ownerID, day)
	if err != nil {
		a.internalError(c, "delete Pocket Note", err)
		return
	}
	c.Status(http.StatusNoContent)
}

// pocketNoteOwner returns the Space and Human Actor of the signed-in Human when
// the path names that Space.
func (a *App) pocketNoteOwner(c *gin.Context) (string, string, bool) {
	session := currentPrincipal(c).Session
	if !currentPrincipal(c).inSpace(c.Param("tenantId")) {
		a.writeError(c, http.StatusNotFound, "TENANT_NOT_FOUND", "Tenant membership was not found")
		return "", "", false
	}
	return session.HumanTenantID, session.HumanActorID, true
}
