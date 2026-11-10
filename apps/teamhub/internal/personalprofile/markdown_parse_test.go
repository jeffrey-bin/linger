package personalprofile

import (
	"errors"
	"reflect"
	"strings"
	"testing"
)

func markdownTestDocument() Document {
	return Document{
		Name: "Avery",
		Background: Background{
			Overview: "Avery leads research at Example Lab.",
			Points:   []Point{{Title: "Focus", Text: "Agents and memory.", Items: []string{"Wiki", "Profile"}}},
			Timeline: []TimelineEntry{
				{Period: "–2013", Organization: "Example University", Role: "Bachelor of Engineering", Details: []string{}},
				{Period: "2019–Present", Organization: "Example Lab", Place: "Singapore", Role: "Founder", Description: "Builds the product.", Details: []string{"Raised a seed round", "Hired ten people"}},
			},
		},
		CommunicationStyle: Module{Overview: "Direct and brief.", Points: []Point{{Title: "Short replies", Text: "One line for routine traffic.", Items: []string{}}}},
		WorkingStyle:       Module{Overview: "Plans first.", Points: []Point{}},
		Preferences:        Module{Overview: "", Points: []Point{{Title: "Async", Text: "", Items: []string{"Written updates"}}}},
		WritingStyle:       Module{Overview: "Short sentences.", Points: []Point{}},
	}
}

func TestParseProfileMarkdownReadsTheRenderedLayoutBack(t *testing.T) {
	want, err := NormalizeDocument(markdownTestDocument())
	if err != nil {
		t.Fatal(err)
	}
	got, err := ParseProfileMarkdown(renderProfileMarkdown(want), "Avery")
	if err != nil {
		t.Fatal(err)
	}
	got, err = NormalizeDocument(got)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("round trip changed the Profile:\n got %+v\nwant %+v", got, want)
	}
}

func TestParseProfileMarkdownTakesAHumanEdit(t *testing.T) {
	markdown := strings.Join([]string{
		"## Background",
		"Avery leads research",
		"and hiring.",
		"",
		"### Timeline",
		"- 2019 · Example Lab",
		"  Researcher",
		"  - Shipped the first model",
		"",
		"## communication style",
		"Direct.",
		"## Working Style",
		"Plans first.",
		"## Preferences",
		"Async.",
		"## Writing Style",
		"Short.",
	}, "\n")
	doc, err := ParseProfileMarkdown(markdown, "Avery")
	if err != nil {
		t.Fatal(err)
	}
	if doc.Background.Overview != "Avery leads research and hiring." {
		t.Fatalf("overview=%q", doc.Background.Overview)
	}
	want := []TimelineEntry{{Period: "2019", Organization: "Example Lab", Role: "Researcher", Details: []string{"Shipped the first model"}}}
	if !reflect.DeepEqual(doc.Background.Timeline, want) {
		t.Fatalf("timeline=%+v", doc.Background.Timeline)
	}
	if doc.CommunicationStyle.Overview != "Direct." || doc.WritingStyle.Overview != "Short." {
		t.Fatalf("modules=%+v", doc)
	}
}

func TestParseProfileMarkdownNamesTheLineItCannotRead(t *testing.T) {
	for _, tc := range []struct {
		markdown string
		line     int
	}{
		{"Intro\n## Background\nText", 1},
		{"## Background\nText\n## Hobbies\nChess", 3},
		{"## Background\n### Timeline\n- 2019 Example Lab", 3},
		{"## Background\n### Timeline\n  Researcher", 3},
		{"## Background\nA\n## Background\nB", 3},
	} {
		_, err := ParseProfileMarkdown(tc.markdown, "Avery")
		var markdownErr *MarkdownError
		if !errors.As(err, &markdownErr) || markdownErr.Line != tc.line || !errors.Is(err, ErrInvalid) {
			t.Fatalf("%q: err=%v, want line %d", tc.markdown, err, tc.line)
		}
	}
}
