package voicelive

import (
	"slices"
	"strings"
	"time"
)

// AsksAboutToday is true when the recall's dates include today, which
// Memory has not indexed yet. The live model sets them for today or just now.
func AsksAboutToday(eventFrom, eventTo, today string) bool {
	if eventFrom == "" && eventTo == "" {
		return false
	}
	return (eventFrom == "" || eventFrom <= today) && (eventTo == "" || eventTo >= today)
}

// TodayMessage is an authorized recent message included in today’s digest.
type TodayMessage struct {
	Room, Author, Text string
	At                 time.Time
}

// TodayDigest is today's Pocket Note page and Messages, oldest Message first,
// shortened for the live model.
func TodayDigest(date, note string, messages []TodayMessage, location *time.Location) map[string]any {
	digest := map[string]any{"date": date}
	if note = strings.TrimSpace(note); note != "" {
		digest["pocket_note"] = truncateRunes(note, 800)
	}
	lines := make([]map[string]string, 0, len(messages))
	for _, message := range slices.Backward(messages) {
		lines = append(lines, map[string]string{
			"time": message.At.In(location).Format("15:04"), "room": message.Room,
			"author": message.Author, "text": truncateRunes(Snippet(message.Text), 160),
		})
	}
	digest["messages"] = lines
	return digest
}
