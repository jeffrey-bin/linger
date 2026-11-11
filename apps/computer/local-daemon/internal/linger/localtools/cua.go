package localtools

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"maps"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/mcpproxy"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/permission"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/process"
)

type cuaSession struct {
	op           *operation
	client       *mcpClient
	label        string
	desktopCheck func() error
	mu           sync.Mutex
	started      bool
	// desktop is a second Cua session for whole-screen tools. Cua makes a
	// desktop escalation permanent, which would disable the window tools.
	desktop bool
	// permitted caches a Windows UI Automation check; it cannot change while
	// the driver process runs at the same integrity level.
	permitted bool
	ended     bool
	unknown   *actionReceipt
	// servicePID is the macOS Cua service this session talks to, or 0.
	servicePID int
	// lost marks a session whose service has exited; the Operation opens a
	// new one on its next call.
	lost bool
	// leased is the macOS app the Computer last brought to the front, or 0.
	leased int
	// focus is, per macOS app, the window the Computer last saw become the
	// app's key window. Cua's z_index does not follow a window raised inside
	// an app, so this record decides which window holds the keys.
	focus map[int]focusRecord
	// named is, per macOS app, the window the Agent last named.
	named map[int]float64
	// input is, per macOS app, when the Agent last sent it input.
	input map[int]time.Time
}

func (c *cuaSession) checkDesktop() error {
	if c.desktopCheck != nil {
		return c.desktopCheck()
	}
	return desktopReady()
}

// inputSettle is how long a read of an app's focused window waits after
// input to that app. Cua no longer waits for a window change after each
// input, and a window that cmd+n opens is listed only after ~0.2 s.
var inputSettle = 300 * time.Millisecond

// focusRecord is an app's key window and the windows the app showed then. A
// window opened since, such as a new document, sheet or panel, opens in front.
type focusRecord struct {
	window float64
	known  map[float64]bool
}

// checkPermissionsTool is the Computer's own read-only desktop tool. Both the
// Cua catalog and the unavailable-driver catalog add it beside cuaTools.
const checkPermissionsTool = "check_permissions"

// cuaTools are the Cua 0.35.4 tools an Agent may call. Both platforms ship the
// same catalog; Cua owns the platform-specific input routes.
var cuaTools = map[string]bool{"list_windows": true, "get_window_state": true, "get_desktop_state": true, "get_screen_size": true, "get_cursor_position": true,
	"click": true, "double_click": true, "right_click": true, "move_cursor": true, "drag": true, "scroll": true, "type_text": true, "press_key": true, "hotkey": true,
	"clipboard_read": true, "clipboard_write": true, "launch_app": true, "bring_to_front": true, "set_window_frame": true}

func (m *Manager) openCua(ctx context.Context, op *operation) (*cuaSession, []tool, error) {
	if !filepath.IsAbs(m.options.CuaPath) {
		return nil, nil, errors.New("managed Cua driver is not installed; repair the Computer installation")
	}
	environment := append(append([]string{}, m.env...), cuaQuietEnvironment...)
	arguments := []string{"mcp", "--direct"}
	run := process.Run
	servicePID := 0
	if runtime.GOOS == "windows" {
		// Each Operation owns one in-process driver in the signed-in session;
		// Windows needs no permission grant beyond UI Automation.
		if err := interactiveSession(); err != nil {
			return nil, nil, err
		}
		// Applications that launch_app starts belong to the user. Only the
		// driver joins the Operation's Job Object, so task end never closes
		// them, as on macOS where Launch Services starts them.
		run = process.RunDirectChild
	} else {
		socket, err := m.ensureCuaService(ctx)
		if err != nil {
			return nil, nil, err
		}
		// The signed application owns TCC permissions. Embedded mode here applies
		// only to the proxy: it must not auto-launch another, prompting service.
		environment = append(environment, "CUA_DRIVER_EMBEDDED=1")
		arguments = []string{"mcp", "--socket", socket}
		servicePID = cuaServicePID(socket)
	}
	client, err := startClientWith(ctx, run, m.options.CuaPath, arguments, op.spec.WorkingDirectory, environment)
	var session *cuaSession
	if client != nil {
		session = &cuaSession{op: op, client: client, label: "linger-" + rand.Text(), servicePID: servicePID}
	}
	if err != nil {
		return session, nil, err
	}
	catalog, err := client.tools(ctx)
	if err != nil {
		return session, nil, err
	}
	var tools []tool
	for _, item := range catalog {
		if !cuaTools[item.Name] && (item.Name != "run_script" || runtime.GOOS != "darwin") {
			continue
		}
		var input map[string]any
		if json.Unmarshal(item.InputSchema, &input) != nil {
			return session, nil, errors.New("invalid Cua tool schema")
		}
		if props, ok := input["properties"].(map[string]any); ok {
			delete(props, "session")
		}
		if required, ok := input["required"].([]any); ok {
			kept := []any{}
			for _, key := range required {
				if key != "session" {
					kept = append(kept, key)
				}
			}
			input["required"] = kept
		}
		item.InputSchema, _ = json.Marshal(input)
		if inputTools[item.Name] {
			if runtime.GOOS == "darwin" {
				item.Description += macInputResult
			} else {
				item.Description += " With pid and window_id, the result ends with what changed in that window since your last read, as text with a new snapshot_id. The read replaces the snapshot, so use the new snapshot's tokens next. A screenshot follows only when the window has no readable tree. Send several inputs planned on one snapshot as one run_actions call."
			}
		}
		if item.Name == "launch_app" && runtime.GOOS == "darwin" {
			item.Description = "Open a macOS app in the background through Launch Services, as `open -g` does, and return its pid and windows. Optional urls are handed to the app; for Finder, pass a folder to open it in a window."
			item.InputSchema = schema(map[string]any{"bundle_id": map[string]string{"type": "string", "description": "Preferred, for example com.apple.TextEdit."}, "name": map[string]string{"type": "string", "description": "App name, when the bundle id is unknown."}, "urls": map[string]any{"type": "array", "items": map[string]string{"type": "string"}, "description": "Files or folders to open in the app."},
				"agent_browser": map[string]string{"type": "boolean", "description": "Open the URLs in the Computer's own browser, which keeps working while other windows cover it on the user's desktop and has its own sign-ins, instead of the user's everyday browser. With no bundle_id it is the first installed of Chrome, Edge, Firefox and Safari; a bundle_id of com.google.Chrome, com.microsoft.edgemac, org.mozilla.firefox or com.apple.Safari picks one. Safari has no separate profile, so there it is a window of its own in the user's Safari, with the user's sign-ins."}})
		}
		if item.Name == "get_desktop_state" {
			item.Description += " Read-only whole-screen view; act through the window tools with a pid and window_id. A system privacy prompt about CuaDriver belongs to the user: never answer it, and keep working through the window tools."
		}
		if compact, ok := macCompactTools[item.Name]; ok && runtime.GOOS == "darwin" {
			// Codex shows these tools directly, so the model sees every schema
			// field; only the fields the Computer routes stay.
			item.Description, item.InputSchema = compact.description, compact.schema()
		}
		if item.Name == "run_script" {
			item.Description, item.InputSchema = macScriptDescription, macScriptSchema()
		}
		if item.Name == "type_text" {
			item.Description += " In a macOS Open or Save panel, the name field takes a file name only: a slash there becomes a colon in the saved name. To choose the folder, press cmd+shift+g on that window, enter the folder path in the field that opens, press return, then set the name."
		}
		tools = append(tools, item)
	}
	names := slices.Sorted(maps.Keys(inputTools))
	step := map[string]any{"type": "object", "properties": map[string]any{"tool": map[string]any{"type": "string", "enum": names}}, "required": []string{"tool"}}
	batchDescription := "Preferred for two or more inputs you can already plan on one get_window_state snapshot, for example set a field, click Save and press Return. Each step names an input tool with its usual arguments, such as pid, window_id and element_token. Runs the steps in order, stops at the first failed step and says which steps ran, then reads the last step's window once, as one input does. Steps keep their tokens valid for the next steps; a token from an older read is refused."
	if runtime.GOOS == "darwin" {
		batchDescription = "Runs one or more planned inputs in one call, for example cmd+shift+g, type a path and press Return. Each step names an input tool with its usual arguments, such as pid, window_id and element_token. Runs the steps in order and stops at the first failed step and says which steps ran. Inputs keep the read's tokens valid, so later steps can use them; a token from an older read is refused, and a step with role and name is found when it runs. Steps report only whether they were sent. The call then reads the window once and returns what changed: by default the last step's window, or the app's focused window when that step names none; pass read with get_window_state arguments, such as {pid, window_id, query}, to read another window."
	}
	batchProperties := map[string]any{"actions": map[string]any{"type": "array", "minItems": 1, "maxItems": maxBatchActions, "items": step}}
	if runtime.GOOS == "darwin" {
		batchProperties["read"] = map[string]any{"type": "object", "description": "get_window_state arguments for the read after the last step; defaults to the last step's window with since: \"latest\"."}
	}
	tools = append(tools, tool{Name: "run_actions", Description: batchDescription, InputSchema: schema(batchProperties, "actions")})
	if runtime.GOOS == "darwin" {
		tools = append(tools, tool{Name: "recognize_text", Description: recognizeTextDescription, InputSchema: recognizeTextSchema()})
		tools = append(tools, tool{Name: "report_blocker", Description: reportBlockerDescription, InputSchema: reportBlockerSchema()})
	}
	tools = append(tools, tool{Name: checkPermissionsTool, Description: "Read Cua application permissions without prompting. Also reports an unresolved prior action.", InputSchema: schema(map[string]any{})})
	return session, tools, nil
}

// macKeyDescriptions replace Cua's descriptions of the macOS key tools,
// whose background and restore-the-previous-app delivery the Computer does
// not use.
var macKeyDescriptions = map[string]string{
	"press_key": "Press and release one key, with optional modifiers. Keys: return, tab, escape, up, down, left, right, space, delete, home, end, pageup, pagedown, f1-f12, any letter or digit.",
	"hotkey":    "Press a key combination such as [\"cmd\", \"s\"]: modifiers (cmd, shift, option, ctrl, fn) first, one other key last.",
	"type_text": "Type text. It does not press Return, Escape or arrows; use press_key for those.",
}

