package localtools

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"path/filepath"
	"strconv"
	"time"
)

// linuxApplications are the desktop applications open_application launches.
var linuxApplications = []string{"firefox", "libreoffice-writer", "libreoffice-calc", "libreoffice-impress", "gnome-text-editor", "gedit", "nautilus", "gnome-terminal", "mousepad", "thunar", "xfce4-terminal"}

func nativeLinuxTools() []tool {
	str := map[string]string{"type": "string"}
	number := map[string]any{"type": "integer", "minimum": 0}
	element := map[string]any{"type": "integer", "minimum": 1}
	button := map[string]any{"type": "string", "enum": []string{"left", "right", "middle"}}
	direction := map[string]any{"type": "string", "enum": []string{"up", "down"}}
	steps := map[string]any{"type": "integer", "minimum": 1, "maximum": 100}
	application := map[string]any{"type": "string", "enum": linuxApplications}
	tools := []tool{
		{Name: "get_window_state", Description: "Read the active window as text: its title, the focused control and a numbered list of its controls with their names and values. Prefer it to a screenshot; act on the numbers with click_element and set_value. Returns a screenshot too when the window cannot be read as text.", InputSchema: schema(nil)},
		{Name: "screenshot", Description: "Capture the desktop. Coordinates use the returned image pixels. Use it when the window state does not show what you need.", InputSchema: schema(nil)},
		{Name: "click_element", Description: "Click a control by its number from the latest window state. A number from a window that has gone fails instead of clicking something else.", InputSchema: schema(map[string]any{"element": element}, "element")},
		{Name: "set_value", Description: "Replace the whole text of an editable field, chosen by its number from the latest window state, and read it back.", InputSchema: schema(map[string]any{"element": element, "value": str}, "element", "value")},
		{Name: "click", Description: "Click the desktop at screenshot coordinates.", InputSchema: schema(map[string]any{"x": number, "y": number, "button": button}, "x", "y")},
		{Name: "move", Description: "Move the pointer on the desktop.", InputSchema: schema(map[string]any{"x": number, "y": number}, "x", "y")},
		{Name: "drag", Description: "Hold the left mouse button and drag continuously from x,y to to_x,to_y, then release. Coordinates use the current screenshot pixels.", InputSchema: schema(map[string]any{"x": number, "y": number, "to_x": number, "to_y": number}, "x", "y", "to_x", "to_y")},
		{Name: "type_text", Description: "Type literal text into the focused application. Unicode is supported. In a terminal a final newline runs the command.", InputSchema: schema(map[string]any{"text": str}, "text")},
		{Name: "press_key", Description: "Press an X11 key combination, for example ctrl+s or Return.", InputSchema: schema(map[string]any{"key": str}, "key")},
		{Name: "scroll", Description: "Scroll the focused desktop window.", InputSchema: schema(map[string]any{"direction": direction, "steps": steps}, "direction")},
		{Name: "open_application", Description: "Open an installed application in the signed-in user's desktop. Optional path is an absolute file or folder path. Applications remain open after the tool session ends.", InputSchema: schema(map[string]any{"application": application, "path": str}, "application")},
		{Name: "open_url", Description: "Open an http(s) URL or a file:// URL inside the user's home in the user's default browser and its existing profile.", InputSchema: schema(map[string]any{"url": str}, "url")},
	}
	for i := range tools[2:] {
		tools[i+2].Description += resultNote
	}
	step := map[string]any{"type": "object", "properties": map[string]any{
		"tool":    map[string]any{"type": "string", "enum": []string{"click_element", "set_value", "click", "move", "drag", "type_text", "press_key", "scroll", "open_application", "open_url"}},
		"element": element, "value": str,
		"x": number, "y": number, "to_x": number, "to_y": number, "button": button, "text": str, "key": str,
		"direction": direction, "steps": steps, "application": application, "path": str, "url": str,
	}, "required": []string{"tool"}, "additionalProperties": false}
	return append(tools, tool{Name: "run_actions", Description: "Sends one or more inputs you can already plan, for example open an application, type a command and press Return: runs the steps in order in one call. Each step names a computer tool and its arguments. It waits for a launch to finish before the next step and stops early when another input changes the active window, because later steps were planned for the window you saw." + resultNote,
		InputSchema: schema(map[string]any{"actions": map[string]any{"type": "array", "minItems": 1, "maxItems": maxBatchActions, "items": step}}, "actions")})
}

