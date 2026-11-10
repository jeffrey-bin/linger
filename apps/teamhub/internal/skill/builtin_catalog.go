package skill

import (
	"bytes"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"path"
	"regexp"
	"sort"
	"strings"

	builtinskills "github.com/simplexai-labs/linger/skills"
	"gopkg.in/yaml.v3"
)

const builtinCatalogPath = "builtin/catalog.yaml"

const builtinPackageMaxFiles = 512

var (
	skillIDPattern         = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,511}$`)
	manifestIDPattern      = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,511}$`)
	manifestVersionPattern = regexp.MustCompile(`^(0|[1-9][0-9]*)[.](0|[1-9][0-9]*)[.](0|[1-9][0-9]*)(-((0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)([.](0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?([+]([0-9A-Za-z-]+)([.][0-9A-Za-z-]+)*)?$`)
)

// packageMediaSniffBytes is the prefix http.DetectContentType inspects.
const packageMediaSniffBytes = 512

type catalogDocument struct {
	SchemaVersion int                      `yaml:"schema_version"`
	Skills        []catalogSkillDefinition `yaml:"skills"`
}

type catalogSkillDefinition struct {
	SkillID             string                      `yaml:"skill_id"`
	BootstrapManifestID string                      `yaml:"bootstrap_manifest_id"`
	DefaultAgentTypes   []string                    `yaml:"default_agent_types"`
	Manifests           []catalogManifestDefinition `yaml:"manifests"`
}

type catalogManifestDefinition struct {
	ManifestID  string `yaml:"manifest_id"`
	Version     string `yaml:"version"`
	PackagePath string `yaml:"package_path"`
}

type builtinCatalog struct {
	Skills []builtinSkill
	// source is the filesystem that package files are streamed from at install time.
	source fs.FS
}

type builtinSkill struct {
	SkillID             string
	Name                string
	BootstrapManifestID string
	DefaultAgentTypes   []string
	Manifests           []builtinManifest
}

type builtinManifest struct {
	ManifestID string
	Version    string
	// PackagePath is the embedded directory that holds this Manifest's files.
	PackagePath string
	// FileCount and SizeBytes summarize PackagePath from directory metadata only.
	FileCount int
	SizeBytes int64
	// Package is empty until the Manifest's content is loaded.
	Package Package
}

// loadBuiltinCatalog loads the embedded catalog with every Package verified.
func loadBuiltinCatalog() (builtinCatalog, error) {
	return loadBuiltinCatalogFromFS(builtinskills.FS)
}

// loadBuiltinDefinitions loads the embedded catalog definitions without
// opening any package file.
func loadBuiltinDefinitions() (builtinCatalog, error) {
	return loadBuiltinDefinitionsFromFS(builtinskills.FS)
}

// loadBuiltinCatalogFromFS loads definitions and then streams every Package
// through its content validations.
func loadBuiltinCatalogFromFS(source fs.FS) (builtinCatalog, error) {
	catalog, err := loadBuiltinDefinitionsFromFS(source)
	if err != nil {
		return builtinCatalog{}, err
	}
	for skillIndex := range catalog.Skills {
		skill := &catalog.Skills[skillIndex]
		for manifestIndex := range skill.Manifests {
			manifest := &skill.Manifests[manifestIndex]
			pkg, err := loadManifestPackage(source, skill.SkillID, *manifest)
			if err != nil {
				return builtinCatalog{}, err
			}
			manifest.Package = pkg
		}
	}
	return catalog, nil
}

