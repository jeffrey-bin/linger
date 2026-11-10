package lingercontext

import (
	"archive/zip"
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
)

const demoSkillDigest = "b46c269b8ee9240b2626d113988e1a5e431a5f928997f30f38a0737b974944a7"

type zipEntry struct {
	name string
	body string
	mode os.FileMode
}

func skillArchive(t *testing.T, entries []zipEntry) []byte {
	t.Helper()
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	for _, entry := range entries {
		header := &zip.FileHeader{Name: entry.name, Method: zip.Store}
		mode := entry.mode
		if mode == 0 {
			mode = 0o644
		}
		header.SetMode(mode)
		file, err := writer.CreateHeader(header)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := io.WriteString(file, entry.body); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

func demoSkill(t *testing.T, wrapper string) []byte {
	return skillArchive(t, []zipEntry{
		{name: wrapper + "SKILL.md", body: "---\nname: demo\n---\nDemo skill\n"},
		{name: wrapper + "scripts/run.sh", body: "#!/bin/sh\necho hi\n", mode: 0o755},
	})
}

func skillFetcher(archive []byte, calls *atomic.Int32) func(context.Context, string) (io.ReadCloser, error) {
	return func(_ context.Context, manifestID string) (io.ReadCloser, error) {
		calls.Add(1)
		if manifestID != "manifest_demo" {
			return nil, ErrSkillPackageUnavailable
		}
		return io.NopCloser(bytes.NewReader(archive)), nil
	}
}

func TestSkillPackageDigestMatchesTeamHub(t *testing.T) {
	files, err := extractSkillPackage(demoSkill(t, "demo/"), filepath.Join(t.TempDir(), "files"))
	if err != nil {
		t.Fatal(err)
	}
	if got := skillPackageDigest(files); got != demoSkillDigest {
		t.Fatalf("digest=%s, want the digest TeamHub computes", got)
	}
}

func TestEnsureProjectsVerifiedSkillPackagesAndCachesThem(t *testing.T) {
	content := newTestContent(t)
	store := openTestStore(t)
	var calls atomic.Int32
	source := ContentSource{ContentURL: content.url(), FetchSkillPackage: skillFetcher(demoSkill(t, ""), &calls)}
	skills := []Skill{{PackageName: "demo", ManifestID: "manifest_demo", PackageSHA256: demoSkillDigest}}
	digest := content.publish(t, "context-1", "runtime-1", nil, nil, skills)
	record, err := store.Ensure(t.Context(), testRequest("context-1", digest), source)
	if err != nil {
		t.Fatal(err)
	}
	skillFile := filepath.Join(record.WorkspacePath, ".agents", "skills", "demo", "SKILL.md")
	if got, err := os.ReadFile(skillFile); err != nil || !strings.Contains(string(got), "Demo skill") {
		t.Fatalf("Skill=%q err=%v", got, err)
	}
	script, err := os.Stat(filepath.Join(record.WorkspacePath, ".agents", "skills", "demo", "scripts", "run.sh"))
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" && script.Mode()&0o100 == 0 {
		t.Fatalf("executable Skill file mode=%v", script.Mode())
	}
	if names := authorizedClaudeSkillNames(record.View.Mappings); len(names) != 1 || names[0] != "demo" {
		t.Fatalf("Claude Skill names=%v", names)
	}
	other := content.publish(t, "context-2", "runtime-1", nil, nil, skills)
	if _, err := store.Ensure(t.Context(), testRequest("context-2", other), source); err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 1 {
		t.Fatalf("package fetched %d times, want one", calls.Load())
	}
}

func TestEnsureRejectsASkillPackageThatIsNotItsDigest(t *testing.T) {
	content := newTestContent(t)
	store := openTestStore(t)
	var calls atomic.Int32
	tampered := skillArchive(t, []zipEntry{{name: "SKILL.md", body: "---\nname: demo\n---\nTampered\n"}})
	source := ContentSource{ContentURL: content.url(), FetchSkillPackage: skillFetcher(tampered, &calls)}
	digest := content.publish(t, "context-1", "runtime-1", nil, nil,
		[]Skill{{PackageName: "demo", ManifestID: "manifest_demo", PackageSHA256: demoSkillDigest}})
	if _, err := store.Ensure(t.Context(), testRequest("context-1", digest), source); err == nil || !strings.Contains(err.Error(), "does not match its TeamHub digest") {
		t.Fatalf("tampered package accepted: %v", err)
	}
	if _, err := os.Stat(filepath.Join(store.root, ".skill-packages", demoSkillDigest)); !os.IsNotExist(err) {
		t.Fatalf("an unverified package was cached: %v", err)
	}
}

func TestSkillPackageRejectsUnsafeArchives(t *testing.T) {
	for name, entries := range map[string][]zipEntry{
		"parent path":      {{name: "SKILL.md"}, {name: "../escape.txt"}},
		"absolute path":    {{name: "SKILL.md"}, {name: "/etc/passwd"}},
		"symbolic link":    {{name: "SKILL.md"}, {name: "link", mode: os.ModeSymlink | 0o777}},
		"no Skill":         {{name: "README.md"}},
		"two wrappers":     {{name: "a/SKILL.md"}, {name: "b/other.md"}},
		"case duplicate":   {{name: "SKILL.md"}, {name: "Notes.md"}, {name: "notes.md"}},
		"dot segment path": {{name: "SKILL.md"}, {name: "a/./b.md"}},
	} {
		if _, err := extractSkillPackage(skillArchive(t, entries), filepath.Join(t.TempDir(), "files")); err == nil {
			t.Fatalf("%s was extracted", name)
		}
	}
}

func TestEnsureReportsAnUnavailableSkillPackage(t *testing.T) {
	content := newTestContent(t)
	store := openTestStore(t)
	var calls atomic.Int32
	source := ContentSource{ContentURL: content.url(), FetchSkillPackage: skillFetcher(demoSkill(t, ""), &calls)}
	digest := content.publish(t, "context-1", "runtime-1", nil, nil,
		[]Skill{{PackageName: "demo", ManifestID: "manifest_revoked", PackageSHA256: demoSkillDigest}})
	if _, err := store.Ensure(t.Context(), testRequest("context-1", digest), source); !errors.Is(err, ErrSkillPackageUnavailable) {
		t.Fatalf("unavailable package error=%v", err)
	}
}
