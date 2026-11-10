package skill

import (
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"path"
	"sort"
	"strings"
)

// ErrInvalidManifestFiles rejects a Skill Package file list that cannot be
// stored on its Manifest.
var ErrInvalidManifestFiles = errors.New("invalid Skill Package file list")

// maxManifestFileBytes is the stored per-file size limit; it matches
// DefaultPackageLimits so every parsed package fits.
const maxManifestFileBytes = 8 << 20

// ManifestFile is one stored file of a Skill Package: skill_manifests.files
// holds the list in path byte order, and SHA256 is lowercase hex.
type ManifestFile struct {
	Path      string `json:"path"`
	MediaType string `json:"media_type"`
	SizeBytes int64  `json:"size_bytes"`
	SHA256    string `json:"sha256"`
	ObjectKey string `json:"object_key"`
}

// NewManifestFile describes a parsed package file stored under objectKey.
func NewManifestFile(file PackageFile, objectKey string) ManifestFile {
	return ManifestFile{
		Path: file.Path, MediaType: file.MediaType, SizeBytes: file.SizeBytes,
		SHA256: hex.EncodeToString(file.SHA256[:]), ObjectKey: objectKey,
	}
}

// EncodeManifestFiles validates a Package file list and encodes it, sorted by
// path bytes, for skill_manifests.files. Every writer goes through it, so it
// holds the path rules the database does not: each path is a clean relative
// printable-ASCII file path, no two paths fold to the same lower-case path,
// and no file sits where another path needs a directory.
func EncodeManifestFiles(files []ManifestFile) ([]byte, error) {
	if err := ValidateManifestFiles(files); err != nil {
		return nil, err
	}
	ordered := append([]ManifestFile(nil), files...)
	sort.Slice(ordered, func(i, j int) bool { return ordered[i].Path < ordered[j].Path })
	return json.Marshal(ordered)
}

// ValidateManifestFiles reports the first path, metadata, or path-conflict
// error in files.
func ValidateManifestFiles(files []ManifestFile) error {
	folded := make(map[string]string, len(files))
	for _, file := range files {
		if !ValidatePackageFilePath(file.Path) {
			return fmt.Errorf("%w: unsafe path %q", ErrInvalidManifestFiles, file.Path)
		}
		if len(file.MediaType) < 1 || len(file.MediaType) > 255 || len(file.ObjectKey) < 1 || len(file.ObjectKey) > 512 {
			return fmt.Errorf("%w: file %q metadata", ErrInvalidManifestFiles, file.Path)
		}
		if file.SizeBytes < 0 || file.SizeBytes > maxManifestFileBytes {
			return fmt.Errorf("%w: file %q size", ErrInvalidManifestFiles, file.Path)
		}
		if digest, err := hex.DecodeString(file.SHA256); err != nil || len(digest) != 32 || file.SHA256 != strings.ToLower(file.SHA256) {
			return fmt.Errorf("%w: file %q digest", ErrInvalidManifestFiles, file.Path)
		}
		key := foldASCII(file.Path)
		if other, duplicate := folded[key]; duplicate {
			return fmt.Errorf("%w: path %q collides with %q", ErrInvalidManifestFiles, file.Path, other)
		}
		folded[key] = file.Path
	}
	for _, file := range files {
		for parent := path.Dir(file.Path); parent != "."; parent = path.Dir(parent) {
			if other, conflict := folded[foldASCII(parent)]; conflict {
				return fmt.Errorf("%w: path %q needs file %q as a directory", ErrInvalidManifestFiles, file.Path, other)
			}
		}
	}
	return nil
}

// foldASCII lower-cases ASCII letters only; stored paths are ASCII.
func foldASCII(value string) string {
	return strings.Map(func(char rune) rune {
		if char >= 'A' && char <= 'Z' {
			return char + ('a' - 'A')
		}
		return char
	}, value)
}
