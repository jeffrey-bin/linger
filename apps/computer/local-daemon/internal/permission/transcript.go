package permission

import "unicode/utf8"

// Transcript budget: the newest entries first, each cut to its own budget,
// until the count or the total is reached. Older history is dropped before
// newer history, which is the evidence the pending call most likely builds on.
const (
	maxTranscriptEntries   = 40
	maxAssistantRunes      = 5000
	maxToolRunes           = 1500
	maxTranscriptTotalRune = 40000
)

// Trim fits a chronological transcript to the review budget and keeps it
// chronological.
func Trim(entries []TranscriptEntry) []TranscriptEntry {
	var newestFirst []TranscriptEntry
	total := 0
	for index := len(entries) - 1; index >= 0 && len(newestFirst) < maxTranscriptEntries; index-- {
		entry := entries[index]
		limit := maxToolRunes
		if entry.Kind == "assistant" {
			limit = maxAssistantRunes
		}
		if utf8.RuneCountInString(entry.Text) > limit {
			entry.Text = string([]rune(entry.Text)[:limit])
			entry.Truncated = true
		}
		if total += utf8.RuneCountInString(entry.Text); total > maxTranscriptTotalRune {
			break
		}
		newestFirst = append(newestFirst, entry)
	}
	trimmed := make([]TranscriptEntry, 0, len(newestFirst))
	for index := len(newestFirst) - 1; index >= 0; index-- {
		trimmed = append(trimmed, newestFirst[index])
	}
	return trimmed
}
