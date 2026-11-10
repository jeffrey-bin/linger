package agentregistry

import (
	"testing"
)

func TestBumpPatchVersionAdvancesCoreRelease(t *testing.T) {
	for version, want := range map[string]string{
		"1.0.0":      "1.0.1",
		"1.2.9":      "1.2.10",
		"0.0.0":      "0.0.1",
		"2.0.3-rc.1": "2.0.4",
	} {
		got, err := bumpPatchVersion(version)
		if err != nil || got != want {
			t.Fatalf("bump %q = %q %v want %q", version, got, err, want)
		}
	}
}

func TestSkillManifestVersionRequiresStrictSemVer(t *testing.T) {
	for version, want := range map[string]bool{
		"0.0.0":               true,
		"1.2.3":               true,
		"1.2.3-alpha.1+build": true,
		"release-1":           false,
		"1.2":                 false,
		"01.2.3":              false,
		"1.2.3-01":            false,
	} {
		if got := SkillManifestVersionPattern.MatchString(version); got != want {
			t.Fatalf("Skill Manifest version %q valid=%v want=%v", version, got, want)
		}
	}
}
