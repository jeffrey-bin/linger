// Package voicecaptureqa is the recording's Agent in Ask: in one Agent Service
// model call it decides whether what the person typed is a question about their
// recording, which it answers from the confirmed transcript, or a request for
// their Another Me to act, which it titles as a Task. It also renders the
// recording context a task sent from the recording carries. It stores
// nothing; the caller persists the reply and creates the Task.
package voicecaptureqa

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/roomagent"
)

const (
	// transcriptBudgetRunes keeps the request small so the answer stays fast.
	transcriptBudgetRunes = 20000
	maxSources            = 5
	maxTaskTitleRunes     = 80
)

type Segment struct {
	StartOffsetMS, EndOffsetMS int64
	Text                       string
	// Speaker is the diarization id ("spk_2"), or empty when the recording
	// does not separate speakers.
	Speaker string
}

// Reply kinds: an answer to a question, or a request to hand to Another Me.
const (
	KindAnswer = "answer"
	KindTask   = "task"
)

type Answer struct {
	Kind     string
	Text     string
	Answered bool
	Sources  []Segment
	// TaskTitle names the Task a task request becomes; empty for an answer.
	TaskTitle string
}

type Answerer interface {
	Answer(ctx context.Context, owner roomagent.ModelCallOwner, question string, segments []Segment) (Answer, error)
}

// Cutoff is the end of the last confirmed transcript the answer could read.
func Cutoff(segments []Segment) int64 {
	var cutoff int64
	for _, segment := range segments {
		cutoff = max(cutoff, segment.EndOffsetMS)
	}
	return cutoff
}

const systemPrompt = `You are the Agent inside a meeting the person is recording. They type to you while the meeting goes on. Each message is either a question about the meeting, which you answer, or a request for their Another Me (their personal AI agent) to do something, which becomes a Task.

First decide "kind":
- "task" only when the person asks for something to be done, produced, sent, or followed up on: drafting or sending an email or message, writing a summary, document or plan to hand on, scheduling, reminding them after the meeting, looking something up for later, or explicitly "create a task", "help me…", "remind me after the meeting…", or the same request in any language. The request must be about acting, not about knowing what was said.
- "answer" for every question about the meeting: what was said, decided, left open, who said what, numbers, dates, owners, how many people spoke, or a quick recap to read now.
- When unsure, choose "answer": answer what you can, and end with one short line offering to hand it to Another Me as a task (in the question's language, for example "Want Another Me to do this? Ask it as a task.").

For kind "task":
- Set "task_title" to a short imperative title for the Task in the request's language, at most 60 characters, naming the deliverable (for example "Draft the launch email to Lena").
- Set "answer" to "", "answered" to true, and "source_segments" to the transcript lines the request refers to, if any.

For kind "answer":
1. Answer in the language of the question.
2. Be brief: at most 3 short bullet points, or 1-2 sentences.
3. Use only the transcript.
4. If the recording so far does not settle the question, say it is not determined yet and set "answered" to false. Otherwise set "answered" to true.
5. Never invent amounts, dates, owners or decisions.
6. Put the numbers of the transcript lines you used in "source_segments" (at most 5).
7. Speaker labels come from automatic speaker separation. Use them to answer who said what or how many people have spoken ("so far, 3 speakers"), refer to people as "Speaker 2" unless the transcript names them, and do not claim certainty about identities.
8. Set "task_title" to "".`

// BuildInput numbers the transcript lines [1..n] and keeps only the most
// recent part when it is long. firstNumber is the number of the first line
// included.
func BuildInput(question string, segments []Segment) (input string, firstNumber int) {
	var builder strings.Builder
	builder.WriteString("Message: ")
	builder.WriteString(strings.TrimSpace(question))
	speakers := speakerLabels(segments)
	if len(speakers) > 0 {
		fmt.Fprintf(&builder, "\n\nSpeakers told apart by automatic speaker separation so far: %s. "+
			"The labels are anonymous and may occasionally merge or split people; lines without a label have no speaker.",
			strings.Join(speakers, ", "))
		builder.WriteString("\n\nTranscript so far ([number] mm:ss speaker: text):\n")
	} else {
		builder.WriteString("\n\nThis recording does not tell speakers apart.")
		builder.WriteString("\n\nTranscript so far ([number] mm:ss text):\n")
	}
	first := keepRecent(len(segments), func(index int) string { return segments[index].Text }, transcriptBudgetRunes)
	if first > 0 {
		builder.WriteString("(The earlier part of the recording is omitted.)\n")
	}
	if len(segments) == 0 {
		builder.WriteString("(Nothing has been said yet.)\n")
	}
	for index := first; index < len(segments); index++ {
		speaker := ""
		if label := speakerLabel(segments[index].Speaker); label != "" {
			speaker = label + ": "
		}
		fmt.Fprintf(&builder, "[%d] %s %s%s\n", index+1, clock(segments[index].StartOffsetMS), speaker, strings.TrimSpace(segments[index].Text))
	}
	return builder.String(), first + 1
}

