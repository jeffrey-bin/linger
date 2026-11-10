package collaboration

import (
	"slices"
	"testing"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/typedcard"
)

func TestBlankAgentQuestionOffersDistinctOptionsFromThePool(t *testing.T) {
	for range 20 {
		opening := blankAgentQuestion()
		if opening.Kind != typedcard.DecisionKindQuestion || len(opening.Questions) != 1 {
			t.Fatalf("opening=%+v", opening)
		}
		question := opening.Questions[0]
		if question.Prompt != blankAgentPrompt || question.Input != "radio" || len(question.Options) != blankAgentOfferedOption {
			t.Fatalf("question=%+v", question)
		}
		seen := map[string]bool{}
		for index, option := range question.Options {
			if option.ID != []string{"o1", "o2", "o3"}[index] || seen[option.Label] || !slices.Contains(blankAgentOptions, option.Label) {
				t.Fatalf("options=%+v", question.Options)
			}
			seen[option.Label] = true
		}
	}
}

func TestGreetingName(t *testing.T) {
	for input, want := range map[string]string{
		"Alice Chen":          "Alice",
		" alice@example.com ": "alice",
		"  ":                  "there",
	} {
		if got := GreetingName(input); got != want {
			t.Fatalf("GreetingName(%q)=%q want %q", input, got, want)
		}
	}
}
