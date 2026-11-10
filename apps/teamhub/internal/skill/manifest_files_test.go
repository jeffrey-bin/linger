package skill

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
)

func manifestTestFile(path string) ManifestFile {
	return ManifestFile{
		Path: path, MediaType: "text/plain", SizeBytes: 1,
		SHA256: strings.Repeat("00", 32), ObjectKey: "objects/fixture",
	}
}

func TestValidateManifestFilesPathConflicts(t *testing.T) {
	cases := []struct {
		name          string
		first, second string
		wantErr       bool
	}{
		{name: "file before nested file", first: "scripts/a", second: "scripts/a/b", wantErr: true},
		{name: "nested file before file", first: "scripts/a/b", second: "scripts/a", wantErr: true},
		{name: "casefold file before nested file", first: "scripts/A", second: "scripts/a/b", wantErr: true},
		{name: "casefold nested file before file", first: "scripts/a/B", second: "scripts/A", wantErr: true},
		{name: "deep nested after file", first: "references/x", second: "references/x/y/z", wantErr: true},
		{name: "deep nested before file", first: "references/x/y/z", second: "references/x", wantErr: true},
		{name: "exact duplicate", first: "scripts/a", second: "scripts/a", wantErr: true},
		{name: "casefold duplicate", first: "scripts/a", second: "scripts/A", wantErr: true},
		{name: "sibling prefix directory", first: "scripts/a", second: "scripts/ab/c"},
		{name: "dot is not a separator", first: "scripts/a.b", second: "scripts/a/c"},
		{name: "dash is not a separator", first: "scripts/a-b", second: "scripts/a/c"},
		{name: "percent is literal", first: "scripts/a%", second: "scripts/ab/c"},
		{name: "underscore is literal", first: "scripts/a_", second: "scripts/ab/c"},
		{name: "underscore file before directory", first: "scripts/a_", second: "scripts/a/b"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := ValidateManifestFiles([]ManifestFile{manifestTestFile(tc.first), manifestTestFile(tc.second)})
			if tc.wantErr != (err != nil) {
				t.Fatalf("ValidateManifestFiles(%q, %q) error=%v, want error=%t", tc.first, tc.second, err, tc.wantErr)
			}
			if err != nil && !errors.Is(err, ErrInvalidManifestFiles) {
				t.Fatalf("error=%v does not wrap ErrInvalidManifestFiles", err)
			}
		})
	}
}

// The conflict check covers the whole list, at sizes on both sides of the old
// statement-size split.
func TestValidateManifestFilesLargeLists(t *testing.T) {
	for _, size := range []int{32, 33, 256} {
		t.Run(fmt.Sprintf("%d files", size), func(t *testing.T) {
			files := make([]ManifestFile, 0, size+1)
			for index := range size {
				files = append(files, manifestTestFile(fmt.Sprintf("references/fill-%03d.md", index)))
			}
			if err := ValidateManifestFiles(files); err != nil {
				t.Fatalf("near-miss list: %v", err)
			}
			files = append(files, manifestTestFile("references/fill-000.md/inner"))
			if err := ValidateManifestFiles(files); !errors.Is(err, ErrInvalidManifestFiles) {
				t.Fatalf("conflict at the end error=%v", err)
			}
		})
	}
}

func TestValidateManifestFilesRejectsUnsafePaths(t *testing.T) {
	for _, path := range []string{
		"", "/SKILL.md", "C:/SKILL.md", `scripts\a`, "scripts//a", "scripts/./a", "scripts/../a",
		"./a", "../a", ".", "..", "scripts/", "scripts/a/", "scripts/\x01", "scripts/\x7f",
		"scripts/é", strings.Repeat("a", 1025),
	} {
		if err := ValidateManifestFiles([]ManifestFile{manifestTestFile(path)}); !errors.Is(err, ErrInvalidManifestFiles) {
			t.Errorf("path %q error=%v, want rejected", path, err)
		}
	}
	for _, path := range []string{"SKILL.md", "a b/c.md", "scripts/a~1", strings.Repeat("a", 1024)} {
		if err := ValidateManifestFiles([]ManifestFile{manifestTestFile(path)}); err != nil {
			t.Errorf("path %q error=%v, want accepted", path, err)
		}
	}
}

func TestValidateManifestFilesRejectsBadMetadata(t *testing.T) {
	for name, mutate := range map[string]func(*ManifestFile){
		"empty media type":     func(file *ManifestFile) { file.MediaType = "" },
		"long media type":      func(file *ManifestFile) { file.MediaType = strings.Repeat("a", 256) },
		"empty object key":     func(file *ManifestFile) { file.ObjectKey = "" },
		"long object key":      func(file *ManifestFile) { file.ObjectKey = strings.Repeat("a", 513) },
		"negative size":        func(file *ManifestFile) { file.SizeBytes = -1 },
		"oversized file":       func(file *ManifestFile) { file.SizeBytes = 8<<20 + 1 },
		"short digest":         func(file *ManifestFile) { file.SHA256 = "00" },
		"upper-case digest":    func(file *ManifestFile) { file.SHA256 = strings.Repeat("AB", 32) },
		"non-hexadecimal hash": func(file *ManifestFile) { file.SHA256 = strings.Repeat("zz", 32) },
	} {
		file := manifestTestFile("SKILL.md")
		mutate(&file)
		if err := ValidateManifestFiles([]ManifestFile{file}); !errors.Is(err, ErrInvalidManifestFiles) {
			t.Errorf("%s: error=%v, want rejected", name, err)
		}
	}
}

func TestEncodeManifestFilesSortsByPathBytes(t *testing.T) {
	encoded, err := EncodeManifestFiles([]ManifestFile{
		manifestTestFile("scripts/b"), manifestTestFile("SKILL.md"), manifestTestFile("README.md"), manifestTestFile("scripts/a"),
	})
	if err != nil {
		t.Fatal(err)
	}
	var decoded []ManifestFile
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatal(err)
	}
	var paths []string
	for _, file := range decoded {
		paths = append(paths, file.Path)
	}
	if got := strings.Join(paths, ","); got != "README.md,SKILL.md,scripts/a,scripts/b" {
		t.Fatalf("encoded order %s", got)
	}
	if _, err := EncodeManifestFiles([]ManifestFile{manifestTestFile("a"), manifestTestFile("A")}); err == nil {
		t.Fatal("encoded a casefold duplicate")
	}
}