// speakerLabel names a diarization id the way the recording window shows it:
// "spk_2" is "Speaker 2".
func speakerLabel(id string) string {
	number, ok := strings.CutPrefix(id, "spk_")
	if !ok || number == "" {
		return ""
	}
	return "Speaker " + number
}

// speakerLabels lists the distinct speakers in the order they first spoke.
func speakerLabels(segments []Segment) []string {
	seen := map[string]bool{}
	labels := []string{}
	for _, segment := range segments {
		label := speakerLabel(segment.Speaker)
		if label != "" && !seen[label] {
			seen[label] = true
			labels = append(labels, label)
		}
	}
	return labels
}

// MapSources turns the model's line numbers back into transcript windows,
// dropping numbers outside the included lines and duplicates.
func MapSources(numbers []int, segments []Segment, firstNumber int) []Segment {
	sources := []Segment{}
	seen := map[int]bool{}
	for _, number := range numbers {
		if number < firstNumber || number > len(segments) || seen[number] || len(sources) == maxSources {
			continue
		}
		seen[number] = true
		sources = append(sources, segments[number-1]) //nolint:gosec // number is range-checked against len(segments) above
	}
	return sources
}

// keepRecent returns the first index whose items, through the last one, fit
// the rune budget. The last item is always kept.
func keepRecent(count int, text func(int) string, budget int) int {
	used := 0
	for index := count - 1; index >= 0; index-- {
		used += utf8.RuneCountInString(text(index))
		if used > budget && index < count-1 {
			return index + 1
		}
	}
	return 0
}

func clock(offsetMS int64) string {
	seconds := max(offsetMS, 0) / 1000
	return fmt.Sprintf("%02d:%02d", seconds/60, seconds%60)
}

type modelAnswerer struct {
	models  *roomagent.ModelCallClient
	timeout time.Duration
}

// NewAnswerer answers through a foreground Agent Service model call on the
// owner's Agent Runtime, which starts at once; timeout bounds its single
// Runtime attempt.
func NewAnswerer(models *roomagent.ModelCallClient, timeout time.Duration) Answerer {
	return &modelAnswerer{models: models, timeout: timeout}
}

// Answer answers the question from the recording's segments on the owner's
// Agent Runtime.
func (a *modelAnswerer) Answer(ctx context.Context, owner roomagent.ModelCallOwner, question string, segments []Segment) (Answer, error) {
	input, firstNumber := BuildInput(question, segments)
	raw, _, err := a.models.Structured(ctx, roomagent.ModelCallRequest{
		Kind: roomagent.KindVoiceAsk, Key: "voice-ask:" + owner.TenantID + ":" + owner.OwnerActorID,
		Owner:        owner,
		Instructions: systemPrompt, Input: input, Timeout: a.timeout,
	}, "voice_capture_answer", map[string]any{
		"type": "object", "additionalProperties": false,
		"required": []string{"kind", "answer", "answered", "source_segments", "task_title"},
		"properties": map[string]any{
			"kind":       map[string]any{"type": "string", "enum": []string{KindAnswer, KindTask}},
			"task_title": map[string]any{"type": "string"},
			"answer":     map[string]any{"type": "string"},
			"answered":   map[string]any{"type": "boolean"},
			"source_segments": map[string]any{
				"type": "array", "maxItems": maxSources, "items": map[string]any{"type": "integer"},
			},
		},
	})
	if err != nil {
		return Answer{}, err
	}
	return ParseOutput(string(raw), question, segments, firstNumber)
}

// ParseOutput reads the model's structured reply. A task request without a
// usable title is titled after the request itself, so it is never lost.
func ParseOutput(raw, question string, segments []Segment, firstNumber int) (Answer, error) {
	var output struct {
		Kind           string `json:"kind"`
		Answer         string `json:"answer"`
		Answered       bool   `json:"answered"`
		SourceSegments []int  `json:"source_segments"`
		TaskTitle      string `json:"task_title"`
	}
	if err := json.Unmarshal([]byte(raw), &output); err != nil {
		return Answer{}, fmt.Errorf("recording answer is invalid: %w", err)
	}
	sources := MapSources(output.SourceSegments, segments, firstNumber)
	switch output.Kind {
	case KindTask:
		title := oneLine(output.TaskTitle)
		if title == "" {
			title = oneLine(question)
		}
		if runes := []rune(title); len(runes) > maxTaskTitleRunes {
			title = string(runes[:maxTaskTitleRunes-1]) + "…"
		}
		if title == "" {
			return Answer{}, fmt.Errorf("recording task request is empty")
		}
		return Answer{Kind: KindTask, Answered: true, Sources: sources, TaskTitle: title}, nil
	case KindAnswer:
		text := strings.TrimSpace(output.Answer)
		if text == "" {
			return Answer{}, fmt.Errorf("recording answer is empty")
		}
		return Answer{Kind: KindAnswer, Text: text, Answered: output.Answered, Sources: sources}, nil
	default:
		return Answer{}, fmt.Errorf("recording reply kind %q is invalid", output.Kind)
	}
}

func oneLine(text string) string {
	return strings.Join(strings.Fields(text), " ")
}
