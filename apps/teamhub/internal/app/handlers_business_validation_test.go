package app

import (
	"strings"
	"testing"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentregistry"
)

func TestNormalizeAgentDescriptionUsesUnicodeRuneLimit(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name      string
		value     string
		wantValue string
		want      bool
	}{
		{name: "empty", value: "", want: true},
		{name: "whitespace", value: " \n\t", want: true},
		{name: "trimmed", value: "  Collaboration profile  ", wantValue: "Collaboration profile", want: true},
		{name: "exact multibyte rune limit", value: strings.Repeat("€", 1000), wantValue: strings.Repeat("€", 1000), want: true},
		{name: "exact emoji rune limit", value: strings.Repeat("🙂", 1000), wantValue: strings.Repeat("🙂", 1000), want: true},
		{name: "over rune limit", value: strings.Repeat("🙂", 1001)},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			value, ok := agentregistry.NormalizeAgentDescription(test.value)
			if ok != test.want || test.want && value != test.wantValue {
				t.Fatalf("agentregistry.NormalizeAgentDescription()=(%q, %v) want=(%q, %v)", value, ok, test.wantValue, test.want)
			}
		})
	}
}