// MacToolGuide lists the macOS computer tools' call shapes for every
// Operation, which always has both tool servers. The model then plans a whole
// batch without reading each tool's schema first.
const MacToolGuide = `Computer tools on this Mac (MCP server "computer"):
- launch_app({bundle_id, urls?}) opens an app in the background and returns its pid and windows. list_windows({pid}) lists an app's windows.
- get_window_state({pid, window_id?, since?: "latest", query?, max_depth?}) reads a window as text; without window_id it reads the app's focused window, such as a sheet or panel just opened. Row [N] is element_token "<snapshot_id>:N". Read a Save or Open sheet with max_depth: 3: its name field, Where and buttons are within that depth, and its file list is slow to walk.
- run_actions({actions: [...], read?: {pid, window_id, query?}}) sends inputs in order in one call, then reads the window and returns what changed. The read follows the last step's window, or the app's focused window when that step names none; pass read to choose another. Steps:
  {tool: "click" | "double_click" | "right_click", pid, window_id, element_token, modifier?: ["cmd"]} on a row of the latest read; cmd-clicks add rows to a selection, so one cmd+c copies several files;
  {tool: "hotkey", pid, keys: ["cmd", "s"]}, {tool: "press_key", pid, key: "return"}, {tool: "type_text", pid, text} go to the app's focused field, such as a sheet, panel or rename field; a new Save sheet's name field already has focus with its text selected, so type the name without clicking, and text fields refuse click;
  {tool: "scroll", pid, window_id, direction}.
  A click, scroll or type_text, in a step or alone, can name its target with role and name instead of element_token: the one element with that role whose label or value is exactly name, or nth (from 0) when several match. It is found when it runs, so one batch can cross pages; finding it reads the window, which stales the tokens of your earlier read, so later steps name their targets the same way.
- run_script({script}) runs JavaScript that loops, waits and reads between inputs and returns only what you extract. Use it to repeat a flow over several items, such as open each result, read it and close it, in one call instead of a turn per item.
- bring_to_front({pid, window_id}) raises one window.
- recognize_text({pid, window_id, region?, pages?, next_key?}) reads the text in a window's pixels, such as words inside a picture, in any language; it types nothing. pages with next_key reads a picture viewer page by page in one call.
- report_blocker({kind, url}) as soon as a page in the Computer's own browser shows a check only the user may pass (captcha, verification, login_required, rate_limited) or one item that cannot be viewed (content_unavailable). Never try to pass the check.
The Computer's own browser takes input at a person's pace, within a budget per task and per day, and a script there sends at most 20 inputs: return what you have and look at the window before the next script. A tab that a link in the script opens is the task's and is in front afterwards. The browser tools stay off every site a task opened in that browser.
Plan as many steps as you can in one run_actions call, as in one script; its read shows their effect, so do not read again before the next input unless you need another window. Keys are often shorter than clicks: in Finder, cmd+shift+g then a path and Return opens a folder, cmd+down opens the selected item, and in the Trash cmd+delete puts the selected item back.
In Chrome, launch_app({bundle_id: "com.google.Chrome", urls: [url]}) opens a URL in a new tab without bringing Chrome forward; its pages read as empty while the window is covered or on another Space. Add agent_browser: true to use the Computer's own browser instead: it keeps working while covered and has its own sign-ins, but not on another desktop (Space). Chrome's own toolbar, such as Back and the address bar, refuses background input: press escape to close a page overlay, or hotkey cmd+[ to go back. A web control that ignores a background click, such as an option in a menu that opens on hover, takes one click with delivery_mode "foreground" at x,y of a screenshot.
A menu item in the read, such as File > Put Back, can be clicked directly; do not click a menu bar title first, because an open menu holds the app until it closes. A right_click menu does not show in the read, so select the row with click and use the menu bar item or its keyboard shortcut.
Before the first shell screenshot, or when one fails or comes back blank, run ` + "`teamhub computer permissions status`" + `; if Screen Recording is missing for Linger, run ` + "`teamhub computer permissions request --permissions screen_recording`" + ` and end your turn — the card wakes you. Never operate System Settings or privacy prompts yourself.
` + browserToolGuide

// browserToolGuide lists the Playwright browser tools, which Codex also defers.
const browserToolGuide = `Browser tools (MCP server "browser", when present): browser_navigate({url}), browser_snapshot() reads the page with element refs, browser_click({target}) and browser_type({target, text, submit?}) act on a ref from the latest snapshot, browser_tabs({action: "list" | "new" | "select" | "close"}). Each action returns the page snapshot after it, so call browser_snapshot only to read a page you have not changed.`

// macCompactTool is the macOS shape of one Cua tool: the fields the Computer
// routes, without Cua's delivery modes, scopes and capture ids.
type macCompactTool struct {
	description string
	properties  map[string]any
	required    []string
}

func (t macCompactTool) schema() json.RawMessage {
	encoded, _ := json.Marshal(schema(t.properties, t.required...))
	return encoded
}

var (
	macPID      = map[string]any{"type": "integer"}
	macWindowID = map[string]any{"type": "integer", "description": "Omit to use the app's focused window."}
	macToken    = map[string]any{"type": "string", "description": "\"<snapshot_id>:N\" from the latest read."}
	macPixel    = map[string]any{"type": "number", "description": "Pixels of the window's latest screenshot."}
	macString   = map[string]any{"type": "string"}
)

// macLocator names an input's target by role and label instead of a token:
// Cua finds it when the input runs, so it outlives later reads.
var (
	macRole  = map[string]any{"type": "string", "description": "Instead of element_token: the element's role from a read, such as AXButton; found when the input runs, and the window needs window_id."}
	macLabel = map[string]any{"type": "string", "description": "With role: the element's exact label or value as the read shows it."}
	macNth   = map[string]any{"type": "integer", "description": "With role and name: which of several equal elements, from 0."}
)

var macPointer = map[string]any{"pid": macPID, "window_id": macWindowID, "element_token": macToken, "x": macPixel, "y": macPixel, "role": macRole, "name": macLabel, "nth": macNth,
	"modifier":      map[string]any{"type": "array", "items": macString, "description": "Keys held during the click, such as [\"cmd\"] to add a Finder row to the selection; needs window_id."},
	"action":        map[string]any{"type": "string", "description": "An accessibility action other than press, from the element's actions in the read, such as show_alternate_ui to reveal hover-only controls."},
	"delivery_mode": map[string]any{"type": "string", "enum": []string{"background", "foreground"}, "description": "Default background. foreground sends a real pointer click at x,y: the Computer brings the window to the front first and the pointer moves. Use it only where a background click had no effect, such as a web page control that reacts only to a real pointer; needs window_id."}}

var macCompactTools = map[string]macCompactTool{
	"click":        {"Click an element by element_token from the latest get_window_state read, by role and name, or a point x,y of the window's latest screenshot." + macInputResult, macPointer, []string{"pid"}},
	"double_click": {"Double-click an element by element_token, by role and name, or a point x,y of the window's latest screenshot." + macInputResult, macPointer, []string{"pid"}},
	"right_click":  {"Right-click an element by element_token, by role and name, or a point x,y, to open its context menu; read the window to see the menu." + macInputResult, macPointer, []string{"pid"}},
	"hotkey":       {macKeyDescriptions["hotkey"] + macKeyRouting + macInputResult, map[string]any{"pid": macPID, "keys": map[string]any{"type": "array", "items": macString}, "window_id": macWindowID}, []string{"pid", "keys"}},
	"press_key":    {macKeyDescriptions["press_key"] + macKeyRouting + macInputResult, map[string]any{"pid": macPID, "key": macString, "modifiers": map[string]any{"type": "array", "items": macString}, "window_id": macWindowID}, []string{"pid", "key"}},
	"type_text":    {macKeyDescriptions["type_text"] + macKeyRouting + macInputResult, map[string]any{"pid": macPID, "text": macString, "window_id": macWindowID, "element_token": macToken, "role": macRole, "name": macLabel, "nth": macNth}, []string{"pid", "text"}},
	"scroll":       {"Scroll a window, or the element element_token, by amount lines in direction." + macInputResult, map[string]any{"pid": macPID, "window_id": macWindowID, "element_token": macToken, "role": macRole, "name": macLabel, "nth": macNth, "direction": map[string]any{"type": "string", "enum": []string{"up", "down", "left", "right"}}, "amount": map[string]any{"type": "integer"}}, []string{"pid", "direction"}},
	"get_window_state": {macWindowStateDescription, map[string]any{
		"pid": macPID, "window_id": macWindowID, "since": map[string]any{"type": "string", "description": "\"latest\" returns only what changed since your last read of this window."},
		"query": macString, "max_depth": map[string]any{"type": "integer"}, "max_elements": map[string]any{"type": "integer"},
		"timeout_ms": map[string]any{"type": "integer"}, "include_screenshot": map[string]any{"type": "boolean"},
	}, []string{"pid"}},
}

// macWindowStateDescription replaces Cua's, whose reads include a screenshot
// by default; on macOS the Computer reads text unless pixels are asked for.
const macWindowStateDescription = "Read a window as text: its accessibility tree as Markdown rows. Row [N] is addressed by element_token \"<snapshot_id>:N\", with snapshot_id from the response header. A read walks at most 500 nodes; narrow it with query (a case-insensitive substring) or raise max_elements. since:\"latest\" returns only what changed since your last read of this window, with a new snapshot_id. Without window_id, reads the app's focused window, including a sheet or panel that an input just opened. A Save or Open sheet shows its controls with max_depth:3; a deeper read also walks its file list and can run out of time. Each read replaces the window's snapshot and stales the old tokens. No screenshot is included; pass include_screenshot:true to see pixels, for example when the tree does not show what you need. A window without a readable tree is returned as a screenshot."

// macKeyRouting describes how the Computer delivers macOS keys.
const macKeyRouting = " The input goes to the focused field of the app with this pid, as a person's keys do: a sheet, panel or rename field that has focus receives it. Pass only pid to follow the app's focus; also pass window_id to require that this window holds the focus. The Computer first brings the app to the front and leaves it there; if the user has since brought another app forward, nothing is sent."

// macInputResult says what a macOS input returns. As in Codex, an input does
// not read the window: a chain of inputs reads once, when the Agent asks.
const macInputResult = " The result reports only whether the input was sent; read the window with get_window_state after the inputs whose effect you need."

// cuaQuietEnvironment keeps the pinned driver offline: no telemetry and no
// update check. Computer upgrades replace it with a reviewed release.
var cuaQuietEnvironment = []string{"CUA_TELEMETRY_ENABLED=false", "CUA_DRIVER_RS_UPDATE_CHECK=0"}

// cuaServiceEnvironment also stops the macOS service from waiting up to a
// second after each action for a window to change. As in Codex, the Agent
// reads the window itself after its inputs, so that wait only delayed each
// click and key by 0.3–0.4 seconds.
var cuaServiceEnvironment = append([]string{"CUA_DRIVER_WINDOW_CHANGE_TIMEOUT_MS=0"}, cuaQuietEnvironment...)

type cuaResult struct {
	IsError    bool `json:"isError"`
	Structured struct {
		Session         string `json:"session"`
		Active          *bool  `json:"active"`
		Code            string `json:"code"`
		Effect          string `json:"effect"`
		Detail          string `json:"detail"`
		Degraded        string `json:"degraded_reason"`
		Tool            string `json:"tool"`
		Accessibility   bool   `json:"accessibility"`
		ScreenRecording bool   `json:"screen_recording"`
		UIA             bool   `json:"uia"`
		Source          struct {
			Attribution string `json:"attribution"`
			Embedded    bool   `json:"embedded"`
		} `json:"source"`
	} `json:"structuredContent"`
}

func cuaPermissionsGranted(permission cuaResult, embedded bool) bool {
	if runtime.GOOS == "windows" {
		return !permission.IsError && permission.Structured.UIA
	}
	if permission.IsError || !permission.Structured.Accessibility || !permission.Structured.ScreenRecording {
		return false
	}
	if embedded {
		return permission.Structured.Source.Attribution == "host" && permission.Structured.Source.Embedded
	}
	return permission.Structured.Source.Attribution == "driver-daemon"
}

func (c *cuaSession) permissions(ctx context.Context) (json.RawMessage, error) {
	// Windows has no permission prompt, and Cua rejects the argument there.
	arguments := map[string]bool{"prompt": false}
	if runtime.GOOS == "windows" {
		arguments = map[string]bool{}
	}
	return c.client.request(ctx, "tools/call", map[string]any{"name": checkPermissionsTool, "arguments": arguments})
}

