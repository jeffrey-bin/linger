package skill

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"strings"
	"testing"
)

type zipEntry struct {
	name    string
	content string
	mode    os.FileMode
}

func TestParsePackageNormalizesAndHashesFileCollection(t *testing.T) {
	flat := makeSkillZIP(t, []zipEntry{
		{name: "references/examples.md", content: "# Example\n"},
		{name: "SKILL.md", content: validSkillMarkdown("official-mock-artifact")},
	})
	wrapped := makeSkillZIP(t, []zipEntry{
		{name: "official-mock-artifact/SKILL.md", content: validSkillMarkdown("official-mock-artifact")},
		{name: "official-mock-artifact/references/examples.md", content: "# Example\n"},
	})

	first, err := ParsePackage(bytes.NewReader(flat), int64(len(flat)), DefaultPackageLimits())
	if err != nil {
		t.Fatal(err)
	}
	second, err := ParsePackage(bytes.NewReader(wrapped), int64(len(wrapped)), DefaultPackageLimits())
	if err != nil {
		t.Fatal(err)
	}
	if first.Name != "official-mock-artifact" || first.Description == "" {
		t.Fatalf("unexpected frontmatter: %+v", first.Frontmatter)
	}
	if first.SHA256 != second.SHA256 {
		t.Fatalf("equivalent packages have different hashes: %x != %x", first.SHA256, second.SHA256)
	}
	if len(first.Files) != 2 || first.Files[0].Path != "SKILL.md" || first.Files[1].Path != "references/examples.md" {
		t.Fatalf("files are not stably sorted: %+v", first.Files)
	}
	wantFileHash := sha256.Sum256([]byte(validSkillMarkdown("official-mock-artifact")))
	if first.Files[0].SHA256 != wantFileHash || first.Files[0].MediaType != "text/markdown; charset=utf-8" {
		t.Fatalf("unexpected SKILL.md metadata: %+v", first.Files[0])
	}
}

func TestParsePackagePreservesExtensionFrontmatterAsJSON(t *testing.T) {
	data := makeSkillZIP(t, []zipEntry{{
		name: "SKILL.md",
		content: `---
name: ecommerce-seo-optimizer
description: Optimizes ecommerce SEO.
version: "1.0.0"
author: BytesAgain
homepage: https://bytesagain.com
source: https://github.com/bytesagain/ai-skills
tags: [ecommerce, seo]
category: ecommerce
metadata:
  author: BytesAgain
  hermes:
    tags: [marketing, seo]
    category: seo-geo
---
`,
	}})

	pkg, err := ParsePackage(bytes.NewReader(data), int64(len(data)), DefaultPackageLimits())
	if err != nil {
		t.Fatal(err)
	}
	var extra map[string]any
	if err := json.Unmarshal(pkg.Frontmatter.FrontmatterExtra, &extra); err != nil {
		t.Fatal(err)
	}
	if extra["version"] != "1.0.0" || extra["author"] != "BytesAgain" || extra["category"] != "ecommerce" {
		t.Fatalf("unexpected extension frontmatter: %#v", extra)
	}
	tags, ok := extra["tags"].([]any)
	if !ok || len(tags) != 2 || tags[0] != "ecommerce" || tags[1] != "seo" {
		t.Fatalf("unexpected tags: %#v", extra["tags"])
	}
	metadata, ok := extra["metadata"].(map[string]any)
	if !ok {
		t.Fatalf("unexpected metadata: %#v", extra["metadata"])
	}
	hermes, ok := metadata["hermes"].(map[string]any)
	if !ok || hermes["category"] != "seo-geo" {
		t.Fatalf("unexpected nested metadata: %#v", metadata["hermes"])
	}
}

func TestCanonicalPackageDigestMatchesComputerContract(t *testing.T) {
	contents := map[string][]byte{
		"SKILL.md":       []byte("---\nname: sample-skill\ndescription: A sample local Skill\n---\n\n# Sample\n"),
		"scripts/run.sh": []byte("#!/bin/sh\nexit 0\n"),
	}
	files := make([]PackageFile, 0, len(contents))
	for path, content := range contents {
		files = append(files, PackageFile{
			Path: path, SizeBytes: int64(len(content)), SHA256: sha256.Sum256(content),
		})
	}
	digest := CanonicalPackageDigest(files)
	const expected = "d37a492e077c9dbea7ad7de7de46bcf668b12ec8678dc6a569afbc7901d241b0"
	if hex.EncodeToString(digest[:]) != expected {
		t.Fatalf("canonical digest = %x, want %s", digest, expected)
	}
}

