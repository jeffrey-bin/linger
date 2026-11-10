package voicecaptureqa

// Recording tasks: what a task sent from a live recording gives the
// recording's Agent.

import (
	"fmt"
	"strings"
	"time"
)

// ContextLine is one confirmed sentence of the recording, on the recording's
// own clock.
type ContextLine struct {
	StartMS int64
	EndMS   int64
	Speaker string
	Text    string
}

// ContextAsk is one earlier exchange in the recording's Ask, which the request
// may refer to ("send this to Lena"). Answer is empty for an earlier
// task request.
type ContextAsk struct {
	Question string
	Answer   string
}

// ContextInput is everything an Agent gets when the recorder sends it a task
// they wrote in Ask.
type ContextInput struct {
	RecordedAt time.Time
	Text       string
	AtMS       int64
	Asks       []ContextAsk
	Transcript []ContextLine
}

// ContextMarkdown renders recording-context.md, the document attached to every
// task sent from a recording: the task and its transcript context, so the
// Agent can act on it without having heard the meeting.
func ContextMarkdown(input ContextInput) string {
	var builder strings.Builder
	fmt.Fprintf(&builder, "# Recording context — %s\n\n", input.RecordedAt.Format("2006-01-02 15:04"))
	builder.WriteString("Shared from a live recording so the Agent can act on the request below. ")
	builder.WriteString("The transcript comes from speech recognition and may contain errors; speaker labels come from automatic speaker separation.\n\n")
	builder.WriteString("## Request\n\n")
	fmt.Fprintf(&builder, "- Written by the recorder at %s: %s\n\n", Clock(input.AtMS), oneLine(input.Text))
	if len(input.Asks) > 0 {
		builder.WriteString("## Earlier in Ask\n\n")
		builder.WriteString("What the recorder asked the recording's Agent before this request, oldest first.\n\n")
		for _, ask := range input.Asks {
			fmt.Fprintf(&builder, "- Asked: %s\n", oneLine(ask.Question))
			if answer := strings.TrimSpace(ask.Answer); answer != "" {
				fmt.Fprintf(&builder, "  Answered: %s\n", oneLine(answer))
			}
		}
		builder.WriteString("\n")
	}
	builder.WriteString("## Transcript so far\n\n")
	if len(input.Transcript) == 0 {
		builder.WriteString("(Nothing confirmed yet.)\n")
	}
	for _, line := range input.Transcript {
		speaker := ""
		if label := SpeakerLabel(line.Speaker); label != "" {
			speaker = label + ": "
		}
		fmt.Fprintf(&builder, "- [%s - %s] %s%s\n", Clock(line.StartMS), Clock(line.EndMS), speaker, oneLine(line.Text))
	}
	return builder.String()
}

// RequestMessage is what the recorder's Message says to the Agent next to the
// attached recording-context.md. A request from a recording is formal: it asks
// for a background Task, which the Agent's Meta creates.
func RequestMessage(text string, atMS int64) string {
	return fmt.Sprintf(
		"From my recording at %s — “%s”\nPlease handle this as a background Task. The transcript so far is attached.",
		Clock(atMS), oneLine(text),
	)
}

// SpeakerLabel names a diarization id the way the recording window shows it:
// "spk_2" is "Speaker 2".
func SpeakerLabel(id string) string {
	number, ok := strings.CutPrefix(id, "spk_")
	if !ok || number == "" {
		return ""
	}
	return "Speaker " + number
}

// Clock is recording time as hh:mm:ss, the clock of the recording's transcript.
func Clock(ms int64) string {
	total := max(ms, 0) / 1000
	return fmt.Sprintf("%02d:%02d:%02d", total/3600, total%3600/60, total%60)
}