func (c *cuaSession) call(ctx context.Context, name string, args json.RawMessage) (output json.RawMessage, callErr error) {
	ctx, release, err := c.op.manager.holdLane(ctx, desktopLane)
	if err != nil {
		return nil, err
	}
	defer release()
	if c.needsFocus(ctx, name, args) {
		var releaseFocus func()
		if ctx, releaseFocus, err = c.op.manager.holdFocusedInput(ctx); err != nil {
			return nil, err
		}
		defer releaseFocus()
	}
	c.mu.Lock()
	pending := c.unknown != nil
	c.mu.Unlock()
	// Another call may have retired this session while this one waited for
	// the screen; a pending unknown action settles once the driver is gone.
	if c.retired() || pending && c.driverStopped() {
		return nil, errDriverGone
	}
	switch name {
	case checkPermissionsTool:
		return c.checkPermissionsCall(ctx)
	case "run_actions":
		return c.runActions(ctx, args)
	case "report_blocker":
		if runtime.GOOS == "darwin" {
			return c.reportBlocker(args)
		}
	}
	// A one-page read sends nothing. A paged read presses keys, so it takes
	// the lease and the action journal below as other input does.
	paged := name == "recognize_text" && runtime.GOOS == "darwin" && pagedRead(args)
	if name == "recognize_text" && runtime.GOOS == "darwin" && !paged {
		return c.recognizeText(ctx, args, false)
	}
	arguments, err := cuaCallArguments(args)
	if err != nil {
		return nil, err
	}
	agentChrome, err := c.claimAgentChromeInput(ctx, name, arguments, paged)
	if err != nil {
		return nil, err
	}
	// A Skill script names its window in args, which the script takes in. A
	// script that names none is taken to drive the window this task opened in
	// the Computer's own browser, if any. Only a script that goes to that
	// browser is paced; any script takes its lease.
	scriptTarget, _ := arguments["args"].(map[string]any)
	if name == "run_script" && agentChrome && (scriptTarget == nil || scriptTarget["pid"] == nil) {
		scriptTarget = c.agentChromeTarget()
	}
	ownScript := false
	if name == "run_script" && agentChrome && scriptTarget != nil {
		if ownScript, err = c.isAgentChrome(ctx, scriptTarget["pid"], scriptTarget["window_id"]); err != nil {
			return nil, err
		}
	}
	paced := agentChrome && (inputTools[name] || paged || ownScript)
	scriptInputs := 0
	if paced {
		// A script reserves nothing: its own pause runs inside it, and its
		// inputs are counted from its call log once it ends.
		reserve := 1
		if name == "run_script" {
			reserve = 0
		}
		left, err := c.paceAgentChrome(ctx, reserve)
		if err != nil {
			return nil, err
		}
		scriptInputs = min(agentChromeScriptInputs, left)
	}
	// target is the window an input goes to; a script names its own.
	target := arguments
	if name == "run_script" && scriptTarget != nil {
		target = scriptTarget
	}
	if paced {
		if err := c.checkAgentChromeTabs(ctx, target["pid"], target["window_id"]); err != nil {
			return nil, err
		}
	}
	if name == "run_script" {
		if err := scriptArguments(ctx, arguments, c.reviewScope(), scriptInputs); err != nil {
			return nil, err
		}
	}
	if err := c.checkDesktop(); err != nil {
		return nil, err
	}
	// timing splits one call into its phases, so a slow input names its cause.
	started := time.Now()
	var focusMs, driverMs int64
	defer func() {
		slog.Info("cua.call.timing", "tool", name, "pid", arguments["pid"], "window_id", arguments["window_id"], "since", arguments["since"] != nil, "focus_ms", focusMs, "driver_ms", driverMs, "total_ms", time.Since(started).Milliseconds(), "failed", callErr != nil)
	}()
	// Only the retained original transport can drain an older cancelled call.
	// This never constructs a new client to clear an unknown prior action.
	c.op.manager.retryCleanup()
	receipt, err := c.op.manager.journal.begin(ctx, actionIdentity{AgentID: c.op.spec.AgentID, OperationID: c.op.identity.OperationID, Session: c.label, Background: !holdsFocus(ctx)})
	if err != nil {
		return nil, err
	}
	confirmed := true
	defer func() {
		if callErr != nil && c.driverStopped() {
			// A stopped service runs no action, so the outcome is final.
			confirmed, callErr = true, errDriverStopped
		}
		if !confirmed {
			c.mu.Lock()
			c.unknown = receipt
			c.mu.Unlock()
			c.op.markUnknown()
		}
		if err := receipt.finish(confirmed); err != nil {
			c.mu.Lock()
			c.unknown = receipt
			c.mu.Unlock()
			c.op.markUnknown()
			callErr = errors.Join(callErr, mcpproxy.ErrCleanupUnconfirmed, err)
		}
	}()
	if err := c.requirePermissions(ctx); err != nil {
		return nil, err
	}
	if paged {
		result, err := c.recognizeText(ctx, args, agentChrome)
		confirmed = !errors.Is(err, errOutcomeUnknown)
		c.stampInput(arguments["pid"])
		return result, err
	}
	// Only a script to the Computer's own browser wakes it first.
	wake := scriptTarget
	if !ownScript {
		wake = nil
	}
	appKeys, textRead, err := c.prepareInput(ctx, name, arguments, agentChrome, wake)
	if err != nil {
		return nil, err
	}
	label, err := c.startInputSessions(ctx, name, arguments, appKeys)
	if err != nil {
		confirmed = !errors.Is(err, errOutcomeUnknown) && !errors.Is(err, errUnconfirmedSession)
		return nil, err
	}
	arguments["session"] = label
	owner, picked, pickConfirmed, err := c.pickFocusedWindow(ctx, name, arguments)
	if err != nil {
		confirmed = pickConfirmed
		return nil, err
	}
	if name == "launch_app" && runtime.GOOS == "darwin" {
		result, err := c.launchApp(ctx, arguments)
		confirmed = !errors.Is(err, errOutcomeUnknown)
		return result, err
	}
	if appKeys || runtime.GOOS == "darwin" && foregroundInput(name, arguments) {
		focusStarted := time.Now()
		err := c.focusApp(ctx, name, arguments)
		focusMs = time.Since(focusStarted).Milliseconds()
		if err != nil {
			confirmed = !errors.Is(err, errOutcomeUnknown)
			return nil, err
		}
	}
	driverStarted := time.Now()
	result, err := c.sendInput(ctx, name, arguments, appKeys, agentChrome)
	driverMs = time.Since(driverStarted).Milliseconds()
	if err == nil {
		result = c.annotateInputResult(name, result)
	}
	result, err = c.rereadWindow(ctx, name, arguments, result, err, owner, picked, textRead)
	confirmed = !errors.Is(err, errOutcomeUnknown)
	if paced && name == "run_script" && err == nil {
		c.countScriptInputs(result)
	}
	// A script that throws has still sent the inputs before the throw.
	if paced && (err == nil || name == "run_script") {
		c.recordAgentChromeTabs(ctx, target["pid"], target["window_id"])
	}
	return c.finishInput(ctx, name, arguments, appKeys, result, err)
}

// cuaReadTools send no input.
var cuaReadTools = map[string]bool{"list_windows": true, "get_window_state": true, "get_desktop_state": true, "get_screen_size": true, "get_cursor_position": true, checkPermissionsTool: true, "report_blocker": true}

// backgroundTools are the macOS inputs Cua delivers to the target app in the
// background, without the front window or the clipboard. A double-click is
// not one: when a Finder row refuses AXOpen, sendInput brings Finder to the
// front and double-clicks there.
var backgroundTools = map[string]bool{"click": true, "right_click": true, "scroll": true}

// needsFocus reports a call that must not run beside browser calls; see
// focusGate. Only reads and a macOS background input to a known app other
// than a Chromium browser run beside them. Keys and text may go to the
// front app or through the clipboard, and a script or a batch may send
// anything. Chrome is left out because its window may be a Playwright
// browser's, whose page a background click would meet mid-action.
func (c *cuaSession) needsFocus(ctx context.Context, name string, args json.RawMessage) bool {
	switch {
	case cuaReadTools[name]:
		return false
	case name == "recognize_text":
		// A paged read presses keys in the window.
		return runtime.GOOS != "darwin" || pagedRead(args)
	case runtime.GOOS != "darwin" || !backgroundTools[name]:
		return true
	}
	var arguments map[string]any
	if json.Unmarshal(args, &arguments) != nil {
		return true
	}
	if modifiers, _ := arguments["modifier"].([]any); len(modifiers) > 0 || foregroundInput(name, arguments) {
		return true
	}
	pid, _ := arguments["pid"].(float64)
	if token, ok := arguments["element_token"].(string); ok && pid == 0 {
		if key, _, found := c.op.reads.row(token); found {
			pid = float64(key.pid)
		}
	}
	return pid <= 0 || c.op.manager.chromiumProcess(ctx, int(pid))
}

// checkPermissionsCall answers check_permissions, which sends no input.
func (c *cuaSession) checkPermissionsCall(ctx context.Context) (json.RawMessage, error) {
	result, err := c.permissions(ctx)
	if err != nil {
		if c.driverStopped() {
			return nil, errDriverStopped
		}
		return nil, err
	}
	if c.op.manager.journal.blocked() {
		return nil, errors.New("COMPUTER_ACTION_UNKNOWN: an earlier action has no verified cleanup receipt; restart alone does not authorize new input")
	}
	return result, nil
}

// cuaCallArguments decodes an Agent's Cua arguments and refuses the fields the
// Computer owns.
func cuaCallArguments(args json.RawMessage) (map[string]any, error) {
	var arguments map[string]any
	if json.Unmarshal(args, &arguments) != nil || arguments == nil {
		return nil, errors.New("invalid Cua arguments")
	}
	if _, exists := arguments["session"]; exists {
		return nil, errors.New("Cua session is owned by the Operation")
	}
	for _, key := range []string{"window_id", "pid"} {
		if value, ok := arguments[key]; ok && value == nil {
			// A null id means none, as an absent one does.
			delete(arguments, key)
		}
	}
	for name := range arguments {
		if strings.HasPrefix(name, "_") {
			return nil, errors.New("Cua transport metadata is owned by the Computer")
		}
	}
	return arguments, nil
}

// claimAgentChromeInput reports whether the call reaches the Computer's own
// Chrome and, if so, claims it for this Operation.
func (c *cuaSession) claimAgentChromeInput(ctx context.Context, name string, arguments map[string]any, paged bool) (bool, error) {
	// The Computer's own browser takes input and window changes from one
	// Operation at a time. A script may reach any app from its body, and an
	// input without a pid may reach it by its element_token alone, so both
	// take the lease while that Chrome runs.
	agentChrome := false
	leased := inputTools[name] || windowTools[name] || paged
	if _, pid := arguments["pid"]; runtime.GOOS == "darwin" && (name == "run_script" || leased && !pid) {
		own, err := c.agentChromeRunning(ctx)
		if err != nil {
			return false, err
		}
		agentChrome = own > 0
	} else if leased {
		var err error
		if agentChrome, err = c.isAgentChrome(ctx, arguments["pid"], arguments["window_id"]); err != nil {
			return false, err
		}
	}
	if agentChrome {
		if err := c.claimAgentChrome(); err != nil {
			return false, err
		}
	}
	if modifiers, _ := arguments["modifier"].([]any); agentChrome && len(modifiers) > 0 && arguments["delivery_mode"] != "foreground" {
		return false, fmt.Errorf("COMPUTER_INPUT_NOT_SENT: a click with modifier keys needs the window in front, and the Computer's own browser is never brought forward for it; open a link with launch_app urls instead: %w", errNotSent)
	}
	return agentChrome, nil
}

