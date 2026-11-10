package localtools

import (
	"strings"
	"testing"
)

func TestCountTabsReadsChromeEdgeAndFirefoxStrips(t *testing.T) {
	for name, tree := range map[string]string{
		"chrome": "- [2] AXRadioButton \"Feed\"\n- [3] AXButton \"Close\" [actions=[press]]\n- [4] AXRadioButton \"Post\"\n- [5] AXButton \"Close\" [actions=[press]]",
		"edge": "  - AXTabGroup \"Tab bar\"\n    - [23] AXPopUpButton \"Search tabs\" [actions=[press]]\n      - [24] AXRadioButton \"(en-us)\" [actions=[press]]\n        - [25] AXButton \"Close tab\" [actions=[press]]\n" +
			"      - [26] AXRadioButton \"Trail checklist - Pinboard\" [actions=[press]]\n        - [27] AXButton \"Close tab\" [actions=[press]]\n    - [28] AXButton \"New Tab\" [actions=[press]]",
		"firefox": "    - [2] AXTabGroup [actions=[press]]\n      - [3] AXRadioButton \"Feed\" [actions=[press]]\n        - [4] AXStaticText = \"Feed\" [actions=[press]]\n        - [5] AXButton \"Close tab\" [actions=[press]]\n" +
			"      - [6] AXRadioButton \"Post\" [actions=[press]]\n        - [7] AXStaticText = \"Post\" [actions=[press]]\n        - [8] AXButton \"Close tab\" [actions=[press]]\n      - [9] AXButton (Open a new tab) [actions=[press]]",
		"safari": "    - [17] AXRadioButton \"Trail checklist - Pinboard\" [id=TabBarTab?isPinned=false&isNarrow=false&isActive=false actions=[press,name:close tab]]\n" +
			"    - [18] AXRadioButton \"Start Page\" [id=TabBarTab?isPinned=false&isNarrow=false&isActive=true actions=[press,name:close tab]]",
	} {
		if got := countTabs(tree); got != 2 {
			t.Errorf("%s: %d tabs, want 2", name, got)
		}
	}
	// A page's own radio buttons are not tabs.
	if got := countTabs("- [9] AXRadioButton \"Small\"\n- [10] AXRadioButton \"Large\"\n- [11] AXButton \"Close\" [actions=[press]]"); got != 1 {
		t.Errorf("page radios: %d tabs, want 1", got)
	}
}

func TestPickAgentBrowserTakesTheFirstInstalledOrTheNamedOne(t *testing.T) {
	installed := agentBrowserInstalled
	t.Cleanup(func() { agentBrowserInstalled = installed })
	agentBrowserInstalled = func(b agentBrowser) bool { return b.Name == "Firefox" }
	if b, err := pickAgentBrowser(""); err != nil || b.Name != "Firefox" {
		t.Fatalf("got %v %v, want Firefox when only it is installed", b.Name, err)
	}
	if b, err := pickAgentBrowser("com.microsoft.edgemac"); err != nil || b.Name != "Edge" {
		t.Fatalf("got %v %v, want the named Edge", b.Name, err)
	}
	if _, err := pickAgentBrowser("com.apple.TextEdit"); err == nil {
		t.Fatal("a non-browser was accepted")
	}
	agentBrowserInstalled = func(agentBrowser) bool { return false }
	if _, err := pickAgentBrowser(""); err == nil || !strings.Contains(err.Error(), "COMPUTER_BROWSER_UNAVAILABLE") {
		t.Fatalf("got %v, want unavailable", err)
	}
	if !agentBrowserApp("", "Firefox") || !agentBrowserApp("com.google.Chrome", "") || !agentBrowserApp("com.apple.Safari", "Safari") || agentBrowserApp("com.apple.TextEdit", "TextEdit") {
		t.Fatal("agentBrowserApp misread an app")
	}
}
