package personalprofile

import (
	"fmt"
	"strings"
)

// MarkdownError names the line of an edited Profile Markdown that does not
// follow the rendered layout; it matches ErrInvalid.
type MarkdownError struct {
	Line   int
	Reason string
}

func (e *MarkdownError) Error() string {
	return fmt.Sprintf("line %d: %s", e.Line, e.Reason)
}

func (e *MarkdownError) Unwrap() error { return ErrInvalid }

var markdownModules = map[string]string{
	strings.ToLower(headingBackground):         "background",
	strings.ToLower(headingCommunicationStyle): "communication_style",
	strings.ToLower(headingWorkingStyle):       "working_style",
	strings.ToLower(headingPreferences):        "preferences",
	strings.ToLower(headingWritingStyle):       "writing_style",
}

// ParseProfileMarkdown reads a Human's edit of the Markdown renderProfileMarkdown
// writes back into a Document named name: "## " starts a module, "### Timeline"
// under Background lists "- years · organization · place" entries with an
// indented "role | description" line and indented "- " highlights, and any
// other "### " starts a point whose "- " lines are its items. The leading
// "# " name line is optional and ignored; the name comes from the account.
func ParseProfileMarkdown(markdown, name string) (Document, error) {
	doc := Document{Name: name}
	modules := map[string]*Module{
		"communication_style": &doc.CommunicationStyle,
		"working_style":       &doc.WorkingStyle,
		"preferences":         &doc.Preferences,
		"writing_style":       &doc.WritingStyle,
	}
	var background Module
	modules["background"] = &background

	var (
		module   *Module
		moduleID string
		point    *Point
		inTL     bool
		entry    *TimelineEntry
		para     []string
	)
	appendText := func(target *string, lines []string) {
		text := strings.TrimSpace(strings.Join(lines, " "))
		if text == "" {
			return
		}
		if *target != "" {
			*target += "\n\n"
		}
		*target += text
	}
	flush := func() {
		if len(para) == 0 {
			return
		}
		switch {
		case point != nil:
			appendText(&point.Text, para)
		case module != nil:
			appendText(&module.Overview, para)
		}
		para = nil
	}
	closePoint := func() {
		flush()
		if point != nil && module != nil {
			module.Points = append(module.Points, *point)
		}
		point = nil
	}
	closeEntry := func() {
		if entry != nil {
			doc.Background.Timeline = append(doc.Background.Timeline, *entry)
		}
		entry = nil
	}
	seen := map[string]bool{}

	for index, raw := range strings.Split(strings.ReplaceAll(markdown, "\r\n", "\n"), "\n") {
		line := index + 1
		trimmed := strings.TrimSpace(raw)
		switch {
		case strings.HasPrefix(trimmed, "# ") && module == nil:
			continue
		case strings.HasPrefix(trimmed, "## "):
			closePoint()
			closeEntry()
			inTL = false
			title := strings.TrimSpace(strings.TrimPrefix(trimmed, "## "))
			id, ok := markdownModules[strings.ToLower(title)]
			if !ok {
				return Document{}, &MarkdownError{Line: line, Reason: fmt.Sprintf("unknown section %q; use Background, Communication Style, Working Style, Preferences or Writing Style", title)}
			}
			if seen[id] {
				return Document{}, &MarkdownError{Line: line, Reason: fmt.Sprintf("section %q appears twice", title)}
			}
			seen[id] = true
			module, moduleID = modules[id], id
		case module == nil:
			if trimmed != "" {
				return Document{}, &MarkdownError{Line: line, Reason: "text before the first section; start with ## Background"}
			}
		case strings.HasPrefix(trimmed, "### "):
			closePoint()
			closeEntry()
			title := strings.TrimSpace(strings.TrimPrefix(trimmed, "### "))
			inTL = moduleID == "background" && strings.EqualFold(title, headingTimeline)
			if !inTL {
				point = &Point{Title: title, Items: []string{}}
			}
		case inTL:
			if trimmed == "" {
				continue
			}
			indented := strings.HasPrefix(raw, " ") || strings.HasPrefix(raw, "\t")
			switch {
			case !indented && strings.HasPrefix(trimmed, "- "):
				closeEntry()
				fields := strings.Split(strings.TrimPrefix(trimmed, "- "), " · ")
				if len(fields) < 2 {
					return Document{}, &MarkdownError{Line: line, Reason: "a timeline entry reads \"- years · organization\", optionally followed by \" · place\""}
				}
				entry = &TimelineEntry{
					Period:       strings.TrimSpace(fields[0]),
					Organization: strings.TrimSpace(fields[1]),
					Place:        strings.TrimSpace(strings.Join(fields[2:], " · ")),
					Details:      []string{},
				}
			case entry == nil:
				return Document{}, &MarkdownError{Line: line, Reason: "timeline text needs an entry line \"- years · organization\" above it"}
			case strings.HasPrefix(trimmed, "- "):
				entry.Details = append(entry.Details, strings.TrimSpace(strings.TrimPrefix(trimmed, "- ")))
			case entry.Role == "" && entry.Description == "":
				role, description, found := strings.Cut(trimmed, " | ")
				if found {
					entry.Role, entry.Description = strings.TrimSpace(role), strings.TrimSpace(description)
				} else {
					entry.Role = trimmed
				}
			default:
				entry.Description = strings.TrimSpace(entry.Description + " " + trimmed)
			}
		case trimmed == "":
			flush()
		case point != nil && strings.HasPrefix(trimmed, "- "):
			flush()
			point.Items = append(point.Items, strings.TrimSpace(strings.TrimPrefix(trimmed, "- ")))
		default:
			para = append(para, trimmed)
		}
	}
	closePoint()
	closeEntry()
	doc.Background.Overview, doc.Background.Points = background.Overview, background.Points
	if doc.Background.Timeline == nil {
		doc.Background.Timeline = []TimelineEntry{}
	}
	return doc, nil
}
