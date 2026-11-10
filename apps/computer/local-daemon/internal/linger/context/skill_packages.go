package lingercontext

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"slices"
	"strings"
	"sync"
)

// skillsTargetPath is where a View's Skill packages are projected read-only.
const skillsTargetPath = ".agents/skills"

// TeamHub serves Store-method ZIPs of at most 256 files and 32 MiB of content;
// these limits match the Agent Service's former extraction limits.
const (
	maxSkillArchiveBytes  = 32<<20 + 22 + 256*(110+2*(64+1+1024))
	maxSkillEntries       = 4096
	maxSkillEntryBytes    = 32 << 20
	maxSkillExpandedBytes = 128 << 20
	maxSkillPathBytes     = 1024
	skillDigestVersion    = "teamhub.skill-package.v1\x00"
)

// ErrSkillPackageUnavailable marks a Skill package TeamHub would not serve to
// this Agent's credential, such as one revoked after the View named it.
var ErrSkillPackageUnavailable = errors.New("Skill package is unavailable")

// Skill is one Skill package a View names.
type Skill struct {
	PackageName   string `json:"package_name"`
	ManifestID    string `json:"manifest_id"`
	PackageSHA256 string `json:"package_sha256"`
}

// skillPackageCache keeps each verified package extracted once, keyed by its
// TeamHub content digest. Workspaces receive verified independent copies.
type skillPackageCache struct {
	root  string
	mu    sync.Mutex
	locks map[string]*sync.Mutex
}

type skillPackageFile struct {
	Path       string `json:"path"`
	SizeBytes  int64  `json:"size_bytes"`
	SHA256     string `json:"sha256"`
	Executable bool   `json:"executable,omitempty"`
}

// skillMapping returns the read-only skills mapping of a View: every file of
// every package under <package_name>/, with its verified local source.
func (s *ViewStore) skillMapping(ctx context.Context, skills []Skill, fetch func(context.Context, string) (io.ReadCloser, error)) (Mapping, error) {
	mapping := Mapping{Kind: "skills", TargetPath: skillsTargetPath, Access: "read_only"}
	names := make(map[string]struct{}, len(skills))
	for _, skill := range skills {
		if _, duplicate := names[skill.PackageName]; duplicate {
			return Mapping{}, errors.New("Context View names one Skill package twice")
		}
		names[skill.PackageName] = struct{}{}
		directory, files, err := s.skills.ensure(ctx, skill, fetch)
		if err != nil {
			return Mapping{}, err
		}
		for _, file := range files {
			mapping.Files = append(mapping.Files, FileInput{
				RelativePath: skill.PackageName + "/" + file.Path, MediaType: "application/octet-stream",
				SizeBytes: file.SizeBytes, SHA256: file.SHA256, Executable: file.Executable,
				source: filepath.Join(directory, filepath.FromSlash(file.Path)),
			})
		}
	}
	return mapping, nil
}

func (c *skillPackageCache) lock(digest string) *sync.Mutex {
	c.mu.Lock()
	defer c.mu.Unlock()
	lock, ok := c.locks[digest]
	if !ok {
		lock = &sync.Mutex{}
		c.locks[digest] = lock
	}
	return lock
}

