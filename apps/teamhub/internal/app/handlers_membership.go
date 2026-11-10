package app

import (
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/collaboration"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

func (a *App) listRoomMembers(c *gin.Context) {
	cursor, limit, ok := parsePage(c)
	if !ok {
		a.writeError(c, http.StatusBadRequest, "INVALID_PAGE", "invalid pagination parameters")
		return
	}
	page, err := a.collaboration.ListRoomMembers(c.Request.Context(), currentPrincipal(c).Session.AccountID, c.Param("roomId"), collaboration.Page{Cursor: cursor, Limit: limit})
	if a.notFoundOrError(c, "authorize room members", err) {
		return
	}
	c.JSON(http.StatusOK, page)
}

func (a *App) putRoomMember(c *gin.Context) {
	var request httpapi.RoomMemberPutRequest
	if decodeJSON(c, &request) != nil || !request.Role.Valid() {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "room member role is invalid")
		return
	}
	roomID := c.Param("roomId")
	member, addedAgentIDs, err := a.collaboration.PutRoomMember(c.Request.Context(), currentPrincipal(c).Session.AccountID, roomID, c.Param("actorId"), request.Role, collaboration.AddedByAgent{})
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		a.writeError(c, http.StatusNotFound, "NOT_FOUND", "room or actor was not found")
	case errors.Is(err, collaboration.ErrRoomOwnerRequired):
		a.writeError(c, http.StatusForbidden, "ROOM_OWNER_REQUIRED", "only a Room owner can manage members")
	case errors.Is(err, collaboration.ErrLastRoomOwner):
		a.writeError(c, http.StatusConflict, "LAST_ROOM_OWNER", "a Room must retain at least one owner")
	case errors.Is(err, collaboration.ErrPendingCardDecision):
		a.writeError(c, http.StatusConflict, "PENDING_CARD_DECISION", "resolve pending card work before removing this member")
	case errors.Is(err, collaboration.ErrAgentCannotOwnRoom):
		a.writeError(c, http.StatusBadRequest, "INVALID_ROOM_OWNER", "an Agent cannot be a Room owner")
	case errors.Is(err, collaboration.ErrAgentNotRegistered):
		a.writeError(c, http.StatusConflict, "AGENT_NOT_REGISTERED", "Agent must be actively registered before Room invitation")
	case errors.Is(err, collaboration.ErrAgentSponsorRequired):
		a.writeError(c, http.StatusForbidden, "AGENT_SPONSOR_REQUIRED", "only the Agent Sponsor can add this Agent to a Room")
	case errors.Is(err, collaboration.ErrDirectRoomImmutable):
		a.writeError(c, http.StatusConflict, "DIRECT_ROOM_IMMUTABLE", "Direct Room membership cannot be changed")
	case errors.Is(err, collaboration.ErrThreadImmutable):
		a.writeError(c, http.StatusConflict, "THREAD_ROOM_IMMUTABLE", "Thread room membership cannot be changed")
	case err != nil:
		a.internalError(c, "put room member", err)
	default:
		a.prepareAddedRoomAgents(c, roomID, addedAgentIDs)
		c.JSON(http.StatusOK, member)
	}
}

func (a *App) deleteRoomMember(c *gin.Context) {
	status, err := a.collaboration.DeleteRoomMember(c.Request.Context(), currentPrincipal(c).Session.AccountID, c.Param("roomId"), c.Param("actorId"))
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		a.writeError(c, http.StatusNotFound, "NOT_FOUND", "room member was not found")
	case errors.Is(err, collaboration.ErrRoomOwnerRequired):
		a.writeError(c, http.StatusForbidden, "ROOM_OWNER_REQUIRED", "only a Room owner can manage members")
	case errors.Is(err, collaboration.ErrLastRoomOwner):
		a.writeError(c, http.StatusConflict, "LAST_ROOM_OWNER", "a Room must retain at least one owner")
	case errors.Is(err, collaboration.ErrPendingCardDecision):
		a.writeError(c, http.StatusConflict, "PENDING_CARD_DECISION", "resolve pending card work before removing this member")
	case errors.Is(err, collaboration.ErrDirectRoomImmutable):
		a.writeError(c, http.StatusConflict, "DIRECT_ROOM_IMMUTABLE", "Direct Room membership cannot be changed")
	case errors.Is(err, collaboration.ErrThreadImmutable):
		a.writeError(c, http.StatusConflict, "THREAD_ROOM_IMMUTABLE", "Thread room membership cannot be changed")
	case err != nil:
		a.internalError(c, "delete room member", err)
	default:
		c.Status(status)
	}
}

func (a *App) updateRoom(c *gin.Context) {
	var request httpapi.RoomUpdateRequest
	if decodeJSON(c, &request) != nil || (request.Name == nil && request.Description == nil) ||
		(request.Name != nil && (strings.TrimSpace(*request.Name) == "" || len(*request.Name) > 120)) ||
		(request.Description != nil && len(*request.Description) > 2000) {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "room name and description are invalid")
		return
	}
	room, err := a.collaboration.UpdateRoom(c.Request.Context(), currentPrincipal(c).Session.AccountID, c.Param("roomId"), request)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		a.writeError(c, http.StatusNotFound, "NOT_FOUND", "room was not found")
	case errors.Is(err, collaboration.ErrRoomOwnerRequired):
		a.writeError(c, http.StatusForbidden, "ROOM_OWNER_REQUIRED", "only a Room owner can update Room metadata")
	case errors.Is(err, collaboration.ErrDirectRoomImmutable):
		a.writeError(c, http.StatusConflict, "DIRECT_ROOM_IMMUTABLE", "Direct Room metadata cannot be changed")
	case errors.Is(err, collaboration.ErrThreadImmutable):
		a.writeError(c, http.StatusConflict, "THREAD_ROOM_IMMUTABLE", "Thread room metadata cannot be changed")
	case err != nil:
		a.internalError(c, "update room", err)
	default:
		c.JSON(http.StatusOK, room)
	}
}

// prepareAddedRoomAgents prepares Agents added while someone is in the Room
// now instead of waiting for the next presence heartbeat.
func (a *App) prepareAddedRoomAgents(c *gin.Context, roomID string, addedAgentIDs []string) {
	if len(addedAgentIDs) == 0 || !a.roomPresence.recentlyPresent(roomID, time.Now()) {
		return
	}
	sent, err := a.collaboration.PrepareRoomPresenceContexts(c.Request.Context(), roomID, addedAgentIDs)
	if err != nil {
		a.logger.Warn("Room member presence prepare failed", "room_id", roomID, "error", err)
	} else if sent > 0 {
		a.logger.Info("Room member add sent presence prepares", "room_id", roomID, "count", sent)
	}
}