// resultNote documents every input result. The text item comes first and
// the image second; a script shows the image with image(), not text().
const resultNote = " Returns JSON text with the window title and the focused control with the end of its text, then the window state as numbered elements; open_application also reports window_opened. A screenshot follows only when the window cannot be read as text; in a script, pass that image item to image(), because text() prints it as base64."

// linuxComputerCall serves the computer tools on the signed-in user's X11
// desktop through the native driver.
func (op *operation) linuxComputerCall(ctx context.Context, name string, args json.RawMessage) (json.RawMessage, error) {
	started := time.Now()
	defer func() { slog.Debug("desktop.tool.timing", "tool", name, "ms", time.Since(started).Milliseconds()) }()
	if name == "run_actions" {
		return op.runActions(ctx, args)
	}
	action, err := parseDesktopAction(name, args)
	if err != nil {
		return nil, err
	}
	lease, err := op.beginDesktop(ctx, name != "screenshot" && name != "get_window_state")
	if err != nil {
		return nil, err
	}
	if name == "screenshot" {
		// The screenshot shows the Agent the window that is active now.
		if window, err := lease.Action("active-window"); err == nil {
			op.linuxWindow = window
		}
		output, err := lease.Action("screenshot")
		lease.Finish(true)
		if err != nil {
			return nil, err
		}
		result, _ := json.Marshal(map[string]any{"content": []any{screenImage(output)}})
		return result, nil
	}
	shot := func() ([]byte, error) { return lease.Action("screenshot") }
	if name == "get_window_state" {
		state := readWindowState(lease)
		var screen []byte
		if state.needsScreenshot() {
			// A failed read sends no input, so it never blocks the desktop.
			if screen, err = shot(); err != nil {
				lease.Finish(true)
				return nil, err
			}
		}
		return op.finishDesktop(lease, nil, screen, map[string]any{}, state)
	}
	var window launchMark
	if action.opens() {
		if window, err = markLaunch(lease, action); err != nil {
			lease.Finish(true)
			return nil, err
		}
	}
	if !action.opens() {
		if err := op.checkWindow(lease); err != nil {
			return op.finishDesktop(lease, err, nil, map[string]any{}, readWindowState(lease))
		}
	}
	var output []byte
	var state *windowState
	report := map[string]any{}
	if err = op.perform(lease, action); err == nil {
		output, state = observe(lease, shot, action.opens(), window, report)
		if action.command == "open" && report["window_opened"] == false {
			delete(report, "window_opened")
			err = errURLNotOpened
		}
	} else if !errors.Is(err, errOutcomeUnknown) {
		state = readWindowState(lease)
	}
	report["completed"] = err == nil
	return op.finishDesktop(lease, err, output, report, state)
}

// perform sends one action. An element action first resolves its number to
// the control observed under it and fails on a stale number.
func (op *operation) perform(lease *localLinuxLease, action desktopAction) error {
	if action.element == 0 {
		_, err := lease.Action(action.command, action.values...)
		return err
	}
	request, err := op.elements.elementRequest(action.element, action.value)
	if err != nil {
		return err
	}
	output, err := lease.Action("semantic-ui", request)
	if err != nil {
		return err
	}
	return elementReceipt(action.element, output)
}

