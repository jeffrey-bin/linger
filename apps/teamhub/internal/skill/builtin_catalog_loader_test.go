package skill

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io/fs"
	"net/http"
	"reflect"
	"strings"
	"testing"
	"testing/fstest"

	builtinskills "github.com/simplexai-labs/linger/skills"
)

const loaderFixtureDirectory = "builtin/fixture/1.0.0"

const loaderFixtureSkillMarkdown = "---\nname: fixture\ndescription: Fixture Skill.\n---\n# Fixture\n"

func loaderFixture(files map[string]string) fstest.MapFS {
	source := fstest.MapFS{}
	for name, content := range files {
		source[loaderFixtureDirectory+"/"+name] = &fstest.MapFile{Data: []byte(content)}
	}
	return source
}

func TestStreamingLoaderMatchesCanonicalPackageContract(t *testing.T) {
	// The same vector is checked by the canonical digest and Computer tests.
	// Do not rebuild every embedded package through the retired ZIP loader.
	markdown := "---\nname: sample-skill\ndescription: A sample local Skill\n---\n\n# Sample\n"
	script := "#!/bin/sh\nexit 0\n"
	pkg, err := loadPackageFromFS(loaderFixture(map[string]string{
		"SKILL.md": markdown, "scripts/run.sh": script,
	}), loaderFixtureDirectory)
	if err != nil {
		t.Fatal(err)
	}
	const digest = "d37a492e077c9dbea7ad7de7de46bcf668b12ec8678dc6a569afbc7901d241b0"
	if hex.EncodeToString(pkg.SHA256[:]) != digest {
		t.Fatalf("package digest = %x, want %s", pkg.SHA256, digest)
	}
	if pkg.Name != "sample-skill" || pkg.Description != "A sample local Skill" ||
		pkg.Frontmatter.Name != pkg.Name || pkg.Frontmatter.Description != pkg.Description ||
		pkg.SizeBytes != int64(len(markdown)+len(script)) {
		t.Fatalf("package metadata = %+v", pkg)
	}
	wantFiles := []PackageFile{
		{Path: "SKILL.md", MediaType: "text/markdown; charset=utf-8", SizeBytes: int64(len(markdown)), SHA256: sha256.Sum256([]byte(markdown))},
		{Path: "scripts/run.sh", MediaType: "text/plain; charset=utf-8", SizeBytes: int64(len(script)), SHA256: sha256.Sum256([]byte(script))},
	}
	// Equality also checks stable order and that file content is not retained.
	if !reflect.DeepEqual(pkg.Files, wantFiles) {
		t.Fatalf("package files = %+v, want %+v", pkg.Files, wantFiles)
	}
}

func TestStreamingLoaderRejectsMissingRootSkillMarkdown(t *testing.T) {
	source := loaderFixture(map[string]string{"nested/SKILL.md": loaderFixtureSkillMarkdown})
	_, err := loadPackageFromFS(source, loaderFixtureDirectory)
	if err == nil || !strings.Contains(err.Error(), "root SKILL.md") {
		t.Fatalf("missing root SKILL.md error = %v", err)
	}
}

func TestStreamingLoaderRejectsInvalidFrontmatter(t *testing.T) {
	source := loaderFixture(map[string]string{"SKILL.md": "---\ndescription: Fixture Skill.\n---\n# Fixture\n"})
	if _, err := loadPackageFromFS(source, loaderFixtureDirectory); err == nil {
		t.Fatal("frontmatter without name was accepted")
	}
}

func TestStreamingLoaderEnforcesFileCountLimit(t *testing.T) {
	source := loaderFixture(map[string]string{
		"SKILL.md": loaderFixtureSkillMarkdown,
		"a.txt":    "a",
		"b.txt":    "b",
	})
	limits := DefaultPackageLimits()
	limits.MaxFiles = 2
	_, err := loadPackageWithLimits(source, loaderFixtureDirectory, limits)
	if !errors.Is(err, ErrPackageLimitExceeded) {
		t.Fatalf("too many files error = %v, want ErrPackageLimitExceeded", err)
	}
}

