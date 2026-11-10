package typedcard

import (
	"strings"
	"testing"
)

func TestOnboardingStatusTextTellsAnotherMeWhatSetupCollected(t *testing.T) {
	t.Parallel()
	gmail := []OnboardingConnection{{ID: "connection_gmail", AppName: "Gmail", AccountLabel: "ada@example.test"}}
	for name, test := range map[string]struct {
		status onboardingStatus
		want   []string
	}{
		"open, nothing shared": {
			onboardingStatus{},
			[]string{"Setup cards: not finished", "Connected apps: none.", "mention once that they can still connect", "Do not open the personal-profile Skill"},
		},
		"open, app connected": {
			onboardingStatus{connections: gmail},
			[]string{"- Gmail ada@example.test, connection connection_gmail", "ask whether to start now from what is connected so far"},
		},
		"finished, nothing shared": {
			onboardingStatus{finished: true, chatted: true},
			[]string{"Setup cards: finished.", "Links: none.", "Files: none.", "The Human shared nothing. Do not open the personal-profile Skill"},
		},
		"finished with sources after chatting": {
			onboardingStatus{finished: true, links: []string{"https://ada.example"}, chatted: true},
			[]string{"Links: https://ada.example", "ask the Human once whether to start now", "only offer to add the sources"},
		},
		"finished with sources, quiet": {
			onboardingStatus{finished: true, connections: gmail, files: 2},
			[]string{"Files: 2, attached to this message.", "Tell the Human you are starting their profile"},
		},
	} {
		text := onboardingStatusText(test.status)
		if !strings.HasPrefix(text, "Onboarding status from TeamHub") {
			t.Fatalf("%s: text=%q", name, text)
		}
		for _, want := range test.want {
			if !strings.Contains(text, want) {
				t.Fatalf("%s: missing %q in %q", name, want, text)
			}
		}
		// Exactly one instruction closes the status.
		instructions := 0
		for _, line := range strings.Split(text, "\n") {
			if strings.Contains(line, "personal-profile Skill") {
				instructions++
			}
		}
		if instructions != 1 {
			t.Fatalf("%s: instructions=%d in %q", name, instructions, text)
		}
	}
}