// runActions performs a planned sequence in one call and observes once, so a
// sequence costs one model turn. Like browser-use's multi_act, it stops when
// the active window changes unexpectedly: later steps were planned for the
// window the Agent last saw.
func (op *operation) runActions(ctx context.Context, args json.RawMessage) (json.RawMessage, error) {
	var params struct {
		Actions []struct {
			Tool string `json:"tool"`
		} `json:"actions"`
	}
	var raw struct {
		Actions []json.RawMessage `json:"actions"`
	}
	if json.Unmarshal(args, &params) != nil || json.Unmarshal(args, &raw) != nil || len(raw.Actions) == 0 || len(raw.Actions) > maxBatchActions {
		return nil, fmt.Errorf("actions must list 1 to %d steps", maxBatchActions)
	}
	actions := make([]desktopAction, len(raw.Actions))
	for i, item := range raw.Actions {
		var fields map[string]json.RawMessage
		if json.Unmarshal(item, &fields) != nil {
			return nil, fmt.Errorf("step %d is not an object", i+1)
		}
		delete(fields, "tool")
		stripped, _ := json.Marshal(fields)
		action, err := parseDesktopAction(params.Actions[i].Tool, stripped)
		if err != nil || action.name == "screenshot" || action.name == "get_window_state" {
			return nil, fmt.Errorf("step %d: tool must be one of click_element, set_value, click, move, drag, type_text, press_key, scroll, open_application or open_url", i+1)
		}
		actions[i] = action
	}
	lease, err := op.beginDesktop(ctx, true)
	if err != nil {
		return nil, err
	}
	shot := func() ([]byte, error) { return lease.Action("screenshot") }
	if !actions[0].opens() {
		if err := op.checkWindow(lease); err != nil {
			return op.finishDesktop(lease, err, nil, map[string]any{}, readWindowState(lease))
		}
	}
	window, _ := lease.Action("active-window")
	var mark launchMark
	done, stopped := 0, ""
	for i, action := range actions {
		if action.opens() {
			var markErr error
			if mark, markErr = markLaunch(lease, action); markErr != nil {
				// Without the window before it, the launch cannot be
				// checked, so it is not sent.
				stopped = fmt.Sprintf("reading the active window before step %d failed (%v); observe before continuing", done+1, markErr)
				break
			}
		}
		if err = op.perform(lease, action); err != nil {
			break
		}
		done++
		if i == len(actions)-1 {
			break
		}
		// A launched window or an opened URL must appear before the next step
		// can reach it; other input needs a short pause for the application to
		// process it.
		var waitErr error
		opened := true
		if action.opens() {
			opened, waitErr = awaitWindow(lease, mark)
		} else {
			waitErr = sleepContext(lease.ToolContext(), batchPause)
		}
		if waitErr != nil {
			// Observation sends no input; the next step is simply not sent.
			stopped = fmt.Sprintf("waiting after step %d failed (%v); observe before continuing", done, waitErr)
			break
		}
		if !opened && action.command == "open" {
			done--
			err = errURLNotOpened
			break
		}
		current, _ := lease.Action("active-window")
		if !opened {
			stopped = "the application from step " + strconv.Itoa(done) + " did not become the active window; observe before continuing"
			break
		}
		if action.command != "open" && action.command != "run" && !bytes.Equal(current, window) {
			stopped = "the active window changed after step " + strconv.Itoa(done) + "; observe it before continuing"
			break
		}
		window = current
	}
	var output []byte
	var state *windowState
	report := map[string]any{"completed_steps": done, "total_steps": len(actions)}
	if done > 0 && !errors.Is(err, errOutcomeUnknown) {
		launched := err == nil && done == len(actions) && actions[done-1].opens()
		output, state = observe(lease, shot, launched, mark, report)
		if launched && actions[done-1].command == "open" && report["window_opened"] == false {
			delete(report, "window_opened")
			done--
			report["completed_steps"] = done
			err = errURLNotOpened
		}
	} else if !errors.Is(err, errOutcomeUnknown) {
		state = readWindowState(lease)
	}
	if stopped != "" {
		report["stopped"] = stopped
	}
	if err != nil && done > 0 {
		err = fmt.Errorf("step %d failed after %d completed steps: %w", done+1, done, err)
	}
	return op.finishDesktop(lease, err, output, report, state)
}

// errWindowChanged refuses input planned for the window the Agent last saw
// after another window became active, such as one the user clicked.
var errWindowChanged = errors.New("WINDOW_CHANGED: another window became active since your last observation, so no input was sent; the active window is shown below, so act on it or bring back the window you meant")

// checkWindow refuses input when the active window is not the one in the
// Agent's last observation. Before any observation there is nothing to
// compare, and an action that opens a window needs no check.
func (op *operation) checkWindow(lease *localLinuxLease) error {
	if op.linuxWindow == nil {
		return nil
	}
	current, err := lease.Action("active-window")
	if err != nil {
		return err
	}
	if !bytes.Equal(current, op.linuxWindow) {
		return errWindowChanged
	}
	return nil
}

// observe reads the window after input that was sent. An application
// launch first waits for its window, given the active window before it. The
// window is read as text, and the screen is captured only when text cannot
// describe it. A failed capture is a note: the input happened, and a read
// never makes the outcome unknown.
func observe(lease *localLinuxLease, shot func() ([]byte, error), launched bool, window launchMark, report map[string]any) ([]byte, *windowState) {
	var frame []byte
	var err error
	if launched {
		var opened bool
		opened, err = awaitWindow(lease, window)
		report["window_opened"] = opened
	} else {
		err = sleepContext(lease.ToolContext(), inputPause)
	}
	state := readWindowState(lease)
	if launched && err == nil {
		state, err = awaitReadable(lease, state)
	}
	if err == nil && state != nil && state.Loading {
		state, err = awaitPageLoad(lease, state)
		if state != nil && state.Loading {
			report["loading"] = true
		}
	}
	if err == nil && state.needsScreenshot() {
		frame, err = shot()
	}
	if err != nil {
		report["observation"] = "the input was sent, but the screen could not be observed: " + err.Error()
		return nil, state
	}
	return frame, state
}

