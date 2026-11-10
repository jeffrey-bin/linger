package localtools

import (
	"context"
	"errors"
	"log/slog"
	"os/exec"
	"sync"
)

// macOS privacy permission vocabulary of ComputerPermissionStatus.
const (
	PermissionScreenRecording = "screen_recording"
	PermissionAccessibility   = "accessibility"

	PermissionSubjectLinger      = "linger"
	PermissionSubjectComputerUse = "computer_use"

	PermissionActionStatus       = "status"
	PermissionActionPrompt       = "prompt"
	PermissionActionOpenSettings = "open_settings"
	PermissionActionRelaunch     = "relaunch"

	permissionGranted       = "granted"
	permissionDenied        = "denied"
	permissionNotDetermined = "not_determined"
	permissionUnknown       = "unknown"

	promptAvailable    = "available"
	promptSettingsOnly = "settings_only"
)

// permissionIDs is the order every subject reports its permissions in.
var permissionIDs = []string{PermissionScreenRecording, PermissionAccessibility}

// permissionSettingsURL opens the System Settings privacy pane that lists the
// apps holding one permission.
var permissionSettingsURL = map[string]string{
	PermissionScreenRecording: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
	PermissionAccessibility:   "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
}

// ComputerPermissionStatus is the ComputerPermissionStatus wire object.
type ComputerPermissionStatus struct {
	Platform string                    `json:"platform"`
	Host     string                    `json:"host"`
	Subjects []ComputerPermissionGroup `json:"subjects"`
}

// ComputerPermissionGroup is one TCC subject's permissions.
type ComputerPermissionGroup struct {
	Subject     string                    `json:"subject"`
	Permissions []ComputerPermissionState `json:"permissions"`
}

// ComputerPermissionState is one permission of one subject.
type ComputerPermissionState struct {
	ID               string `json:"id"`
	State            string `json:"state"`
	Prompt           string `json:"prompt"`
	RelaunchRequired bool   `json:"relaunch_required"`
}

// ComputerPermissionError is an owner-facing, retry-classified failure.
type ComputerPermissionError struct {
	Code, Message string
	Retryable     bool
}

func (e *ComputerPermissionError) Error() string { return e.Code + ": " + e.Message }

// LingerPermission is one permission the Desktop app reports for itself.
type LingerPermission struct {
	ID               string `json:"id"`
	State            string `json:"state"`
	RelaunchRequired bool   `json:"relaunch_required"`
}

// ErrLingerBridgeUnavailable means the Desktop app cannot answer permission
// requests: the Daemon runs standalone, or the app never announced them.
var ErrLingerBridgeUnavailable = errors.New("the Linger app does not answer permission requests")

// LingerBridgeError is a refusal the Desktop app reported with a short code.
type LingerBridgeError struct{ Code string }

func (e *LingerBridgeError) Error() string {
	return "Linger app refused the permission request: " + e.Code
}

// LingerBridge asks the Desktop app, which is the TCC subject of the shell
// commands the Daemon spawns, to check, prompt for, or open the settings of
// its own permissions. Every answer carries the app's full permission list.
type LingerBridge interface {
	LingerPermissions(ctx context.Context, op, permission string) ([]LingerPermission, error)
}

// CuaPermissionReading is what CuaDriver reports about its own permissions.
type CuaPermissionReading struct{ Accessibility, ScreenRecording bool }

// ErrCuaUnavailable means CuaDriver is not installed or cannot start.
var ErrCuaUnavailable = errors.New("CuaDriver is unavailable")

// CuaPermissionChecker reads CuaDriver's permissions through its own
// check_permissions tool and asks macOS for the missing ones.
type CuaPermissionChecker interface {
	CuaPermissions(ctx context.Context) (CuaPermissionReading, error)
	// RequestCuaPermissions starts CuaDriver's own grant flow, which raises
	// the macOS prompts for the missing permissions.
	RequestCuaPermissions() error
	// RestartCua stops the CuaDriver service so the next read starts a new
	// process.
	RestartCua() error
}

