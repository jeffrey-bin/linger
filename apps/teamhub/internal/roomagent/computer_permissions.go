package roomagent

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"slices"

	"github.com/simplexai-labs/linger/contracts-go/nodeservicesinternal"
)

// Errors of a permission command; the handlers map each to its own status.
var (
	ErrLocalComputerPermissionsUnsupported = errors.New("Local Computer does not support permission requests")
	ErrLocalComputerPermissionFailed       = errors.New("Local Computer permission command failed")
	ErrLocalComputerPermissionTimeout      = errors.New("Local Computer did not answer the permission command")
)

// LocalComputerPermissionAction selects what a permission command does on the Computer.
type LocalComputerPermissionAction string

// The permission actions: status reads, the others are one step of the owner's.
const (
	LocalComputerPermissionStatusAction LocalComputerPermissionAction = "status"
	LocalComputerPermissionPrompt       LocalComputerPermissionAction = "prompt"
	LocalComputerPermissionOpenSettings LocalComputerPermissionAction = "open_settings"
	LocalComputerPermissionRelaunch     LocalComputerPermissionAction = "relaunch"
)

// LocalComputerPermissionCommand reads the macOS permissions of an owner's
// Computer, or takes one step that lets the owner grant them on it.
type LocalComputerPermissionCommand struct {
	TenantID, OwnerActorID, ComputerID string
	Action                             LocalComputerPermissionAction
	Subject, Permission                string
}

// LocalComputerPermissionError is a Computer-reported failure with its stable
// code. It is also ErrLocalComputerPermissionFailed.
type LocalComputerPermissionError struct{ Code string }

func (e *LocalComputerPermissionError) Error() string {
	return ErrLocalComputerPermissionFailed.Error() + ": " + e.Code
}

// Is makes every Computer-reported failure match ErrLocalComputerPermissionFailed.
func (e *LocalComputerPermissionError) Is(target error) bool {
	return target == ErrLocalComputerPermissionFailed
}

// LocalComputerPermissionStatus is the Computer-reported permission state, in
// the shape of the ComputerPermissionStatus contract.
type LocalComputerPermissionStatus struct {
	Platform string                           `json:"platform"`
	Host     string                           `json:"host"`
	Subjects []LocalComputerPermissionSubject `json:"subjects"`
}

// LocalComputerPermissionSubject is one app's permissions.
type LocalComputerPermissionSubject struct {
	Subject     string                         `json:"subject"`
	Permissions []LocalComputerPermissionEntry `json:"permissions"`
}

// LocalComputerPermissionEntry is one permission of one app.
type LocalComputerPermissionEntry struct {
	ID               string `json:"id"`
	State            string `json:"state"`
	Prompt           string `json:"prompt"`
	RelaunchRequired bool   `json:"relaunch_required"`
}

// Granted reports whether every listed permission of the subject is granted.
// A Computer that is not a Mac has no such permissions, so they count as
// granted there.
func (s LocalComputerPermissionStatus) Granted(subject string, permissions []string) bool {
	if s.Platform != "darwin" {
		return true
	}
	index := slices.IndexFunc(s.Subjects, func(entry LocalComputerPermissionSubject) bool { return entry.Subject == subject })
	if index < 0 {
		return false
	}
	for _, permission := range permissions {
		if !slices.ContainsFunc(s.Subjects[index].Permissions, func(entry LocalComputerPermissionEntry) bool {
			return entry.ID == permission && entry.State == "granted"
		}) {
			return false
		}
	}
	return true
}

// LocalComputerPermissions forwards one permission command to the owner's
// Computer. A prompt may wait briefly on the Computer, so it uses the long
// command client.
func (g *HTTPGateway) LocalComputerPermissions(ctx context.Context, command LocalComputerPermissionCommand) (LocalComputerPermissionStatus, error) {
	if !opaqueIDPattern.MatchString(command.TenantID) || !opaqueIDPattern.MatchString(command.OwnerActorID) || !opaqueIDPattern.MatchString(command.ComputerID) {
		return LocalComputerPermissionStatus{}, ErrLocalComputerNotFound
	}
	var (
		status *nodeservicesinternal.ComputerPermissionStatus
		code   int
		body   *nodeservicesinternal.ErrorResponse
		err    error
	)
	if command.Action == LocalComputerPermissionStatusAction {
		var response *nodeservicesinternal.GetLocalComputerPermissionsResponse
		response, err = g.browserClient.GetLocalComputerPermissionsWithResponse(ctx, command.TenantID, command.OwnerActorID, command.ComputerID)
		if err == nil {
			status, code, body = response.JSON200, response.StatusCode(), firstError(response.JSON502, response.JSON503)
		}
	} else {
		request := nodeservicesinternal.ComputerPermissionAction{
			Action:  nodeservicesinternal.ComputerPermissionActionAction(command.Action),
			Subject: nodeservicesinternal.ComputerPermissionSubject(command.Subject),
		}
		if command.Permission != "" {
			permission := nodeservicesinternal.ComputerPermissionId(command.Permission)
			request.Permission = &permission
		}
		var response *nodeservicesinternal.ActOnLocalComputerPermissionResponse
		response, err = g.browserClient.ActOnLocalComputerPermissionWithResponse(ctx, command.TenantID, command.OwnerActorID, command.ComputerID, request)
		if err == nil {
			status, code, body = response.JSON200, response.StatusCode(), firstError(response.JSON502, response.JSON503)
		}
	}
	if err != nil {
		return LocalComputerPermissionStatus{}, fmt.Errorf("computer permission %s: %w", command.Action, err)
	}
	if code == http.StatusOK && status != nil {
		return localComputerPermissionStatus(*status), nil
	}
	switch code {
	case http.StatusNotFound:
		return LocalComputerPermissionStatus{}, ErrLocalComputerNotFound
	case http.StatusConflict:
		return LocalComputerPermissionStatus{}, ErrLocalComputerPermissionsUnsupported
	case http.StatusBadGateway:
		if body != nil && body.Error.Code != "" {
			return LocalComputerPermissionStatus{}, &LocalComputerPermissionError{Code: body.Error.Code}
		}
		return LocalComputerPermissionStatus{}, ErrLocalComputerPermissionFailed
	case http.StatusServiceUnavailable:
		if body != nil && body.Error.Code == "LOCAL_COMPUTER_OFFLINE" {
			return LocalComputerPermissionStatus{}, ErrLocalComputerOffline
		}
		if body != nil && body.Error.Code == "COMPUTER_PERMISSION_TIMEOUT" {
			return LocalComputerPermissionStatus{}, ErrLocalComputerPermissionTimeout
		}
	}
	return LocalComputerPermissionStatus{}, fmt.Errorf("AgentManagement returned status %d for computer permission %s", code, command.Action)
}

func localComputerPermissionStatus(value nodeservicesinternal.ComputerPermissionStatus) LocalComputerPermissionStatus {
	status := LocalComputerPermissionStatus{Platform: string(value.Platform), Host: string(value.Host), Subjects: []LocalComputerPermissionSubject{}}
	for _, subject := range value.Subjects {
		entry := LocalComputerPermissionSubject{Subject: string(subject.Subject), Permissions: []LocalComputerPermissionEntry{}}
		for _, permission := range subject.Permissions {
			entry.Permissions = append(entry.Permissions, LocalComputerPermissionEntry{
				ID: string(permission.Id), State: string(permission.State), Prompt: string(permission.Prompt), RelaunchRequired: permission.RelaunchRequired,
			})
		}
		status.Subjects = append(status.Subjects, entry)
	}
	return status
}