var batchPause = 150 * time.Millisecond

func (op *operation) finishDesktop(lease *localLinuxLease, err error, screen []byte, report map[string]any, state *windowState) (json.RawMessage, error) {
	// An input with an unknown outcome stays pending in the action journal,
	// which blocks later input until cleanup confirms it.
	confirmed := !errors.Is(err, errOutcomeUnknown)
	if state != nil {
		op.linuxWindow = state.windowID
	}
	lease.Finish(confirmed)
	if !confirmed {
		op.markUnknown()
	}
	if err != nil && state == nil {
		return nil, err
	}
	if err != nil {
		// A refused or unverified input still shows the window, so the Agent
		// corrects it without another read.
		result, _ := json.Marshal(map[string]any{"isError": true, "content": []any{
			map[string]string{"type": "text", "text": err.Error()},
			map[string]string{"type": "text", "text": op.elements.describe(state)},
		}})
		return result, nil //nolint:nilerr // the failure is reported as a tool error result with the window
	}
	// Every input returns its effect, so the Agent needs no extra turn to
	// look. Like OpenAI's computer use, the window is text by default; the
	// image is kept only where text cannot describe the window.
	if state != nil {
		report["window"] = state.Window
		if len(state.Focused) > 0 && string(state.Focused) != "null" {
			report["focused"] = state.Focused
		}
	}
	text, _ := json.Marshal(report)
	content := []any{map[string]string{"type": "text", "text": string(text)}}
	if state != nil {
		content = append(content, map[string]string{"type": "text", "text": op.elements.describe(state)})
	}
	if state.needsScreenshot() && screen != nil {
		content = append(content, screenImage(screen))
	}
	result, _ := json.Marshal(map[string]any{"content": content})
	return result, nil
}

func screenImage(png []byte) map[string]string {
	return map[string]string{"type": "image", "data": base64.StdEncoding.EncodeToString(png), "mimeType": "image/png"}
}

// desktopAction is one computer tool call translated to a desktop command.
type desktopAction struct {
	name, command string
	values        []string
	// element and value select an element action by its observed number.
	element int
	value   *string
}

func parseDesktopAction(name string, args json.RawMessage) (desktopAction, error) {
	var params struct {
		X           *int    `json:"x"`
		Y           *int    `json:"y"`
		ToX         *int    `json:"to_x"`
		ToY         *int    `json:"to_y"`
		Button      string  `json:"button"`
		Text        string  `json:"text"`
		Key         string  `json:"key"`
		Direction   string  `json:"direction"`
		Steps       int     `json:"steps"`
		Application string  `json:"application"`
		Path        string  `json:"path"`
		URL         string  `json:"url"`
		Element     int     `json:"element"`
		Value       *string `json:"value"`
	}
	if json.Unmarshal(args, &params) != nil {
		return desktopAction{}, errors.New("invalid desktop arguments")
	}
	action := desktopAction{name: name, command: name}
	switch name {
	case "screenshot", "get_window_state":
	case "click_element", "set_value":
		if params.Element < 1 {
			return desktopAction{}, errors.New("element must be a number from the window state")
		}
		action.command, action.element = "semantic-ui", params.Element
		if name == "set_value" {
			if params.Value == nil {
				return desktopAction{}, errors.New("value is required")
			}
			action.value = params.Value
		}
	case "click", "move", "drag":
		if params.X == nil || params.Y == nil {
			return desktopAction{}, errors.New("x and y are required")
		}
		action.values = []string{strconv.Itoa(*params.X), strconv.Itoa(*params.Y)}
		if name == "drag" {
			if params.ToX == nil || params.ToY == nil {
				return desktopAction{}, errors.New("to_x and to_y are required")
			}
			action.values = append(action.values, strconv.Itoa(*params.ToX), strconv.Itoa(*params.ToY))
		}
		if name == "click" && params.Button != "" {
			action.values = append(action.values, params.Button)
		}
	case "type_text":
		action.command, action.values = "type", []string{params.Text}
	case "press_key":
		action.command, action.values = "key", []string{params.Key}
	case "scroll":
		if params.Steps == 0 {
			params.Steps = 1
		}
		action.values = []string{params.Direction, strconv.Itoa(params.Steps)}
	case "open_application":
		action.command, action.values = "run", []string{params.Application}
		if params.Path != "" {
			action.values = append(action.values, params.Path)
		}
	case "open_url":
		action.command, action.values = "open", []string{params.URL}
	default:
		return desktopAction{}, errors.New("unsupported desktop tool")
	}
	return action, nil
}

