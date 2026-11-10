package workspace

import (
	"os"
	"path/filepath"
	"testing"
)

func writeSkill(t *testing.T, directory, name, description string) string {
	t.Helper()
	if err := os.MkdirAll(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	body := "---\nname: " + name + "\ndescription: " + description + "\n---\nOnly a fixture.\n"
	if err := os.WriteFile(filepath.Join(directory, "SKILL.md"), []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return directory
}

func discoveredNames(skills []ClaudeSkill) []string {
	names := make([]string, 0, len(skills))
	for _, skill := range skills {
		names = append(names, skill.Name)
	}
	return names
}

func equalStrings(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}

func TestDiscoverClaudeSkillsReadsPersonalAndInstalledPluginTrees(t *testing.T) {
	configHome := t.TempDir()
	writeSkill(t, filepath.Join(configHome, "skills", "impeccable"), "impeccable", "Personal Skill")
	// An account-synced tree sits one level deeper and must not be inherited:
	// the Runtime disables claude.ai Skill and plugin sync.
	writeSkill(t, filepath.Join(configHome, "skills", "synced", "abc123", "xlsx"), "xlsx", "Account-synced Skill")
	// A marketplace checkout is fetched, not installed.
	writeSkill(t, filepath.Join(configHome, "plugins", "marketplaces", "shop", "plugins", "helper", "skills", "oz-notify"), "oz-notify", "Marketplace Skill")
	installed := filepath.Join(configHome, "plugins", "cache", "shop", "warp", "2.2.0")
	writeSkill(t, filepath.Join(installed, "skills", "warp-probe"), "warp-probe", "Installed plugin Skill")
	record := `{"version":2,"plugins":{"warp@shop":[{"scope":"user","installPath":` + jsonString(installed) + `}]}}`
	if err := os.MkdirAll(filepath.Join(configHome, "plugins"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(configHome, "plugins", "installed_plugins.json"), []byte(record), 0o600); err != nil {
		t.Fatal(err)
	}

	skills, err := DiscoverClaudeSkills(configHome)
	if err != nil {
		t.Fatal(err)
	}
	if names := discoveredNames(skills); !equalStrings(names, []string{"impeccable", "warp-probe"}) {
		t.Fatalf("inherited the wrong Skills: %v", names)
	}
	for _, skill := range skills {
		switch skill.Name {
		case "impeccable":
			if skill.Source != "user" {
				t.Fatalf("personal Skill source is %q", skill.Source)
			}
		case "warp-probe":
			if skill.Source != "warp" {
				t.Fatalf("plugin Skill source is %q", skill.Source)
			}
		}
	}
}

func TestDiscoverClaudeSkillsSkipsUnusableFrontmatter(t *testing.T) {
	configHome := t.TempDir()
	root := filepath.Join(configHome, "skills")
	writeSkill(t, filepath.Join(root, "good"), "good", "Has both fields")
	if err := os.MkdirAll(filepath.Join(root, "no-description"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "no-description", "SKILL.md"), []byte("---\nname: no-description\n---\nBody.\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, "no-skill-file"), 0o700); err != nil {
		t.Fatal(err)
	}
	oversized := filepath.Join(root, "oversized")
	if err := os.MkdirAll(oversized, 0o700); err != nil {
		t.Fatal(err)
	}
	body := append([]byte("---\nname: oversized\ndescription: Too large\n---\n"), make([]byte, 64*1024)...)
	if err := os.WriteFile(filepath.Join(oversized, "SKILL.md"), body, 0o600); err != nil {
		t.Fatal(err)
	}

	skills, err := DiscoverClaudeSkills(configHome)
	if err != nil {
		t.Fatal(err)
	}
	if names := discoveredNames(skills); !equalStrings(names, []string{"good"}) {
		t.Fatalf("unusable Skills were inherited: %v", names)
	}
}

func TestSyncClaudeSkillsLinksUnderTheInvocableName(t *testing.T) {
	configHome, configRoot, platform := t.TempDir(), t.TempDir(), t.TempDir()
	source := writeSkill(t, filepath.Join(configHome, "skills", "directory-name"), "frontmatter-name", "Names differ")

	names, err := SyncClaudeSkills(configRoot, configHome, platform)
	if err != nil {
		t.Fatal(err)
	}
	// Claude Code identifies a Skill by its directory name, so the link must
	// carry the frontmatter name the model will actually call.
	if !equalStrings(names, []string{"frontmatter-name"}) {
		t.Fatalf("inherited names are %v", names)
	}
	canonical, err := filepath.EvalSymlinks(source)
	if err != nil {
		t.Fatal(err)
	}
	target, err := os.Readlink(filepath.Join(configRoot, "skills", "frontmatter-name"))
	if err != nil || target != canonical {
		t.Fatalf("inherited Skill link is %q (%v)", target, err)
	}
}

func TestSyncClaudeSkillsYieldsToTheAuthorizedSnapshot(t *testing.T) {
	configHome, configRoot, platform := t.TempDir(), t.TempDir(), t.TempDir()
	writeSkill(t, filepath.Join(configHome, "skills", "shared-name"), "shared-name", "Computer copy")
	writeSkill(t, filepath.Join(configHome, "skills", "only-local"), "only-local", "Computer only")
	if err := os.MkdirAll(filepath.Join(platform, "shared-name"), 0o700); err != nil {
		t.Fatal(err)
	}

	names, err := SyncClaudeSkills(configRoot, configHome, platform)
	if err != nil {
		t.Fatal(err)
	}
	if !equalStrings(names, []string{"only-local"}) {
		t.Fatalf("a Snapshot name was shadowed: %v", names)
	}
	if _, err := os.Lstat(filepath.Join(configRoot, "skills", "shared-name")); !os.IsNotExist(err) {
		t.Fatal("an inherited Skill shadowed the authorized Snapshot")
	}
}

func TestSyncClaudeSkillsRemovesEntriesThatNoLongerExist(t *testing.T) {
	configHome, configRoot, platform := t.TempDir(), t.TempDir(), t.TempDir()
	writeSkill(t, filepath.Join(configHome, "skills", "kept"), "kept", "Still installed")
	root := filepath.Join(configRoot, "skills")
	if err := os.MkdirAll(root, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := createTestDirectoryLink(filepath.Join(configHome, "skills", "removed"), filepath.Join(root, "removed")); err != nil {
		t.Fatal(err)
	}
	// Anything in this daemon-owned directory that is not a link is stale state.
	if err := os.MkdirAll(filepath.Join(root, "leftover"), 0o700); err != nil {
		t.Fatal(err)
	}

	names, err := SyncClaudeSkills(configRoot, configHome, platform)
	if err != nil {
		t.Fatal(err)
	}
	if !equalStrings(names, []string{"kept"}) {
		t.Fatalf("inherited names are %v", names)
	}
	for _, stale := range []string{"removed", "leftover"} {
		if _, err := os.Lstat(filepath.Join(root, stale)); !os.IsNotExist(err) {
			t.Fatalf("stale entry %s survived", stale)
		}
	}
}

func jsonString(value string) string {
	encoded := make([]byte, 0, len(value)+2)
	encoded = append(encoded, '"')
	for _, character := range []byte(value) {
		if character == '"' || character == '\\' {
			encoded = append(encoded, '\\')
		}
		encoded = append(encoded, character)
	}
	return string(append(encoded, '"'))
}
