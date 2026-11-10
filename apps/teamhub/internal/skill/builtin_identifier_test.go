package skill

import (
	"strings"
	"testing"
)

func TestSkillCatalogIdentifierLimits(t *testing.T) {
	for name, pattern := range map[string]interface{ MatchString(string) bool }{
		"Skill":    skillIDPattern,
		"Manifest": manifestIDPattern,
	} {
		if !pattern.MatchString("i" + strings.Repeat("x", 511)) {
			t.Fatalf("%s identifier rejected 512 characters", name)
		}
		if pattern.MatchString("i" + strings.Repeat("x", 512)) {
			t.Fatalf("%s identifier accepted 513 characters", name)
		}
	}
}
