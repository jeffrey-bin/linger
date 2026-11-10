package app

import (
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/collaboration"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/idempotency"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/roomcreation"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voicelive"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

func (a *App) listTenants(c *gin.Context) {
	c.JSON(http.StatusOK, httpapi.TenantList{Items: []httpapi.Tenant{tenantModel(currentPrincipal(c).Session)}})
}

func (a *App) getTenant(c *gin.Context) {
	if !a.requireSpace(c, c.Param("tenantId")) {
		return
	}
	c.JSON(http.StatusOK, tenantModel(currentPrincipal(c).Session))
}

func (a *App) listActors(c *gin.Context) {
	cursor, limit, ok := parsePage(c)
	if !ok {
		a.writeError(c, http.StatusBadRequest, "INVALID_PAGE", "invalid pagination parameters")
		return
	}
	accountID, tenantID := currentPrincipal(c).Session.AccountID, c.Param("tenantId")
	if !a.requireSpace(c, tenantID) {
		return
	}
	page, err := a.collaboration.ListActors(c.Request.Context(), accountID, tenantID, collaboration.Page{Cursor: cursor, Limit: limit})
	if a.notFoundOrError(c, "list actors", err) {
		return
	}
	c.JSON(http.StatusOK, page)
}

func (a *App) getActor(c *gin.Context) {
	actor, err := a.collaboration.GetActor(c.Request.Context(), currentPrincipal(c).Session.AccountID, c.Param("tenantId"), c.Param("actorId"))
	if a.notFoundOrError(c, "get actor", err) {
		return
	}
	c.JSON(http.StatusOK, actor)
}

func (a *App) listRooms(c *gin.Context) {
	cursor, limit, ok := parsePage(c)
	if !ok {
		a.writeError(c, http.StatusBadRequest, "INVALID_PAGE", "invalid pagination parameters")
		return
	}
	accountID, tenantID := currentPrincipal(c).Session.AccountID, c.Param("tenantId")
	if !a.requireSpace(c, tenantID) {
		return
	}
	page, err := a.collaboration.ListRooms(c.Request.Context(), accountID, tenantID, collaboration.Page{Cursor: cursor, Limit: limit})
	if a.notFoundOrError(c, "list rooms", err) {
		return
	}
	c.JSON(http.StatusOK, page)
}

func (a *App) getRoom(c *gin.Context) {
	room, err := a.collaboration.GetRoom(c.Request.Context(), currentPrincipal(c).Session.AccountID, c.Param("roomId"))
	if a.notFoundOrError(c, "get room", err) {
		return
	}
	c.JSON(http.StatusOK, room)
}

func (a *App) createRoom(c *gin.Context) {
	var request httpapi.HumanRoomCreateRequest
	if err := decodeJSON(c, &request); err != nil || strings.TrimSpace(request.Name) == "" || len(request.Name) > 120 || (request.Description != nil && len(*request.Description) > 2000) {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "room name and description are invalid")
		return
	}
	request.Name = strings.TrimSpace(request.Name)
	// A repeated creation finds its name taken; only Live tool calls deduplicate.
	result, err := a.collaboration.CreateRoom(c.Request.Context(), currentPrincipal(c).Session.AccountID, c.Param("tenantId"), request, "")
	if errors.Is(err, pgx.ErrNoRows) {
		a.writeError(c, http.StatusNotFound, "TENANT_NOT_FOUND", "tenant was not found")
		return
	}
	if errors.Is(err, collaboration.ErrRoomNameTaken) {
		a.writeError(c, http.StatusConflict, "ROOM_NAME_TAKEN", "a Room with this name already exists")
		return
	}
	if errors.Is(err, voicelive.ErrInvalidTurn) || errors.Is(err, voicelive.ErrTurnConflict) {
		a.writeError(c, http.StatusConflict, "VOICE_TURN_UNAVAILABLE", "The Live turn is no longer available.")
		return
	}
	if errors.Is(err, roomcreation.ErrNotFound) {
		a.writeError(c, http.StatusNotFound, "NOT_FOUND", "the Room creator is not an active Tenant member")
		return
	}
	if errors.Is(err, roomcreation.ErrInvalid) {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "room name and description are invalid")
		return
	}
	if err != nil {
		a.internalError(c, "create room", err)
		return
	}
	writeResultResponse(c, result)
}