// loadBuiltinDefinitionsFromFS validates catalog.yaml and summarizes each
// Manifest directory from metadata. Package content is not read here.
func loadBuiltinDefinitionsFromFS(source fs.FS) (builtinCatalog, error) {
	content, err := fs.ReadFile(source, builtinCatalogPath)
	if err != nil {
		return builtinCatalog{}, fmt.Errorf("read built-in Skill catalog: %w", err)
	}
	decoder := yaml.NewDecoder(bytes.NewReader(content))
	decoder.KnownFields(true)
	var document catalogDocument
	if err := decoder.Decode(&document); err != nil {
		return builtinCatalog{}, fmt.Errorf("decode built-in Skill catalog: %w", err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return builtinCatalog{}, fmt.Errorf("%w: catalog contains multiple YAML documents", ErrBuiltinSkillConflict)
		}
		return builtinCatalog{}, fmt.Errorf("decode built-in Skill catalog trailer: %w", err)
	}
	if document.SchemaVersion != 1 || len(document.Skills) == 0 {
		return builtinCatalog{}, fmt.Errorf("%w: unsupported or empty catalog", ErrBuiltinSkillConflict)
	}

	seenSkillIDs := make(map[string]struct{}, len(document.Skills))
	seenManifestIDs := make(map[string]struct{})
	seenPackagePaths := make(map[string]struct{})
	catalog := builtinCatalog{Skills: make([]builtinSkill, 0, len(document.Skills)), source: source}
	for _, definition := range document.Skills {
		if !skillIDPattern.MatchString(definition.SkillID) ||
			!manifestIDPattern.MatchString(definition.BootstrapManifestID) ||
			len(definition.Manifests) == 0 ||
			definition.DefaultAgentTypes == nil ||
			!canonicalAgentTypes(definition.DefaultAgentTypes) {
			return builtinCatalog{}, fmt.Errorf("%w: invalid catalog entry for Skill %q", ErrBuiltinSkillConflict, definition.SkillID)
		}
		if _, duplicate := seenSkillIDs[definition.SkillID]; duplicate {
			return builtinCatalog{}, fmt.Errorf("%w: duplicate Skill ID %s", ErrBuiltinSkillConflict, definition.SkillID)
		}
		seenSkillIDs[definition.SkillID] = struct{}{}

		skill := builtinSkill{
			SkillID:             definition.SkillID,
			BootstrapManifestID: definition.BootstrapManifestID,
			DefaultAgentTypes:   append([]string{}, definition.DefaultAgentTypes...),
			Manifests:           make([]builtinManifest, 0, len(definition.Manifests)),
		}
		seenVersions := make(map[string]struct{}, len(definition.Manifests))
		bootstrapFound := false
		for _, manifestDefinition := range definition.Manifests {
			if !manifestIDPattern.MatchString(manifestDefinition.ManifestID) ||
				!manifestVersionPattern.MatchString(manifestDefinition.Version) ||
				!validPackagePath(manifestDefinition.PackagePath, manifestDefinition.Version) {
				return builtinCatalog{}, fmt.Errorf(
					"%w: invalid Manifest %q for Skill %s",
					ErrBuiltinSkillConflict, manifestDefinition.ManifestID, definition.SkillID,
				)
			}
			if _, duplicate := seenManifestIDs[manifestDefinition.ManifestID]; duplicate {
				return builtinCatalog{}, fmt.Errorf("%w: duplicate Manifest ID %s", ErrBuiltinSkillConflict, manifestDefinition.ManifestID)
			}
			if _, duplicate := seenVersions[manifestDefinition.Version]; duplicate {
				return builtinCatalog{}, fmt.Errorf(
					"%w: duplicate version %s for Skill %s",
					ErrBuiltinSkillConflict, manifestDefinition.Version, definition.SkillID,
				)
			}
			if _, duplicate := seenPackagePaths[manifestDefinition.PackagePath]; duplicate {
				return builtinCatalog{}, fmt.Errorf("%w: duplicate package path %s", ErrBuiltinSkillConflict, manifestDefinition.PackagePath)
			}
			seenManifestIDs[manifestDefinition.ManifestID] = struct{}{}
			seenVersions[manifestDefinition.Version] = struct{}{}
			seenPackagePaths[manifestDefinition.PackagePath] = struct{}{}

			fileCount, sizeBytes, err := summarizePackageDirectory(source, manifestDefinition.PackagePath)
			if err != nil {
				return builtinCatalog{}, fmt.Errorf(
					"summarize built-in Skill %s@%s: %w",
					definition.SkillID, manifestDefinition.Version, err,
				)
			}
			skillName := path.Base(path.Dir(manifestDefinition.PackagePath))
			if skill.Name == "" {
				skill.Name = skillName
			} else if skill.Name != skillName {
				return builtinCatalog{}, fmt.Errorf(
					"%w: Skill %s changes name from %q to %q",
					ErrBuiltinSkillConflict, definition.SkillID, skill.Name, skillName,
				)
			}
			skill.Manifests = append(skill.Manifests, builtinManifest{
				ManifestID:  manifestDefinition.ManifestID,
				Version:     manifestDefinition.Version,
				PackagePath: manifestDefinition.PackagePath,
				FileCount:   fileCount,
				SizeBytes:   sizeBytes,
			})
			bootstrapFound = bootstrapFound || manifestDefinition.ManifestID == definition.BootstrapManifestID
		}
		if !bootstrapFound {
			return builtinCatalog{}, fmt.Errorf(
				"%w: Skill %s bootstrap Manifest is not in its catalog",
				ErrBuiltinSkillConflict, definition.SkillID,
			)
		}
		sort.Slice(skill.Manifests, func(left, right int) bool {
			return skill.Manifests[left].ManifestID < skill.Manifests[right].ManifestID
		})
		catalog.Skills = append(catalog.Skills, skill)
	}
	sort.Slice(catalog.Skills, func(left, right int) bool {
		return catalog.Skills[left].SkillID < catalog.Skills[right].SkillID
	})
	return catalog, nil
}