func TestStreamingLoaderEnforcesPerFileLimit(t *testing.T) {
	limit := len(loaderFixtureSkillMarkdown)
	source := loaderFixture(map[string]string{
		"SKILL.md": loaderFixtureSkillMarkdown,
		"data.txt": strings.Repeat("x", limit+1),
	})
	limits := DefaultPackageLimits()
	limits.MaxFileBytes = int64(limit)
	_, err := loadPackageWithLimits(source, loaderFixtureDirectory, limits)
	if !errors.Is(err, ErrPackageLimitExceeded) || !strings.Contains(err.Error(), "data.txt") {
		t.Fatalf("oversized file error = %v, want ErrPackageLimitExceeded naming data.txt", err)
	}
}

func TestStreamingLoaderEnforcesTotalLimit(t *testing.T) {
	source := loaderFixture(map[string]string{
		"SKILL.md": loaderFixtureSkillMarkdown,
		"a.txt":    "ab",
	})
	limits := DefaultPackageLimits()
	limits.MaxTotalBytes = int64(len(loaderFixtureSkillMarkdown)) + 1
	_, err := loadPackageWithLimits(source, loaderFixtureDirectory, limits)
	if !errors.Is(err, ErrPackageLimitExceeded) {
		t.Fatalf("total size error = %v, want ErrPackageLimitExceeded", err)
	}
}

func TestStreamingLoaderRejectsNonNormalizedPath(t *testing.T) {
	// "é" in decomposed form (e + combining acute) is not NFC.
	source := loaderFixture(map[string]string{
		"SKILL.md":  loaderFixtureSkillMarkdown,
		"café.txt": "x",
	})
	_, err := loadPackageFromFS(source, loaderFixtureDirectory)
	if err == nil || !strings.Contains(err.Error(), "normalized package path") {
		t.Fatalf("non-NFC path error = %v", err)
	}
}

func TestStreamingLoaderRejectsSymlinkEntry(t *testing.T) {
	source := loaderFixture(map[string]string{"SKILL.md": loaderFixtureSkillMarkdown})
	source[loaderFixtureDirectory+"/link.md"] = &fstest.MapFile{Data: []byte("SKILL.md"), Mode: fs.ModeSymlink}
	_, err := loadPackageFromFS(source, loaderFixtureDirectory)
	if err == nil || !strings.Contains(err.Error(), "not a regular file") {
		t.Fatalf("symlink entry error = %v", err)
	}
}

func TestStreamingLoaderMediaTypeMatchesContentSniffing(t *testing.T) {
	binary := make([]byte, 1500)
	for index := range binary {
		binary[index] = byte(index*31 + 7)
	}
	binary[0], binary[1], binary[2], binary[3] = 0x89, 'P', 'N', 'G'
	source := loaderFixture(map[string]string{
		"SKILL.md": loaderFixtureSkillMarkdown,
		"blob":     string(binary),
	})
	pkg, err := loadPackageFromFS(source, loaderFixtureDirectory)
	if err != nil {
		t.Fatal(err)
	}
	var blob *PackageFile
	for index := range pkg.Files {
		if pkg.Files[index].Path == "blob" {
			blob = &pkg.Files[index]
		}
	}
	if blob == nil {
		t.Fatalf("extensionless file missing from %+v", pkg.Files)
	}
	if want := http.DetectContentType(binary); blob.MediaType != want {
		t.Fatalf("media type = %q, want %q", blob.MediaType, want)
	}
	if blob.SizeBytes != int64(len(binary)) || blob.SHA256 != sha256.Sum256(binary) {
		t.Fatalf("blob size=%d sha=%x, want size=%d sha=%x", blob.SizeBytes, blob.SHA256, len(binary), sha256.Sum256(binary))
	}
}

// openFailingFS fails one embedded open so tests can prove read errors keep their package path.
type openFailingFS struct {
	fs.FS
	failPath string
}

func (source openFailingFS) Open(name string) (fs.File, error) {
	if name == source.failPath {
		return nil, errors.New("embedded storage unavailable")
	}
	return source.FS.Open(name)
}