// prepareInput resolves the call's target and defaults before any session
// starts. appKeys reports macOS keys that go to the app's focused field, and
// textRead a macOS window read the Computer turned into text.
func (c *cuaSession) prepareInput(ctx context.Context, name string, arguments map[string]any, agentChrome bool, scriptTarget map[string]any) (appKeys, textRead bool, err error) {
	modifiedClick(name, arguments)
	if name == "run_script" && agentChrome && scriptTarget != nil {
		if err := c.startSession(ctx, "auto"); err != nil {
			return false, false, err
		}
		if err := c.wakeAgentChrome(ctx, scriptTarget["pid"], scriptTarget["window_id"]); err != nil {
			return false, false, err
		}
	}
	if runtime.GOOS == "darwin" && located(name, arguments) {
		arguments["session"] = c.label
		if err := c.startSession(ctx, "auto"); err != nil {
			return false, false, err
		}
		if err := c.locate(ctx, name, arguments); err != nil {
			return false, false, err
		}
		delete(arguments, "session")
	}
	// On macOS, keys without an element or point go to the front app's
	// focused field through Cua's desktop session, as a person's keys do.
	// The Computer's own browser is never brought forward: its keys go to its
	// window in the background, which works while it is hidden.
	appKeys = runtime.GOOS == "darwin" && keyboardInput(name, arguments)
	if appKeys && agentChrome {
		if err := c.agentChromeKeys(ctx, arguments); err != nil {
			return false, false, err
		}
		appKeys = false
	}
	if pid, ok := arguments["pid"].(float64); ok && runtime.GOOS == "darwin" {
		if window, ok := arguments["window_id"].(float64); ok {
			c.mu.Lock()
			if c.named == nil {
				c.named = map[int]float64{}
			}
			c.named[int(pid)] = window
			c.mu.Unlock()
		}
	}
	// Like Codex's getAXState, a macOS read is text unless the Agent asks for
	// pixels. A window without a readable tree is read again with them.
	if name == "get_window_state" && runtime.GOOS == "darwin" {
		if _, ok := arguments["include_screenshot"]; !ok && arguments["include_accessibility_tree"] != false {
			arguments["include_screenshot"], textRead = false, true
		}
		// Cua stops at 250 nodes, which cuts a Finder list with its folders
		// expanded; the Agent then opens folders one by one to find a file.
		if _, ok := arguments["max_elements"]; !ok {
			arguments["max_elements"] = float64(500)
		}
		// Cua's 1000 ms walk budget cuts a browser page of a thousand nodes,
		// and a cut tree reads as degraded, so the read after every click on
		// such a page fell back to a screenshot the model then had to read
		// again as text.
		if _, ok := arguments["timeout_ms"]; !ok {
			arguments["timeout_ms"] = float64(windowReadTimeoutMs)
		}
	}
	if appKeys {
		if _, ok := arguments["scope"]; ok {
			return false, false, fmt.Errorf("COMPUTER_TARGET_REQUIRED: on macOS, keys go to the app named by pid, not to the desktop: %w", errNotSent)
		}
		if _, ok := arguments["target"]; ok {
			return false, false, fmt.Errorf("COMPUTER_TARGET_REQUIRED: on macOS, name the app with pid and optionally window_id, not target: %w", errNotSent)
		}
	}
	return appKeys, textRead, nil
}

// startInputSessions starts the Cua sessions the call needs and returns the
// session label its driver call names.
func (c *cuaSession) startInputSessions(ctx context.Context, name string, arguments map[string]any, appKeys bool) (string, error) {
	label, scope := c.label, "auto"
	if desktopScoped(name, arguments) {
		label, scope = c.desktopLabel(), "desktop"
	}
	scopes := []string{scope}
	if appKeys {
		// Focusing the app reads and fronts windows in the window session;
		// keys to the app's focus go through the desktop session.
		scopes = []string{"auto", "desktop"}
		// The Computer chooses the delivery of keys without an element.
		delete(arguments, "delivery_mode")
	}
	for _, scope := range scopes {
		if err := c.startSession(ctx, scope); err != nil {
			return "", err
		}
	}
	return label, nil
}

// pickFocusedWindow names the app's focused window for a macOS read without
// window_id. owner is the app's recorded key window when the read picked
// another one, such as a Save panel, whose controls macOS lists under the
// window it belongs to; picked lists the app's windows when the Computer
// chose the window. confirmed reports whether a failure left no unknown
// outcome.
func (c *cuaSession) pickFocusedWindow(ctx context.Context, name string, arguments map[string]any) (owner any, picked []listedWindow, confirmed bool, err error) {
	if _, ok := arguments["window_id"]; ok || name != "get_window_state" || runtime.GOOS != "darwin" || arguments["pid"] == nil {
		return nil, nil, true, nil
	}
	// Like Codex's getAXState, a read without a window reads the app's
	// focused window, where its keys go.
	number, _ := arguments["pid"].(float64)
	c.mu.Lock()
	sent := c.input[int(number)]
	c.mu.Unlock()
	if wait := time.Until(sent.Add(inputSettle)); wait > 0 {
		if err := sleepContext(ctx, wait); err != nil {
			return nil, nil, true, err
		}
	}
	windows, top, err := c.focusedWindow(ctx, arguments["pid"])
	if err != nil {
		return nil, nil, !errors.Is(err, errOutcomeUnknown), err
	}
	if top == nil {
		return nil, nil, true, fmt.Errorf("COMPUTER_WINDOW_NOT_FOUND: the app with pid %v shows no window", arguments["pid"])
	}
	arguments["window_id"] = top.WindowID
	c.mu.Lock()
	record, recorded := c.focus[int(number)]
	c.mu.Unlock()
	if recorded && record.window != top.WindowID {
		owner = record.window
	}
	return owner, windows, true, nil
}

// sendInput makes the driver call: keys to the app's focus, or the tool itself.
func (c *cuaSession) sendInput(ctx context.Context, name string, arguments map[string]any, appKeys, agentChrome bool) (json.RawMessage, error) {
	if appKeys {
		return c.sendKeys(ctx, name, arguments, int(arguments["pid"].(float64)))
	}
	result, err := c.client.request(ctx, "tools/call", map[string]any{"name": name, "arguments": arguments})
	if err == nil && runtime.GOOS == "darwin" && name == "double_click" && arguments["delivery_mode"] != "foreground" && !agentChrome && strings.Contains(string(result), "AXOpen returned -25205") {
		// Finder list rows refuse AXOpen, so nothing was sent. Open the
		// row as a person does: a double-click on the app in front.
		arguments["delivery_mode"] = "foreground"
		if err = c.focusApp(ctx, name, arguments); err == nil {
			result, err = c.client.request(ctx, "tools/call", map[string]any{"name": name, "arguments": arguments})
		}
	}
	return result, err
}

// annotateInputResult adds the notes that tell the Agent why a sent call had
// no useful effect.
func (c *cuaSession) annotateInputResult(name string, result json.RawMessage) json.RawMessage {
	if (failed(result) || bytes.Contains(result, []byte(`"degraded_reason"`))) && c.checkDesktop() != nil {
		// The screen locked during the call, as during a long script.
		result = withNote(result, "COMPUTER_DESKTOP_LOCKED: the screen locked during this call, so the steps after that failed. Tell the user and stop until they unlock it; do not try other routes.")
	}
	if runtime.GOOS == "darwin" && name == "click" && strings.Contains(string(result), "AXMenuBarItem") {
		// An open menu bar menu holds the app's input until it closes, as
		// Finder did after the Agent opened File to reach Put Back.
		result = withNote(result, "This click opened a menu bar menu, and the app takes no other input until it closes: click a menu item from the latest read, or press_key escape with only pid.")
	}
	if runtime.GOOS == "darwin" && name == "click" {
		// TextEdit's text view refuses AXPress, and a menu item whose title
		// changed since the read is not found; the Agent retried both.
		if strings.Contains(string(result), "AXPress) returned -25206") {
			result = withNote(result, "This element does not take a press. To write in a text area, send type_text with only pid: it goes to the focused field.")
		} else if strings.Contains(string(result), "invoke_menu: path segment") {
			result = withNote(result, "The menu item was not found by its title. Send the item's keyboard shortcut instead, such as cmd+shift+t for Format > Make Plain Text in TextEdit.")
		}
	}
	return result
}

// rereadWindow reads a window again when the first read cannot stand: a
// rejected delta, a picked window that closed, an empty sheet, or a tree that
// was not readable in time.
func (c *cuaSession) rereadWindow(ctx context.Context, name string, arguments map[string]any, result json.RawMessage, err error, owner any, picked []listedWindow, textRead bool) (json.RawMessage, error) {
	var reply cuaResult
	since, _ := arguments["since"].(string)
	if err == nil && name == "get_window_state" && since != "" &&
		json.Unmarshal(result, &reply) == nil && reply.IsError &&
		reply.Structured.Tool == name && reply.Structured.Code == "typed_output_mismatch" &&
		reply.Structured.Detail == "returned_element_count does not match elements" {
		// Cua 0.35.4 can reject its own delta-tree count. Read the same window
		// once without the delta baseline; never replay an input or a lost call.
		delete(arguments, "since")
		result, err = c.client.request(ctx, "tools/call", map[string]any{"name": name, "arguments": arguments})
	}
	if err == nil && picked != nil && cuaWindowNotFound(result) {
		// The picked window closed before the read, as a Go to Folder sheet
		// does after Return. Read the app's window again.
		if owner == nil {
			top, topErr := c.topWindow(ctx, arguments["pid"])
			if topErr == nil && top != nil && top.WindowID != arguments["window_id"] {
				owner = top.WindowID
			}
		}
		if owner != nil {
			arguments["window_id"] = owner
			result, err = c.client.request(ctx, "tools/call", map[string]any{"name": name, "arguments": arguments})
			owner = nil
		}
	}
	var read cuaResult
	if err == nil && picked != nil && json.Unmarshal(result, &read) == nil && !read.IsError && read.Structured.Degraded == "" {
		// A readable focused window becomes the app's key window, so a later
		// empty sheet falls back to the document it belongs to, not to the
		// window that held the keys before cmd+n opened this one.
		c.record(int(arguments["pid"].(float64)), arguments["window_id"].(float64), picked)
	}
	read = cuaResult{}
	if err == nil && owner != nil && json.Unmarshal(result, &read) == nil && !read.IsError && read.Structured.Degraded != "" {
		arguments["window_id"] = owner
		result, err = c.client.request(ctx, "tools/call", map[string]any{"name": name, "arguments": arguments})
		read = cuaResult{}
	}
	if err == nil && textRead && json.Unmarshal(result, &read) == nil && !read.IsError && read.Structured.Degraded != "" {
		// A tree that was only slow to walk, or not yet rebuilt after an
		// input, is still text: read it once more with a longer budget. Only
		// a window that is still unreadable then is shown as pixels.
		if sleepContext(ctx, windowRetryDelay) == nil {
			retry := maps.Clone(arguments)
			retry["timeout_ms"] = float64(windowRetryTimeoutMs)
			if again, againErr := c.client.request(ctx, "tools/call", map[string]any{"name": name, "arguments": retry}); againErr == nil {
				var reread cuaResult
				if json.Unmarshal(again, &reread) == nil && !reread.IsError && reread.Structured.Degraded == "" {
					result, read = again, reread
				}
			}
		}
		if read.Structured.Degraded != "" {
			delete(arguments, "include_screenshot")
			result, err = c.client.request(ctx, "tools/call", map[string]any{"name": name, "arguments": arguments})
		}
	}
	return result, err
}

// finishInput records what the call changed and shapes its result for the
// Agent.
func (c *cuaSession) finishInput(ctx context.Context, name string, arguments map[string]any, appKeys bool, result json.RawMessage, err error) (json.RawMessage, error) {
	if (inputTools[name] || appKeys) && runtime.GOOS == "darwin" {
		c.stampInput(arguments["pid"])
	}
	if name == "bring_to_front" && runtime.GOOS == "darwin" && err == nil && !failed(result) {
		// The Agent chose this app; later inputs may bring their apps
		// forward from it.
		if front, frontErr := frontmostPID(ctx); frontErr == nil && arguments["pid"] == float64(front) {
			c.mu.Lock()
			c.leased = front
			c.mu.Unlock()
			if window, ok := arguments["window_id"].(float64); ok {
				c.remember(ctx, front, window)
			}
		}
	}
	if err == nil && name == "get_window_state" && arguments["include_accessibility_tree"] != false {
		c.op.reads.observe(result)
	}
	if err == nil && inputTools[name] && ctx.Value(cuaInternalInput{}) == nil && runtime.GOOS != "darwin" {
		result = c.withWindowState(ctx, arguments, result)
	}
	if err == nil && name == "run_script" {
		result = compactScriptResult(result)
	}
	if err == nil && textResultTools[name] {
		result = withoutStructured(result)
	}
	if err == nil {
		// Window reads, desktop reads and the read after a batch all carry
		// screenshots; results without one pass through unchanged.
		result = compactScreenshots(result)
	}
	return result, err
}

