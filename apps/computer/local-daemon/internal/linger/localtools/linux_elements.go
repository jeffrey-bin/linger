package localtools

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"sync"
)

// elementIndex numbers accessibility elements for the whole Operation, like
// OpenAI's Linux element IDs: one number always names one control, and a
// number whose control has gone fails instead of acting on whatever now sits
// at that position.
type elementIndex struct {
	mu      sync.Mutex
	byKey   map[string]int
	entries []elementEntry
}

type elementEntry struct {
	ref      json.RawMessage
	value    string
	complete bool
	editable bool
	// role, name, window and app describe the element for the permission
	// review.
	role, name, window, app string
}

type windowElement struct {
	Ref           json.RawMessage `json:"ref"`
	Role          string          `json:"role"`
	Name          string          `json:"name"`
	Value         *string         `json:"value"`
	ValueComplete bool            `json:"value_complete"`
	Editable      bool            `json:"editable"`
	States        []string        `json:"states"`
}

type windowState struct {
	Window   string          `json:"window"`
	App      string          `json:"app"`
	Focused  json.RawMessage `json:"focused"`
	Elements []windowElement `json:"elements"`
	Omitted  int             `json:"omitted"`
	// Truncated is set when the bounded read left out part of the window,
	// as on a large web page.
	Truncated bool `json:"truncated"`
	// Loading is set while a page in the window is still loading.
	Loading bool   `json:"loading"`
	Error   string `json:"error"`
	// AccessibilityOff is set when a window shows no controls and the
	// desktop's accessibility switch is off, which hides browsers' controls.
	AccessibilityOff bool `json:"-"`
	// windowID is the X11 id of the active window when it was read.
	windowID []byte
}

// minReadableElements is the smallest accessible window the Agent can act on
// from text alone. Fewer elements means the content is drawn, not exposed,
// so the observation keeps the screenshot.
const minReadableElements = 5

// readWindowState reads the active window's accessibility tree. A window
// without a readable tree, such as Chrome, is still named by its title; a nil
// state means not even the title could be read.
func readWindowState(lease *localLinuxLease) *windowState {
	data, err := lease.Action("semantic-ui", `{"kind":"state","target":"atspi:active"}`)
	state := &windowState{}
	if err != nil || json.Unmarshal(data, state) != nil || state.Error != "" {
		title, _ := lease.Action("window-title")
		name := strings.TrimSpace(string(title))
		if name == "" {
			return nil
		}
		state = &windowState{Window: name}
	}
	// A failed read leaves no id, and the next input goes unchecked.
	state.windowID, _ = lease.Action("active-window")
	if len(state.Elements) == 0 {
		switched, _ := lease.Action("accessibility")
		state.AccessibilityOff = string(switched) == "off"
	}
	return state
}

// needsScreenshot keeps the image where text cannot describe the window: no
// accessibility tree, too few elements, or a browser whose page content is
// served by the browser tools instead. A small dialog whose every control has
// a name is fully described by text. A browser known only by its title gets
// no image: the browser tools read its page, and screenshot shows it.
func (s *windowState) needsScreenshot() bool {
	if s != nil && len(s.Elements) == 0 && s.browserTitle() {
		return false
	}
	if s == nil || len(s.Elements) == 0 || (len(s.Elements) < minReadableElements && !s.allNamed()) {
		return true
	}
	app := strings.ToLower(s.App)
	return strings.Contains(app, "chrome") || strings.Contains(app, "chromium") || strings.Contains(app, "firefox")
}

// browserTitle reports a Chrome window left to the browser tools when it
// reads empty. With the accessibility switch off every Chrome reads empty,
// including the user's own, which the browser tools cannot reach; that one
// gets a screenshot and the note about the switch.
func (s *windowState) browserTitle() bool {
	return !s.AccessibilityOff && strings.HasSuffix(s.Window, " - Google Chrome")
}

func (s *windowState) allNamed() bool {
	for _, el := range s.Elements {
		if strings.TrimSpace(el.Name) == "" {
			return false
		}
	}
	return true
}

