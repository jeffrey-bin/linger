package permission

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"
)

// guiReuseTTL bounds how long an allow verdict for one desktop navigation
// shape stands in for the judge within a Run. Scrolling a page or dismissing
// its overlays repeats one shape many times, and judging each again cost
// eight seconds and told the judge nothing new. Clicks have no shape: the
// same window holds both a link that opens a post and a button that sends a
// comment, and a click by element_token does not show which one it is.
const guiReuseTTL = 10 * time.Minute

// reusableKeys are the press_key keys a reused verdict covers: they move
// within or dismiss what is on screen and submit nothing. Return, space and
// the letters stay out, because they can send what was typed before them.
var reusableKeys = map[string]bool{"escape": true, "up": true, "down": true, "left": true, "right": true, "pageup": true, "pagedown": true, "home": true, "end": true}

// reusableHotkeys switch tabs, go back and forward, or open an empty tab or
// the address bar. Modifiers are sorted, the key comes last. cmd+w and the
// edit shortcuts stay out: they close or change something.
var reusableHotkeys = map[string]bool{
	"cmd+1": true, "cmd+2": true, "cmd+3": true, "cmd+4": true, "cmd+5": true, "cmd+6": true, "cmd+7": true, "cmd+8": true, "cmd+9": true,
	"cmd+[": true, "cmd+]": true, "cmd+shift+[": true, "cmd+shift+]": true,
	"cmd+option+left": true, "cmd+option+right": true, "ctrl+tab": true, "ctrl+shift+tab": true,
	"cmd+left": true, "cmd+right": true, "cmd+l": true, "cmd+t": true,
}

// GUIReuseKey names the shape of a desktop navigation call: a movement or
// dismissal key, a tab or history shortcut, a scroll, a paged recognize_text
// (which has the shape of its next_key), or a run_actions batch made only of
// those. Calls of one shape share an allow verdict within a Run
// (see Reviewer). Clicks, typing, dragging, scripts and other shortcuts have
// no shape: each is judged on its own.
func GUIReuseKey(tool, input string) (string, bool) {
	var arguments map[string]any
	if json.Unmarshal([]byte(input), &arguments) != nil {
		return "", false
	}
	if tool == "mcp__computer__run_actions" {
		steps, _ := arguments["actions"].([]any)
		if len(steps) == 0 {
			return "", false
		}
		keys := make([]string, 0, len(steps))
		for _, step := range steps {
			fields, _ := step.(map[string]any)
			name, _ := fields["tool"].(string)
			key, ok := stepReuseKey(name, fields)
			if !ok {
				return "", false
			}
			keys = append(keys, key)
		}
		return "run_actions:" + strings.Join(keys, ";"), true
	}
	name, ok := strings.CutPrefix(tool, "mcp__computer__")
	if !ok {
		return "", false
	}
	if name == "recognize_text" {
		// The read itself is display-only; the keys between pages are what
		// is judged, so the call shares the verdict of that key.
		for field := range arguments {
			switch field {
			case "pid", "window_id", "region", "pages", "next_key":
			default:
				return "", false
			}
		}
		key, _ := arguments["next_key"].(string)
		step := map[string]any{"key": key}
		for _, field := range []string{"pid", "window_id"} {
			if value, present := arguments[field]; present {
				step[field] = value
			}
		}
		return stepReuseKey("press_key", step)
	}
	return stepReuseKey(name, arguments)
}

// reusableFields are the arguments a navigation step of each tool may carry.
// A step with any other argument has no shape, so the judge sees it: an
// allow for the shape never covers an option the judge did not see.
var reusableFields = map[string]map[string]bool{
	"scroll":    {"direction": true, "amount": true, "by": true, "element_token": true, "x": true, "y": true},
	"press_key": {"key": true, "element_token": true},
	"hotkey":    {"keys": true},
}

func stepReuseKey(name string, arguments map[string]any) (string, bool) {
	// A foreground input fronts the window and moves the pointer: the judge
	// sees each one.
	if mode, present := arguments["delivery_mode"]; present && mode != "background" {
		return "", false
	}
	for field := range arguments {
		switch field {
		case "tool", "pid", "window_id", "delivery_mode":
		default:
			if !reusableFields[name][field] {
				return "", false
			}
		}
	}
	pid, ok := arguments["pid"].(float64)
	if !ok {
		return "", false
	}
	window := "-"
	if id, ok := arguments["window_id"].(float64); ok {
		window = fmt.Sprint(int64(id))
	}
	target := fmt.Sprintf("@%d/%s", int64(pid), window)
	switch name {
	case "scroll":
		return "scroll" + target, true
	case "press_key":
		key, _ := arguments["key"].(string)
		key = strings.ToLower(key)
		if modifiers, _ := arguments["modifiers"].([]any); len(modifiers) > 0 || !reusableKeys[key] {
			return "", false
		}
		return "press_key:" + key + target, true
	case "hotkey":
		raw, _ := arguments["keys"].([]any)
		if len(raw) < 2 {
			return "", false
		}
		keys := make([]string, 0, len(raw))
		for _, item := range raw {
			key, _ := item.(string)
			keys = append(keys, strings.ToLower(key))
		}
		modifiers := keys[:len(keys)-1]
		sort.Strings(modifiers)
		combo := strings.Join(append(modifiers, keys[len(keys)-1]), "+")
		if !reusableHotkeys[combo] {
			return "", false
		}
		return "hotkey:" + combo + target, true
	}
	return "", false
}
