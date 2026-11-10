package personalprofile

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"unicode/utf8"
)

// Document is the structured Personal Profile. TeamHub owns its Markdown
// rendering; readers use the fields, never the rendered headings.
type Document struct {
	Name               string     `json:"name"`
	Background         Background `json:"background"`
	CommunicationStyle Module     `json:"communication_style"`
	WorkingStyle       Module     `json:"working_style"`
	Preferences        Module     `json:"preferences"`
	WritingStyle       Module     `json:"writing_style"`
}

// Module is one Profile module: an overview paragraph and topical points.
type Module struct {
	Overview string  `json:"overview"`
	Points   []Point `json:"points"`
}

// Background is the Background module plus its education and work timeline.
type Background struct {
	Overview string          `json:"overview"`
	Points   []Point         `json:"points"`
	Timeline []TimelineEntry `json:"timeline"`
}

// Point keeps the generated contract's field order so the app layer can
// convert it directly.
type Point struct {
	Items []string `json:"items"`
	Text  string   `json:"text"`
	Title string   `json:"title"`
}

// TimelineEntry keeps the generated contract's field order so the app layer
// can convert it directly. Period and Organization are required; an empty
// Place, Role or Description means the value is unknown.
type TimelineEntry struct {
	Description  string   `json:"description"`
	Details      []string `json:"details"`
	Organization string   `json:"organization"`
	Period       string   `json:"period"`
	Place        string   `json:"place"`
	Role         string   `json:"role"`
}

// DocumentErrorCode classifies why a submitted Document was rejected.
type DocumentErrorCode string

// The codes a rejected Document reports, one per failed rule.
const (
	// DocumentInvalid marks a Document whose shape or a field fails validation.
	DocumentInvalid DocumentErrorCode = "profile_document_invalid"
	// ModuleEmpty marks a required module that carries no content.
	ModuleEmpty DocumentErrorCode = "profile_module_empty"
)

// DocumentError names the rejected field; it matches ErrInvalid.
type DocumentError struct {
	Code  DocumentErrorCode
	Field string
}

func (e *DocumentError) Error() string {
	return fmt.Sprintf("personal profile document %s: %s", e.Code, e.Field)
}

func (e *DocumentError) Unwrap() error { return ErrInvalid }

const (
	maxRenderedProfileBytes = 100_000
	maxModulePoints         = 20
	maxPointItems           = 20
	maxTimelineEntries      = 40
	maxTimelineDetails      = 3
)

// Headings belong to the renderer only; no reader parses them.
const (
	headingBackground         = "Background"
	headingTimeline           = "Timeline"
	headingCommunicationStyle = "Communication Style"
	headingWorkingStyle       = "Working Style"
	headingPreferences        = "Preferences"
	headingWritingStyle       = "Writing Style"
)

// NormalizeDocument trims every text field, replaces absent lists with empty
// ones, and validates the result. Both write paths call it before rendering,
// so equal normalized documents have equal canonical JSON.
func NormalizeDocument(doc Document) (Document, error) {
	v := &documentValidator{}
	out := Document{Name: v.line("name", doc.Name, 1, 200)}
	out.Background = Background{
		Overview: v.paragraph("background.overview", doc.Background.Overview),
		Points:   v.points("background.points", doc.Background.Points),
		Timeline: v.timeline("background.timeline", doc.Background.Timeline),
	}
	if v.err == nil && out.Background.Overview == "" && len(out.Background.Points) == 0 && len(out.Background.Timeline) == 0 {
		v.fail(ModuleEmpty, "background")
	}
	out.CommunicationStyle = v.module("communication_style", doc.CommunicationStyle)
	out.WorkingStyle = v.module("working_style", doc.WorkingStyle)
	out.Preferences = v.module("preferences", doc.Preferences)
	out.WritingStyle = v.module("writing_style", doc.WritingStyle)
	if v.err != nil {
		return Document{}, v.err
	}
	if len(renderProfileMarkdown(out)) > maxRenderedProfileBytes {
		return Document{}, &DocumentError{Code: DocumentInvalid, Field: "profile"}
	}
	return out, nil
}

// CanonicalJSON is the stored and compared form of a normalized Document.
func CanonicalJSON(doc Document) []byte {
	encoded, _ := json.Marshal(doc)
	return encoded
}

type documentValidator struct {
	err *DocumentError
}

func (v *documentValidator) fail(code DocumentErrorCode, field string) {
	if v.err == nil {
		v.err = &DocumentError{Code: code, Field: field}
	}
}

// text validates one plain-text field. Headings, scripts, and images would let
// field content change the rendered document's structure or safety.
func (v *documentValidator) text(field, value string, minRunes, maxRunes int, multiline bool) string {
	value = strings.TrimSpace(value)
	count := utf8.RuneCountInString(value)
	lower := strings.ToLower(value)
	switch {
	case !utf8.ValidString(value), count < minRunes, count > maxRunes,
		strings.Contains(lower, "<script"), strings.Contains(value, "!["),
		!multiline && strings.ContainsAny(value, "\r\n"):
		v.fail(DocumentInvalid, field)
		return value
	}
	for _, line := range strings.Split(value, "\n") {
		if strings.HasPrefix(strings.TrimLeft(line, " \t"), "#") {
			v.fail(DocumentInvalid, field)
		}
	}
	return value
}

func (v *documentValidator) line(field, value string, minRunes, maxRunes int) string {
	return v.text(field, value, minRunes, maxRunes, false)
}

