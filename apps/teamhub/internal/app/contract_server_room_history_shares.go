package app

import (
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/collaboration"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

func (a *App) createRoomHistoryShareRoute(c *gin.Context) {
	roomID := c.Param("roomId")
	var input httpapi.CreateRoomHistoryShare
	if err := decodeStrictJSON(http.MaxBytesReader(c.Writer, c.Request.Body, 4096), &input, "invalid share request"); err != nil || (input.WebVersion != nil && len(*input.WebVersion) > 200) {
		a.writeError(c, 400, "INVALID_REQUEST", "Invalid share request")
		return
	}
	result, err := a.collaboration.CreateRoomHistoryShare(c.Request.Context(), currentPrincipal(c).Session.AccountID, roomID, input)
	if a.writeHistoryError(c, err) {
		return
	}
	historyHeaders(c)
	c.JSON(http.StatusCreated, result)
}

func (a *App) listRoomHistoryShares(c *gin.Context) {
	items, err := a.collaboration.ListRoomHistoryShares(c.Request.Context(), currentPrincipal(c).Session.AccountID, c.Param("roomId"))
	if a.writeHistoryError(c, err) {
		return
	}
	historyHeaders(c)
	c.JSON(http.StatusOK, httpapi.RoomHistorySharePage{Items: items})
}

func (a *App) revokeRoomHistoryShare(c *gin.Context) {
	err := a.collaboration.RevokeRoomHistoryShare(c.Request.Context(), currentPrincipal(c).Session.AccountID, c.Param("roomId"), c.Param("shareId"))
	if a.writeHistoryError(c, err) {
		return
	}
	historyHeaders(c)
	c.Status(http.StatusNoContent)
}

func (a *App) issueRoomHistoryShareLinkRoute(c *gin.Context) {
	roomID := c.Param("roomId")
	shareID := c.Param("shareId")
	result, err := a.collaboration.IssueRoomHistoryShareLink(
		c.Request.Context(),
		currentPrincipal(c).Session.AccountID,
		roomID,
		shareID,
	)
	if a.writeHistoryError(c, err) {
		return
	}
	historyHeaders(c)
	c.JSON(http.StatusOK, result)
}

func historyHeaders(c *gin.Context) {
	c.Header("Cache-Control", "no-store")
	c.Header("Referrer-Policy", "no-referrer")
	c.Header("X-Content-Type-Options", "nosniff")
}
func (a *App) writeHistoryError(c *gin.Context, err error) bool {
	if err == nil {
		return false
	}
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		a.writeError(c, 404, "SHARE_UNAVAILABLE", "This shared conversation is unavailable or has been revoked.")
	case errors.Is(err, collaboration.ErrRoomOwnerRequired):
		a.writeError(c, 403, "ROOM_OWNER_REQUIRED", "Only a Room owner can manage shared conversations.")
	case errors.Is(err, collaboration.ErrRoomParticipationLeft):
		a.writeError(c, 409, "ROOM_LEFT", "Rejoin the Room before creating a shared conversation.")
	case errors.Is(err, collaboration.ErrDirectRoomImmutable), errors.Is(err, collaboration.ErrThreadImmutable):
		a.writeError(c, 409, "SHARE_UNAVAILABLE", "Only group Room conversations can be shared.")
	case errors.Is(err, collaboration.ErrHistoryTooLarge):
		a.writeError(c, 413, "SHARE_TOO_LARGE", "This conversation exceeds the sharing limit of 10,000 messages or 100 MB.")
	default:
		a.internalError(c, "Room history share", err)
	}
	return true
}

func (a *App) readHistoryRequest(c *gin.Context, asset bool) {
	historyHeaders(c)
	var input httpapi.ReadRoomHistoryShare
	if err := decodeStrictJSON(http.MaxBytesReader(c.Writer, c.Request.Body, 4096), &input, "invalid shared conversation"); err != nil {
		a.writeError(c, 400, "INVALID_REQUEST", "Invalid shared conversation link")
		return
	}
	after := int64(0)
	if input.After != nil {
		after = *input.After
	}
	if after < 0 {
		a.writeError(c, 400, "INVALID_REQUEST", "Invalid page")
		return
	}
	if asset {
		if input.AssetId == nil {
			a.writeHistoryError(c, pgx.ErrNoRows)
			return
		}
		content, err := a.collaboration.ReadRoomHistoryAsset(c.Request.Context(), input.Token, *input.AssetId)
		if a.writeHistoryError(c, err) {
			return
		}
		c.Header("Content-Security-Policy", "default-src 'none'; sandbox")
		c.Data(http.StatusOK, content.MediaType, content.Content)
		return
	}
	page, err := a.collaboration.ReadRoomHistory(c.Request.Context(), input.Token, after)
	if a.writeHistoryError(c, err) {
		return
	}
	c.JSON(http.StatusOK, gin.H{"share": page.Share, "items": page.Items, "next_after": page.NextAfter})
}

func (a *App) readRoomHistoryShare(c *gin.Context) {
	a.readHistoryRequest(c, false)
}
func (a *App) readRoomHistoryShareAsset(c *gin.Context) {
	a.readHistoryRequest(c, true)
}