// ComputerPermissionOptions configures ComputerPermissions. Nil Linger and
// Cua mean the Desktop app or CuaDriver is absent.
type ComputerPermissionOptions struct {
	// Platform is runtime.GOOS.
	Platform string
	// Desktop is set when the Desktop app launched this Daemon.
	Desktop bool
	Linger  LingerBridge
	Cua     CuaPermissionChecker
	// Open opens a URL with /usr/bin/open; nil uses openURL.
	Open func(ctx context.Context, url string) error
}

// ComputerPermissions answers execute computer_permission. It only reports,
// raises the macOS prompt, or opens System Settings: the owner grants every
// permission, and nothing here restarts an app unless the owner asks.
type ComputerPermissions struct {
	options ComputerPermissionOptions
	// mu serializes actions, so a status read cannot stop the CuaDriver
	// service while another action is prompting through it.
	mu sync.Mutex
	// cuaPrompted records the CuaDriver permissions this process prompted
	// for. check_permissions reports only granted or not, and macOS shows each
	// prompt once, so a permission still missing after its prompt is denied.
	cuaPrompted map[string]bool
}

// NewComputerPermissions returns the Computer's permission service.
func NewComputerPermissions(options ComputerPermissionOptions) *ComputerPermissions {
	if options.Open == nil {
		options.Open = openURL
	}
	return &ComputerPermissions{options: options, cuaPrompted: map[string]bool{}}
}

func openURL(ctx context.Context, url string) error {
	return exec.CommandContext(ctx, "/usr/bin/open", url).Run()
}

