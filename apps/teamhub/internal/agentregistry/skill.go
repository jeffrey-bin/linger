package agentregistry

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"regexp"

	artifactstore "github.com/simplexai-labs/linger/apps/teamhub/internal/artifact"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/skill"
)

var (
	// ErrSkillInvalid reports a Skill configuration the Manifest rejects.
	ErrSkillInvalid = errors.New("skill resource is invalid")
	// ErrSkillIdentityConflict reports a SKILL.md name that differs from the Skill's identity.
	ErrSkillIdentityConflict = errors.New("skill identity conflicts with an existing global skill")
	// ErrSkillPackageImmutable reports an existing Skill version uploaded again with other content.
	ErrSkillPackageImmutable = errors.New("skill package version is immutable")
	// ErrSkillPackageTooLarge reports a Skill package over the configured limits.
	ErrSkillPackageTooLarge = errors.New("skill package exceeds configured limits")
	// ErrSkillManifestInactive reports a disabled or deleted Skill Manifest.
	ErrSkillManifestInactive = errors.New("skill manifest is not active")
	// ErrSkillManifestNotCurrent reports a platform Skill version that is not its current one.
	ErrSkillManifestNotCurrent = errors.New("platform skill accepts only its current latest manifest version")
	// Skill files and PostgreSQL cannot commit atomically; when the outcome is unknown, keep objects that a manifest may already reference.
	errSkillCommitOutcomeUnknown = errors.New("skill package metadata commit outcome is unknown")
)

var (
	skillIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,511}$`)
	// SkillManifestVersionPattern matches a strict SemVer Manifest version.
	SkillManifestVersionPattern = regexp.MustCompile(`^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-((0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(\.(0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?(\+([0-9A-Za-z-]+)(\.[0-9A-Za-z-]+)*)?$`)
)

type skillPackageRegistration struct {
	SkillID, ManifestVersion, Description string
	ConfigSchema                          []byte
	Package                               skill.Package
}

type storedSkillPackageFile struct {
	File   skill.PackageFile
	Object artifactstore.Object
}

func encodeSkillCursor(first, second string) string {
	data, _ := json.Marshal([]string{first, second})
	return base64.RawURLEncoding.EncodeToString(data)
}

// DecodeSkillCursor reads a Skill Manifest page cursor; an empty cursor is the first page.
func DecodeSkillCursor(cursor string) (string, string, bool) {
	if cursor == "" {
		return "", "", true
	}
	data, err := base64.RawURLEncoding.DecodeString(cursor)
	if err != nil {
		return "", "", false
	}
	var values []string
	if json.Unmarshal(data, &values) != nil || len(values) != 2 || values[0] == "" || values[1] == "" {
		return "", "", false
	}
	return values[0], values[1], true
}