func TestParsePackageRejectsMissingOrInvalidSkillMarkdown(t *testing.T) {
	tests := []struct {
		name    string
		entries []zipEntry
	}{
		{name: "missing", entries: []zipEntry{{name: "references/example.md", content: "example"}}},
		{name: "missing frontmatter", entries: []zipEntry{{name: "SKILL.md", content: "# Instructions\n"}}},
		{name: "missing name", entries: []zipEntry{{name: "SKILL.md", content: "---\ndescription: useful\n---\n"}}},
		{name: "invalid name", entries: []zipEntry{{name: "SKILL.md", content: validSkillMarkdown("Invalid_Name")}}},
		{name: "missing description", entries: []zipEntry{{name: "SKILL.md", content: "---\nname: valid-name\n---\n"}}},
		{name: "duplicate yaml key", entries: []zipEntry{{name: "SKILL.md", content: "---\nname: valid-name\nname: other-name\ndescription: useful\n---\n"}}},
		{name: "wrapper mismatch", entries: []zipEntry{{name: "wrong-name/SKILL.md", content: validSkillMarkdown("right-name")}}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			data := makeSkillZIP(t, test.entries)
			if _, err := ParsePackage(bytes.NewReader(data), int64(len(data)), DefaultPackageLimits()); err == nil {
				t.Fatal("invalid package was accepted")
			}
		})
	}
}

func TestParsePackageRejectsUnsafeAndConflictingPaths(t *testing.T) {
	for _, name := range []string{"/absolute.txt", "../outside.txt", "references/../SKILL.md", `references\windows.txt`, "bad\x00name", "references/bad\nname.md"} {
		t.Run(name, func(t *testing.T) {
			entries := []zipEntry{{name: "SKILL.md", content: validSkillMarkdown("valid-name")}, {name: name, content: "unsafe"}}
			if name == "bad\x00name" {
				entries[1].name = "bad" + string([]byte{0}) + "name"
			}
			data := makeSkillZIP(t, entries)
			if _, err := ParsePackage(bytes.NewReader(data), int64(len(data)), DefaultPackageLimits()); err == nil {
				t.Fatal("unsafe path was accepted")
			}
		})
	}

	// Stored file rows accept printable ASCII paths only, unique after ASCII
	// case folding; anything else must fail here with 400, not at insert.
	for name, entries := range map[string][]zipEntry{
		"non-ASCII":            {{name: "references/caf\u00e9.md", content: "one"}},
		"case duplicate":       {{name: "references/Notes.md", content: "one"}, {name: "references/notes.md", content: "two"}},
		"case parent conflict": {{name: "scripts/A", content: "file"}, {name: "scripts/a/b", content: "nested"}},
		"drive letter":         {{name: "C:/windows.txt", content: "drive"}},
	} {
		t.Run(name, func(t *testing.T) {
			data := makeSkillZIP(t, append([]zipEntry{{name: "SKILL.md", content: validSkillMarkdown("valid-name")}}, entries...))
			if _, err := ParsePackage(bytes.NewReader(data), int64(len(data)), DefaultPackageLimits()); err == nil {
				t.Fatal("path the stored file rows reject was accepted")
			}
		})
	}
	digitColon := makeSkillZIP(t, []zipEntry{
		{name: "SKILL.md", content: validSkillMarkdown("valid-name")},
		{name: "1:/notes.md", content: "not a drive"},
	})
	if _, err := ParsePackage(bytes.NewReader(digitColon), int64(len(digitColon)), DefaultPackageLimits()); err != nil {
		t.Fatalf("path the stored file rows accept was rejected: %v", err)
	}

	duplicateDirectory := makeSkillZIP(t, []zipEntry{
		{name: "SKILL.md", content: validSkillMarkdown("valid-name")},
		{name: "references/", mode: os.ModeDir | 0o755},
		{name: "references/", mode: os.ModeDir | 0o755},
	})
	if _, err := ParsePackage(bytes.NewReader(duplicateDirectory), int64(len(duplicateDirectory)), DefaultPackageLimits()); err == nil {
		t.Fatal("duplicate directory paths were accepted")
	}

	prefixCollision := makeSkillZIP(t, []zipEntry{
		{name: "SKILL.md", content: validSkillMarkdown("valid-name")},
		{name: "references", content: "file"},
		{name: "references-other", content: "intervening sort entry"},
		{name: "references/example.md", content: "nested"},
	})
	if _, err := ParsePackage(bytes.NewReader(prefixCollision), int64(len(prefixCollision)), DefaultPackageLimits()); err == nil {
		t.Fatal("file/directory prefix collision was accepted")
	}
}