// textResultTools are the Cua tools whose text content says all their
// structuredContent does. Claude Code shows a result's structuredContent as
// JSON in place of its text, so a window read reached the model as escaped
// Markdown wrapped in capture metadata, and a script's result as its full
// call log. list_windows keeps it: its text only counts the windows.
var textResultTools = map[string]bool{"get_window_state": true, "run_script": true, "click": true, "double_click": true, "right_click": true,
	"drag": true, "scroll": true, "type_text": true, "press_key": true, "hotkey": true}

// withoutStructured drops a result's structuredContent.
func withoutStructured(result json.RawMessage) json.RawMessage {
	var reply map[string]json.RawMessage
	if json.Unmarshal(result, &reply) != nil || reply["structuredContent"] == nil {
		return result
	}
	delete(reply, "structuredContent")
	if encoded, err := json.Marshal(reply); err == nil {
		return encoded
	}
	return result
}

// stampInput records that the Agent just sent input to the app pid.
func (c *cuaSession) stampInput(pid any) {
	number, ok := pid.(float64)
	if !ok {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.input == nil {
		c.input = map[int]time.Time{}
	}
	c.input[int(number)] = time.Now()
}

// errUnconfirmedSession reports a start_session reply that does not prove
// the owned session.
var errUnconfirmedSession = errors.New("Cua did not confirm the owned session")

// startSession starts the window ("auto") or desktop Cua session once.
func (c *cuaSession) startSession(ctx context.Context, scope string) error {
	label := c.label
	if scope == "desktop" {
		label = c.desktopLabel()
	}
	c.mu.Lock()
	started := c.started
	if scope == "desktop" {
		started = c.desktop
	}
	ended := c.ended
	if !ended && !started {
		// The same transport must retain cleanup authority even if the start
		// response is lost after the driver accepted it.
		if scope == "desktop" {
			c.desktop = true
		} else {
			c.started = true
		}
	}
	c.mu.Unlock()
	if ended {
		return errors.New("Cua Operation session has ended")
	}
	if started {
		return nil
	}
	result, err := c.client.request(ctx, "tools/call", map[string]any{"name": "start_session", "arguments": map[string]any{"session": label, "capture_scope": scope}})
	if err != nil {
		return err
	}
	var start cuaResult
	if json.Unmarshal(result, &start) != nil || start.Structured.Session != label || start.Structured.Active == nil || !*start.Structured.Active {
		return errUnconfirmedSession
	}
	return nil
}

// cuaInternalInput marks inputs run_actions sends, which read the window
// themselves.
type cuaInternalInput struct{}

// runActions sends inputs planned on one snapshot in order and reads the last
// window once. Each step is its own driver call: an input does not replace the
// snapshot, so later steps keep their tokens, and a token from an older read
// is refused instead of rebound to another element with the same label, as
// Cua run_steps would.
func (c *cuaSession) runActions(ctx context.Context, args json.RawMessage) (json.RawMessage, error) {
	var params struct {
		Actions []map[string]any `json:"actions"`
		Read    map[string]any   `json:"read"`
	}
	if json.Unmarshal(args, &params) != nil || len(params.Actions) == 0 || len(params.Actions) > maxBatchActions {
		return nil, fmt.Errorf("actions must list 1 to %d steps", maxBatchActions)
	}
	names := make([]string, len(params.Actions))
	for i, step := range params.Actions {
		names[i], _ = step["tool"].(string)
		if !inputTools[names[i]] {
			return nil, fmt.Errorf("step %d: tool must be one of the window input tools", i+1)
		}
		delete(step, "tool")
		for key := range step {
			if key == "session" || strings.HasPrefix(key, "_") {
				return nil, fmt.Errorf("step %d: %s is owned by the Computer", i+1, key)
			}
		}
	}
	internal := context.WithValue(ctx, cuaInternalInput{}, true)
	var reports []json.RawMessage
	first := 0
	total := len(params.Actions)
	// send runs steps first..last (0-based) as one driver call and keeps its
	// report. A failure names the completed prefix, the state of the failed
	// steps and the suffix that was never sent, so only inputs proven unsent
	// are resent.
	send := func(last int, name string, arguments any) (json.RawMessage, error) {
		encoded, _ := json.Marshal(arguments)
		result, err := c.call(internal, name, encoded)
		steps := fmt.Sprintf("Step %d", first+1)
		if last > first {
			steps = fmt.Sprintf("Steps %d-%d", first+1, last+1)
		}
		rest := ""
		if last+2 == total {
			rest = fmt.Sprintf(" Step %d was not sent.", total)
		} else if last+1 < total {
			rest = fmt.Sprintf(" Steps %d-%d were not sent.", last+2, total)
		}
		done := map[bool]string{true: "Step 1 completed. ", false: fmt.Sprintf("Steps 1-%d completed. ", first)}[first == 1]
		if first == 0 {
			done = ""
		}
		switch {
		case err == nil:
		case errors.Is(err, errNotSent):
			return nil, fmt.Errorf("%s%s was not sent: %w.%s", done, steps, err, rest)
		case errors.Is(err, errOutcomeUnknown):
			return nil, fmt.Errorf("%s%s has an unknown outcome: do not resend it. The Computer blocks further input in this task until the driver confirms its cleanup, so end the task and report what is known: %w.%s", done, steps, err, rest)
		default:
			return nil, fmt.Errorf("%s%s failed and may have taken effect: read the window before resending it: %w.%s", done, steps, err, rest)
		}
		var reply struct {
			IsError bool              `json:"isError"`
			Content []json.RawMessage `json:"content"`
		}
		if json.Unmarshal(result, &reply) == nil && reply.IsError {
			hint := ""
			if strings.Contains(string(result), "AXOpen returned -25205") {
				// Finder list rows refuse AXOpen, and the double-click in front
				// failed too; Codex opens them with keys.
				hint = " The element cannot be opened by double_click: click it, then send hotkey cmd+down, which opens the selected item in Finder."
			}
			note, _ := json.Marshal(map[string]string{"type": "text", "text": fmt.Sprintf("%s%s failed; the driver report below says which of them ran, and a failed step may have taken effect: read the window before resending it.%s%s", done, steps, rest, hint)})
			refused, _ := json.Marshal(map[string]any{"isError": true, "content": append(append(reports, note), reply.Content...)})
			return refused, nil
		}
		reports = append(reports, reply.Content...)
		first = last + 1
		return nil, nil
	}
	var target map[string]any
	for i, step := range params.Actions {
		if names[i] == "type_text" && i > 0 && (names[i-1] == "hotkey" || names[i-1] == "press_key") {
			// A shortcut such as cmd+shift+n or cmd+shift+g opens the field
			// the text is for a moment later; text sent before it lands in
			// the window, where a paste would drop copied files.
			if err := sleepContext(ctx, inputSettle); err != nil {
				return nil, fmt.Errorf("Steps 1-%d completed; steps %d-%d were not sent: %w", i, i+1, total, err)
			}
		}
		if refused, err := send(i, names[i], step); refused != nil || err != nil {
			return refused, err
		}
		if step["pid"] != nil {
			target = map[string]any{"pid": step["pid"], "window_id": step["window_id"], "session": c.label}
		}
	}
	if runtime.GOOS == "darwin" && params.Read == nil && target != nil {
		// Every input call ends with a read, as Codex's REPL ends a script
		// with getAXState, so the Agent never spends a turn only to look.
		params.Read = map[string]any{"pid": target["pid"], "since": "latest"}
		if target["window_id"] != nil {
			params.Read["window_id"] = target["window_id"]
		}
	}
	if runtime.GOOS == "darwin" && params.Read != nil {
		encoded, _ := json.Marshal(params.Read)
		read, err := c.call(ctx, "get_window_state", encoded)
		if err != nil {
			return nil, fmt.Errorf("Steps 1-%d completed; the read after them failed: %w", total, err)
		}
		var reply struct {
			Content []json.RawMessage `json:"content"`
		}
		if json.Unmarshal(read, &reply) == nil {
			reports = append(reports, reply.Content...)
		}
	}
	result, _ := json.Marshal(map[string]any{"content": reports})
	if target == nil || runtime.GOOS == "darwin" {
		// On macOS the read above already shows the effect.
		return result, nil
	}
	if target["window_id"] == nil {
		top, err := c.topWindow(ctx, target["pid"])
		if err != nil || top == nil {
			return result, nil //nolint:nilerr // the input was sent; a failed window lookup only skips the readback
		}
		target["window_id"] = top.WindowID
	}
	return c.withWindowState(ctx, target, result), nil
}

// inputTools change a window. Their results report delivery, and often an
// unverifiable effect, but not what the window shows afterwards.
var inputTools = map[string]bool{"click": true, "double_click": true, "right_click": true, "drag": true, "scroll": true, "type_text": true, "press_key": true, "hotkey": true}

// windowTools move or raise a window without sending it input.
var windowTools = map[string]bool{"bring_to_front": true, "set_window_frame": true}

// windowViewDelay lets an input's effect render before the read. Cua already
// waits for its own read-back after each input, so a short pause suffices.
var windowViewDelay = 100 * time.Millisecond

// windowRetryDelay is how long a failed read waits before its one retry.
var windowRetryDelay = 400 * time.Millisecond

// windowReadTimeoutMs is the walk budget of a macOS text read that names no
// timeout_ms. Cua's own default of 1000 ms is enough for a native window and
// too little for a browser page of a thousand nodes.
const windowReadTimeoutMs = 4000

// windowRetryTimeoutMs is the budget of the one text re-read of a window
// whose first read came back degraded.
const windowRetryTimeoutMs = 6000

// withWindowState appends what an input changed in its window, as text, so
// the Agent sees the effect and the new element tokens without another model
// turn. Like any read, it replaces the window's snapshot. A window without a
// readable tree gets a display-only screenshot instead.
func (c *cuaSession) withWindowState(ctx context.Context, arguments map[string]any, result json.RawMessage) json.RawMessage {
	pid, window := arguments["pid"], arguments["window_id"]
	var reply struct {
		IsError bool              `json:"isError"`
		Content []json.RawMessage `json:"content"`
	}
	var merged map[string]json.RawMessage
	if pid == nil || window == nil || json.Unmarshal(result, &reply) != nil || reply.IsError || json.Unmarshal(result, &merged) != nil {
		return result
	}
	select {
	case <-ctx.Done():
		return result
	case <-time.After(windowViewDelay):
	}
	read := func(args map[string]any) []json.RawMessage {
		args["pid"], args["window_id"], args["session"] = pid, window, arguments["session"]
		data, err := c.client.request(ctx, "tools/call", map[string]any{"name": "get_window_state", "arguments": args})
		if err == nil && args["include_accessibility_tree"] != false {
			c.op.reads.observe(data)
		}
		var view struct {
			IsError    bool              `json:"isError"`
			Content    []json.RawMessage `json:"content"`
			Structured struct {
				Degraded string `json:"degraded_reason"`
			} `json:"structuredContent"`
		}
		if err != nil || json.Unmarshal(data, &view) != nil || view.IsError || view.Structured.Degraded != "" {
			return nil
		}
		return view.Content
	}
	added := read(map[string]any{"since": "latest", "include_screenshot": false})
	if added == nil {
		// Cua 0.35.4 can reject its own delta tree; a full read is still text.
		added = read(map[string]any{"include_screenshot": false})
	}
	if added == nil && sleepContext(ctx, windowRetryDelay) == nil {
		// A window that has just opened can be unreadable for a moment.
		added = read(map[string]any{"include_screenshot": false})
	}
	if added == nil {
		for _, item := range read(map[string]any{"include_accessibility_tree": false, "display_only": true}) {
			var kind struct {
				Type string `json:"type"`
			}
			if json.Unmarshal(item, &kind) == nil && kind.Type == "image" {
				added = append(added, item)
			}
		}
	}
	if added == nil {
		// The input ran; only the read failed, so its effect is not known.
		note, _ := json.Marshal(map[string]string{"type": "text", "text": "COMPUTER_VIEW_UNAVAILABLE: the window could not be read after this input, so its effect is not shown; read it with get_window_state before relying on the effect."})
		added = []json.RawMessage{note}
	}
	merged["content"], _ = json.Marshal(append(reply.Content, added...))
	combined, _ := json.Marshal(merged)
	return compactScreenshots(combined)
}

// foregroundInputTools send real HID events in foreground mode.
var foregroundInputTools = map[string]bool{"click": true, "double_click": true, "right_click": true, "drag": true, "scroll": true, "type_text": true, "press_key": true, "hotkey": true}

// modifiedClick sends a click with modifier keys, such as a cmd-click that
// adds a Finder row to the selection, as a foreground event: Cua holds a
// modifier only for those.
func modifiedClick(name string, arguments map[string]any) {
	modifiers, _ := arguments["modifier"].([]any)
	if runtime.GOOS == "darwin" && len(modifiers) > 0 && (name == "click" || name == "double_click" || name == "right_click") {
		arguments["delivery_mode"] = "foreground"
	}
}

// foregroundInput reports whether a call asks Cua for real HID events.
func foregroundInput(name string, arguments map[string]any) bool {
	return foregroundInputTools[name] && arguments["delivery_mode"] == "foreground"
}

// keyboardInput reports whether an input carries keys without an element or
// a screen point. On macOS such keys go to the focused field of the front
// app, as a person's keys do.
func keyboardInput(name string, arguments map[string]any) bool {
	_, token := arguments["element_token"]
	_, x := arguments["x"]
	return !token && !x && !located(name, arguments) && (name == "press_key" || name == "hotkey" || name == "type_text")
}

// located reports whether an input names its target by role and label
// instead of an element_token or a point. Only input tools take such a
// target; launch_app's name is an app name.
func located(name string, arguments map[string]any) bool {
	_, role := arguments["role"]
	_, label := arguments["name"]
	return inputTools[name] && (role || label)
}

// locatorTools take a role and label target on macOS.
var locatorTools = map[string]bool{"click": true, "double_click": true, "right_click": true, "scroll": true, "type_text": true}

// locate replaces an input's role and label target with the token of the one
// element that has exactly that role and label, or value, in a fresh read of
// its window, so the target stays valid across the Agent's reads. A label
// that matches only part of another element's never counts: a vanished
// Delete must not become Delete all. Several matches need nth.
func (c *cuaSession) locate(ctx context.Context, name string, arguments map[string]any) error {
	if !locatorTools[name] {
		return fmt.Errorf("COMPUTER_TARGET_REQUIRED: %s takes no role and name target: %w", name, errNotSent)
	}
	if _, token := arguments["element_token"]; token {
		return fmt.Errorf("COMPUTER_TARGET_REQUIRED: name the target by element_token or by role and name, not both: %w", errNotSent)
	}
	role, _ := arguments["role"].(string)
	label, _ := arguments["name"].(string)
	if role == "" || label == "" || arguments["pid"] == nil || arguments["window_id"] == nil {
		return fmt.Errorf("COMPUTER_TARGET_REQUIRED: a role and name target needs pid, window_id, role and name: %w", errNotSent)
	}
	read, err := c.client.request(ctx, "tools/call", map[string]any{"name": "get_window_state", "arguments": map[string]any{
		"pid": arguments["pid"], "window_id": arguments["window_id"], "tree_format": "elements", "include_screenshot": false,
		"max_elements": 3000, "timeout_ms": float64(windowReadTimeoutMs), "session": arguments["session"]}})
	if err != nil {
		return err
	}
	var state struct {
		Structured struct {
			// elements_complete is false for every browser window, whose
			// toolbar Cua cannot prove whole, so only these two count.
			Truncated bool `json:"truncated"`
			Returned  *int `json:"returned_element_count"`
			Total     *int `json:"total_element_count"`
			Elements  []struct {
				Token string `json:"element_token"`
				Role  string `json:"role"`
				Label string `json:"label"`
				Value any    `json:"value"`
			} `json:"elements"`
		} `json:"structuredContent"`
	}
	_ = json.Unmarshal(read, &state)
	if state.Structured.Truncated || state.Structured.Returned != nil && state.Structured.Total != nil && *state.Structured.Returned < *state.Structured.Total {
		// An element left out of the read could be a second match.
		return fmt.Errorf("COMPUTER_TARGET_UNREADABLE: window %v was read only in part, so a %s labeled %q cannot be proven to be the only one; use an element_token from a read: %w", arguments["window_id"], role, label, errNotSent)
	}
	var matches []string
	for _, element := range state.Structured.Elements {
		if element.Role == role && (element.Label == label || element.Value == label) {
			matches = append(matches, element.Token)
		}
	}
	nth, hasNth := arguments["nth"].(float64)
	switch {
	case len(matches) == 0:
		return fmt.Errorf("COMPUTER_TARGET_NOT_FOUND: window %v shows no %s with exactly the label %q: %w", arguments["window_id"], role, label, errNotSent)
	case !hasNth && len(matches) > 1:
		return fmt.Errorf("COMPUTER_TARGET_AMBIGUOUS: window %v shows %d %s elements labeled %q; pass nth, from 0, or an element_token: %w", arguments["window_id"], len(matches), role, label, errNotSent)
	case hasNth && (nth < 0 || int(nth) >= len(matches)):
		return fmt.Errorf("COMPUTER_TARGET_NOT_FOUND: window %v shows %d %s elements labeled %q, so nth %v is out of range: %w", arguments["window_id"], len(matches), role, label, nth, errNotSent)
	}
	arguments["element_token"] = matches[int(nth)]
	delete(arguments, "role")
	delete(arguments, "name")
	delete(arguments, "nth")
	return nil
}

// listedWindow is one window from Cua list_windows.
type listedWindow struct {
	WindowID   float64 `json:"window_id"`
	Title      string  `json:"title"`
	AppName    string  `json:"app_name"`
	Layer      int     `json:"layer"`
	ZIndex     int     `json:"z_index"`
	IsOnScreen bool    `json:"is_on_screen"`
	// OnCurrentSpace is false for a window on another Space than the one
	// the user is on; Cua leaves it out when it cannot tell.
	OnCurrentSpace *bool `json:"on_current_space"`
	Bounds         struct {
		Width  float64 `json:"width"`
		Height float64 `json:"height"`
	} `json:"bounds"`
}

// frontmostPID returns the pid of the macOS front application.
var frontmostPID = func(ctx context.Context) (int, error) {
	front, err := exec.CommandContext(ctx, "/usr/bin/lsappinfo", "front").Output()
	if err != nil {
		return 0, err
	}
	return lsappPID(ctx, strings.TrimSpace(string(front)))
}

// lsappPID returns the pid of a running application, named by bundle id,
// name or Launch Services ASN.
func lsappPID(ctx context.Context, app string) (int, error) {
	info, err := exec.CommandContext(ctx, "/usr/bin/lsappinfo", "info", "-only", "pid", app).Output()
	if err != nil {
		return 0, err
	}
	_, value, _ := strings.Cut(strings.TrimSpace(string(info)), "=")
	pid, err := strconv.Atoi(strings.TrimSpace(value))
	if err == nil && pid > 0 {
		return pid, nil
	}
	// lsappinfo resolves a bundle id or name only while one instance runs.
	// With a second instance, such as a test Chrome with its own profile,
	// the first registered one is the instance Launch Services opens URLs in.
	for _, key := range []string{"bundleid", "name"} {
		found, findErr := exec.CommandContext(ctx, "/usr/bin/lsappinfo", "find", key+"="+app).Output()
		asn, _, _ := strings.Cut(strings.TrimSpace(string(found)), " ")
		if findErr != nil || !strings.HasPrefix(asn, "ASN:") {
			continue
		}
		return lsappPID(ctx, strings.TrimSuffix(asn, ":"))
	}
	return 0, fmt.Errorf("%s is not running", app)
}

// topWindow returns the app's key window: the recorded key window, or a
// window opened in front of it since; without a record, the front window by
// z_index. It returns nil when the app shows no window.
func (c *cuaSession) topWindow(ctx context.Context, pid any) (*listedWindow, error) {
	_, top, err := c.focusedWindow(ctx, pid)
	return top, err
}

// focusedWindow is topWindow that also returns the app's windows.
func (c *cuaSession) focusedWindow(ctx context.Context, pid any) ([]listedWindow, *listedWindow, error) {
	windows, err := c.appWindows(ctx, pid)
	if err != nil || len(windows) == 0 {
		return nil, nil, err
	}
	number, _ := pid.(float64)
	c.mu.Lock()
	record, ok := c.focus[int(number)]
	c.mu.Unlock()
	if !ok {
		return windows, &windows[0], nil
	}
	// A recorded window that closed or was minimized no longer holds the keys.
	index := slices.IndexFunc(windows, func(item listedWindow) bool { return item.WindowID == record.window && item.IsOnScreen })
	if index < 0 {
		return windows, &windows[0], nil
	}
	key, base, opened := &windows[index], windows[index].ZIndex, false
	for i := range windows {
		// An off-screen helper window, such as a Save panel's accessory
		// view, never holds the keys. A titled window opened since the
		// record wins even below it: Cua ranks a new TextEdit document under
		// the documents TextEdit restored. An untitled one, such as a sheet,
		// must rank above it, since Finder shows short-lived untitled windows.
		w := windows[i]
		if w.IsOnScreen && !record.known[w.WindowID] && (w.ZIndex > base || w.Title != "") && (!opened || w.ZIndex > key.ZIndex) {
			key, opened = &windows[i], true
		}
	}
	return windows, key, nil
}

// remember records window as the key window of the front app pid.
func (c *cuaSession) remember(ctx context.Context, pid int, window float64) {
	windows, err := c.appWindows(ctx, float64(pid))
	if err != nil {
		return
	}
	c.record(pid, window, windows)
}

// record sets window as the key window of app pid, with windows as the
// windows the app showed then.
func (c *cuaSession) record(pid int, window float64, windows []listedWindow) {
	known := map[float64]bool{}
	for _, item := range windows {
		known[item.WindowID] = true
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.focus == nil {
		c.focus = map[int]focusRecord{}
	}
	c.focus[pid] = focusRecord{window: window, known: known}
}

// errNotSent marks an input the Computer refused before any of it reached
// the driver, so resending it after a fix cannot repeat an effect.
var errNotSent = errors.New("nothing was sent")

// focusApp puts the app of a macOS key or foreground input in front and
// leaves it there, so the input reaches the app's focused field.
//
// It brings an app forward only on the Operation's first input or from the
// Computer's own previous app: when the user has brought another app to the
// front since, the user has taken over and nothing is sent. It never fronts
// a window of an app that is already in front, which would end a rename
// field or close a menu, and never redirects input to another window.
func (c *cuaSession) focusApp(ctx context.Context, name string, arguments map[string]any) error {
	pid, window := arguments["pid"], arguments["window_id"]
	number, ok := pid.(float64)
	if !ok {
		return fmt.Errorf("COMPUTER_TARGET_REQUIRED: keys and foreground input need the pid of the app: %w", errNotSent)
	}
	if _, ok := window.(float64); window != nil && !ok {
		return fmt.Errorf("COMPUTER_TARGET_REQUIRED: window_id must be a number: %w", errNotSent)
	}
	if window == nil && !keyboardInput(name, arguments) {
		return fmt.Errorf("COMPUTER_TARGET_REQUIRED: foreground input at an element or point needs pid and window_id: %w", errNotSent)
	}
	var fronted any
	for attempt := range 4 {
		front, err := c.checkFront(ctx, int(number))
		if err != nil {
			return err
		}
		if front == int(number) && fronted != nil {
			c.remember(ctx, front, fronted.(float64))
		}
		top, err := c.topWindow(ctx, pid)
		if err != nil {
			return err
		}
		if front == int(number) {
			if top != nil {
				c.mu.Lock()
				_, recorded := c.focus[front]
				c.mu.Unlock()
				if !recorded {
					c.remember(ctx, front, top.WindowID)
				}
			}
			if window != nil && (top == nil || top.WindowID != window) {
				above := "no window of this app is shown"
				if top != nil {
					above = fmt.Sprintf("window %v %q of this app is in front of it and would receive the input", top.WindowID, top.Title)
				}
				return fmt.Errorf("COMPUTER_INPUT_NOT_SENT: window %v is not the app's front window; %s: %w. To type into the app's focused field, pass only pid. To use window %v, call bring_to_front with it first", window, above, errNotSent, window)
			}
			c.mu.Lock()
			c.leased = front
			c.mu.Unlock()
			return nil
		}
		if attempt == 3 {
			return fmt.Errorf("COMPUTER_INPUT_NOT_SENT: the app with pid %v did not come to the front; the front app has pid %d: %w", pid, front, errNotSent)
		}
		if attempt > 0 {
			// macOS can refuse the first activation of a window that has just opened.
			if err := sleepContext(ctx, 300*time.Millisecond); err != nil {
				return err
			}
		}
		// A window the Agent named, or else the app's key window, comes
		// forward with the app.
		fronted = window
		if fronted == nil {
			c.mu.Lock()
			named, ok := c.named[int(number)]
			c.mu.Unlock()
			if ok && c.shows(ctx, pid, named) {
				fronted = named
			} else if top != nil {
				fronted = top.WindowID
			}
		}
		arguments := map[string]any{"pid": pid, "session": c.label}
		if fronted != nil {
			arguments["window_id"] = fronted
		}
		// Cua reports an activation it could not fully verify as an error,
		// although the app may have come to the front; the next pass checks.
		if _, err := c.client.request(ctx, "tools/call", map[string]any{"name": "bring_to_front", "arguments": arguments}); err != nil {
			return err
		}
	}
	return nil
}

// shows reports whether the app still shows window.
func (c *cuaSession) shows(ctx context.Context, pid any, window float64) bool {
	windows, err := c.appWindows(ctx, pid)
	return err == nil && slices.ContainsFunc(windows, func(item listedWindow) bool { return item.WindowID == window })
}

// checkFront returns the front app's pid, or refuses when the user has
// brought an app forward that is neither the target nor the Computer's own.
func (c *cuaSession) checkFront(ctx context.Context, target int) (int, error) {
	front, err := frontmostPID(ctx)
	if err != nil {
		return 0, err
	}
	c.mu.Lock()
	leased := c.leased
	c.mu.Unlock()
	if front != target && leased != 0 && front != leased {
		return 0, fmt.Errorf("COMPUTER_USER_TOOK_OVER: the user brought the app with pid %d to the front, so the Computer does not take the screen back by itself: %w. Ask the user, or call bring_to_front to continue", front, errNotSent)
	}
	return front, nil
}

// pasteboardScript keeps the pasteboard's items while text passes through
// it: "save" archives every item before it touches the pasteboard, puts the
// text there, marked transient for clipboard managers, and prints the change
// count and the archive; "restore <count>" puts the archive back unless the
// pasteboard changed since, so a file the Agent copied in Finder survives.
const pasteboardScript = `ObjC.import('AppKit');
function run(argv) {
	const pb = $.NSPasteboard.generalPasteboard;
	const input = $.NSString.alloc.initWithDataEncoding($.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile, $.NSUTF8StringEncoding);
	if (argv[0] === 'save') {
		const saved = $.NSMutableArray.array;
		const items = pb.pasteboardItems;
		for (let i = 0; i < items.count; i++) {
			const item = items.objectAtIndex(i);
			const kept = $.NSMutableDictionary.dictionary;
			for (let j = 0; j < item.types.count; j++) {
				const type = item.types.objectAtIndex(j);
				const data = item.dataForType(type);
				if (!data.isNil()) kept.setObjectForKey(data, type);
			}
			saved.addObject(kept);
		}
		const archived = $.NSPropertyListSerialization.dataWithPropertyListFormatOptionsError(saved, $.NSPropertyListBinaryFormat_v1_0, 0, null).base64EncodedStringWithOptions(0).js;
		pb.clearContents;
		pb.setStringForType(input, $.NSPasteboardTypeString);
		// Clipboard managers skip transient and concealed items.
		pb.setStringForType($(''), 'org.nspasteboard.TransientType');
		pb.setStringForType($(''), 'org.nspasteboard.ConcealedType');
		return pb.changeCount + '\n' + archived;
	}
	if (Number(pb.changeCount) !== Number(argv[1])) return 'changed';
	const data = $.NSData.alloc.initWithBase64EncodedStringOptions(input, 1);
	const saved = $.NSPropertyListSerialization.propertyListWithDataOptionsFormatError(data, 0, null, null);
	const items = $.NSMutableArray.array;
	for (let i = 0; i < saved.count; i++) {
		const kept = saved.objectAtIndex(i);
		const item = $.NSPasteboardItem.alloc.init;
		for (let j = 0; j < kept.allKeys.count; j++) {
			const type = kept.allKeys.objectAtIndex(j);
			item.setDataForType(kept.objectForKey(type), type);
		}
		items.addObject(item);
	}
	pb.clearContents;
	if (items.count > 0) pb.writeObjects(items);
	return 'restored';
}
`

// setClipboard puts text on the pasteboard and returns how to put the
// earlier items back. Saving and restoring run outside the call's context: a
// cancelled call must not leave the user's pasteboard half replaced.
var setClipboard = func(ctx context.Context, text string) (func(), error) {
	save, cancel := context.WithTimeout(context.WithoutCancel(ctx), pasteboardTimeout)
	defer cancel()
	command := exec.CommandContext(save, "/usr/bin/osascript", "-l", "JavaScript", "-e", pasteboardScript, "save")
	command.Stdin = strings.NewReader(text)
	output, err := command.Output()
	if err != nil {
		return nil, err
	}
	count, archive, _ := strings.Cut(strings.TrimSpace(string(output)), "\n")
	return func() {
		ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), pasteboardTimeout)
		defer cancel()
		restore := exec.CommandContext(ctx, "/usr/bin/osascript", "-l", "JavaScript", "-e", pasteboardScript, "restore", count)
		restore.Stdin = strings.NewReader(archive)
		if err := restore.Run(); err != nil {
			slog.Warn("cua.pasteboard.restore_failed", "error", err)
		}
	}, nil
}

