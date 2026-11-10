package localskills

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	wire "github.com/simplexai-labs/linger/contracts-go/runnergateway"
)

func TestCatalogScansSkillTrees(t *testing.T) {
	home := t.TempDir()
	root := filepath.Join(home, ".agents", "skills")
	skill := filepath.Join(root, "review-helper")
	writeSkillFile(t, filepath.Join(skill, "SKILL.md"), "---\nname: review-helper\ndescription: Review changes\n---\n", 0o600)
	writeSkillFile(t, filepath.Join(skill, "scripts", "check.sh"), "#!/bin/sh\nexit 0\n", 0o700)
	now := time.Date(2026, 9, 2, 0, 0, 0, 0, time.UTC)
	catalog := openTestCatalog(t, home, now)

	scan := testCommand(now)
	scan.RuntimeType = "codex"
	scanned := handleOutcome[scannedOutcome](t, catalog, scan)
	if len(scanned.Items) != 1 || scanned.Items[0].Importability != "ready" || scanned.Items[0].Name != "review-helper" {
		t.Fatalf("scan outcome=%+v", scanned)
	}
	if scanned.Items[0].NativeSource != "user" || scanned.Items[0].NativeEnabled == nil || !*scanned.Items[0].NativeEnabled {
		t.Fatal("native inheritance metadata missing")
	}
	if len(scanned.Items[0].RiskFlags) != 2 || scanned.Items[0].RiskFlags[0] != "contains_scripts" || scanned.Items[0].RiskFlags[1] != "contains_executables" {
		t.Fatalf("risk flags=%v", scanned.Items[0].RiskFlags)
	}
}

func TestCatalogMarksUnsafeSymlinkUnsupported(t *testing.T) {
	home := t.TempDir()
	root := filepath.Join(home, ".claude", "skills")
	skill := filepath.Join(root, "safe-skill")
	manifest := filepath.Join(skill, "SKILL.md")
	writeSkillFile(t, manifest, "---\nname: safe-skill\ndescription: Safe\n---\n", 0o600)
	outside := filepath.Join(t.TempDir(), "outside-skill")
	writeSkillFile(t, filepath.Join(outside, "SKILL.md"), "---\nname: outside-skill\ndescription: Outside\n---\n", 0o600)
	if err := os.MkdirAll(root, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := createTestDirectoryLink(outside, filepath.Join(root, "outside-skill")); err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 9, 2, 0, 0, 0, 0, time.UTC)
	catalog := openTestCatalog(t, home, now)
	scan := testCommand(now)
	scan.RuntimeType = "claude"
	scanned := handleOutcome[scannedOutcome](t, catalog, scan)
	if len(scanned.Items) != 2 {
		t.Fatalf("items=%+v", scanned.Items)
	}
	var ready, unsupported Candidate
	for _, item := range scanned.Items {
		if item.Importability == "ready" {
			ready = item
		} else {
			unsupported = item
		}
	}
	if ready.Name != "safe-skill" || unsupported.ErrorCode != "LOCAL_SKILL_UNSAFE_PATH" {
		t.Fatalf("ready=%+v unsupported=%+v", ready, unsupported)
	}
}

func TestPackageDigestMatchesTypeScriptContract(t *testing.T) {
	root := t.TempDir()
	skill := filepath.Join(root, "sample-skill")
	writeSkillFile(t, filepath.Join(skill, "SKILL.md"), "---\nname: sample-skill\ndescription: A sample local Skill\n---\n\n# Sample\n", 0o600)
	writeSkillFile(t, filepath.Join(skill, "scripts", "run.sh"), "#!/bin/sh\nexit 0\n", 0o700)
	inspected, err := inspectSkill(skill, os.Getuid())
	if err != nil {
		t.Fatal(err)
	}
	const expected = "d37a492e077c9dbea7ad7de7de46bcf668b12ec8678dc6a569afbc7901d241b0"
	if inspected.PackageSHA256 != expected {
		t.Fatalf("package digest=%s, want TypeScript digest=%s", inspected.PackageSHA256, expected)
	}
}

func openTestCatalog(t *testing.T, home string, now time.Time) *Catalog {
	t.Helper()
	catalog, err := Open(Options{
		HomeDirectory: home, CurrentUID: os.Getuid(),
		Now: func() time.Time { return now },
	})
	if err != nil {
		t.Fatal(err)
	}
	return catalog
}

func testCommand(now time.Time) Command {
	return Command{
		Type: wire.TypeExecute, Kind: wire.KindSkillsScan, ProtocolVersion: wire.ProtocolVersion, CommandID: "command-scan",
		RunnerID: "computer-local", TenantID: "tenant-acme", OwnerActorID: "actor-alice",
		ConnectionEpoch: 1, ExpiresAt: now.Add(time.Hour), ScanID: "scan-local-skills",
	}
}

func handleOutcome[T any](t *testing.T, catalog *Catalog, command Command) T {
	t.Helper()
	encoded, err := json.Marshal(command)
	if err != nil {
		t.Fatal(err)
	}
	outcome, err := catalog.Handle(context.Background(), encoded)
	if err != nil {
		t.Fatal(err)
	}
	var decoded T
	if err := json.Unmarshal(outcome, &decoded); err != nil {
		t.Fatal(err)
	}
	return decoded
}

func writeSkillFile(t *testing.T, path, content string, mode os.FileMode) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), mode); err != nil {
		t.Fatal(err)
	}
}

// The Skills panel distinguishes an inherited Skill from an importable one by
// native_source. Without native discovery for Claude, a Local Claude Agent's
// own Skills are listed as ordinary import candidates and the panel shows none
// of them as inherited.
func TestCatalogReportsClaudeSkillsAsInherited(t *testing.T) {
	home := t.TempDir()
	root := filepath.Join(home, ".claude", "skills")
	writeSkillFile(t, filepath.Join(root, "impeccable", "SKILL.md"),
		"---\nname: impeccable\ndescription: Design quality\n---\n", 0o600)
	// Account-synced Skills sit one level deeper and are not inherited.
	writeSkillFile(t, filepath.Join(root, "synced", "abc123", "xlsx", "SKILL.md"),
		"---\nname: xlsx\ndescription: Spreadsheets\n---\n", 0o600)
	now := time.Date(2026, 9, 2, 0, 0, 0, 0, time.UTC)
	catalog := openTestCatalog(t, home, now)

	scan := testCommand(now)
	scan.RuntimeType = "claude"
	scanned := handleOutcome[scannedOutcome](t, catalog, scan)

	var inherited []string
	for _, item := range scanned.Items {
		if item.NativeSource != "" {
			inherited = append(inherited, item.Name)
		}
	}
	if len(inherited) != 1 || inherited[0] != "impeccable" {
		t.Fatalf("inherited Skills reported as %v (all items %+v)", inherited, scanned.Items)
	}
	for _, item := range scanned.Items {
		if item.Name == "impeccable" && (item.NativeSource != "user" || item.NativeEnabled == nil || !*item.NativeEnabled) {
			t.Fatalf("inheritance metadata missing: %+v", item)
		}
	}
}
