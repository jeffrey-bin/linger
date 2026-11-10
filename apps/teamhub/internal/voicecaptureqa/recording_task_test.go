package voicecaptureqa

import (
	"strings"
	"testing"
	"time"
)

func TestContextMarkdownGivesTheAgentTheMeetingSoFar(t *testing.T) {
	markdown := ContextMarkdown(ContextInput{
		RecordedAt: time.Date(2026, 10, 12, 15, 30, 0, 0, time.UTC),
		Text:       "Zoe sends a competitor\ncomparison by Friday",
		AtMS:       70_000,
		Transcript: []ContextLine{
			{StartMS: 5_000, EndMS: 8_400, Speaker: "spk_1", Text: "Let us look at competitors"},
			{StartMS: 70_000, EndMS: 74_000, Speaker: "spk_2", Text: "Zoe sends a competitor comparison by Friday"},
			{StartMS: 3_725_000, EndMS: 3_726_500, Text: "Thanks all"},
		},
	})
	for _, want := range []string{
		"# Recording context — 2026-10-12 15:30",
		"## Request\n\n- Written by the recorder at 00:01:10: Zoe sends a competitor comparison by Friday",
		"- [00:00:05 - 00:00:08] Speaker 1: Let us look at competitors",
		"- [00:01:10 - 00:01:14] Speaker 2: Zoe sends a competitor comparison by Friday",
		"- [01:02:05 - 01:02:06] Thanks all",
	} {
		if !strings.Contains(markdown, want) {
			t.Fatalf("context misses %q:\n%s", want, markdown)
		}
	}
}

func TestContextMarkdownSaysWhenNothingIsConfirmedYet(t *testing.T) {
	markdown := ContextMarkdown(ContextInput{Text: "x"})
	if !strings.Contains(markdown, "(Nothing confirmed yet.)") {
		t.Fatalf("context = %s", markdown)
	}
}