func (a *App) listMessages(c *gin.Context) {
	cursor, limit, ok := parsePage(c)
	if !ok {
		a.writeError(c, http.StatusBadRequest, "INVALID_PAGE", "invalid pagination parameters")
		return
	}
	timings := startMessageReadTimings(c)
	page, err := a.collaboration.ListMessages(c.Request.Context(), currentPrincipal(c).Session.AccountID, c.Param("roomId"),
		collaboration.Page{Cursor: cursor, Limit: limit}, timings)
	if a.notFoundOrError(c, "authorize message history", err) {
		return
	}
	c.JSON(http.StatusOK, page)
	timings.Stage("response")
}

func (a *App) getMessage(c *gin.Context) {
	message, err := a.collaboration.GetMessage(c.Request.Context(), currentPrincipal(c).Session.AccountID, c.Param("roomId"), c.Param("messageId"))
	if a.notFoundOrError(c, "get message", err) {
		return
	}
	c.JSON(http.StatusOK, message)
}

func (a *App) forwardRoomMessage(c *gin.Context) {
	idempotencyKey := contractParams[httpapi.ForwardRoomMessageParams](c).IdempotencyKey
	var request httpapi.MessageForwardRequest
	if err := c.ShouldBindJSON(&request); err != nil {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Forward target is invalid")
		return
	}
	forwarded, err := a.collaboration.ForwardMessage(c.Request.Context(), currentPrincipal(c).Session.AccountID,
		c.Param("roomId"), c.Param("messageId"), request, idempotencyKey)
	switch {
	case errors.Is(err, collaboration.ErrForwardSourceNotFound):
		a.writeError(c, http.StatusNotFound, "MESSAGE_NOT_FOUND", "Message was not found")
	case errors.Is(err, collaboration.ErrForwardTargetNotFound):
		a.writeError(c, http.StatusNotFound, "FORWARD_TARGET_NOT_FOUND", "Forward target is unavailable")
	case errors.Is(err, collaboration.ErrForwardTargetInvalid):
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Forward target is invalid")
	case errors.Is(err, collaboration.ErrForwardNotAllowed):
		a.writeError(c, http.StatusNotFound, "FORWARD_NOT_ALLOWED", "Message could not be forwarded")
	case errors.Is(err, voicelive.ErrInvalidTurn), errors.Is(err, voicelive.ErrTurnConflict):
		a.writeError(c, http.StatusConflict, "VOICE_TURN_UNAVAILABLE", "The Live turn is no longer available.")
	case errors.Is(err, idempotency.ErrConflict):
		a.writeError(c, http.StatusConflict, "IDEMPOTENCY_KEY_REUSED", "idempotency key was used with different input")
	case err != nil:
		a.internalError(c, "forward Message", err)
	default:
		if forwarded.Replay {
			c.Header("Idempotent-Replay", "true")
		}
		c.JSON(http.StatusCreated, forwarded.Result)
	}
}

