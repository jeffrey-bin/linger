package reminder

import (
	_ "embed"
	"strings"
)

// promptFile holds the proactive wake labels, one per "## " section.
//
//go:embed wake_prompts.md
var promptFile string

var prompts = parsePrompts(promptFile)

// Wake labels in wake_prompts.md.
const (
	EventData           = "Event data"
	EventTrackOnly      = "Event track only"
	NightlyPlan         = "Nightly plan"
	RoutineTrackingItem = "Routine tracking item"
)

// Prompt returns one wake label with its {name} placeholders replaced.
func Prompt(name string, values map[string]string) string {
	text := prompts[name]
	for key, value := range values {
		text = strings.ReplaceAll(text, "{"+key+"}", value)
	}
	return text
}

func parsePrompts(text string) map[string]string {
	sections := map[string][]string{}
	heading := ""
	for _, line := range strings.Split(text, "\n") {
		if name, ok := strings.CutPrefix(line, "## "); ok {
			heading = strings.TrimSpace(name)
			continue
		}
		if heading != "" && strings.TrimSpace(line) != "" {
			sections[heading] = append(sections[heading], strings.TrimSpace(line))
		}
	}
	parsed := map[string]string{}
	for _, name := range []string{EventData, EventTrackOnly, NightlyPlan, RoutineTrackingItem} {
		if len(sections[name]) == 0 {
			panic("wake_prompts.md is missing " + name)
		}
		parsed[name] = strings.Join(sections[name], "\n")
	}
	return parsed
}
