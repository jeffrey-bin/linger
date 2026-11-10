package skill

import (
	"errors"
	"strings"
	"testing"
)

func TestPolicyConflictDiagnosticsExposeReferencesWithoutConfiguration(t *testing.T) {
	_, err := validateResolvedItems([]Item{{SkillID: "skill_a", Name: "same", Config: map[string]any{"token": "NEVER_EXPOSE"}}, {SkillID: "skill_b", Name: "same"}})
	message := err.Error()
	if !errors.Is(err, ErrConflict) || !strings.Contains(message, "share a Runtime name") || !strings.Contains(message, "skill_a, skill_b") || strings.Contains(message, "NEVER_EXPOSE") {
		t.Fatalf("diagnostic=%s error=%v", message, err)
	}
}