var (
	// inputPause lets an application process input before its window is read.
	inputPause = 250 * time.Millisecond
	// launchWait bounds the wait for a launched application's window or an
	// opened URL.
	launchWait = 8 * time.Second
	windowPoll = 100 * time.Millisecond
	// pageLoadWait bounds the wait for a busy page, and pagePoll spaces its
	// reads: each one reads the whole window.
	pageLoadWait = 8 * time.Second
	// launchTreeWait bounds the wait for a launched window's controls.
	launchTreeWait = 3 * time.Second
	pagePoll       = 300 * time.Millisecond
)

// errURLNotOpened reports an open_url the desktop did not act on. The handler
// ran, so the input is known, but no window or title changed.
var errURLNotOpened = errors.New("the URL did not open: no window or tab title changed within 8 s; observe before trying again")

// opens reports an action that should bring up a window or tab, so its
// result waits for one instead of a fixed pause.
func (a desktopAction) opens() bool { return a.command == "run" || a.command == "open" }

// awaitPageLoad rereads a window whose page is still loading until it
// settles or pageLoadWait passes, and returns the last reading.
func awaitPageLoad(lease *localLinuxLease, state *windowState) (*windowState, error) {
	deadline := time.Now().Add(pageLoadWait)
	for state != nil && state.Loading && time.Now().Before(deadline) {
		if err := sleepContext(lease.ToolContext(), pagePoll); err != nil {
			return state, err
		}
		state = readWindowState(lease)
	}
	return state, nil
}

// awaitReadable rereads a launched window that shows no controls yet: its
// X11 window appears before the application registers with AT-SPI. A window
// that never exposes controls costs launchTreeWait once.
func awaitReadable(lease *localLinuxLease, state *windowState) (*windowState, error) {
	deadline := time.Now().Add(launchTreeWait)
	for (state == nil || len(state.Elements) == 0) && time.Now().Before(deadline) {
		if err := sleepContext(lease.ToolContext(), pagePoll); err != nil {
			return state, err
		}
		state = readWindowState(lease)
	}
	return state, nil
}

// launchMark is the active window before a launch, and the name of the file
// it opens: Mousepad may show the file in a new tab of the same window, or
// only focus the tab that already shows it, so only the title names it. For
// a URL it is the window title: a browser that is already active opens the
// page in a new tab of the same window.
type launchMark struct {
	window []byte
	file   string
	title  []byte
}

func markLaunch(lease *localLinuxLease, action desktopAction) (launchMark, error) {
	var mark launchMark
	var err error
	if mark.window, err = lease.Action("active-window"); err != nil {
		return mark, err
	}
	if action.command == "open" {
		mark.title, err = lease.Action("window-title")
		return mark, err
	}
	if len(action.values) > 1 {
		mark.file = filepath.Base(action.values[1])
	}
	return mark, nil
}

// opened reports whether another window is active, or the same window now
// names the launched file or shows another title.
func (mark launchMark) opened(lease *localLinuxLease) (bool, error) {
	current, err := lease.Action("active-window")
	if err != nil || !bytes.Equal(current, mark.window) || (mark.file == "" && mark.title == nil) {
		return err == nil && !bytes.Equal(current, mark.window), err
	}
	title, err := lease.Action("window-title")
	if err != nil {
		return false, err
	}
	if mark.title != nil {
		return !bytes.Equal(title, mark.title), nil
	}
	return bytes.Contains(title, []byte(mark.file)), nil
}

// awaitWindow waits until the launch opened its window, then lets the window
// draw. It polls the window id, which costs far less than comparing
// screenshots.
func awaitWindow(lease *localLinuxLease, before launchMark) (bool, error) {
	deadline := time.Now().Add(launchWait)
	for {
		opened, err := before.opened(lease)
		if err != nil {
			return false, err
		}
		if opened {
			return true, sleepContext(lease.ToolContext(), inputPause)
		}
		if time.Now().After(deadline) {
			return false, nil
		}
		if err := sleepContext(lease.ToolContext(), windowPoll); err != nil {
			return false, err
		}
	}
}
