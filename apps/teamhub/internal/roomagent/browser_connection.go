package roomagent

import (
	"context"
	"errors"
	"fmt"
	"net/http"

	"github.com/simplexai-labs/linger/contracts-go/nodeservicesinternal"
)

// ConnectLocalBrowser forwards one browser connection command to the owner's Computer.
// A configure is verified on the Computer for up to a minute, so it uses the
// long command client. The token is sent once and never logged or returned.
func (g *HTTPGateway) ConnectLocalBrowser(ctx context.Context, command LocalBrowserConnectionCommand) (LocalBrowserConnectionStatus, error) {
	if !opaqueIDPattern.MatchString(command.TenantID) || !opaqueIDPattern.MatchString(command.OwnerActorID) || !opaqueIDPattern.MatchString(command.ComputerID) {
		return LocalBrowserConnectionStatus{}, ErrLocalComputerNotFound
	}
	var (
		status *nodeservicesinternal.BrowserConnectionStatus
		code   int
		body   *nodeservicesinternal.ErrorResponse
		err    error
	)
	switch command.Action {
	case LocalBrowserConnectionStatusAction:
		var response *nodeservicesinternal.GetLocalComputerBrowserConnectionResponse
		response, err = g.browserClient.GetLocalComputerBrowserConnectionWithResponse(ctx, command.TenantID, command.OwnerActorID, command.ComputerID)
		if err == nil {
			status, code, body = response.JSON200, response.StatusCode(), firstError(response.JSON502, response.JSON503)
		}
	case LocalBrowserConnectionConfigure:
		request := nodeservicesinternal.BrowserConnectionConfigureCommand{ExtensionToken: &command.ExtensionToken}
		if command.Profile != "" {
			request.Profile = &command.Profile
		}
		var response *nodeservicesinternal.ConfigureLocalComputerBrowserConnectionResponse
		response, err = g.browserClient.ConfigureLocalComputerBrowserConnectionWithResponse(ctx, command.TenantID, command.OwnerActorID, command.ComputerID, request)
		if err == nil {
			status, code, body = response.JSON200, response.StatusCode(), firstError(response.JSON502, response.JSON503)
		}
	case LocalBrowserConnectionDisconnect:
		var response *nodeservicesinternal.DisconnectLocalComputerBrowserConnectionResponse
		response, err = g.browserClient.DisconnectLocalComputerBrowserConnectionWithResponse(ctx, command.TenantID, command.OwnerActorID, command.ComputerID)
		if err == nil {
			status, code, body = response.JSON200, response.StatusCode(), firstError(response.JSON502, response.JSON503)
		}
	default:
		return LocalBrowserConnectionStatus{}, errors.New("unknown browser connection action")
	}
	if err != nil {
		// The transport error can wrap the request but never its body.
		return LocalBrowserConnectionStatus{}, fmt.Errorf("browser connection %s: %w", command.Action, err)
	}
	if code == http.StatusOK && status != nil {
		return localBrowserConnectionStatus(*status), nil
	}
	switch code {
	case http.StatusNotFound:
		return LocalBrowserConnectionStatus{}, ErrLocalComputerNotFound
	case http.StatusConflict:
		return LocalBrowserConnectionStatus{}, ErrLocalBrowserUnsupported
	case http.StatusBadGateway:
		if body != nil && body.Error.Code != "" {
			return LocalBrowserConnectionStatus{}, &LocalBrowserConnectionError{Code: body.Error.Code}
		}
		return LocalBrowserConnectionStatus{}, ErrLocalBrowserConnectionFailed
	case http.StatusServiceUnavailable:
		if body != nil && body.Error.Code == "LOCAL_COMPUTER_OFFLINE" {
			return LocalBrowserConnectionStatus{}, ErrLocalComputerOffline
		}
		if body != nil && body.Error.Code == "BROWSER_CONNECTION_TIMEOUT" {
			return LocalBrowserConnectionStatus{}, ErrLocalBrowserConnectionTimeout
		}
	}
	return LocalBrowserConnectionStatus{}, fmt.Errorf("AgentManagement returned status %d for browser connection %s", code, command.Action)
}

func firstError(values ...*nodeservicesinternal.ErrorResponse) *nodeservicesinternal.ErrorResponse {
	for _, value := range values {
		if value != nil {
			return value
		}
	}
	return nil
}

func localBrowserConnectionStatus(value nodeservicesinternal.BrowserConnectionStatus) LocalBrowserConnectionStatus {
	status := LocalBrowserConnectionStatus{
		Mode: string(value.Mode), State: string(value.State), Platform: string(value.Platform),
		ConfiguredAt: value.ConfiguredAt, VerifiedAt: value.VerifiedAt,
	}
	if value.Browser != nil {
		status.Browser = string(*value.Browser)
	}
	if value.Profile != nil {
		status.Profile = *value.Profile
	}
	if value.Message != nil {
		status.Message = *value.Message
	}
	return status
}