func validPackagePath(packagePath, version string) bool {
	parts := strings.Split(packagePath, "/")
	return fs.ValidPath(packagePath) && len(parts) == 3 && parts[0] == "builtin" &&
		parts[1] != "" && parts[2] == version
}

func canonicalAgentTypes(agentTypes []string) bool {
	canonical := []string{"anotherme", "general"}
	index := 0
	for _, known := range canonical {
		if index < len(agentTypes) && agentTypes[index] == known { //nolint:gosec // index is bounds-checked by the preceding condition
			index++
		}
	}
	return index == len(agentTypes)
}

// summarizePackageDirectory counts the regular files under one Package directory
// and their total size. It reads directory metadata only, so a sealed Manifest
// can be compared without opening its files.
func summarizePackageDirectory(source fs.FS, directory string) (int, int64, error) {
	var fileCount int
	var sizeBytes int64
	err := fs.WalkDir(source, directory, func(name string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			return nil
		}
		if !entry.Type().IsRegular() {
			return fmt.Errorf("embedded Skill entry %q is not a regular file", name)
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		fileCount++
		sizeBytes += info.Size()
		return nil
	})
	if err != nil {
		return 0, 0, err
	}
	if fileCount == 0 {
		return 0, 0, errors.New("Skill Package is empty")
	}
	if fileCount > builtinPackageMaxFiles {
		return 0, 0, fmt.Errorf("%w: file count", ErrPackageLimitExceeded)
	}
	return fileCount, sizeBytes, nil
}

// loadManifestPackage streams one Manifest's files and applies the checks that
// need content: the frontmatter name and the canonical package metadata.
func loadManifestPackage(source fs.FS, skillID string, manifest builtinManifest) (Package, error) {
	pkg, err := loadPackageFromFS(source, manifest.PackagePath)
	if err != nil {
		return Package{}, fmt.Errorf(
			"load built-in Skill %s@%s: %w",
			skillID, manifest.Version, err,
		)
	}
	packageName := path.Base(path.Dir(manifest.PackagePath))
	if pkg.Name != packageName || pkg.Frontmatter.Name != packageName {
		return Package{}, fmt.Errorf(
			"%w: package %s name %q differs from its directory",
			ErrBuiltinSkillConflict, manifest.PackagePath, pkg.Name,
		)
	}
	if len(pkg.Files) == 0 || pkg.SizeBytes <= 0 ||
		pkg.SHA256 != CanonicalPackageDigest(pkg.Files) {
		return Package{}, fmt.Errorf(
			"%w: package %s has invalid canonical metadata",
			ErrBuiltinSkillConflict, manifest.PackagePath,
		)
	}
	return pkg, nil
}

// loadPackageFromFS streams one built-in Package directory into metadata and
// content digests. Files are hashed in place, so the returned Package carries
// no file content; installation re-opens each file from source when uploading.
func loadPackageFromFS(source fs.FS, directory string) (Package, error) {
	limits := DefaultPackageLimits()
	// Repository-reviewed built-ins may vendor offline dependencies. Keep this
	// higher file-count allowance scoped away from tenant package uploads.
	limits.MaxFiles = builtinPackageMaxFiles
	return loadPackageWithLimits(source, directory, limits)
}

