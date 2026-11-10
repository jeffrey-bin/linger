package app

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/realtime"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

// maxEventStreamRoomCursors bounds the per-wake Room reread; a client keeps
// cursors only for the Rooms it displays.
const maxEventStreamRoomCursors = 50

var roomCursorPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}:[0-9]{1,19}$`)

type resourceInvalidatedEvent struct {
	TenantID string `json:"tenant_id"`
	Resource string `json:"resource"`
	ID       string `json:"id"`
	RoomSeq  int64  `json:"room_seq,omitempty"`
}

// parseRoomCursors reads roomId:room_seq values. A repeated Room keeps its
// lowest cursor, so nothing the client has not applied is skipped.
func parseRoomCursors(values []string) (map[string]int64, bool) {
	if len(values) > maxEventStreamRoomCursors {
		return nil, false
	}
	cursors := make(map[string]int64, len(values))
	for _, value := range values {
		if !roomCursorPattern.MatchString(value) {
			return nil, false
		}
		roomID, rawSeq, _ := strings.Cut(value, ":")
		seq, err := strconv.ParseInt(rawSeq, 10, 64)
		if err != nil {
			return nil, false
		}
		if current, found := cursors[roomID]; !found || seq < current {
			cursors[roomID] = seq
		}
	}
	return cursors, true
}

// humanWakeBurst is one drained burst of HumanEventsTopic wakes, split by what
// the stream does with each.
type humanWakeBurst struct {
	// reconcile: hints may have been dropped; reread every cursor Room and resync.
	reconcile bool
	// cursorRooms have a Room Event past their cursor and are reread from PostgreSQL.
	cursorRooms []string
	// otherRooms maps each Room without a cursor to the highest room_seq woken.
	otherRooms map[string]int64
	// hints are Tenant invalidations, one per resource and ID.
	hints []realtime.Invalidation
}

func classifyHumanWakes(wakes []realtime.Event, cursors map[string]int64) humanWakeBurst {
	burst := humanWakeBurst{otherRooms: make(map[string]int64)}
	hintIndex := make(map[string]int)
	for _, wake := range wakes {
		if wake.Kind == realtime.ReconcileKind {
			burst.reconcile = true
			continue
		}
		if roomID, found := strings.CutPrefix(wake.Topic, "room:"); found && wake.Kind == "room.event" {
			if cursor, tracked := cursors[roomID]; tracked {
				if wake.Sequence > cursor && !slices.Contains(burst.cursorRooms, roomID) {
					burst.cursorRooms = append(burst.cursorRooms, roomID)
				}
			} else if wake.Sequence > burst.otherRooms[roomID] {
				burst.otherRooms[roomID] = wake.Sequence
			}
			continue
		}
		hint, ok := realtime.InvalidationFromEvent(wake)
		if !ok {
			continue
		}
		key := hint.Resource + "\x00" + hint.ID
		if index, seen := hintIndex[key]; seen {
			burst.hints[index].RoomSeq = max(burst.hints[index].RoomSeq, hint.RoomSeq)
			continue
		}
		hintIndex[key] = len(burst.hints)
		burst.hints = append(burst.hints, hint)
	}
	return burst
}

// humanEventStream is the state of one /v0/events connection.
type humanEventStream struct {
	app       *App
	c         *gin.Context
	flusher   http.Flusher
	accountID string
	// tenantID is the Human's Space, the only Tenant whose hints it forwards.
	tenantID string
	cursors  map[string]int64
	// roomTenants caches each Room's Tenant; a Room never changes Tenant.
	roomTenants map[string]string
}

// streamEvents is the browser's single business SSE.
func (a *App) streamEvents(c *gin.Context) {
	var rawCursors []string
	if room := contractParams[httpapi.StreamEventsParams](c).Room; room != nil {
		rawCursors = *room
	}
	cursors, ok := parseRoomCursors(rawCursors)
	if !ok {
		a.writeError(c, http.StatusBadRequest, "INVALID_ROOM_CURSOR",
			fmt.Sprintf("room must be up to %d roomId:room_seq values", maxEventStreamRoomCursors))
		return
	}
	principal := currentPrincipal(c)
	// Subscribe before the initial replay so a concurrent commit is either in
	// the replay or observed as a later wake.
	subscription := a.broker.Subscribe(realtime.HumanEventsTopic)
	defer subscription.Close()
	c.Header("Content-Type", "text/event-stream")
	c.Header("Cache-Control", "no-cache")
	c.Header("Connection", "keep-alive")
	c.Header("X-Accel-Buffering", "no")
	c.Status(http.StatusOK)
	flusher, ok := c.Writer.(http.Flusher)
	if !ok {
		a.internalError(c, "stream events", errors.New("response writer does not support flushing"))
		return
	}
	if _, err := fmt.Fprint(c.Writer, ": connected\n\n"); err != nil {
		return
	}
	flusher.Flush()
	if !a.ensureStreamSession(c, flusher, principal.Token) {
		return
	}
	stream := &humanEventStream{
		app: a, c: c, flusher: flusher, accountID: principal.Session.AccountID,
		tenantID: principal.Session.HumanTenantID, cursors: cursors, roomTenants: make(map[string]string),
	}
	if !stream.syncCursorRooms(stream.cursorRoomIDs()) || !stream.writeResync("connected") {
		return
	}

	heartbeat := time.NewTicker(a.cfg.SSEHeartbeatInterval)
	defer heartbeat.Stop()
	expiresIn := time.Until(principal.Session.ExpiresAt.Time)
	if expiresIn < 0 {
		expiresIn = 0
	}
	expiry := time.NewTimer(expiresIn)
	defer expiry.Stop()
	for {
		select {
		case <-c.Request.Context().Done():
			return
		case <-a.streamsDone.Done():
			return
		case <-subscription.Done():
			return
		case wake := <-subscription.Events():
			if !a.ensureStreamSession(c, flusher, principal.Token) ||
				!stream.apply(classifyHumanWakes(subscription.Drain(wake), stream.cursors)) {
				return
			}
		case <-heartbeat.C:
			// The heartbeat rereads the cursor Rooms, so a lost notification
			// delays a Room Event by at most one heartbeat.
			if !a.ensureStreamSession(c, flusher, principal.Token) ||
				!stream.syncCursorRooms(stream.cursorRoomIDs()) {
				return
			}
			if _, err := fmt.Fprint(c.Writer, ": heartbeat\n\n"); err != nil {
				return
			}
			flusher.Flush()
		case <-expiry.C:
			if !a.resetStreamSessionExpiry(c, flusher, principal.Token, expiry) {
				return
			}
		}
	}
}

func (s *humanEventStream) apply(burst humanWakeBurst) bool {
	if burst.reconcile {
		if !s.syncCursorRooms(s.cursorRoomIDs()) || !s.writeResync("hints_lost") {
			return false
		}
	} else if len(burst.cursorRooms) > 0 && !s.syncCursorRooms(burst.cursorRooms) {
		return false
	}
	if len(burst.otherRooms) > 0 {
		roomIDs := make([]string, 0, len(burst.otherRooms))
		for roomID := range burst.otherRooms {
			roomIDs = append(roomIDs, roomID)
		}
		slices.Sort(roomIDs)
		if !s.resolveRoomTenants(roomIDs) {
			return false
		}
		for _, roomID := range roomIDs {
			if !s.writeInvalidation(realtime.Invalidation{
				TenantID: s.roomTenants[roomID], Resource: realtime.InvalidateRoom,
				ID: roomID, RoomSeq: burst.otherRooms[roomID],
			}) {
				return false
			}
		}
	}
	for _, hint := range burst.hints {
		if !s.writeInvalidation(hint) {
			return false
		}
	}
	return true
}

func (s *humanEventStream) cursorRoomIDs() []string {
	roomIDs := make([]string, 0, len(s.cursors))
	for roomID := range s.cursors {
		roomIDs = append(roomIDs, roomID)
	}
	slices.Sort(roomIDs)
	return roomIDs
}

// syncCursorRooms sends every committed Room Event past each listed cursor.
// A Room the Account can no longer read loses its cursor and yields one room
// hint, so the client refetches it and learns the outcome from that read.
func (s *humanEventStream) syncCursorRooms(roomIDs []string) bool {
	if len(roomIDs) == 0 {
		return true
	}
	ctx := s.c.Request.Context()
	latest, err := s.app.collaboration.RoomEventWatermarks(ctx, s.accountID, roomIDs)
	if err != nil {
		return false
	}
	var lost []string
	for _, roomID := range roomIDs {
		watermark, readable := latest[roomID]
		if !readable {
			delete(s.cursors, roomID)
			lost = append(lost, roomID)
			continue
		}
		if !s.sendRoomEvents(roomID, watermark) {
			return false
		}
	}
	if len(lost) == 0 {
		return true
	}
	if !s.resolveRoomTenants(lost) {
		return false
	}
	for _, roomID := range lost {
		if !s.writeInvalidation(realtime.Invalidation{TenantID: s.roomTenants[roomID], Resource: realtime.InvalidateRoom, ID: roomID}) {
			return false
		}
	}
	return true
}

func (s *humanEventStream) sendRoomEvents(roomID string, through int64) bool {
	for s.cursors[roomID] < through {
		rows, err := s.app.collaboration.RoomEventsThrough(s.c.Request.Context(), s.accountID, roomID,
			s.cursors[roomID], through, int32(s.app.cfg.SSEReplayBatchSize))
		if err != nil {
			return false
		}
		if len(rows) == 0 {
			// Access ended between the watermark and this page; the next
			// sync drops the cursor.
			return true
		}
		for _, row := range rows {
			encoded, err := json.Marshal(row)
			if err != nil {
				return false
			}
			if _, err := fmt.Fprintf(s.c.Writer, "event: room.event\ndata: %s\n\n", encoded); err != nil {
				return false
			}
			s.cursors[roomID] = row.RoomSeq
		}
		s.flusher.Flush()
	}
	return true
}

// resolveRoomTenants fills the Tenant of each uncached Room with one read.
func (s *humanEventStream) resolveRoomTenants(roomIDs []string) bool {
	var unknown []string
	for _, roomID := range roomIDs {
		if _, found := s.roomTenants[roomID]; !found {
			unknown = append(unknown, roomID)
		}
	}
	if len(unknown) == 0 {
		return true
	}
	tenants, err := s.app.collaboration.RoomTenants(s.c.Request.Context(), unknown)
	if err != nil {
		return false
	}
	for roomID, tenantID := range tenants {
		s.roomTenants[roomID] = tenantID
	}
	return true
}

// writeInvalidation forwards a hint of the Human's Space; a Room that no
// longer exists has no Tenant and is skipped.
func (s *humanEventStream) writeInvalidation(hint realtime.Invalidation) bool {
	if hint.TenantID == "" || hint.TenantID != s.tenantID {
		return true
	}
	encoded, err := json.Marshal(resourceInvalidatedEvent{
		TenantID: hint.TenantID, Resource: hint.Resource, ID: hint.ID, RoomSeq: hint.RoomSeq,
	})
	if err != nil {
		return false
	}
	if _, err := fmt.Fprintf(s.c.Writer, "event: resource.invalidated\ndata: %s\n\n", encoded); err != nil {
		return false
	}
	s.flusher.Flush()
	return true
}

func (s *humanEventStream) writeResync(reason string) bool {
	if _, err := fmt.Fprintf(s.c.Writer, "event: stream.resync\ndata: {\"reason\":%q}\n\n", reason); err != nil {
		return false
	}
	s.flusher.Flush()
	return true
}
