package personalprofile

import (
	"errors"
	"strings"
	"testing"
)

func testDocument() Document {
	return Document{
		Name: "Lin Zhou",
		Background: Background{
			Overview: "Product design lead.",
			Timeline: []TimelineEntry{
				{Period: "2014–2018", Organization: "Tongji University", Place: "Shanghai", Role: "BA, Industrial Design"},
				{Period: "2019–Present", Organization: "Acme", Role: "Design lead", Description: "Leads the design system.", Details: []string{"Owns the component library"}},
				{Period: "2018", Organization: "Studio", Description: "Freelance work."},
			},
			Points: []Point{{Title: "Current work", Text: "Runs weekly critiques."}},
		},
		CommunicationStyle: Module{Overview: "Direct and brief."},
		WorkingStyle:       Module{Points: []Point{{Title: "Planning", Items: []string{"Writes plans first", "Reviews daily"}}}},
		Preferences:        Module{Overview: "Prefers async updates."},
		WritingStyle:       Module{Overview: "Short sentences."},
	}
}

func TestRenderProfileMarkdownProducesFixedShape(t *testing.T) {
	doc, err := NormalizeDocument(testDocument())
	if err != nil {
		t.Fatal(err)
	}
	want := `# Lin Zhou

## Background

Product design lead.

### Timeline

- 2014–2018 · Tongji University · Shanghai
  BA, Industrial Design
- 2019–Present · Acme
  Design lead | Leads the design system.
  - Owns the component library
- 2018 · Studio
  Freelance work.

### Current work

Runs weekly critiques.

## Communication Style

Direct and brief.

## Working Style

### Planning

- Writes plans first
- Reviews daily

## Preferences

Prefers async updates.

## Writing Style

Short sentences.`
	if got := renderProfileMarkdown(doc); got != want {
		t.Fatalf("rendered:\n%s", got)
	}
}

func TestNormalizeDocumentTrimsAndCanonicalizes(t *testing.T) {
	doc := testDocument()
	doc.Name = "  \u9879\u76ee Lin  "
	doc.Preferences.Points = nil
	normalized, err := NormalizeDocument(doc)
	if err != nil {
		t.Fatal(err)
	}
	if normalized.Name != "\u9879\u76ee Lin" || normalized.Preferences.Points == nil {
		t.Fatalf("normalized=%+v", normalized)
	}
	again, err := NormalizeDocument(normalized)
	if err != nil || string(CanonicalJSON(again)) != string(CanonicalJSON(normalized)) {
		t.Fatalf("normalization is not idempotent: %v", err)
	}
}

func TestNormalizeDocumentRejectsInvalidFields(t *testing.T) {
	cases := []struct {
		name  string
		edit  func(*Document)
		code  DocumentErrorCode
		field string
	}{
		{"empty module", func(d *Document) { d.WritingStyle = Module{Overview: "  "} }, ModuleEmpty, "writing_style"},
		{"empty background", func(d *Document) { d.Background = Background{} }, ModuleEmpty, "background"},
		{"missing name", func(d *Document) { d.Name = "" }, DocumentInvalid, "name"},
		{"heading line", func(d *Document) { d.Preferences.Overview = "Fine\n## Injected" }, DocumentInvalid, "preferences.overview"},
		{"script", func(d *Document) { d.Background.Overview = "<SCRIPT>x</script>" }, DocumentInvalid, "background.overview"},
		{"image", func(d *Document) { d.CommunicationStyle.Overview = "![x](y)" }, DocumentInvalid, "communication_style.overview"},
		{"line break in title", func(d *Document) { d.Background.Points[0].Title = "a\nb" }, DocumentInvalid, "background.points[0].title"},
		{"point without content", func(d *Document) { d.Background.Points[0].Text = "" }, DocumentInvalid, "background.points[0]"},
		{"timeline too long", func(d *Document) {
			d.Background.Timeline = make([]TimelineEntry, 41)
			for i := range d.Background.Timeline {
				d.Background.Timeline[i] = TimelineEntry{Period: "2020", Organization: "Acme"}
			}
		}, DocumentInvalid, "background.timeline"},
		{"too many details", func(d *Document) { d.Background.Timeline[1].Details = []string{"a", "b", "c", "d"} }, DocumentInvalid, "background.timeline[1].details"},
		{"invalid utf8", func(d *Document) { d.WritingStyle.Overview = "\xff" }, DocumentInvalid, "writing_style.overview"},
		{"oversized render", func(d *Document) {
			d.Background.Points = nil
			for i := 0; i < 20; i++ {
				d.Background.Points = append(d.Background.Points, Point{Title: "p", Text: strings.Repeat("x", 4000)})
				d.Preferences.Points = append(d.Preferences.Points, Point{Title: "p", Text: strings.Repeat("x", 4000)})
			}
		}, DocumentInvalid, "profile"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			doc := testDocument()
			tc.edit(&doc)
			_, err := NormalizeDocument(doc)
			var documentErr *DocumentError
			if !errors.As(err, &documentErr) || documentErr.Code != tc.code || documentErr.Field != tc.field || !errors.Is(err, ErrInvalid) {
				t.Fatalf("err=%v", err)
			}
		})
	}
}