// pasteboardTimeout bounds one pasteboard save or restore.
const pasteboardTimeout = 5 * time.Second

// pasteSettle is how long an app gets to read the pasteboard after cmd+v
// before the earlier items go back.
var pasteSettle = 200 * time.Millisecond

// typedChunk is how many characters go to the front app between checks that
// the user has not brought another app forward.
const typedChunk = 16

// sendKeys sends macOS keys or text once the app is in front, checking the
// front app before each key and each chunk of text. Without a window the
// keys go to the front app's focused field through Cua's desktop session;
// with one, Cua delivers them to that exact window and refuses when it does
// not hold the focus.
func (c *cuaSession) sendKeys(ctx context.Context, name string, arguments map[string]any, pid int) (json.RawMessage, error) {
	keys := map[string]any{}
	for _, field := range []string{"key", "keys", "modifiers", "delay_ms"} {
		if value, ok := arguments[field]; ok {
			keys[field] = value
		}
	}
	if arguments["window_id"] == nil {
		keys["scope"], keys["session"] = "desktop", c.desktopLabel()
	} else {
		keys["pid"], keys["window_id"], keys["delivery_mode"], keys["session"] = arguments["pid"], arguments["window_id"], "foreground", c.label
	}
	text, _ := arguments["text"].(string)
	if name == "type_text" && arguments["window_id"] == nil {
		// Cua inserts text into the app's focused element through
		// accessibility: bound to the pid, atomic, and free of autocorrect.
		// It refuses before sending when it cannot tell which window has the
		// focus, as in Finder with several windows or an Open or Save panel;
		// the text is then typed to the front app.
		if front, err := c.checkFront(ctx, pid); err != nil || front != pid {
			if err == nil {
				err = fmt.Errorf("COMPUTER_INPUT_NOT_SENT: the app with pid %d is no longer in front: %w", pid, errNotSent)
			}
			return nil, err
		}
		result, err := c.client.request(ctx, "tools/call", map[string]any{"name": name, "arguments": map[string]any{"pid": arguments["pid"], "text": text, "session": c.label}})
		if err != nil || !failed(result) || !axRefused(result) {
			return result, err
		}
		// Like Codex's paste, the text goes through the pasteboard in one
		// keystroke; typing it key by key takes seconds.
		if front, err := c.checkFront(ctx, pid); err != nil || front != pid {
			if err == nil {
				err = fmt.Errorf("COMPUTER_INPUT_NOT_SENT: the app with pid %d is no longer in front: %w", pid, errNotSent)
			}
			return nil, err
		}
		restore, err := setClipboard(ctx, text)
		if err != nil {
			return nil, fmt.Errorf("COMPUTER_INPUT_NOT_SENT: could not place the text on the pasteboard: %v: %w", err, errNotSent) //nolint:errorlint // the cause is detail; the call classifies as not sent only
		}
		// A cancelled request returns before the driver answers, and a cmd+v
		// it runs later would paste the restored pasteboard, so this one
		// request outlives a cancellation.
		paste, cancel := context.WithTimeout(context.WithoutCancel(ctx), pasteboardTimeout)
		result, err = c.client.request(paste, "tools/call", map[string]any{"name": "hotkey", "arguments": map[string]any{"keys": []string{"cmd", "v"}, "scope": "desktop", "session": c.desktopLabel()}})
		cancel()
		// Like Codex's paste, leave the pasteboard as it was, even when the
		// call is cancelled: the Agent or the user may paste it next.
		time.Sleep(pasteSettle)
		restore()
		if err != nil || failed(result) {
			return result, err
		}
		pasted, _ := json.Marshal(map[string]any{"content": []map[string]string{{"type": "text", "text": fmt.Sprintf("Pasted %d characters into the focused field of the front app.", len([]rune(text)))}}})
		return pasted, nil
	}
	runes := []rune(text)
	var result json.RawMessage
	for sent := 0; sent == 0 || sent < len(runes); {
		front, err := c.checkFront(ctx, pid)
		if err == nil && front != pid {
			err = fmt.Errorf("COMPUTER_INPUT_NOT_SENT: the app with pid %d is no longer in front: %w", pid, errNotSent)
		}
		if err != nil {
			if sent > 0 {
				return nil, fmt.Errorf("COMPUTER_INPUT_PARTIAL: typed the first %d of %d characters, then stopped: %v; read the field before typing the rest", sent, len(runes), err) //nolint:errorlint // a partial input must not inherit the cause's classification
			}
			return nil, err
		}
		end := len(runes)
		if name == "type_text" {
			end = min(sent+typedChunk, len(runes))
			keys["text"] = string(runes[sent:end])
		}
		if result, err = c.client.request(ctx, "tools/call", map[string]any{"name": name, "arguments": keys}); err != nil {
			if sent > 0 {
				err = fmt.Errorf("typed the first %d of %d characters before this failure: %w", sent, len(runes), err)
			}
			return nil, err
		}
		if failed(result) {
			if sent > 0 {
				return nil, fmt.Errorf("COMPUTER_INPUT_PARTIAL: typed the first %d of %d characters, then the driver refused the rest; read the field before typing the rest", sent, len(runes))
			}
			return result, nil
		}
		sent = max(end, 1)
	}
	return result, nil
}