func TestParsePackageRejectsExcessArchiveEntries(t *testing.T) {
	entries := []zipEntry{{name: "SKILL.md", content: validSkillMarkdown("valid-name")}}
	for _, name := range []string{"one/", "two/", "three/", "four/"} {
		entries = append(entries, zipEntry{name: name, mode: os.ModeDir | 0o755})
	}
	data := makeSkillZIP(t, entries)
	limits := DefaultPackageLimits()
	limits.MaxFiles = 1
	if _, err := ParsePackage(bytes.NewReader(data), int64(len(data)), limits); err == nil {
		t.Fatal("archive with excessive directory entries was accepted")
	}
}

func TestParsePackageRejectsSymlinkAndLimits(t *testing.T) {
	symlink := makeSkillZIP(t, []zipEntry{
		{name: "SKILL.md", content: validSkillMarkdown("valid-name")},
		{name: "references/link", content: "../secret", mode: os.ModeSymlink | 0o777},
	})
	if _, err := ParsePackage(bytes.NewReader(symlink), int64(len(symlink)), DefaultPackageLimits()); err == nil {
		t.Fatal("symlink was accepted")
	}

	base := []zipEntry{{name: "SKILL.md", content: validSkillMarkdown("valid-name")}, {name: "a.txt", content: "1234"}}
	for _, test := range []struct {
		name   string
		limits PackageLimits
	}{
		{name: "file count", limits: PackageLimits{MaxFiles: 1, MaxFileBytes: 1 << 20, MaxTotalBytes: 1 << 20, MaxCompressionRatio: 1000}},
		{name: "single file", limits: PackageLimits{MaxFiles: 10, MaxFileBytes: 8, MaxTotalBytes: 1 << 20, MaxCompressionRatio: 1000}},
		{name: "total size", limits: PackageLimits{MaxFiles: 10, MaxFileBytes: 1 << 20, MaxTotalBytes: 16, MaxCompressionRatio: 1000}},
	} {
		t.Run(test.name, func(t *testing.T) {
			data := makeSkillZIP(t, base)
			if _, err := ParsePackage(bytes.NewReader(data), int64(len(data)), test.limits); err == nil {
				t.Fatal("package exceeding limit was accepted")
			}
		})
	}

	bomb := makeSkillZIP(t, []zipEntry{
		{name: "SKILL.md", content: validSkillMarkdown("valid-name")},
		{name: "assets/zeros.bin", content: strings.Repeat("0", 64<<10)},
	})
	limits := DefaultPackageLimits()
	limits.MaxCompressionRatio = 2
	if _, err := ParsePackage(bytes.NewReader(bomb), int64(len(bomb)), limits); err == nil {
		t.Fatal("excessive compression ratio was accepted")
	}
}

func TestParseUploadedPackageAcceptsMarkdownAndZIP(t *testing.T) {
	markdown := []byte("---\nname: sidebar-upload\ndescription: Uploads from the Agent sidebar.\nversion: 1.2.0\n---\n\n# Instructions\n")
	parsed, err := ParseUploadedPackage(markdown, "skill.md", DefaultPackageLimits())
	if err != nil {
		t.Fatal(err)
	}
	if parsed.Name != "sidebar-upload" || OptionalFrontmatterVersion(parsed.Frontmatter.FrontmatterExtra) != "1.2.0" {
		t.Fatalf("markdown upload: %+v extra=%s", parsed.Frontmatter, parsed.Frontmatter.FrontmatterExtra)
	}
	archive := makeSkillZIP(t, []zipEntry{{name: "SKILL.md", content: string(markdown)}})
	zipped, err := ParseUploadedPackage(archive, "custom.zip", DefaultPackageLimits())
	if err != nil || zipped.Name != parsed.Name || zipped.SHA256 != parsed.SHA256 {
		t.Fatalf("zip upload: %+v %v", zipped, err)
	}
	if _, err = ParseUploadedPackage([]byte("not a skill"), "notes.txt", DefaultPackageLimits()); err == nil {
		t.Fatal("expected non-skill upload to fail")
	}
}

func makeSkillZIP(t *testing.T, entries []zipEntry) []byte {
	t.Helper()
	var output bytes.Buffer
	writer := zip.NewWriter(&output)
	for _, entry := range entries {
		header := &zip.FileHeader{Name: entry.name, Method: zip.Deflate}
		if entry.mode != 0 {
			header.SetMode(entry.mode)
		}
		part, err := writer.CreateHeader(header)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := part.Write([]byte(entry.content)); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return output.Bytes()
}

func validSkillMarkdown(name string) string {
	return "---\nname: " + name + "\ndescription: Reads an input Artifact and writes a deterministic result when testing TeamHub.\n---\n\n# Instructions\n"
}
