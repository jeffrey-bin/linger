package native

import (
	"strings"
	"unicode/utf8"
)

// ReasoningTitle extracts a title from public reasoning text: a leading bold
// heading, or else the first line. Incomplete text yields nothing until its
// title is delimited. Every Runtime's thinking goes through it.
func ReasoningTitle(text string, complete bool) (string, bool) {
	text = strings.ReplaceAll(text, "\r\n", "\n")
	text = strings.ReplaceAll(text, "\r", "\n")
	text = strings.TrimLeftFunc(text, jsSpace)
	var candidate string
	if strings.HasPrefix(text, "**") || strings.HasPrefix(text, "__") {
		marker := text[:2]
		if end := strings.Index(text[2:], marker); end >= 0 {
			candidate = text[:end+4]
		} else if complete {
			candidate, _, _ = strings.Cut(text, "\n")
		} else {
			return "", false
		}
	} else {
		line, _, found := strings.Cut(text, "\n")
		if !found && !complete {
			return "", false
		}
		candidate = line
	}
	return normalizeReasoningTitle(candidate), true
}

func normalizeReasoningTitle(title string) string {
	hashes := 0
	for hashes < len(title) && hashes < 6 && title[hashes] == '#' {
		hashes++
	}
	if hashes > 0 {
		if rest := title[hashes:]; rest != "" {
			if r, _ := utf8.DecodeRuneInString(rest); jsSpace(r) {
				title = strings.TrimLeftFunc(rest, jsSpace)
			}
		}
	}
	if strings.HasPrefix(title, "-") || strings.HasPrefix(title, "*") {
		if r, _ := utf8.DecodeRuneInString(title[1:]); jsSpace(r) {
			title = strings.TrimLeftFunc(title[1:], jsSpace)
		}
	}
	title = strings.TrimFunc(title, jsSpace)
	for _, marker := range []string{"**", "__"} {
		if strings.HasPrefix(title, marker) && strings.HasSuffix(title, marker) {
			if len(title) < 4 {
				title = ""
			} else {
				title = strings.TrimFunc(title[2:len(title)-2], jsSpace)
			}
			break
		}
	}
	return strings.Join(strings.FieldsFunc(title, jsSpace), " ")
}

// jsSpace is JavaScript's \s: ASCII whitespace, Unicode space
// separators, line and paragraph separators, and U+FEFF.
func jsSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0x00a0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff:
		return true
	}
	return r >= 0x2000 && r <= 0x200a
}
