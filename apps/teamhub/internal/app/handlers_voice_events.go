package app

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voice"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

func (a *App) listVoiceEvents(c *gin.Context) {
	params := contractParams[httpapi.ListVoiceEventsParams](c)
	if !a.requireVoiceMedia(c) {
		return
	}
	cursor := ""
	if params.After != nil {
		cursor = *params.After
	}
	after, err := voice.ParseVoiceEventCursor(c.Param("voiceSessionId"), cursor)
	if err != nil {
		a.writeError(c, http.StatusBadRequest, "INVALID_CURSOR", err.Error())
		return
	}
	page, err := a.voice.ReadVoiceEventPage(c.Request.Context(), currentPrincipal(c).Session, c.Param("voiceSessionId"), after)
	if a.writeVoiceMediaError(c, "read voice events", err) {
		return
	}
	c.JSON(http.StatusOK, page)
}

func (a *App) streamVoiceEvents(c *gin.Context) {
	params := contractParams[httpapi.StreamVoiceEventsParams](c)
	if !a.requireVoiceMedia(c) {
		return
	}
	cursor := ""
	if params.After != nil {
		cursor = *params.After
	}
	if params.LastEventID != nil && *params.LastEventID != "" {
		cursor = *params.LastEventID
	}
	sessionID := c.Param("voiceSessionId")
	after, err := voice.ParseVoiceEventCursor(sessionID, cursor)
	if err != nil {
		a.writeError(c, http.StatusBadRequest, "INVALID_CURSOR", err.Error())
		return
	}
	principal := currentPrincipal(c)
	// Subscribe before reading: a write committed after the first snapshot
	// wakes the stream, including writes on another TeamHub replica.
	subscription := a.broker.Subscribe("voice:" + sessionID)
	defer subscription.Close()
	page, err := a.voice.ReadVoiceEventPage(c.Request.Context(), principal.Session, sessionID, after)
	if a.writeVoiceMediaError(c, "open voice events", err) {
		return
	}
	c.Header("Content-Type", "text/event-stream")
	c.Header("Cache-Control", "no-cache, no-transform")
	c.Header("Connection", "keep-alive")
	c.Header("X-Accel-Buffering", "no")
	c.Status(http.StatusOK)
	response := http.NewResponseController(c.Writer)
	defer func() { _ = response.SetWriteDeadline(time.Time{}) }()
	write := func(name, id string, value any) bool {
		data, marshalErr := json.Marshal(value)
		if marshalErr != nil {
			return false
		}
		_ = response.SetWriteDeadline(time.Now().Add(10 * time.Second))
		if id != "" {
			if _, err := fmt.Fprintf(c.Writer, "id: %s\n", id); err != nil {
				return false
			}
		}
		if _, err := fmt.Fprintf(c.Writer, "event: %s\ndata: %s\n\n", name, data); err != nil {
			return false
		}
		c.Writer.Flush()
		return c.Request.Context().Err() == nil
	}
	revoked := func(err error) bool {
		if errors.Is(err, pgx.ErrNoRows) {
			write("access.revoked", "", struct{}{})
		}
		return false
	}
	// flushEvents writes transcript events after the stream cursor and the
	// session and Capture snapshots that differ from the last ones sent. A
	// voice.changed wake and every heartbeat call it.
	sent := map[string]string{}
	flushEvents := func(initial *httpapi.VoiceEventPage) bool {
		for {
			if initial != nil {
				page = *initial
				initial = nil
			} else {
				page, err = a.voice.ReadVoiceEventPage(c.Request.Context(), principal.Session, sessionID, after)
				if err != nil {
					return revoked(err)
				}
			}
			items := page.Items[:0]
			for _, item := range page.Items {
				key := ""
				switch {
				case item.Capture != nil:
					key = "capture:" + item.Capture.Id
				case item.Session != nil:
					key = "session"
				}
				if key != "" {
					encoded, _ := json.Marshal(item)
					if sent[key] == string(encoded) {
						continue
					}
					sent[key] = string(encoded)
				}
				items = append(items, item)
			}
			page.Items = items
			if len(page.Items) > 0 {
				if !write("voice.events", page.NextCursor, page) {
					return false
				}
				after, _ = voice.ParseVoiceEventCursor(sessionID, page.NextCursor)
			}
			if !page.HasMore {
				return true
			}
			select {
			case <-c.Request.Context().Done():
				return false
			case <-a.streamsDone.Done():
				return false
			default:
			}
		}
	}
	// flushPartial reads only the partial, so speech (a partial wake about
	// every 100 ms) costs one query instead of a snapshot read.
	lastPartial := ""
	var lastPartialAt pgtype.Timestamptz
	flushPartial := func() bool {
		partial, readErr := a.voice.VoiceSessionPartial(c.Request.Context(), principal.Session.AccountID, sessionID)
		if readErr != nil {
			return revoked(readErr)
		}
		lastPartialAt = partial.LatestPartialUpdatedAt
		snapshot := httpapi.VoiceTranscriptEventPage{Items: []httpapi.VoiceTranscriptEvent{}}
		if partial.LatestPartialText.Valid {
			snapshot.PartialTranscript = &partial.LatestPartialText.String
			snapshot.PartialStartOffsetMs = &partial.LatestPartialStartOffsetMs.Int64
			snapshot.PartialEndOffsetMs = &partial.LatestPartialEndOffsetMs.Int64
		}
		encoded, _ := json.Marshal(snapshot)
		if string(encoded) == lastPartial {
			return true
		}
		lastPartial = string(encoded)
		return write("voice.partial", "", snapshot)
	}
	if !flushEvents(&page) || !flushPartial() || !write("voice.ready", "", struct{}{}) {
		return
	}
	// Bounded coalescing: notifications carry no text and stale partial wakes
	// collapse into one latest snapshot without blocking the ASR write path.
	coalesce := time.NewTicker(100 * time.Millisecond)
	defer coalesce.Stop()
	heartbeat := time.NewTicker(min(a.cfg.SSEHeartbeatInterval, 5*time.Second))
	defer heartbeat.Stop()
	expiry := time.NewTimer(max(time.Millisecond, time.Until(principal.Session.ExpiresAt.Time)))
	defer expiry.Stop()
	eventsDirty, partialDirty := false, false
	for {
		select {
		case <-c.Request.Context().Done():
			return
		case <-a.streamsDone.Done():
			return
		case <-subscription.Done():
			return
		case event := <-subscription.Events():
			if event.Kind == "voice.partial" {
				partialDirty = true
			} else {
				eventsDirty = true
			}
		case <-coalesce.C:
			if eventsDirty {
				eventsDirty = false
				if !flushEvents(nil) {
					return
				}
			}
			if partialDirty {
				partialDirty = false
				if !flushPartial() {
					return
				}
			}
		case <-heartbeat.C:
			// Revalidate the login session and membership, and recover
			// notifications missed during a listener outage: the snapshot
			// sends only what changed, the partial only when it moved.
			if !a.ensureStreamSession(c, c.Writer, principal.Token) {
				return
			}
			partialAt, stateErr := a.voice.VoiceStreamState(c.Request.Context(), store.GetVoiceStreamStateParams{
				AccountID: principal.Session.AccountID, VoiceSessionID: sessionID, AuthSessionID: principal.Session.ID,
			})
			if stateErr != nil {
				revoked(stateErr)
				return
			}
			eventsDirty = false
			if !flushEvents(nil) {
				return
			}
			if partialAt.Valid != lastPartialAt.Valid || !partialAt.Time.Equal(lastPartialAt.Time) {
				partialDirty = false
				if !flushPartial() {
					return
				}
			}
			if !write("voice.ready", "", struct{}{}) {
				return
			}
		case <-expiry.C:
			if !a.resetStreamSessionExpiry(c, c.Writer, principal.Token, expiry) {
				return
			}
		}
	}
}