func (a *App) createMessage(c *gin.Context) {
	key, ok := a.requireIdempotencyKey(c)
	if !ok {
		return
	}
	var request httpapi.MessageCreateRequest
	if err := decodeJSON(c, &request); err != nil {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "message content is invalid")
		return
	}
	content, err := collaboration.NormalizeMessageCreateRequest(request)
	if err != nil {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "message content is invalid")
		return
	}
	result, err := a.collaboration.CreateMessage(c.Request.Context(), currentPrincipal(c).Session.AccountID, c.Param("roomId"), request, content, key)
	if errors.Is(err, collaboration.ErrRoomParticipationLeft) {
		a.writeError(c, http.StatusForbidden, "ROOM_LEFT", "Rejoin this Room before sending messages.")
		return
	}
	if errors.Is(err, pgx.ErrNoRows) {
		a.writeError(c, http.StatusNotFound, "ROOM_NOT_FOUND", "room was not found")
		return
	}
	if errors.Is(err, voicelive.ErrInvalidTurn) || errors.Is(err, voicelive.ErrTurnConflict) {
		a.writeError(c, http.StatusConflict, "VOICE_TURN_UNAVAILABLE", "The Live turn is no longer available.")
		return
	}
	if errors.Is(err, idempotency.ErrConflict) {
		a.writeError(c, http.StatusConflict, "IDEMPOTENCY_KEY_REUSED", "idempotency key was used with different input")
		return
	}
	if errors.Is(err, collaboration.ErrInvalidMention) {
		a.writeError(c, http.StatusBadRequest, "INVALID_MENTION", "message references must target eligible Tenant Actors")
		return
	}
	if errors.Is(err, collaboration.ErrInvalidMessageSkill) {
		a.writeError(c, http.StatusBadRequest, "INVALID_SKILL", "skill segments must target an eligible Room Agent with the exact enabled Skill binding")
		return
	}
	if errors.Is(err, collaboration.ErrInvalidMessageContext) {
		a.writeError(c, http.StatusBadRequest, "INVALID_MESSAGE_CONTEXT", "context messages must be distinct committed Messages in the same Room")
		return
	}
	if errors.Is(err, collaboration.ErrInvalidDocumentReference) {
		a.writeError(c, http.StatusBadRequest, "INVALID_DOCUMENT_REFERENCE", "Document references must be active in the current message Context")
		return
	}
	if errors.Is(err, collaboration.ErrAttachmentUploadUnavailable) {
		a.writeError(c, http.StatusConflict, "ATTACHMENT_UPLOAD_UNAVAILABLE", "message attachment upload is unavailable")
		return
	}
	if errors.Is(err, collaboration.ErrInvalidMessageAttachment) {
		a.writeError(c, http.StatusBadRequest, "INVALID_ATTACHMENT", "message context must reference currently authorized published Artifact Versions")
		return
	}
	if errors.Is(err, collaboration.ErrDirectRoomPeerInactive) {
		a.writeError(c, http.StatusConflict, "DIRECT_ROOM_PEER_INACTIVE", "the Direct Room Agent is unavailable")
		return
	}
	if err != nil {
		a.internalError(c, "create message", err)
		return
	}
	a.recordMessageCommitTiming(c)
	writeResultResponse(c, result)
}

func (a *App) recordMessageCommitTiming(c *gin.Context) {
	correlationID := c.GetHeader("X-Linger-Latency-ID")
	if !idempotencyKeyPattern.MatchString(correlationID) {
		return
	}
	committedAt := time.Now().UTC()
	c.Header("X-Linger-Message-Commit-Unix-Ms", strconv.FormatInt(committedAt.UnixMilli(), 10))
	if a.logger != nil {
		a.logger.Info("local_agent_ingress.message_committed",
			"correlation_id", correlationID,
			"room_id", c.Param("roomId"),
			"committed_at_unix_ms", committedAt.UnixMilli(),
		)
	}
}

func (a *App) notFoundOrError(c *gin.Context, action string, err error) bool {
	if err == nil {
		return false
	}
	// A failure after access was established is never a hidden resource.
	var internal *collaboration.InternalError
	if errors.As(err, &internal) {
		a.internalError(c, internal.Action, internal.Err)
		return true
	}
	// For protected resources, callers use authorization queries with Account/Tenant/Room conditions and always return 404, so the response does not reveal whether the resource exists.
	if errors.Is(err, pgx.ErrNoRows) {
		a.writeError(c, http.StatusNotFound, "NOT_FOUND", "resource was not found")
		return true
	}
	a.internalError(c, action, err)
	return true
}
