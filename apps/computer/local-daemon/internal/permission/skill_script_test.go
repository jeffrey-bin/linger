package permission

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSkillScriptReadsOnlyScriptsInsideASkill(t *testing.T) {
	root := t.TempDir()
	skill := filepath.Join(root, "xhs")
	if err := os.MkdirAll(filepath.Join(skill, "scripts"), 0o700); err != nil {
		t.Fatal(err)
	}
	for name, body := range map[string]string{"SKILL.md": "---\nname: xhs\n---\n", "scripts/read.js": "return args.n;", "scripts/notes.txt": "x"} {
		if err := os.WriteFile(filepath.Join(skill, name), []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	loose := filepath.Join(root, "loose.js")
	if err := os.WriteFile(loose, []byte("return 1;"), 0o600); err != nil {
		t.Fatal(err)
	}
	if body, err := SkillScript(filepath.Join(skill, "scripts", "read.js")); err != nil || body != "return args.n;" {
		t.Fatalf("skill script: %q %v", body, err)
	}
	for _, path := range []string{loose, filepath.Join(skill, "scripts", "notes.txt"), "scripts/read.js", filepath.Join(skill, "scripts", "gone.js")} {
		if _, err := SkillScript(path); err == nil {
			t.Fatalf("%s was read", path)
		}
	}
	evidence := RunScriptEvidence("mcp__computer__run_script", map[string]any{"script_file": filepath.Join(skill, "scripts", "read.js")})
	if evidence == nil || evidence.Script == nil || evidence.Script.Body != "return args.n;" || evidence.Script.SHA256 == "" {
		t.Fatalf("evidence: %+v", evidence)
	}
	if missing := RunScriptEvidence("mcp__computer__run_script", map[string]any{"script_file": loose}); missing == nil || len(missing.Missing) != 1 || !strings.Contains(missing.Missing[0], "SKILL.md") {
		t.Fatalf("missing: %+v", missing)
	}
	if RunScriptEvidence("mcp__computer__click", map[string]any{"script_file": loose}) != nil {
		t.Fatal("evidence for another tool")
	}
}
