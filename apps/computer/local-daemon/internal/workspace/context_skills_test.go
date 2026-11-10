package workspace

import (
	"os"
	"path/filepath"
	"testing"
)

func TestClaudeProjectSkillsRemainLiveAndRejectLocalContent(t *testing.T) {
	stubClaudeKeychain(t, "")
	workspace, home := t.TempDir(), t.TempDir()
	for i := 0; i < 2; i++ {
		if _, err := ConfigureClaudeContextHome(home, workspace, map[string]string{"HOME": t.TempDir()}, nil); err != nil {
			t.Fatal(err)
		}
	}
	source := filepath.Join(workspace, ".agents", "skills", "café.txt")
	if err := os.WriteFile(source, []byte("fresh skill"), 0600); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(workspace, ".claude", "skills", "café.txt"))
	if err != nil || string(data) != "fresh skill" {
		t.Fatalf("snapshot is not live: %q %v", data, err)
	}
	if err := os.Remove(filepath.Join(workspace, ".claude", "skills")); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(workspace, ".claude", "skills"), 0700); err != nil {
		t.Fatal(err)
	}
	if _, err := ConfigureClaudeContextHome(home, workspace, map[string]string{"HOME": t.TempDir()}, nil); err == nil {
		t.Fatal("accepted local content in the snapshot link")
	}
	if data, err := os.ReadFile(source); err != nil || string(data) != "fresh skill" {
		t.Fatal("link removal touched snapshot content")
	}
}
