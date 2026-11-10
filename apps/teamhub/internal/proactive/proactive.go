// Package proactive hands, for one Human at a time, outside events from their
// own material to their AnotherMe, which judges in its own Run with the same
// rules as its conversation review whether to remind them, record a Tracking
// Item quietly, or stay silent. It only reminds; it never acts for the Human.
// Every read and write is scoped to one (tenant, owner) pair, so no Human ever
// sees another's material.
package proactive

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"time"
)

// Candidate is one thing from a source, as it is recorded for the day.
type Candidate struct {
	Source    string     `json:"source"` // event
	SourceKey string     `json:"-"`      // stable within the source for one day
	Kind      string     `json:"kind,omitempty"`
	Content   string     `json:"content"`
	DueAt     *time.Time `json:"due_at,omitempty"`
}

// Guideline is a Human's reminder prompt: the shared general part lives with
// the Agent Service; Specific holds what dreaming learned from this Human's
// replies.
type Guideline struct {
	Version  int      `json:"version"`
	Specific []string `json:"specific"`
}

// MaxSpecific bounds the learned part so every evaluation stays small.
const MaxSpecific = 20

// DefaultGuideline is a new Human's guideline: general rules only.
func DefaultGuideline() Guideline { return Guideline{Version: 1} }

// EventJudgeRequest is what AnotherMe weighs an event against.
type EventJudgeRequest struct {
	Specific  []string
	OpenItems []OpenItem
}

// EventJudge returns the rules AnotherMe judges an event by, put before the
// event in its wake; the Agent Service renders them in production.
type EventJudge func(context.Context, EventJudgeRequest) (string, error)

// maxRecordedRunes bounds the recorded text. The record only marks what was
// judged today; AnotherMe's wake carries the full event, so a long mail body is
// cut here instead of failing the judgment.
const maxRecordedRunes = 500

// withDue is the candidate's text with its due time, as the Human reads it.
func withDue(candidate Candidate) string {
	text := strings.TrimSpace(candidate.Content)
	if runes := []rune(text); len(runes) > maxRecordedRunes {
		text = strings.TrimSpace(string(runes[:maxRecordedRunes])) + "…"
	}
	if candidate.DueAt != nil {
		due := candidate.DueAt.In(time.Local)
		layout := "Jan 2 15:04"
		// Memory writes a day without a time as 23:59:59: name the day only.
		if due.Hour() == 23 && due.Minute() == 59 && due.Second() == 59 {
			layout = "Jan 2"
		}
		text += " (" + due.Format(layout) + ")"
	}
	return text
}

// SourceKey identifies a candidate within its source for a day. Tracking Items
// are rebuilt each Daily, so their content (not their ID) names the thing.
func SourceKey(source, content string, day time.Time) string {
	sum := sha256.Sum256([]byte(source + "\x00" + strings.TrimSpace(content) + "\x00" + day.Format("2006-01-02")))
	return hex.EncodeToString(sum[:16])
}

// Day is the deployment's local calendar day as a UTC midnight.
func Day(now time.Time) time.Time {
	year, month, day := now.In(time.Local).Date()
	return time.Date(year, month, day, 0, 0, 0, 0, time.UTC)
}