func (v *documentValidator) paragraph(field, value string) string {
	return v.text(field, value, 0, 4000, true)
}

func (v *documentValidator) list(field string, values []string, maxItems, maxRunes int) []string {
	if len(values) > maxItems {
		v.fail(DocumentInvalid, field)
	}
	out := make([]string, 0, len(values))
	for i, value := range values {
		out = append(out, v.line(fmt.Sprintf("%s[%d]", field, i), value, 1, maxRunes))
	}
	return out
}

func (v *documentValidator) points(field string, values []Point) []Point {
	if len(values) > maxModulePoints {
		v.fail(DocumentInvalid, field)
	}
	out := make([]Point, 0, len(values))
	for i, value := range values {
		path := fmt.Sprintf("%s[%d]", field, i)
		point := Point{
			Title: v.line(path+".title", value.Title, 1, 200),
			Text:  v.paragraph(path+".text", value.Text),
			Items: v.list(path+".items", value.Items, maxPointItems, 1000),
		}
		if point.Text == "" && len(point.Items) == 0 {
			v.fail(DocumentInvalid, path)
		}
		out = append(out, point)
	}
	return out
}

func (v *documentValidator) timeline(field string, values []TimelineEntry) []TimelineEntry {
	if len(values) > maxTimelineEntries {
		v.fail(DocumentInvalid, field)
	}
	out := make([]TimelineEntry, 0, len(values))
	for i, value := range values {
		path := fmt.Sprintf("%s[%d]", field, i)
		out = append(out, TimelineEntry{
			Period:       v.line(path+".period", value.Period, 1, 100),
			Organization: v.line(path+".organization", value.Organization, 1, 200),
			Place:        v.line(path+".place", value.Place, 0, 200),
			Role:         v.line(path+".role", value.Role, 0, 200),
			Description:  v.line(path+".description", value.Description, 0, 1000),
			Details:      v.list(path+".details", value.Details, maxTimelineDetails, 500),
		})
	}
	return out
}

func (v *documentValidator) module(field string, value Module) Module {
	out := Module{Overview: v.paragraph(field+".overview", value.Overview), Points: v.points(field+".points", value.Points)}
	if v.err == nil && out.Overview == "" && len(out.Points) == 0 {
		v.fail(ModuleEmpty, field)
	}
	return out
}

// renderProfileMarkdown renders a normalized Document as the Markdown served
// to Agents and SQL readers.
func renderProfileMarkdown(doc Document) string {
	var b strings.Builder
	b.WriteString("# " + doc.Name + "\n")
	b.WriteString("\n## " + headingBackground + "\n")
	writeParagraph(&b, doc.Background.Overview)
	if len(doc.Background.Timeline) > 0 {
		b.WriteString("\n### " + headingTimeline + "\n\n")
		for _, entry := range doc.Background.Timeline {
			first := "- " + entry.Period + " · " + entry.Organization
			if entry.Place != "" {
				first += " · " + entry.Place
			}
			b.WriteString(first + "\n")
			second := entry.Role
			if entry.Description != "" {
				if second != "" {
					second += " | "
				}
				second += entry.Description
			}
			if second != "" {
				b.WriteString("  " + second + "\n")
			}
			for _, detail := range entry.Details {
				b.WriteString("  - " + detail + "\n")
			}
		}
	}
	writePoints(&b, doc.Background.Points)
	for _, section := range []struct {
		heading string
		module  Module
	}{
		{headingCommunicationStyle, doc.CommunicationStyle},
		{headingWorkingStyle, doc.WorkingStyle},
		{headingPreferences, doc.Preferences},
		{headingWritingStyle, doc.WritingStyle},
	} {
		b.WriteString("\n## " + section.heading + "\n")
		writeParagraph(&b, section.module.Overview)
		writePoints(&b, section.module.Points)
	}
	return strings.TrimRight(b.String(), "\n")
}

func writeParagraph(b *strings.Builder, text string) {
	if text != "" {
		b.WriteString("\n" + text + "\n")
	}
}

func writePoints(b *strings.Builder, points []Point) {
	for _, point := range points {
		b.WriteString("\n### " + point.Title + "\n")
		writeParagraph(b, point.Text)
		if len(point.Items) > 0 {
			b.WriteString("\n")
			for _, item := range point.Items {
				b.WriteString("- " + item + "\n")
			}
		}
	}
}

// documentSchema is the model structured-output schema for a Document. Length
// and count limits stay in NormalizeDocument because model gateways reject
// them in output schemas.
func documentSchema() map[string]any {
	str := map[string]any{"type": "string"}
	textList := map[string]any{"type": "array", "items": str}
	object := func(properties map[string]any) map[string]any {
		required := make([]string, 0, len(properties))
		for name := range properties {
			required = append(required, name)
		}
		sort.Strings(required)
		return map[string]any{"type": "object", "additionalProperties": false, "required": required, "properties": properties}
	}
	point := object(map[string]any{"title": str, "text": str, "items": textList})
	points := map[string]any{"type": "array", "items": point}
	module := object(map[string]any{"overview": str, "points": points})
	entry := object(map[string]any{"period": str, "organization": str, "place": str, "role": str, "description": str, "details": textList})
	background := object(map[string]any{"overview": str, "points": points, "timeline": map[string]any{"type": "array", "items": entry}})
	return object(map[string]any{
		"name": str, "background": background, "communication_style": module,
		"working_style": module, "preferences": module, "writing_style": module,
	})
}
