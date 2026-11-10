package workspace

import (
	"os"
	"path/filepath"
	"testing"
)

func TestClaudeContextHasNativeSkillPathAndPrivateConfig(t *testing.T) {
	stubClaudeKeychain(t, "")
	home, workspace := t.TempDir(), t.TempDir()
	environment := map[string]string{"HOME": t.TempDir()}
	if _, err := ConfigureClaudeContextHome(home, workspace, environment, nil); err != nil {
		t.Fatal(err)
	}
	if environment["CLAUDE_CONFIG_DIR"] != filepath.Join(home, ".claude") {
		t.Fatal("Claude config was not isolated")
	}
	target, err := os.Stat(filepath.Join(workspace, ".agents", "skills"))
	linked, linkErr := os.Stat(filepath.Join(workspace, ".claude", "skills"))
	if err != nil || linkErr != nil || !os.SameFile(target, linked) {
		t.Fatal("Claude cannot discover bound Skills")
	}
	info, err := os.Stat(filepath.Join(workspace, ".claude", "skills"))
	if err != nil || !info.IsDir() {
		t.Fatalf("empty Skill inventory left a dangling discovery path: %v", err)
	}
}

// An inherited Skill stays on the Computer. Its bytes never enter the Context
// workspace, which refuses a link that leaves it, and never enter the authorized
// Snapshot, which refuses a link at all; the isolated configuration directory is
// the one place that can hold one.
func TestClaudeContextInheritsComputerSkillsOutsideTheWorkspace(t *testing.T) {
	stubClaudeKeychain(t, "")
	home, workspace, userHome := t.TempDir(), t.TempDir(), t.TempDir()
	skill := filepath.Join(userHome, ".claude", "skills", "impeccable")
	if err := os.MkdirAll(skill, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(skill, "SKILL.md"),
		[]byte("---\nname: impeccable\ndescription: Computer Skill\n---\nOnly a fixture.\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	inherited, err := ConfigureClaudeContextHome(home, workspace, map[string]string{"HOME": userHome}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(inherited) != 1 || inherited[0] != "impeccable" {
		t.Fatalf("inherited Skills are %v", inherited)
	}
	link := filepath.Join(home, ".claude", "skills", "impeccable")
	if _, err := os.Readlink(link); err != nil {
		t.Fatalf("inherited Skill was not linked into the isolated configuration: %v", err)
	}
	if _, err := os.Lstat(filepath.Join(workspace, ".agents", "skills", "impeccable")); !os.IsNotExist(err) {
		t.Fatal("an inherited Skill entered the authorized Snapshot")
	}
}