func TestStreamingLoaderOpenFailureNamesEmbeddedPath(t *testing.T) {
	source := loaderFixture(map[string]string{
		"SKILL.md": loaderFixtureSkillMarkdown,
		"data.txt": "data",
	})
	_, err := loadPackageFromFS(openFailingFS{FS: source, failPath: loaderFixtureDirectory + "/data.txt"}, loaderFixtureDirectory)
	if err == nil || !strings.Contains(err.Error(), loaderFixtureDirectory+"/data.txt") || !strings.Contains(err.Error(), "embedded storage unavailable") {
		t.Fatalf("open failure error = %v, want embedded path and cause", err)
	}
}

// openRecordingFS records file opens so tests can prove a loader reads no package content.
// Directory metadata delegates without Open, matching how the embedded filesystem behaves.
type openRecordingFS struct {
	fs.FS
	opened []string
}

func (source *openRecordingFS) Open(name string) (fs.File, error) {
	if name != builtinCatalogPath {
		source.opened = append(source.opened, name)
	}
	return source.FS.Open(name)
}

func (source *openRecordingFS) Stat(name string) (fs.FileInfo, error) {
	return fs.Stat(source.FS, name)
}

func (source *openRecordingFS) ReadDir(name string) ([]fs.DirEntry, error) {
	return fs.ReadDir(source.FS, name)
}

func TestBuiltinDefinitionsSummarizeManifestsWithoutOpeningPackages(t *testing.T) {
	recorder := &openRecordingFS{FS: builtinskills.FS}
	definitions, err := loadBuiltinDefinitionsFromFS(recorder)
	if err != nil {
		t.Fatal(err)
	}
	if len(recorder.opened) != 0 {
		t.Fatalf("definition load opened package files: %v", recorder.opened)
	}
	full, err := loadBuiltinCatalog()
	if err != nil {
		t.Fatal(err)
	}
	if len(definitions.Skills) != len(full.Skills) {
		t.Fatalf("definitions Skills=%d, full Skills=%d", len(definitions.Skills), len(full.Skills))
	}
	for skillIndex, skill := range definitions.Skills {
		fullSkill := full.Skills[skillIndex]
		if skill.SkillID != fullSkill.SkillID || skill.Name != fullSkill.Name || len(skill.Manifests) != len(fullSkill.Manifests) {
			t.Fatalf("definition %s differs from the full catalog", skill.SkillID)
		}
		for manifestIndex, manifest := range skill.Manifests {
			want := fullSkill.Manifests[manifestIndex]
			if manifest.ManifestID != want.ManifestID || manifest.PackagePath != want.PackagePath {
				t.Fatalf("definition Manifest %s differs from the full catalog", manifest.ManifestID)
			}
			if manifest.FileCount != len(want.Package.Files) || manifest.SizeBytes != want.Package.SizeBytes {
				t.Fatalf("Manifest %s summary files=%d bytes=%d, package files=%d bytes=%d",
					manifest.ManifestID, manifest.FileCount, manifest.SizeBytes, len(want.Package.Files), want.Package.SizeBytes)
			}
			if len(manifest.Package.Files) != 0 {
				t.Fatalf("definition Manifest %s carries package content", manifest.ManifestID)
			}
		}
	}
}

func TestSummarizePackageDirectoryCountsRegularFilesAndRejectsSymlinks(t *testing.T) {
	source := loaderFixture(map[string]string{"SKILL.md": loaderFixtureSkillMarkdown, "a.txt": "ab"})
	fileCount, sizeBytes, err := summarizePackageDirectory(source, loaderFixtureDirectory)
	if err != nil {
		t.Fatal(err)
	}
	if want := len(loaderFixtureSkillMarkdown) + 2; fileCount != 2 || sizeBytes != int64(want) {
		t.Fatalf("summary files=%d bytes=%d, want files=2 bytes=%d", fileCount, sizeBytes, want)
	}
	source[loaderFixtureDirectory+"/link.md"] = &fstest.MapFile{Data: []byte("SKILL.md"), Mode: fs.ModeSymlink}
	if _, _, err := summarizePackageDirectory(source, loaderFixtureDirectory); err == nil || !strings.Contains(err.Error(), "not a regular file") {
		t.Fatalf("symlink summary error = %v", err)
	}
}
