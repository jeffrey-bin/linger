package app

import (
	"errors"
	"net/http"
	"regexp"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/roomagent"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

const browserExtensionTokenPrefix = "PLAYWRIGHT_MCP_EXTENSION_TOKEN=" //nolint:gosec // G101: the variable name prefix, not a credential

var (
	browserExtensionTokenPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{20,256}$`)
	browserProfilePattern        = regexp.MustCompile(`^(Default|Profile [1-9][0-9]{0,3}|Guest Profile)$`)
)

// The browser connection handlers persist nothing and never log the request
// body: the configure body carries the Playwright Extension token.
func (a *App) getLocalComputerBrowserConnection(c *gin.Context) {
	a.forwardLocalBrowserConnection(c, roomagent.LocalBrowserConnectionCommand{Action: roomagent.LocalBrowserConnectionStatusAction})
}

func (a *App) putLocalComputerBrowserConnection(c *gin.Context) {
	var request httpapi.BrowserConnectionConfigureRequest
	if err := decodeJSON(c, &request); err != nil || request.ExtensionToken == nil {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Browser connection request is invalid")
		return
	}
	token, ok := normalizeBrowserExtensionToken(*request.ExtensionToken)
	if !ok {
		a.writeError(c, http.StatusBadRequest, "INVALID_BROWSER_TOKEN", "Paste the token shown by the Playwright Extension")
		return
	}
	command := roomagent.LocalBrowserConnectionCommand{Action: roomagent.LocalBrowserConnectionConfigure, ExtensionToken: token}
	if request.Profile != nil {
		if !browserProfilePattern.MatchString(*request.Profile) {
			a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Browser profile is invalid")
			return
		}
		command.Profile = *request.Profile
	}
	a.forwardLocalBrowserConnection(c, command)
}

func (a *App) deleteLocalComputerBrowserConnection(c *gin.Context) {
	a.forwardLocalBrowserConnection(c, roomagent.LocalBrowserConnectionCommand{Action: roomagent.LocalBrowserConnectionDisconnect})
}

func (a *App) forwardLocalBrowserConnection(c *gin.Context, command roomagent.LocalBrowserConnectionCommand) {
	tenantID := c.Param("tenantId")
	ownerID, ok := a.spaceHuman(c, tenantID)
	if !ok {
		return
	}
	if a.localComputers == nil {
		a.writeError(c, http.StatusServiceUnavailable, "BROWSER_CONNECTION_UNAVAILABLE", "Browser connection is unavailable")
		return
	}
	command.TenantID, command.OwnerActorID, command.ComputerID = tenantID, ownerID, c.Param("computerId")
	status, err := a.localComputers.ConnectLocalBrowser(c.Request.Context(), command)
	if err != nil {
		a.writeLocalBrowserConnectionError(c, command.Action, err)
		return
	}
	a.settleBrowserConnectionCards(c.Request.Context(), command, status)
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, browserConnectionStatusModel(status))
}

func (a *App) writeLocalBrowserConnectionError(c *gin.Context, action roomagent.LocalBrowserConnectionAction, err error) {
	switch {
	case errors.Is(err, roomagent.ErrLocalComputerNotFound):
		a.writeError(c, http.StatusNotFound, "LOCAL_COMPUTER_NOT_FOUND", "Local Computer was not found")
	case errors.Is(err, roomagent.ErrLocalComputerOffline):
		a.writeError(c, http.StatusServiceUnavailable, "LOCAL_COMPUTER_OFFLINE", "Local Computer is offline")
	case errors.Is(err, roomagent.ErrLocalBrowserUnsupported):
		a.writeError(c, http.StatusConflict, "BROWSER_CONNECTION_UNSUPPORTED", "Upgrade the Local Computer before connecting your browser")
	case errors.Is(err, roomagent.ErrLocalBrowserConnectionTimeout):
		a.writeError(c, http.StatusServiceUnavailable, "BROWSER_CONNECTION_TIMEOUT", "Local Computer did not finish connecting your browser")
	case errors.Is(err, roomagent.ErrLocalBrowserConnectionFailed):
		// Forward only the Computer's known codes; each needs its own guidance.
		var typed *roomagent.LocalBrowserConnectionError
		if errors.As(err, &typed) {
			if message, ok := browserConnectionFailures[typed.Code]; ok {
				a.writeError(c, http.StatusBadGateway, typed.Code, message)
				return
			}
		}
		a.writeError(c, http.StatusBadGateway, "BROWSER_CONNECTION_FAILED", "Local Computer could not connect your browser")
	default:
		// The error never contains the request body or token.
		a.logger.Error("browser connection failed", "action", string(action), "error", err)
		a.writeError(c, http.StatusServiceUnavailable, "BROWSER_CONNECTION_UNAVAILABLE", "Browser connection is unavailable")
	}
}

// browserConnectionFailures are the Computer failure codes a Human can act on.
var browserConnectionFailures = map[string]string{
	"BROWSER_TOKEN_REJECTED":        "The Playwright Extension did not accept this token",
	"BROWSER_EXTENSION_UNAVAILABLE": "The Playwright Extension is not installed in Chrome",
	"BROWSER_UNAVAILABLE":           "Google Chrome is not installed on the Local Computer",
	"BROWSER_BUSY":                  "An Agent task is using this Chrome",
	"BROWSER_CONNECTION_INVALID":    "The saved browser connection is invalid; connect the browser again",
	"INVALID_BROWSER_TOKEN":         "Paste the token shown by the Playwright Extension",
}

// normalizeBrowserExtensionToken treats pasted text strictly as data. It
// accepts the bare token or the extension's whole PLAYWRIGHT_MCP_EXTENSION_TOKEN=
// line, optionally quoted, and rejects anything else without echoing it.
func normalizeBrowserExtensionToken(raw string) (string, bool) {
	value := unquoteBrowserToken(strings.TrimSpace(raw))
	value = unquoteBrowserToken(strings.TrimSpace(strings.TrimPrefix(value, browserExtensionTokenPrefix)))
	if !browserExtensionTokenPattern.MatchString(value) {
		return "", false
	}
	return value, true
}

func unquoteBrowserToken(value string) string {
	if len(value) >= 2 && (value[0] == '"' || value[0] == '\'') && value[len(value)-1] == value[0] {
		return value[1 : len(value)-1]
	}
	return value
}

func browserConnectionStatusModel(status roomagent.LocalBrowserConnectionStatus) httpapi.BrowserConnectionStatus {
	model := httpapi.BrowserConnectionStatus{
		Mode:         httpapi.BrowserConnectionStatusMode(status.Mode),
		State:        httpapi.BrowserConnectionStatusState(status.State),
		Platform:     httpapi.BrowserConnectionStatusPlatform(status.Platform),
		ConfiguredAt: status.ConfiguredAt, VerifiedAt: status.VerifiedAt,
	}
	if status.Browser != "" {
		browser := httpapi.BrowserConnectionStatusBrowser(status.Browser)
		model.Browser = &browser
	}
	if status.Profile != "" {
		model.Profile = &status.Profile
	}
	if status.Message != "" {
		model.Message = &status.Message
	}
	return model
}
