package localtools

import (
	"context"
	_ "embed"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"runtime"
	"sync"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/mcpproxy"
)

// The fixed driver source, never supplied by a model or a wire request.
//
//go:embed local_linux.py
var nativeLinuxProgram string

// localLinux reports the signed-in user's own X11 desktop.
func (m *Manager) localLinux() bool { return runtime.GOOS == "linux" }

func (op *operation) ensureLinux(ctx context.Context) (*mcpClient, error) {
	op.cuaMu.Lock()
	defer op.cuaMu.Unlock()
	if op.linux != nil && op.linux.closed() {
		// The driver exits after a lost accessibility bus or a hung read and
		// asks for a new process. Its own input already settled; the exited
		// child is cleaned up once before the replacement starts.
		if err := op.linux.close(); err != nil {
			return nil, err
		}
		op.linux = nil
	}
	if op.linux != nil {
		return op.linux, nil
	}
	client, err := startClient(op.ctx, "/usr/bin/python3", []string{"-u", "-c", nativeLinuxProgram}, op.spec.WorkingDirectory, op.manager.env)
	// Retain even a failed launch until its owned process cleanup is confirmed.
	op.linux = client
	if err != nil {
		return nil, err
	}
	if _, err = linuxAction(ctx, client, "probe"); err != nil {
		return nil, err
	}
	return client, nil
}

func linuxAction(ctx context.Context, client *mcpClient, command string, args ...string) ([]byte, error) {
	raw, err := client.request(ctx, "tools/call", map[string]any{"name": "action", "arguments": map[string]any{"command": command, "args": args}})
	readOnly := command == "probe" || command == "screenshot" || command == "active-window" || command == "window-title" || command == "accessibility"
	if command == "semantic-ui" && len(args) == 1 {
		var request struct {
			Kind string `json:"kind"`
		}
		_ = json.Unmarshal([]byte(args[0]), &request)
		readOnly = request.Kind == "state" || request.Kind == "observe"
	}
	failure := func(err error) ([]byte, error) {
		if readOnly {
			return nil, err
		}
		return nil, fmt.Errorf("%w: %v", errOutcomeUnknown, err) //nolint:errorlint // the input may have run; the call classifies as an unknown outcome only
	}
	if err != nil {
		return failure(err)
	}
	var result struct{ Content []struct{ Type, Text string } }
	if json.Unmarshal(raw, &result) != nil || len(result.Content) != 1 || result.Content[0].Type != "text" {
		return failure(errors.New("native Linux driver returned an invalid receipt"))
	}
	data := []byte(result.Content[0].Text)
	var receipt struct {
		Status, Error string
		Output        string `json:"output_base64"`
	}
	if json.Unmarshal(data, &receipt) != nil {
		return failure(errors.New("native Linux driver returned invalid JSON"))
	}
	if receipt.Status == "unknown" {
		return failure(errors.New(receipt.Error))
	}
	if command == "semantic-ui" {
		return data, nil
	}
	if receipt.Error != "" {
		return nil, errors.New(receipt.Error)
	}
	if receipt.Status != "confirmed" {
		return failure(errors.New("native Linux action was not confirmed"))
	}
	return base64.StdEncoding.DecodeString(receipt.Output)
}

type localLinuxLease struct {
	ctx     context.Context
	op      *operation
	client  *mcpClient
	receipt *actionReceipt
	release func()
	once    sync.Once
}

func (l *localLinuxLease) ToolContext() context.Context { return l.ctx }
func (l *localLinuxLease) Action(command string, args ...string) ([]byte, error) {
	return linuxAction(l.ctx, l.client, command, args...)
}
func (l *localLinuxLease) Finish(confirmed bool) {
	l.once.Do(func() {
		err := l.receipt.finish(confirmed)
		if !confirmed || err != nil {
			l.op.mu.Lock()
			l.op.linuxUnknown = l.receipt
			l.op.unknown = true
			l.op.mu.Unlock()
		}
		l.release()
	})
}

// beginDesktop holds the screen for one call. Only input is journaled: a
// read that a daemon crash interrupts sent nothing, so it must not leave a
// durable block on later input.
func (op *operation) beginDesktop(ctx context.Context, input bool) (*localLinuxLease, error) {
	if !op.manager.localLinux() {
		return nil, errors.New("native Linux desktop unavailable")
	}
	ctx, releaseLane, err := op.manager.holdLane(ctx, desktopLane)
	if err != nil {
		return nil, err
	}
	release := releaseLane
	var receipt *actionReceipt
	if input {
		// X11 input goes to the active window, which a browser call could
		// change; see focusGate.
		var releaseFocus func()
		if ctx, releaseFocus, err = op.manager.holdFocusedInput(ctx); err != nil {
			releaseLane()
			return nil, err
		}
		release = func() { releaseFocus(); releaseLane() }
		receipt, err = op.manager.journal.begin(ctx, actionIdentity{AgentID: op.spec.AgentID, OperationID: op.identity.OperationID, Session: op.label + "-linux"})
		if err != nil {
			release()
			return nil, err
		}
	}
	client, err := op.ensureLinux(ctx)
	if err != nil {
		cleanup := op.linux.close()
		if cleanup == nil {
			op.linux = nil
		}
		_ = receipt.finish(cleanup == nil)
		release()
		return nil, errors.Join(err, cleanup)
	}
	return &localLinuxLease{ctx: ctx, op: op, client: client, receipt: receipt, release: release}, nil
}

func (op *operation) closeLinux() error {
	if op.linux == nil {
		return nil
	}
	err := op.linux.close()
	if err == nil && op.linuxUnknown != nil {
		err = op.linuxUnknown.finish(true)
		if err == nil {
			op.linuxUnknown = nil
		}
	}
	if err != nil {
		return errors.Join(err, mcpproxy.ErrCleanupUnconfirmed)
	}
	return nil
}

const NativeLinuxToolGuide = `Computer tools control this signed-in user's Linux X11 desktop. get_window_state() reads AT-SPI elements; screenshot() captures the actual screen. click_element and set_value use numbers from the latest state. click({x,y}), drag({x,y,to_x,to_y}), type_text({text}), press_key({key:"ctrl+s"}), scroll({direction:"down"}) send native input. open_application supports Firefox, LibreOffice Writer/Calc/Impress, GNOME Terminal/Text Editor/Files and installed Xfce apps. open_url uses the user's default browser and existing profile. For an existing Firefox session, use computer tools; browser tools use a separate Chrome profile. Coordinates are screenshot pixels. `
