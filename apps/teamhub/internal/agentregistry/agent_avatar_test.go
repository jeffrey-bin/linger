package agentregistry

import (
	"strings"
	"testing"
)

func TestValidAgentAvatarImage(t *testing.T) {
	for name, tc := range map[string]struct {
		value string
		valid bool
	}{
		"remove":     {"", true},
		"png":        {"data:image/png;base64,iVBORw0KGgo=", true},
		"jpeg":       {"data:image/jpeg;base64,/9j/4AAQ", true},
		"webp":       {"data:image/webp;base64,UklGRg==", true},
		"gif":        {"data:image/gif;base64,R0lGOD==", false},
		"svg":        {"data:image/svg+xml;base64,PHN2Zz4=", false},
		"no payload": {"data:image/png;base64,", false},
		"not base64": {"data:image/png;base64,not base64!", false},
		"plain url":  {"https://example.com/a.png", false},
		"at cap":     {"data:image/png;base64," + strings.Repeat("A", (agentAvatarImageMaxLength-len("data:image/png;base64,"))/4*4), true},
		"past cap":   {"data:image/png;base64," + strings.Repeat("A", agentAvatarImageMaxLength), false},
	} {
		if got := ValidAgentAvatarImage(tc.value); got != tc.valid {
			t.Errorf("%s: valid=%v, want %v", name, got, tc.valid)
		}
	}
}

func TestDecodeAgentAvatarImageServesTheStoredMediaType(t *testing.T) {
	contentType, body, ok := decodeAgentAvatarImage("data:image/webp;base64,UklGRg==")
	if !ok || contentType != "image/webp" || string(body) != "RIFF" {
		t.Fatalf("decoded %q %q ok=%v", contentType, body, ok)
	}
	for _, invalid := range []string{"", "data:image/gif;base64,R0lGOD==", "data:image/png;base64,", "data:image/png;base64,!!"} {
		if _, _, ok := decodeAgentAvatarImage(invalid); ok {
			t.Errorf("decoded invalid %q", invalid)
		}
	}
}

func TestAgentAvatarImageURLEscapesAndVersions(t *testing.T) {
	got := agentAvatarImageURL("tenant a", "actor/1", "k2x")
	if got != "/v0/tenants/tenant%20a/agents/actor%2F1/avatar-image?v=k2x" {
		t.Fatalf("url=%q", got)
	}
}