// ensure returns the extracted package directory and its file list, fetching
// and verifying the package the first time this Computer needs it.
func (c *skillPackageCache) ensure(ctx context.Context, skill Skill, fetch func(context.Context, string) (io.ReadCloser, error)) (string, []skillPackageFile, error) {
	lock := c.lock(skill.PackageSHA256)
	lock.Lock()
	defer lock.Unlock()
	packageRoot := filepath.Join(c.root, skill.PackageSHA256)
	if files, err := readSkillIndex(packageRoot); err == nil {
		return filepath.Join(packageRoot, "files"), files, nil
	}
	if fetch == nil {
		return "", nil, fmt.Errorf("%w: no TeamHub credential", ErrSkillPackageUnavailable)
	}
	body, err := fetch(ctx, skill.ManifestID)
	if err != nil {
		return "", nil, err
	}
	archive, err := io.ReadAll(io.LimitReader(body, maxSkillArchiveBytes+1))
	_ = body.Close()
	if err != nil {
		return "", nil, fmt.Errorf("%w: %w", ErrInputDownloadUnavailable, err)
	}
	if len(archive) > maxSkillArchiveBytes {
		return "", nil, errors.New("Skill package exceeds its size limit")
	}
	if err := os.MkdirAll(c.root, 0o700); err != nil {
		return "", nil, err
	}
	staging, err := os.MkdirTemp(c.root, ".package-*")
	if err != nil {
		return "", nil, err
	}
	defer os.RemoveAll(staging)
	files, err := extractSkillPackage(archive, filepath.Join(staging, "files"))
	if err != nil {
		return "", nil, err
	}
	if digest := skillPackageDigest(files); digest != skill.PackageSHA256 {
		return "", nil, errors.New("Skill package does not match its TeamHub digest")
	}
	index, err := json.Marshal(files)
	if err != nil {
		return "", nil, err
	}
	if err := os.WriteFile(filepath.Join(staging, "index.json"), index, 0o600); err != nil {
		return "", nil, err
	}
	_ = os.RemoveAll(packageRoot)
	if err := os.Rename(staging, packageRoot); err != nil {
		return "", nil, err
	}
	return filepath.Join(packageRoot, "files"), files, nil
}

func readSkillIndex(packageRoot string) ([]skillPackageFile, error) {
	encoded, err := os.ReadFile(filepath.Join(packageRoot, "index.json"))
	if err != nil {
		return nil, err
	}
	var files []skillPackageFile
	if err := json.Unmarshal(encoded, &files); err != nil || len(files) == 0 {
		return nil, errors.New("Skill package index is invalid")
	}
	return files, nil
}

// extractSkillPackage writes the package files under target and returns them
// with paths relative to the package root: SKILL.md at the archive root, or
// inside one wrapper directory.
func extractSkillPackage(archive []byte, target string) ([]skillPackageFile, error) {
	reader, err := zip.NewReader(bytes.NewReader(archive), int64(len(archive)))
	if err != nil {
		return nil, errors.New("Skill package is not a valid ZIP")
	}
	if len(reader.File) > maxSkillEntries {
		return nil, errors.New("Skill package has too many entries")
	}
	var entries []*zip.File
	seen := make(map[string]struct{})
	expanded := uint64(0)
	for _, entry := range reader.File {
		name := entry.Name
		if !safeSkillPath(name) {
			return nil, fmt.Errorf("Skill package entry path %q is invalid", name)
		}
		key := strings.ToLower(strings.TrimSuffix(name, "/"))
		if _, duplicate := seen[key]; duplicate {
			return nil, fmt.Errorf("Skill package entry path %q conflicts with another entry", name)
		}
		seen[key] = struct{}{}
		mode := entry.Mode()
		if strings.HasSuffix(name, "/") {
			if !mode.IsDir() {
				return nil, fmt.Errorf("Skill package entry %q has inconsistent metadata", name)
			}
			continue
		}
		if !mode.IsRegular() {
			return nil, fmt.Errorf("Skill package entry %q is not a regular file", name)
		}
		if entry.UncompressedSize64 > maxSkillEntryBytes {
			return nil, fmt.Errorf("Skill package entry %q exceeds its size limit", name)
		}
		expanded += entry.UncompressedSize64
		if expanded > maxSkillExpandedBytes {
			return nil, errors.New("Skill package expands beyond its size limit")
		}
		entries = append(entries, entry)
	}
	prefix, err := skillRootPrefix(entries)
	if err != nil {
		return nil, err
	}
	files := make([]skillPackageFile, 0, len(entries))
	for _, entry := range entries {
		relative := strings.TrimPrefix(entry.Name, prefix)
		if len(relative) > maxSkillPathBytes || relative == "" {
			return nil, fmt.Errorf("Skill package entry path %q is invalid", entry.Name)
		}
		destination := filepath.Join(target, filepath.FromSlash(relative))
		if err := os.MkdirAll(filepath.Dir(destination), 0o700); err != nil {
			return nil, err
		}
		executable := entry.CreatorVersion>>8 == 3 && entry.Mode()&0o111 != 0
		digest, size, err := extractSkillFile(entry, destination, executable)
		if err != nil {
			return nil, err
		}
		files = append(files, skillPackageFile{Path: relative, SizeBytes: size, SHA256: digest, Executable: executable})
	}
	if len(files) == 0 {
		return nil, errors.New("Skill package is empty")
	}
	slices.SortFunc(files, func(left, right skillPackageFile) int { return strings.Compare(left.Path, right.Path) })
	return files, nil
}

