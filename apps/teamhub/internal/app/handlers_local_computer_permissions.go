package app

import (
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/roomagent"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/typedcard"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

// The owner reads and acts on their own Computer's macOS permissions from the
// computer_permission card. Every answer also settles the cards it satisfies,
// so the card's own polling is what wakes the waiting Agent.
func (a *App) getLocalComputerPermissions(c *gin.Context) {
	a.forwardLocalComputerPermission(c, roomagent.LocalComputerPermissionCommand{Action: roomagent.LocalComputerPermissionStatusAction})
}

func (a *App) actOnLocalComputerPermission(c *gin.Context) {
	var request httpapi.ComputerPermissionAction
	if err := decodeJSON(c, &request); err != nil {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Permission request is invalid")
		return
	}
	command, ok := localComputerPermissionAction(request)
	if !ok {
		a.writeError(c, http.StatusBadRequest, "INVALID_COMPUTER_PERMISSION_ACTION", "Permission request is invalid")
		return
	}
	a.forwardLocalComputerPermission(c, command)
}

func localComputerPermissionAction(request httpapi.ComputerPermissionAction) (roomagent.LocalComputerPermissionCommand, bool) {
	command := roomagent.LocalComputerPermissionCommand{Action: roomagent.LocalComputerPermissionAction(request.Action), Subject: string(request.Subject)}
	if command.Subject != typedcard.ComputerPermissionSubjectLinger && command.Subject != typedcard.ComputerPermissionSubjectComputerUse {
		return command, false
	}
	switch command.Action {
	case roomagent.LocalComputerPermissionPrompt, roomagent.LocalComputerPermissionOpenSettings:
		if request.Permission == nil {
			return command, false
		}
		command.Permission = string(*request.Permission)
		return command, command.Permission == typedcard.ComputerPermissionScreenRecording || command.Permission == typedcard.ComputerPermissionAccessibility
	case roomagent.LocalComputerPermissionRelaunch:
		return command, request.Permission == nil
	}
	return command, false
}

func (a *App) forwardLocalComputerPermission(c *gin.Context, command roomagent.LocalComputerPermissionCommand) {
	tenantID := c.Param("tenantId")
	ownerID, ok := a.spaceHuman(c, tenantID)
	if !ok {
		return
	}
	if a.localComputers == nil {
		a.writeError(c, http.StatusServiceUnavailable, "COMPUTER_PERMISSIONS_UNAVAILABLE", "Computer permissions are unavailable")
		return
	}
	command.TenantID, command.OwnerActorID, command.ComputerID = tenantID, ownerID, c.Param("computerId")
	status, err := a.localComputers.LocalComputerPermissions(c.Request.Context(), command)
	if err != nil {
		a.writeLocalComputerPermissionError(c, command.Action, err)
		return
	}
	a.settleComputerPermissionCards(c.Request.Context(), tenantID, ownerID, command.ComputerID, status)
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, computerPermissionStatusModel(status))
}

func (a *App) writeLocalComputerPermissionError(c *gin.Context, action roomagent.LocalComputerPermissionAction, err error) {
	switch {
	case errors.Is(err, roomagent.ErrLocalComputerNotFound):
		a.writeError(c, http.StatusNotFound, "LOCAL_COMPUTER_NOT_FOUND", "Local Computer was not found")
	case errors.Is(err, roomagent.ErrLocalComputerOffline):
		a.writeError(c, http.StatusServiceUnavailable, "LOCAL_COMPUTER_OFFLINE", "Local Computer is offline")
	case errors.Is(err, roomagent.ErrLocalComputerPermissionsUnsupported):
		a.writeError(c, http.StatusConflict, "COMPUTER_PERMISSION_UNSUPPORTED", "Upgrade Linger on this Computer before granting permissions from here")
	case errors.Is(err, roomagent.ErrLocalComputerPermissionTimeout):
		a.writeError(c, http.StatusServiceUnavailable, "COMPUTER_PERMISSION_TIMEOUT", "Local Computer did not answer in time")
	case errors.Is(err, roomagent.ErrLocalComputerPermissionFailed):
		// Forward only the Computer's known codes; each needs its own guidance.
		var typed *roomagent.LocalComputerPermissionError
		if errors.As(err, &typed) {
			if message, ok := computerPermissionFailures[typed.Code]; ok {
				a.writeError(c, http.StatusBadGateway, typed.Code, message)
				return
			}
		}
		a.writeError(c, http.StatusBadGateway, "COMPUTER_PERMISSION_FAILED", "Local Computer could not complete this step")
	default:
		a.logger.Error("computer permission failed", "action", string(action), "error", err)
		a.writeError(c, http.StatusServiceUnavailable, "COMPUTER_PERMISSIONS_UNAVAILABLE", "Computer permissions are unavailable")
	}
}

// computerPermissionFailures are the Computer failure codes a Human can act on.
var computerPermissionFailures = map[string]string{
	"COMPUTER_PERMISSION_INVALID":              "Permission request is invalid",
	"COMPUTER_PERMISSION_UNSUPPORTED":          "This Computer is not a Mac",
	"COMPUTER_PERMISSION_UNAVAILABLE":          "The app that needs this permission is not available on the Mac",
	"COMPUTER_PERMISSION_RELAUNCH_UNAVAILABLE": "Quit and reopen Linger on the Mac yourself",
	"COMPUTER_PERMISSION_TIMEOUT":              "The Mac did not answer in time; try again",
}

func computerPermissionStatusModel(status roomagent.LocalComputerPermissionStatus) httpapi.ComputerPermissionStatus {
	model := httpapi.ComputerPermissionStatus{
		Platform: httpapi.ComputerPermissionStatusPlatform(status.Platform), Host: httpapi.ComputerPermissionStatusHost(status.Host),
		Subjects: []httpapi.ComputerPermissionSubjectStatus{},
	}
	for _, subject := range status.Subjects {
		entry := httpapi.ComputerPermissionSubjectStatus{Subject: httpapi.ComputerPermissionSubject(subject.Subject), Permissions: []httpapi.ComputerPermissionEntry{}}
		for _, permission := range subject.Permissions {
			entry.Permissions = append(entry.Permissions, httpapi.ComputerPermissionEntry{
				Id: httpapi.ComputerPermissionId(permission.ID), State: httpapi.ComputerPermissionState(permission.State),
				Prompt: httpapi.ComputerPermissionPrompt(permission.Prompt), RelaunchRequired: permission.RelaunchRequired,
			})
		}
		model.Subjects = append(model.Subjects, entry)
	}
	return model
}
