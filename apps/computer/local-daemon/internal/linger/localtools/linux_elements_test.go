package localtools

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func fixtureState(t *testing.T, app string, elements ...string) *windowState {
	t.Helper()
	state := &windowState{Window: "Untitled 1 - Mousepad", App: app}
	for _, name := range elements {
		value := ""
		el := windowElement{Ref: json.RawMessage(`{"path":"` + name + `"}`), Role: "push button", Name: name}
		if name == "field" {
			el.Role, el.Editable, el.ValueComplete, el.Value = "text", true, true, &value
		}
		state.Elements = append(state.Elements, el)
	}
	return state
}

func TestElementNumbersStayStableAndMarkNewElements(t *testing.T) {
	var index elementIndex
	first := index.describe(fixtureState(t, "mousepad", "Save", "field"))
	if !strings.Contains(first, `[1]* push button "Save"`) || !strings.Contains(first, `[2]* text "field" = ""`) {
		t.Fatalf("first observation:\n%s", first)
	}
	// A dialog adds a control; the old ones keep their numbers and lose the star.
	second := index.describe(fixtureState(t, "mousepad", "Cancel", "Save", "field"))
	if !strings.Contains(second, `[3]* push button "Cancel"`) || !strings.Contains(second, `[1] push button "Save"`) || !strings.Contains(second, `[2] text "field"`) {
		t.Fatalf("second observation:\n%s", second)
	}
}

func TestElementRequestsResolveObservedControls(t *testing.T) {
	var index elementIndex
	index.describe(fixtureState(t, "mousepad", "Save", "field"))
	request, err := index.elementRequest(1, nil)
	if err != nil || !strings.Contains(request, `"kind":"press"`) || !strings.Contains(request, `"path":"Save"`) {
		t.Fatalf("press request=%s err=%v", request, err)
	}
	value := "note.txt"
	request, err = index.elementRequest(2, &value)
	if err != nil || !strings.Contains(request, `"kind":"apply"`) || !strings.Contains(request, `"expected_value":""`) || !strings.Contains(request, `"value":"note.txt"`) {
		t.Fatalf("apply request=%s err=%v", request, err)
	}
	if _, err := index.elementRequest(1, &value); err == nil || !strings.Contains(err.Error(), "not an editable field") {
		t.Fatalf("button value err=%v", err)
	}
	if _, err := index.elementRequest(9, nil); err == nil || !strings.Contains(err.Error(), "get_window_state") {
		t.Fatalf("unknown number err=%v", err)
	}
}

func TestElementReceiptExplainsStaleNumbers(t *testing.T) {
	if err := elementReceipt(4, []byte(`{"status":"confirmed"}`)); err != nil {
		t.Fatal(err)
	}
	if err := elementReceipt(4, []byte(`{"status":"stale_before_input"}`)); !errors.Is(err, errStaleElement) {
		t.Fatalf("stale err=%v", err)
	}
	if err := elementReceipt(4, []byte(`{"status":"confirmed","error":"Exact readback failed after replacement"}`)); err == nil || !strings.Contains(err.Error(), "readback") {
		t.Fatalf("readback err=%v", err)
	}
}

func TestWindowStateKeepsScreenshotOnlyWhereTextCannotDescribeIt(t *testing.T) {
	five := []string{"a", "b", "c", "d", "e"}
	for _, test := range []struct {
		state *windowState
		want  bool
	}{
		{nil, true},
		{fixtureState(t, "mousepad", "a", ""), true},
		{fixtureState(t, "mousepad", "Failed to save", "OK"), false},
		{fixtureState(t, "mousepad", five...), false},
		{fixtureState(t, "Google Chrome", five...), true},
	} {
		if got := test.state.needsScreenshot(); got != test.want {
			t.Errorf("needsScreenshot(%+v) = %v", test.state, got)
		}
	}
}

func TestParseElementActions(t *testing.T) {
	action, err := parseDesktopAction("set_value", json.RawMessage(`{"element":3,"value":""}`))
	if err != nil || action.element != 3 || action.value == nil || *action.value != "" {
		t.Fatalf("set_value action=%+v err=%v", action, err)
	}
	if _, err := parseDesktopAction("set_value", json.RawMessage(`{"element":3}`)); err == nil {
		t.Fatal("set_value without a value was accepted")
	}
	if _, err := parseDesktopAction("click_element", json.RawMessage(`{"element":0}`)); err == nil {
		t.Fatal("element 0 was accepted")
	}
	action, err = parseDesktopAction("open_application", json.RawMessage(`{"application":"mousepad","path":"/home/agent/a.txt"}`))
	if err != nil || strings.Join(action.values, " ") != "mousepad /home/agent/a.txt" {
		t.Fatalf("open_application action=%+v err=%v", action, err)
	}
}

func TestSemanticArgumentKeepsMarkupAndRefusesOversizedText(t *testing.T) {
	encoded, err := semanticArgument(map[string]any{"value": strings.Repeat("<", 16000)})
	if err != nil || len(encoded) > 16100 || strings.Contains(encoded, `\u003c`) {
		t.Fatalf("len=%d err=%v", len(encoded), err)
	}
	if _, err := semanticArgument(map[string]any{"value": strings.Repeat("x", 70000)}); err == nil || !strings.Contains(err.Error(), "too long") {
		t.Fatalf("oversized err=%v", err)
	}
}

func TestTitleOnlyWindowNamesTheWindow(t *testing.T) {
	var index elementIndex
	app := &windowState{Window: "Untitled - GIMP"}
	if !app.needsScreenshot() || !strings.Contains(index.describe(app), "call screenshot") {
		t.Fatalf("an unreadable application keeps its screenshot: %q", index.describe(app))
	}
	browser := &windowState{Window: "Linux - Wikipedia - Google Chrome"}
	got := index.describe(browser)
	if browser.needsScreenshot() || !strings.Contains(got, `"Linux - Wikipedia - Google Chrome"`) || !strings.Contains(got, "browser_snapshot") {
		t.Fatalf("a browser is read by the browser tools: %q", got)
	}
	// With the switch off the user's own Chrome reads empty too, and the
	// browser tools cannot reach it.
	everyday := &windowState{Window: "Linux - Wikipedia - Google Chrome", AccessibilityOff: true}
	got = index.describe(everyday)
	if !everyday.needsScreenshot() || strings.Contains(got, "browser_snapshot") || !strings.Contains(got, "toolkit-accessibility") {
		t.Fatalf("a Chrome without accessibility keeps its screenshot and the switch note: %q", got)
	}
}