func loadPackageWithLimits(source fs.FS, directory string, limits PackageLimits) (Package, error) {
	var embeddedPaths []string
	err := fs.WalkDir(source, directory, func(name string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			return nil
		}
		if !entry.Type().IsRegular() {
			return fmt.Errorf("embedded Skill entry %q is not a regular file", name)
		}
		embeddedPaths = append(embeddedPaths, name)
		return nil
	})
	if err != nil {
		return Package{}, err
	}
	if len(embeddedPaths) == 0 {
		return Package{}, errors.New("Skill Package is empty")
	}
	if len(embeddedPaths) > limits.MaxFiles {
		return Package{}, fmt.Errorf("%w: file count", ErrPackageLimitExceeded)
	}
	sort.Strings(embeddedPaths)

	files := make([]PackageFile, 0, len(embeddedPaths))
	var skillMarkdown bytes.Buffer
	var total int64
	hasSkillMarkdown := false
	for _, embeddedPath := range embeddedPaths {
		logicalPath := strings.TrimPrefix(embeddedPath, directory+"/")
		if !ValidatePackageFilePath(logicalPath) {
			return Package{}, fmt.Errorf("built-in Skill file %q is not a normalized package path", embeddedPath)
		}
		var sink io.Writer
		if logicalPath == "SKILL.md" {
			sink = &skillMarkdown
			hasSkillMarkdown = true
		}
		file, err := streamPackageFile(source, embeddedPath, logicalPath, limits.MaxFileBytes, sink)
		if err != nil {
			return Package{}, err
		}
		if file.SizeBytes > limits.MaxTotalBytes-total {
			return Package{}, fmt.Errorf("%w: total uncompressed size", ErrPackageLimitExceeded)
		}
		total += file.SizeBytes
		files = append(files, file)
	}
	if !hasSkillMarkdown {
		return Package{}, errors.New("Skill Package must contain root SKILL.md")
	}
	matter, err := ParsePackageFrontmatter(skillMarkdown.Bytes())
	if err != nil {
		return Package{}, err
	}
	return Package{
		Frontmatter: matter, Name: matter.Name, Description: matter.Description,
		Files: files, SizeBytes: total, SHA256: CanonicalPackageDigest(files),
	}, nil
}

// streamPackageFile hashes one embedded file without retaining its bytes. A
// non-nil sink receives the same bytes so the caller can keep SKILL.md.
func streamPackageFile(
	source fs.FS,
	embeddedPath, logicalPath string,
	maxBytes int64,
	sink io.Writer,
) (PackageFile, error) {
	file, err := source.Open(embeddedPath)
	if err != nil {
		return PackageFile{}, fmt.Errorf("open built-in Skill file %q: %w", embeddedPath, err)
	}
	defer file.Close()

	hash := sha256.New()
	head := &mediaSniffWriter{}
	writers := []io.Writer{hash, head}
	if sink != nil {
		writers = append(writers, sink)
	}
	// Reading one byte past the limit detects oversize files without buffering them.
	size, err := io.Copy(io.MultiWriter(writers...), io.LimitReader(file, maxBytes+1))
	if err != nil {
		return PackageFile{}, fmt.Errorf("read built-in Skill file %q: %w", embeddedPath, err)
	}
	if size > maxBytes {
		return PackageFile{}, fmt.Errorf("%w: file %q is too large", ErrPackageLimitExceeded, logicalPath)
	}
	var digest [sha256.Size]byte
	copy(digest[:], hash.Sum(nil))
	return PackageFile{
		Path:      logicalPath,
		MediaType: DetectMediaType(logicalPath, head.prefix),
		SizeBytes: size,
		SHA256:    digest,
	}, nil
}

// mediaSniffWriter keeps only the prefix that media type detection reads.
type mediaSniffWriter struct {
	prefix []byte
}

func (w *mediaSniffWriter) Write(p []byte) (int, error) {
	if room := packageMediaSniffBytes - len(w.prefix); room > 0 {
		w.prefix = append(w.prefix, p[:min(room, len(p))]...)
	}
	return len(p), nil
}