// axRefused reports whether Cua refused accessibility text insertion before
// sending anything: Cua marks a result whose actuator never ran with effect
// "refused".
func axRefused(result json.RawMessage) bool {
	var reply cuaResult
	return json.Unmarshal(result, &reply) == nil && reply.IsError && reply.Structured.Effect == "refused"
}

// cuaWindowNotFound reports whether Cua rejected a window_id that no longer
// names a live window.
func cuaWindowNotFound(result json.RawMessage) bool {
	var reply cuaResult
	return json.Unmarshal(result, &reply) == nil && reply.IsError && reply.Structured.Code == "window_id_not_found"
}

// withNote appends a text note to a tool result's content.
func withNote(result json.RawMessage, note string) json.RawMessage {
	var reply map[string]any
	if json.Unmarshal(result, &reply) != nil {
		return result
	}
	content, _ := reply["content"].([]any)
	reply["content"] = append(content, map[string]any{"type": "text", "text": note})
	encoded, _ := json.Marshal(reply)
	return encoded
}

// failed reports whether a driver result is an error.
func failed(result json.RawMessage) bool {
	var reply struct {
		IsError bool `json:"isError"`
	}
	return json.Unmarshal(result, &reply) != nil || reply.IsError
}

func (c *cuaSession) requirePermissions(ctx context.Context) error {
	c.mu.Lock()
	permitted := c.permitted
	c.mu.Unlock()
	if permitted {
		return nil
	}
	permissions, err := c.permissions(ctx)
	if err != nil {
		return err
	}
	var permission cuaResult
	if json.Unmarshal(permissions, &permission) == nil && cuaPermissionsGranted(permission, c.op.manager.options.CuaEmbedded) {
		if runtime.GOOS == "windows" {
			c.mu.Lock()
			c.permitted = true
			c.mu.Unlock()
		}
		return nil
	}
	if runtime.GOOS == "windows" {
		return errors.New("COMPUTER_PERMISSION_REQUIRED: Windows UI Automation is unavailable to the Computer; it never elevates itself")
	}
	owner := "the signed CuaDriver application"
	if c.op.manager.options.CuaEmbedded {
		owner = "the trusted embedding host"
	}
	return errors.New("COMPUTER_PERMISSION_REQUIRED: " + owner + " lacks Accessibility or Screen Recording. Run `teamhub computer permissions request --for computer-use --permissions accessibility,screen_recording` to post a permission card for the user, then end your turn; the card wakes you once they grant them. Never operate System Settings or privacy prompts yourself")
}