// describe numbers the elements and renders one line each. A star marks an
// element the Agent has not seen before, which is usually what its last
// input caused.
func (x *elementIndex) describe(s *windowState) string {
	x.mu.Lock()
	defer x.mu.Unlock()
	if x.byKey == nil {
		x.byKey = map[string]int{}
	}
	var b strings.Builder
	fmt.Fprintf(&b, "Window %q", s.Window)
	if s.App != "" {
		fmt.Fprintf(&b, " (%s)", s.App)
	}
	if len(s.Elements) == 0 && s.browserTitle() {
		b.WriteString(". Read and act on its page with the browser tools, such as browser_snapshot; call screenshot to see it.\n")
		return b.String()
	}
	if len(s.Elements) == 0 {
		b.WriteString(". Its controls cannot be read as text; call screenshot to see it.\n")
		if s.AccessibilityOff {
			b.WriteString(accessibilityOffNote)
		}
		return b.String()
	}
	b.WriteString(". Act on an element with click_element or set_value and its number; * marks an element that is new since the last observation.\n")
	for _, el := range s.Elements {
		key := string(el.Ref)
		number, seen := x.byKey[key]
		entry := elementEntry{ref: el.Ref, editable: el.Editable, complete: el.ValueComplete, role: el.Role, name: el.Name, window: s.Window, app: s.App}
		if el.Value != nil {
			entry.value = *el.Value
		}
		if !seen {
			number = len(x.entries) + 1
			x.byKey[key] = number
			x.entries = append(x.entries, entry)
		} else {
			x.entries[number-1] = entry
		}
		b.WriteString("[" + strconv.Itoa(number) + "]")
		if !seen {
			b.WriteString("*")
		}
		b.WriteString(" " + el.Role)
		if el.Name != "" {
			fmt.Fprintf(&b, " %q", el.Name)
		}
		if el.Value != nil {
			fmt.Fprintf(&b, " = %q", *el.Value)
		}
		if len(el.States) > 0 {
			b.WriteString(" (" + strings.Join(el.States, ", ") + ")")
		}
		b.WriteString("\n")
	}
	if s.Omitted > 0 {
		fmt.Fprintf(&b, "%d more elements omitted; use a screenshot for the rest.\n", s.Omitted)
	} else if s.Truncated {
		b.WriteString("The window has more controls than one read covers; use a screenshot for the rest.\n")
	}
	return b.String()
}

// accessibilityOffNote tells the Agent why a browser shows no controls. The
// switch is the user's system setting, so the Agent asks rather than flips it.
const accessibilityOffNote = "Desktop accessibility is off, so browsers and some applications expose no controls. Ask the user to turn it on with `gsettings set org.gnome.desktop.interface toolkit-accessibility true` and restart the application; until then act on screenshot coordinates.\n"

// target describes the element a number names, as last observed.
func (x *elementIndex) target(number int) (role, name, window, app string, ok bool) {
	x.mu.Lock()
	defer x.mu.Unlock()
	if number < 1 || number > len(x.entries) {
		return "", "", "", "", false
	}
	entry := x.entries[number-1]
	return entry.role, entry.name, entry.window, entry.app, true
}

var errStaleElement = errors.New("is not in the active window now; call get_window_state and use the new numbers")

// elementRequest builds the helper request for an element action. A value
// replacement also carries the value last observed, so a field that changed
// since then is refused instead of overwritten.
func (x *elementIndex) elementRequest(number int, value *string) (string, error) {
	x.mu.Lock()
	defer x.mu.Unlock()
	if number < 1 || number > len(x.entries) {
		return "", fmt.Errorf("element %d is unknown; call get_window_state first", number)
	}
	entry := x.entries[number-1]
	request := map[string]any{"kind": "press", "target": "atspi:active", "ref": entry.ref}
	if value != nil {
		if !entry.editable {
			return "", fmt.Errorf("element %d is not an editable field", number)
		}
		if !entry.complete {
			return "", fmt.Errorf("element %d holds more text than the observation showed; select it and type instead", number)
		}
		request = map[string]any{"kind": "apply", "target": "atspi:active", "ref": entry.ref, "value": *value, "expected_value": entry.value}
	}
	return semanticArgument(request)
}

// semanticArgument encodes an AT-SPI helper request as one desktop action
// argument, which holds at most 64 KiB; a larger request sends nothing.
func semanticArgument(request any) (string, error) {
	var data bytes.Buffer
	encoder := json.NewEncoder(&data)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(request); err != nil {
		return "", err
	}
	if data.Len() > 64*1024 {
		return "", errors.New("the text is too long for one desktop input; enter at most 16000 bytes at a time")
	}
	return strings.TrimSuffix(data.String(), "\n"), nil
}

// elementReceipt turns the helper's receipt into an error the Agent can act on.
func elementReceipt(number int, output []byte) error {
	var receipt struct {
		Status string `json:"status"`
		Error  string `json:"error"`
	}
	if json.Unmarshal(output, &receipt) != nil {
		return fmt.Errorf("element %d: unreadable desktop receipt", number)
	}
	switch receipt.Status {
	case "confirmed":
		if receipt.Error != "" {
			return fmt.Errorf("element %d: %s", number, receipt.Error)
		}
		return nil
	case "stale_before_input":
		return fmt.Errorf("element %d %w", number, errStaleElement)
	default:
		if receipt.Error != "" {
			return fmt.Errorf("element %d cannot take this action: %s", number, receipt.Error)
		}
		return fmt.Errorf("element %d cannot take this action", number)
	}
}