// ComputerPermission runs one validated action and returns the full status
// after it.
func (p *ComputerPermissions) ComputerPermission(ctx context.Context, action, subject, permission string) (ComputerPermissionStatus, error) {
	if err := validatePermissionAction(action, subject, permission); err != nil {
		return ComputerPermissionStatus{}, err
	}
	host := "standalone"
	if p.options.Desktop {
		host = "desktop"
	}
	status := ComputerPermissionStatus{Platform: p.options.Platform, Host: host, Subjects: []ComputerPermissionGroup{}}
	if p.options.Platform != "darwin" {
		if action != PermissionActionStatus {
			return ComputerPermissionStatus{}, &ComputerPermissionError{"COMPUTER_PERMISSION_UNSUPPORTED", "only macOS has permissions to grant", false}
		}
		return status, nil
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	var linger []LingerPermission
	answered := false
	var cua *CuaPermissionReading
	var err error
	switch {
	case action == PermissionActionStatus:
	case subject == PermissionSubjectLinger:
		linger, answered, err = p.lingerAction(ctx, action, permission)
	default:
		cua, err = p.cuaAction(ctx, action, permission)
	}
	if err != nil {
		return ComputerPermissionStatus{}, err
	}
	if !answered {
		if linger, answered, err = p.lingerStatus(ctx); err != nil {
			return ComputerPermissionStatus{}, err
		}
	}
	status.Subjects = append(status.Subjects, lingerGroup(linger, answered))
	if cua == nil {
		cua = p.cuaStatus(ctx)
	}
	status.Subjects = append(status.Subjects, p.cuaGroup(cua))
	return status, nil
}

func validatePermissionAction(action, subject, permission string) error {
	invalid := func(message string) error {
		return &ComputerPermissionError{"COMPUTER_PERMISSION_INVALID", message, false}
	}
	switch action {
	case PermissionActionStatus:
		return nil
	case PermissionActionPrompt, PermissionActionOpenSettings, PermissionActionRelaunch:
	default:
		return invalid("unknown permission action")
	}
	if subject != PermissionSubjectLinger && subject != PermissionSubjectComputerUse {
		return invalid("the action needs a subject: linger or computer_use")
	}
	if action != PermissionActionRelaunch && permissionSettingsURL[permission] == "" {
		return invalid("the action needs a permission: screen_recording or accessibility")
	}
	return nil
}

// lingerAction runs a prompt, open_settings or relaunch for the Desktop app
// and returns the app's permissions when the app answered.
func (p *ComputerPermissions) lingerAction(ctx context.Context, action, permission string) ([]LingerPermission, bool, error) {
	if p.options.Linger != nil {
		linger, err := p.options.Linger.LingerPermissions(ctx, action, permission)
		if err == nil {
			return linger, true, nil
		}
		if !errors.Is(err, ErrLingerBridgeUnavailable) {
			return nil, false, lingerFailure(ctx, action, err)
		}
	}
	// Without the app's own prompt the owner can still grant the permission
	// in System Settings, which lists Linger once it has asked.
	if action == PermissionActionRelaunch {
		return nil, false, &ComputerPermissionError{"COMPUTER_PERMISSION_RELAUNCH_UNAVAILABLE", "this Linger app cannot relaunch itself; quit and reopen it", false}
	}
	return nil, false, p.openSettings(ctx, permission)
}

// lingerStatus reads the Desktop app's permissions and reports whether it
// answered; without the app they stay unknown.
func (p *ComputerPermissions) lingerStatus(ctx context.Context) ([]LingerPermission, bool, error) {
	if p.options.Linger == nil {
		return nil, false, nil
	}
	linger, err := p.options.Linger.LingerPermissions(ctx, PermissionActionStatus, "")
	switch {
	case err == nil:
		return linger, true, nil
	case errors.Is(err, ErrLingerBridgeUnavailable):
		return nil, false, nil
	}
	return nil, false, lingerFailure(ctx, PermissionActionStatus, err)
}

func lingerFailure(ctx context.Context, action string, err error) error {
	var refused *LingerBridgeError
	switch {
	case isTimeout(ctx, err):
		return permissionTimeout()
	case errors.As(err, &refused):
		return &ComputerPermissionError{"COMPUTER_PERMISSION_UNAVAILABLE", "the Linger app could not run the request (" + truncateCode(refused.Code) + ")", true}
	}
	slog.Warn("computer_permission.linger_failed", "action", action, "error", err)
	return &ComputerPermissionError{"COMPUTER_PERMISSION_UNAVAILABLE", "the Linger app did not answer the request", true}
}

func lingerGroup(reported []LingerPermission, known bool) ComputerPermissionGroup {
	group := ComputerPermissionGroup{Subject: PermissionSubjectLinger}
	for _, id := range permissionIDs {
		state := ComputerPermissionState{ID: id, State: permissionUnknown, Prompt: promptSettingsOnly}
		if known {
			state.Prompt = promptAvailable
			for _, item := range reported {
				if item.ID == id && knownPermissionState(item.State) {
					state.State = item.State
					// Only Screen Recording waits for a restart to apply.
					state.RelaunchRequired = id == PermissionScreenRecording && item.RelaunchRequired && item.State != permissionGranted
				}
			}
		}
		group.Permissions = append(group.Permissions, state)
	}
	return group
}

func knownPermissionState(state string) bool {
	return state == permissionGranted || state == permissionDenied || state == permissionNotDetermined || state == permissionUnknown
}

// cuaAction runs a prompt, open_settings or relaunch for CuaDriver and returns
// the permissions a prompt read, or nil when a fresh read must follow.
func (p *ComputerPermissions) cuaAction(ctx context.Context, action, permission string) (*CuaPermissionReading, error) {
	switch action {
	case PermissionActionRelaunch:
		if p.options.Cua != nil {
			if err := p.options.Cua.RestartCua(); err != nil {
				slog.Warn("computer_permission.cua_restart_failed", "error", err)
				return nil, &ComputerPermissionError{"COMPUTER_PERMISSION_UNAVAILABLE", "CuaDriver did not stop; quit CuaDriver and try again", true}
			}
		}
		return nil, nil
	case PermissionActionPrompt:
		if p.options.Cua == nil {
			return nil, p.openSettings(ctx, permission)
		}
		reading, err := p.options.Cua.CuaPermissions(ctx)
		switch {
		case err == nil:
		case isTimeout(ctx, err):
			return nil, permissionTimeout()
		case errors.Is(err, ErrCuaUnavailable):
			return nil, p.openSettings(ctx, permission)
		default:
			slog.Warn("computer_permission.cua_status_failed", "error", err)
			return nil, &ComputerPermissionError{"COMPUTER_PERMISSION_UNAVAILABLE", "CuaDriver could not report its permissions", true}
		}
		if err := p.options.Cua.RequestCuaPermissions(); err != nil {
			if errors.Is(err, ErrCuaUnavailable) {
				return nil, p.openSettings(ctx, permission)
			}
			slog.Warn("computer_permission.cua_prompt_failed", "error", err)
			return nil, &ComputerPermissionError{"COMPUTER_PERMISSION_UNAVAILABLE", "CuaDriver could not ask for its permissions", true}
		}
		// The grant flow asks for every missing permission at once.
		if !reading.Accessibility {
			p.cuaPrompted[PermissionAccessibility] = true
		}
		if !reading.ScreenRecording {
			p.cuaPrompted[PermissionScreenRecording] = true
		}
		// Stopping the service now could disturb the flow it serves, so this
		// reading stands in for the status read.
		return &reading, nil
	default:
		return nil, p.openSettings(ctx, permission)
	}
}

// cuaStatus reads CuaDriver's permissions, or nil when it is unavailable.
func (p *ComputerPermissions) cuaStatus(ctx context.Context) *CuaPermissionReading {
	if p.options.Cua == nil {
		return nil
	}
	reading, err := p.options.Cua.CuaPermissions(ctx)
	if err != nil {
		if !errors.Is(err, ErrCuaUnavailable) {
			slog.Warn("computer_permission.cua_status_failed", "error", err)
		}
		return nil
	}
	if !reading.ScreenRecording {
		// CuaDriver caches its Screen Recording preflight for the life of
		// the process, so only a new process sees a grant made since.
		if err := p.options.Cua.RestartCua(); err != nil {
			slog.Warn("computer_permission.cua_restart_failed", "error", err)
		}
	}
	return &reading
}

func (p *ComputerPermissions) cuaGroup(reading *CuaPermissionReading) ComputerPermissionGroup {
	group := ComputerPermissionGroup{Subject: PermissionSubjectComputerUse}
	for _, id := range permissionIDs {
		state := ComputerPermissionState{ID: id, State: permissionUnknown, Prompt: promptSettingsOnly}
		if reading != nil {
			state.Prompt = promptAvailable
			granted := reading.Accessibility
			if id == PermissionScreenRecording {
				granted = reading.ScreenRecording
			}
			switch {
			case granted:
				state.State = permissionGranted
			case p.cuaPrompted[id]:
				state.State = permissionDenied
			default:
				state.State = permissionNotDetermined
			}
		}
		group.Permissions = append(group.Permissions, state)
	}
	return group
}

func (p *ComputerPermissions) openSettings(ctx context.Context, permission string) error {
	if err := p.options.Open(ctx, permissionSettingsURL[permission]); err != nil {
		if isTimeout(ctx, err) {
			return permissionTimeout()
		}
		slog.Warn("computer_permission.open_settings_failed", "permission", permission, "error", err)
		return &ComputerPermissionError{"COMPUTER_PERMISSION_UNAVAILABLE", "System Settings could not be opened", true}
	}
	return nil
}

func isTimeout(ctx context.Context, err error) bool {
	return errors.Is(err, context.DeadlineExceeded) || ctx.Err() != nil
}

func permissionTimeout() error {
	return &ComputerPermissionError{"COMPUTER_PERMISSION_TIMEOUT", "the Computer did not finish the permission request in time; try again", true}
}

// truncateCode bounds a code the Desktop app reported before it reaches the
// owner.
func truncateCode(code string) string {
	if len(code) > 64 {
		return code[:64]
	}
	return code
}