// desktopScoped tools read or move across the whole screen. They run in the
// desktop session; everything else stays window-scoped.
func desktopScoped(name string, arguments map[string]any) bool {
	return name == "get_desktop_state" || name == "get_screen_size" || name == "get_cursor_position" || (name == "move_cursor" && arguments["scope"] == "desktop")
}

func (c *cuaSession) drain() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.ended {
		return nil
	}
	ctx, cancel := cleanupContext()
	defer cancel()
	for _, session := range []struct {
		label   string
		started *bool
	}{{c.label, &c.started}, {c.desktopLabel(), &c.desktop}} {
		if *session.started {
			if err := c.endSession(ctx, session.label); err != nil {
				return err
			}
			*session.started = false
		}
	}
	if err := c.unknown.finish(true); err != nil {
		return errors.Join(mcpproxy.ErrCleanupUnconfirmed, err)
	}
	c.unknown = nil
	c.ended = true
	return nil
}

func (c *cuaSession) desktopLabel() string { return c.label + "-desktop" }

func (c *cuaSession) endSession(ctx context.Context, label string) error {
	for {
		result, err := c.client.request(ctx, "tools/call", map[string]any{"name": "end_session", "arguments": map[string]string{"session": label}})
		if err != nil {
			return errors.Join(mcpproxy.ErrCleanupUnconfirmed, err)
		}
		var reply cuaResult
		if json.Unmarshal(result, &reply) != nil {
			return mcpproxy.ErrCleanupUnconfirmed
		}
		if !reply.IsError && reply.Structured.Session == label && reply.Structured.Active != nil && !*reply.Structured.Active {
			return nil
		}
		if reply.Structured.Code != "session_cleanup_pending" && reply.Structured.Code != "session_cleanup_partial" {
			return mcpproxy.ErrCleanupUnconfirmed
		}
		select {
		case <-ctx.Done():
			return mcpproxy.ErrCleanupUnconfirmed
		case <-time.After(100 * time.Millisecond):
		}
	}
}

func (c *cuaSession) close() error {
	err := c.drain()
	if err == nil {
		err = c.client.close()
	}
	return err
}

const maxBatchActions = 20

func schema(properties map[string]any, required ...string) json.RawMessage {
	if properties == nil {
		properties = map[string]any{}
	}
	value := map[string]any{"type": "object", "properties": properties, "additionalProperties": false}
	if len(required) > 0 {
		value["required"] = required
	}
	data, _ := json.Marshal(value)
	return data
}

func sleepContext(ctx context.Context, wait time.Duration) error {
	select {
	case <-ctx.Done():
		return context.Cause(ctx)
	case <-time.After(wait):
		return nil
	}
}

// launchAppWait bounds how long a launched app may take to show a window.
var launchAppWait = 5 * time.Second

// reviewScope is the scope a reviewed Run's Skill script reviews belong to,
// or empty when the Run's calls are not reviewed. It uses the executor's own
// test, so it names the Reviewer's ScriptScope exactly when one exists.
func (c *cuaSession) reviewScope() string {
	if !c.op.spec.ReviewsPermissions() {
		return ""
	}
	return permission.ScriptScope(c.op.spec.AgentID, c.op.spec.ScopeID)
}

// launchApp opens a macOS app through Launch Services in the background, as
// `open -g` does, and returns its pid and windows. Cua launch_app keeps the
// app it starts from coming to the front, so later keys could not reach it.

func (c *cuaSession) launchApp(ctx context.Context, arguments map[string]any) (json.RawMessage, error) {
	bundle, _ := arguments["bundle_id"].(string)
	name, _ := arguments["name"].(string)
	urls, _ := arguments["urls"].([]any)
	var addresses []string
	for _, item := range urls {
		url, ok := item.(string)
		if !ok || url == "" || strings.HasPrefix(url, "-") {
			return nil, errors.New("launch_app urls must be paths or URLs")
		}
		addresses = append(addresses, url)
	}
	if own, _ := arguments["agent_browser"].(bool); own {
		b, err := pickAgentBrowser(bundle)
		if err != nil {
			return nil, err
		}
		return c.launchAgentChrome(ctx, b, addresses)
	}
	app, flag := bundle, "-b"
	if app == "" {
		app, flag = name, "-a"
	}
	if app == "" {
		return nil, errors.New("launch_app needs bundle_id or name")
	}
	open := append([]string{"-g", flag, app}, addresses...)
	if err := c.op.refuseOtherBrowserOnChromeSite(addresses); err != nil {
		return nil, err
	}
	// Launch Services may hand a URL to the Computer's own browser when it is
	// the instance it knows, so opening that browser app takes its lease.
	if agentBrowserApp(bundle, name) {
		own, err := c.agentChromeRunning(ctx)
		if err != nil {
			return nil, err
		}
		if own > 0 {
			if err := c.claimAgentChrome(); err != nil {
				return nil, err
			}
		}
	}
	before := map[float64]bool{}
	running := false
	if pid, err := lsappPID(ctx, app); err == nil {
		running = true
		windows, err := c.appWindows(ctx, pid)
		if err != nil {
			return nil, err
		}
		for _, item := range windows {
			before[item.WindowID] = true
		}
	}
	if output, err := exec.CommandContext(ctx, "/usr/bin/open", open...).CombinedOutput(); err != nil {
		return nil, fmt.Errorf("launch_app: %s: %w", strings.TrimSpace(string(output)), err)
	}
	deadline := time.Now().Add(launchAppWait)
	if running && len(urls) > 0 {
		// A running app opens the URLs in a window it already shows, such as
		// a new tab in Chrome, so no new window will appear to wait for.
		if err := sleepContext(ctx, inputSettle); err != nil {
			return nil, err
		}
	}
	for {
		pid, pidErr := lsappPID(ctx, app)
		var windows []listedWindow
		if pidErr == nil {
			var err error
			if windows, err = c.appWindows(ctx, pid); err != nil {
				return nil, err
			}
		}
		opened := slices.ContainsFunc(windows, func(item listedWindow) bool { return !before[item.WindowID] })
		if pidErr == nil && (opened || (len(urls) == 0 || running) && len(windows) > 0) || time.Now().After(deadline) {
			if pidErr != nil {
				return nil, fmt.Errorf("launch_app: %s did not start", app)
			}
			text := fmt.Sprintf("Opened %s (pid %d) in the background.", app, pid)
			listed := []map[string]any{}
			for _, item := range windows {
				text += fmt.Sprintf("\n- %q [window_id: %v]", item.Title, item.WindowID)
				if !before[item.WindowID] {
					text += " new"
				}
				if !item.IsOnScreen {
					text += " not on this screen"
				}
				listed = append(listed, map[string]any{"window_id": item.WindowID, "title": item.Title, "new": !before[item.WindowID], "on_screen": item.IsOnScreen})
			}
			note := "Keys and text with only this pid go to the app's focused field; the Computer brings the app to the front first."
			if running && len(urls) > 0 {
				note = "The app was running, so it opened the URLs in its front window, the first one listed. " + note
			}
			text += "\n" + note
			return json.Marshal(map[string]any{"content": []any{map[string]string{"type": "text", "text": text}}, "structuredContent": map[string]any{"pid": pid, "windows": listed, "note": note}})
		}
		if err := sleepContext(ctx, 150*time.Millisecond); err != nil {
			return nil, err
		}
	}
}

// appWindows lists an app's ordinary windows, front first.
func (c *cuaSession) appWindows(ctx context.Context, pid any) ([]listedWindow, error) {
	result, err := c.client.request(ctx, "tools/call", map[string]any{"name": "list_windows", "arguments": map[string]any{"pid": pid, "session": c.label}})
	if err != nil {
		return nil, err
	}
	var listed struct {
		Structured struct {
			Windows []listedWindow `json:"windows"`
		} `json:"structuredContent"`
	}
	_ = json.Unmarshal(result, &listed)
	windows := slices.DeleteFunc(listed.Structured.Windows, func(item listedWindow) bool { return item.Layer != 0 })
	// A minimized window or one on another Space does not hold the keys.
	slices.SortStableFunc(windows, func(a, b listedWindow) int {
		if a.IsOnScreen != b.IsOnScreen {
			return map[bool]int{true: -1, false: 1}[a.IsOnScreen]
		}
		return b.ZIndex - a.ZIndex
	})
	return windows, nil
}
