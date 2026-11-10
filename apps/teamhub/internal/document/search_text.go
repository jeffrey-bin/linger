package document

import (
	"regexp"
	"strings"
)

var (
	fenceLine      = regexp.MustCompile("(?m)^[ \t]*(```|~~~)[^\n]*$")
	image          = regexp.MustCompile(`!\[([^\]]*)\]\([^)\n]*\)`)
	link           = regexp.MustCompile(`\[([^\]\n]+)\]\([^)\n]*\)`)
	htmlTag        = regexp.MustCompile(`</?[A-Za-z][^>\n]{0,200}>`)
	tableSeparator = regexp.MustCompile(`(?m)^[ \t]*\|?(?:[ \t]*:?-{3,}:?[ \t]*\|?)+[ \t]*$`)
	linePrefix     = regexp.MustCompile(`(?m)^[ \t]*(?:#{1,6}[ \t]+|>[ \t]?|[-*+][ \t]+(?:\[[ xX]\][ \t]+)?|\d{1,3}[.)][ \t]+)`)
	emphasis       = regexp.MustCompile("\\*+|~~|__|`+")
	whitespace     = regexp.MustCompile(`\s+`)
)

// MarkdownToSearchText flattens Markdown into one line of plain words for
// keyword matching and snippets. It drops syntax and link targets, keeps
// alt text and code contents, and leaves single underscores alone so
// identifiers such as room_id stay searchable.
func MarkdownToSearchText(markdown string) string {
	// PostgreSQL text rejects NUL; preserve the surrounding words as separate tokens.
	markdown = strings.ReplaceAll(markdown, "\x00", " ")
	text := fenceLine.ReplaceAllString(markdown, "")
	text = image.ReplaceAllString(text, " $1 ")
	text = link.ReplaceAllString(text, "$1")
	text = htmlTag.ReplaceAllString(text, " ")
	text = tableSeparator.ReplaceAllString(text, "")
	// Nested prefixes such as "> - [ ] item" or "- ## heading" need one pass per level.
	for range 3 {
		stripped := linePrefix.ReplaceAllString(text, "")
		if stripped == text {
			break
		}
		text = stripped
	}
	text = strings.ReplaceAll(text, "|", " ")
	text = emphasis.ReplaceAllString(text, "")
	return strings.TrimSpace(whitespace.ReplaceAllString(text, " "))
}