func extractSkillFile(entry *zip.File, destination string, executable bool) (string, int64, error) {
	source, err := entry.Open()
	if err != nil {
		return "", 0, errors.New("Skill package entry cannot be decoded")
	}
	defer source.Close()
	mode := os.FileMode(0o600)
	if executable {
		mode = 0o700
	}
	file, err := os.OpenFile(destination, os.O_CREATE|os.O_EXCL|os.O_WRONLY, mode)
	if err != nil {
		return "", 0, err
	}
	hash := sha256.New()
	written, copyErr := io.Copy(io.MultiWriter(file, hash), io.LimitReader(source, maxSkillEntryBytes+1))
	closeErr := file.Close()
	if copyErr != nil || closeErr != nil || uint64(written) != entry.UncompressedSize64 {
		return "", 0, errors.New("Skill package entry cannot be decoded")
	}
	return hex.EncodeToString(hash.Sum(nil)), written, nil
}

func skillRootPrefix(entries []*zip.File) (string, error) {
	for _, entry := range entries {
		if entry.Name == "SKILL.md" {
			return "", nil
		}
	}
	for _, entry := range entries {
		parts := strings.Split(entry.Name, "/")
		if len(parts) == 2 && parts[1] == "SKILL.md" {
			prefix := parts[0] + "/"
			for _, other := range entries {
				if !strings.HasPrefix(other.Name, prefix) {
					return "", errors.New("Skill package must contain SKILL.md at its root or inside one wrapper directory")
				}
			}
			return prefix, nil
		}
	}
	return "", errors.New("Skill package must contain SKILL.md at its root or inside one wrapper directory")
}

func safeSkillPath(name string) bool {
	if name == "" || strings.ContainsAny(name, "\x00\\") || strings.HasPrefix(name, "/") ||
		(len(name) >= 2 && name[1] == ':') {
		return false
	}
	trimmed := strings.TrimSuffix(name, "/")
	if trimmed == "" || path.Clean(trimmed) != trimmed {
		return false
	}
	for _, segment := range strings.Split(trimmed, "/") {
		if segment == "" || segment == "." || segment == ".." {
			return false
		}
	}
	return true
}

// skillPackageDigest is TeamHub's content identity of a package, independent
// of ZIP bytes: the version tag, then each file in byte order of its path as
// path length, path, content length and content SHA-256.
func skillPackageDigest(files []skillPackageFile) string {
	ordered := slices.Clone(files)
	slices.SortFunc(ordered, func(left, right skillPackageFile) int { return strings.Compare(left.Path, right.Path) })
	hash := sha256.New()
	hash.Write([]byte(skillDigestVersion))
	var length [8]byte
	for _, file := range ordered {
		binary.BigEndian.PutUint64(length[:], uint64(len(file.Path)))
		hash.Write(length[:])
		hash.Write([]byte(file.Path))
		binary.BigEndian.PutUint64(length[:], uint64(file.SizeBytes))
		hash.Write(length[:])
		content, _ := hex.DecodeString(file.SHA256)
		hash.Write(content)
	}
	return hex.EncodeToString(hash.Sum(nil))
}
