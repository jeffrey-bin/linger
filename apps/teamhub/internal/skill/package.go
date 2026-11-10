// Package skill parses immutable Skill Packages, computes content identity,
// validates configuration, resolves an Agent's effective Skill set, and
// reconciles the built-in Skill catalog into TeamHub.
package skill

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"os"
	"path"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/adrg/frontmatter"
	"gopkg.in/yaml.v3"
)

const packageDigestVersion = "teamhub.skill-package.v1\x00"

const (
	frontmatterExtraMaxBytes  = 64 * 1024
	frontmatterExtraMaxDepth  = 20
	frontmatterExtraMaxValues = 4_096
)

var ErrPackageLimitExceeded = errors.New("Skill Package exceeds a configured limit")

// PackageLimits defines the file-count and decompressed-size limits allowed when parsing a ZIP.
type PackageLimits struct {
	MaxFiles            int
	MaxFileBytes        int64
	MaxTotalBytes       int64
	MaxCompressionRatio uint64
}

// PackageFrontmatter is the normalized frontmatter of the root SKILL.md.
type PackageFrontmatter struct {
	Name             string
	Description      string
	License          string
	Compatibility    string
	Metadata         map[string]any
	AllowedTools     string
	FrontmatterExtra []byte
}

// PackageFile is a file inside the package, after path normalization and content validation.
type PackageFile struct {
	Path      string
	MediaType string
	SizeBytes int64
	SHA256    [sha256.Size]byte
	Content   []byte
}

// Package represents Skill content that has passed full validation and can be used to register an immutable version.
type Package struct {
	Frontmatter PackageFrontmatter
	Name        string
	Description string
	Files       []PackageFile
	SizeBytes   int64
	SHA256      [sha256.Size]byte
}

type packageCandidate struct {
	file *zip.File
	path string
}

// DefaultPackageLimits returns the default ZIP parsing limits used by the service.
func DefaultPackageLimits() PackageLimits {
	return PackageLimits{MaxFiles: 256, MaxFileBytes: 8 << 20, MaxTotalBytes: 32 << 20, MaxCompressionRatio: 200}
}

// ParseUploadedPackage accepts either a Skill ZIP or a single SKILL.md file.
func ParseUploadedPackage(content []byte, filename string, limits PackageLimits) (Package, error) {
	if looksLikeZIP(content) {
		return ParsePackage(bytes.NewReader(content), int64(len(content)), limits)
	}
	if !looksLikeSkillMarkdown(filename, content) {
		return Package{}, errors.New("upload must be a Skill ZIP or SKILL.md")
	}
	archive, err := ArchiveSkillMarkdown(content)
	if err != nil {
		return Package{}, err
	}
	return ParsePackage(bytes.NewReader(archive), int64(len(archive)), limits)
}

// ArchiveSkillMarkdown wraps SKILL.md bytes as a one-file ZIP at the logical root.
func ArchiveSkillMarkdown(content []byte) ([]byte, error) {
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	header := &zip.FileHeader{Name: "SKILL.md", Method: zip.Deflate}
	header.SetMode(0o644)
	file, err := writer.CreateHeader(header)
	if err != nil {
		return nil, err
	}
	if _, err = file.Write(content); err != nil {
		return nil, err
	}
	if err = writer.Close(); err != nil {
		return nil, err
	}
	return buffer.Bytes(), nil
}

// OptionalFrontmatterVersion returns a caller-supplied SKILL.md version when present.
func OptionalFrontmatterVersion(extra []byte) string {
	if len(extra) == 0 {
		return ""
	}
	var values map[string]any
	if json.Unmarshal(extra, &values) != nil {
		return ""
	}
	version, _ := values["version"].(string)
	return strings.TrimSpace(version)
}

func looksLikeZIP(content []byte) bool {
	return len(content) >= 4 && content[0] == 'P' && content[1] == 'K' &&
		(content[2] == 3 || content[2] == 5) && (content[3] == 4 || content[3] == 6)
}

func looksLikeSkillMarkdown(filename string, content []byte) bool {
	name := strings.ToLower(path.Base(strings.TrimSpace(filename)))
	if name == "skill.md" || name == "skill.markdown" {
		return true
	}
	return bytes.HasPrefix(bytes.TrimSpace(content), []byte("---"))
}

// ParsePackage parses and validates a ZIP, returning the logical file set with stable paths in lexicographic order.
func ParsePackage(reader io.ReaderAt, size int64, limits PackageLimits) (Package, error) {
	if reader == nil || size <= 0 || limits.MaxFiles <= 0 || limits.MaxFileBytes <= 0 || limits.MaxTotalBytes <= 0 || limits.MaxCompressionRatio == 0 {
		return Package{}, errors.New("invalid Skill Package or limits")
	}
	archive, err := zip.NewReader(reader, size)
	if err != nil {
		return Package{}, fmt.Errorf("invalid Skill Package ZIP: %w", err)
	}
	if len(archive.File) == 0 {
		return Package{}, errors.New("Skill Package is empty")
	}
	// Directory entries also consume parsing resources, so the total ZIP entry count is limited before regular files are counted.
	maxEntries := math.MaxInt
	if limits.MaxFiles <= math.MaxInt/4 {
		maxEntries = limits.MaxFiles * 4
	}
	if len(archive.File) > maxEntries {
		return Package{}, fmt.Errorf("%w: archive entry count", ErrPackageLimitExceeded)
	}

	candidates := make([]packageCandidate, 0, len(archive.File))
	archivePaths := make(map[string]struct{}, len(archive.File))
	for _, file := range archive.File {
		name, directory, err := normalizeArchivePath(file.Name)
		if err != nil {
			return Package{}, err
		}
		if _, duplicate := archivePaths[name]; duplicate {
			return Package{}, fmt.Errorf("Skill Package contains duplicate path %q", name)
		}
		archivePaths[name] = struct{}{}
		// Package content may only be directories and regular files; symlinks and other special files could bypass the logical root boundary.
		mode := file.Mode()
		if mode&os.ModeSymlink != 0 || (!directory && !mode.IsRegular()) || (directory && mode&os.ModeType != 0 && !mode.IsDir()) {
			return Package{}, fmt.Errorf("Skill Package entry %q is not a regular file or directory", file.Name)
		}
		if directory {
			continue
		}
		candidates = append(candidates, packageCandidate{file: file, path: name})
	}
	if len(candidates) == 0 || len(candidates) > limits.MaxFiles {
		return Package{}, fmt.Errorf("%w: file count", ErrPackageLimitExceeded)
	}

	// Common packaging tools add an extra same-named directory; content identity uses the logical path with that wrapper removed.
	wrapper := packageWrapper(candidates)
	seen := make(map[string]struct{}, len(candidates))
	// Stored paths are unique and conflict-free after ASCII case folding.
	folded := make(map[string]struct{}, len(candidates))
	files := make([]PackageFile, 0, len(candidates))
	var total int64
	for _, item := range candidates {
		logicalPath := item.path
		if wrapper != "" {
			logicalPath = strings.TrimPrefix(logicalPath, wrapper+"/")
		}
		if logicalPath == "" {
			return Package{}, errors.New("Skill Package contains an empty file path")
		}
		if _, duplicate := seen[logicalPath]; duplicate {
			return Package{}, fmt.Errorf("Skill Package contains duplicate path %q", logicalPath)
		}
		seen[logicalPath] = struct{}{}
		if _, duplicate := folded[strings.ToLower(logicalPath)]; duplicate {
			return Package{}, fmt.Errorf("Skill Package path %q differs from another path only in letter case", logicalPath)
		}
		folded[strings.ToLower(logicalPath)] = struct{}{}
		if item.file.UncompressedSize64 > uint64(limits.MaxFileBytes) || item.file.UncompressedSize64 > uint64(limits.MaxTotalBytes) {
			return Package{}, fmt.Errorf("%w: file %q is too large", ErrPackageLimitExceeded, logicalPath)
		}
		// The compression ratio only rejects suspicious entries early based on ZIP metadata; the real read of maximum+1 and
		// the cumulative decompressed size are the content boundary that cannot be bypassed.
		if excessiveCompression(item.file, limits.MaxCompressionRatio) {
			return Package{}, fmt.Errorf("%w: file %q has an excessive compression ratio", ErrPackageLimitExceeded, logicalPath)
		}
		content, err := readZIPFile(item.file, limits.MaxFileBytes)
		if err != nil {
			return Package{}, fmt.Errorf("read Skill Package file %q: %w", logicalPath, err)
		}
		if int64(len(content)) > limits.MaxTotalBytes-total {
			return Package{}, fmt.Errorf("%w: total uncompressed size", ErrPackageLimitExceeded)
		}
		total += int64(len(content))
		files = append(files, PackageFile{
			Path: logicalPath, MediaType: DetectMediaType(logicalPath, content), SizeBytes: int64(len(content)),
			SHA256: sha256.Sum256(content), Content: content,
		})
	}
	// Sorting keeps the output stable and is also the compatibility contract for the later canonical package hash.
	sort.Slice(files, func(i, j int) bool { return files[i].Path < files[j].Path })
	for _, file := range files {
		for parent := path.Dir(file.Path); parent != "."; parent = path.Dir(parent) {
			if _, conflict := folded[strings.ToLower(parent)]; conflict {
				return Package{}, fmt.Errorf("Skill Package path %q conflicts with file %q", file.Path, parent)
			}
		}
	}

	// SKILL.md must be at the normalized logical root; a nested manifest cannot define the whole package.
	skillIndex := sort.Search(len(files), func(index int) bool { return files[index].Path >= "SKILL.md" })
	if skillIndex >= len(files) || files[skillIndex].Path != "SKILL.md" {
		return Package{}, errors.New("Skill Package must contain root SKILL.md")
	}
	matter, err := ParsePackageFrontmatter(files[skillIndex].Content)
	if err != nil {
		return Package{}, err
	}
	// The wrapper is only a strippable packaging layer; if present, its name must still match the package identity declared in the manifest.
	if wrapper != "" && wrapper != matter.Name {
		return Package{}, fmt.Errorf("SKILL.md name %q does not match package directory %q", matter.Name, wrapper)
	}

	return Package{
		Frontmatter: matter, Name: matter.Name, Description: matter.Description,
		Files: files, SizeBytes: total, SHA256: CanonicalPackageDigest(files),
	}, nil
}

// ValidatePackageFilePath reports whether value is already a valid regular file path inside a package.
func ValidatePackageFilePath(value string) bool {
	normalized, directory, err := normalizeArchivePath(value)
	return err == nil && !directory && normalized == value
}

func normalizeArchivePath(name string) (string, bool, error) {
	if name == "" || strings.Contains(name, `\`) || path.IsAbs(name) {
		return "", false, fmt.Errorf("unsafe Skill Package path %q", name)
	}
	// Stored paths are printable ASCII, so no path needs Unicode normalization.
	for index := range len(name) {
		if name[index] < ' ' || name[index] > '~' {
			return "", false, fmt.Errorf("Skill Package path %q must use printable ASCII characters", name)
		}
	}
	directory := strings.HasSuffix(name, "/")
	name = strings.TrimSuffix(name, "/")
	if name == "" || (len(name) >= 3 && isASCIILetter(name[0]) && name[1] == ':' && name[2] == '/') {
		return "", false, fmt.Errorf("unsafe Skill Package path %q", name)
	}
	if path.Clean(name) != name || strings.HasPrefix(name, "../") || name == ".." || len(name) > 1024 {
		return "", false, fmt.Errorf("unsafe Skill Package path %q", name)
	}
	for _, segment := range strings.Split(name, "/") {
		if segment == "" || segment == "." || segment == ".." {
			return "", false, fmt.Errorf("unsafe Skill Package path %q", name)
		}
	}
	return name, directory, nil
}

func isASCIILetter(char byte) bool {
	return (char >= 'A' && char <= 'Z') || (char >= 'a' && char <= 'z')
}

func packageWrapper(items []packageCandidate) string {
	for _, item := range items {
		if item.path == "SKILL.md" {
			return ""
		}
	}
	first, _, ok := strings.Cut(items[0].path, "/")
	if !ok {
		return ""
	}
	for _, item := range items[1:] {
		root, _, hasSeparator := strings.Cut(item.path, "/")
		if !hasSeparator || root != first {
			return ""
		}
	}
	return first
}

func excessiveCompression(file *zip.File, maximum uint64) bool {
	if file.UncompressedSize64 == 0 {
		return false
	}
	if file.CompressedSize64 == 0 {
		return true
	}
	if file.CompressedSize64 > math.MaxUint64/maximum {
		return false
	}
	return file.UncompressedSize64 > file.CompressedSize64*maximum
}

func readZIPFile(file *zip.File, maximum int64) ([]byte, error) {
	reader, err := file.Open()
	if err != nil {
		return nil, err
	}
	defer reader.Close()
	content, err := io.ReadAll(io.LimitReader(reader, maximum+1))
	if err != nil {
		return nil, err
	}
	if int64(len(content)) > maximum {
		return nil, fmt.Errorf("%w: extracted file is too large", ErrPackageLimitExceeded)
	}
	return content, nil
}

// ParsePackageFrontmatter applies the strict SKILL.md frontmatter contract
// shared by upload validation and persisted Package audits.
func ParsePackageFrontmatter(content []byte) (PackageFrontmatter, error) {
	if !utf8.Valid(content) {
		return PackageFrontmatter{}, errors.New("SKILL.md must be valid UTF-8")
	}
	var matter PackageFrontmatter
	format := frontmatter.NewFormat("---", "---", func(data []byte, target any) error {
		parsed, err := decodePackageFrontmatter(data)
		if err != nil {
			return err
		}
		value, ok := target.(*PackageFrontmatter)
		if !ok {
			return errors.New("frontmatter target is invalid")
		}
		*value = parsed
		return nil
	})
	if _, err := frontmatter.Parse(bytes.NewReader(content), &matter, format); err != nil {
		return PackageFrontmatter{}, fmt.Errorf("invalid SKILL.md frontmatter: %w", err)
	}
	if !validPackageName(matter.Name) {
		return PackageFrontmatter{}, errors.New("SKILL.md frontmatter name is invalid")
	}
	matter.Description = strings.TrimSpace(matter.Description)
	if matter.Description == "" || len([]rune(matter.Description)) > 1024 {
		return PackageFrontmatter{}, errors.New("SKILL.md frontmatter description is invalid")
	}
	if matter.Compatibility != "" && len([]rune(matter.Compatibility)) > 500 {
		return PackageFrontmatter{}, errors.New("SKILL.md frontmatter compatibility is invalid")
	}
	return matter, nil
}

func decodePackageFrontmatter(data []byte) (PackageFrontmatter, error) {
	decoder := yaml.NewDecoder(bytes.NewReader(data))
	var raw map[string]any
	if err := decoder.Decode(&raw); err != nil {
		return PackageFrontmatter{}, err
	}
	if raw == nil {
		return PackageFrontmatter{}, errors.New("frontmatter must be a mapping")
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return PackageFrontmatter{}, errors.New("frontmatter must contain one document")
		}
		return PackageFrontmatter{}, err
	}

	matter := PackageFrontmatter{}
	var err error
	if matter.Name, err = requiredFrontmatterString(raw, "name"); err != nil {
		return PackageFrontmatter{}, err
	}
	if matter.Description, err = requiredFrontmatterString(raw, "description"); err != nil {
		return PackageFrontmatter{}, err
	}
	if matter.License, err = optionalFrontmatterString(raw, "license"); err != nil {
		return PackageFrontmatter{}, err
	}
	if matter.Compatibility, err = optionalFrontmatterString(raw, "compatibility"); err != nil {
		return PackageFrontmatter{}, err
	}
	if matter.AllowedTools, err = optionalFrontmatterString(raw, "allowed-tools"); err != nil {
		return PackageFrontmatter{}, err
	}
	if metadata, present := raw["metadata"]; present && metadata != nil {
		values, ok := metadata.(map[string]any)
		if !ok {
			return PackageFrontmatter{}, errors.New("frontmatter metadata must be a mapping")
		}
		matter.Metadata = values
	}

	extra := make(map[string]any, len(raw))
	for key, value := range raw {
		if key != "name" && key != "description" {
			extra[key] = value
		}
	}
	valueCount := 0
	if err := validateFrontmatterJSON(extra, 0, &valueCount); err != nil {
		return PackageFrontmatter{}, err
	}
	matter.FrontmatterExtra, err = json.Marshal(extra)
	if err != nil {
		return PackageFrontmatter{}, errors.New("frontmatter extra fields must be valid JSON")
	}
	if len(matter.FrontmatterExtra) > frontmatterExtraMaxBytes {
		return PackageFrontmatter{}, errors.New("frontmatter extra fields are too large")
	}
	return matter, nil
}

func requiredFrontmatterString(value map[string]any, field string) (string, error) {
	text, ok := value[field].(string)
	if !ok {
		return "", fmt.Errorf("frontmatter %s must be a string", field)
	}
	return text, nil
}

func optionalFrontmatterString(value map[string]any, field string) (string, error) {
	candidate, present := value[field]
	if !present {
		return "", nil
	}
	text, ok := candidate.(string)
	if !ok {
		return "", fmt.Errorf("frontmatter %s must be a string", field)
	}
	return text, nil
}

func validateFrontmatterJSON(value any, depth int, valueCount *int) error {
	*valueCount++
	if depth > frontmatterExtraMaxDepth || *valueCount > frontmatterExtraMaxValues {
		return errors.New("frontmatter extra fields are too complex")
	}
	switch typed := value.(type) {
	case nil, bool, string, int, int8, int16, int32, int64,
		uint, uint8, uint16, uint32, uint64, float32, float64:
		return nil
	case []any:
		for _, item := range typed {
			if err := validateFrontmatterJSON(item, depth+1, valueCount); err != nil {
				return err
			}
		}
		return nil
	case map[string]any:
		for _, item := range typed {
			if err := validateFrontmatterJSON(item, depth+1, valueCount); err != nil {
				return err
			}
		}
		return nil
	default:
		return errors.New("frontmatter extra fields must be valid JSON")
	}
}

func validPackageName(name string) bool {
	if len(name) < 1 || len(name) > 64 || strings.HasPrefix(name, "-") || strings.HasSuffix(name, "-") || strings.Contains(name, "--") {
		return false
	}
	for _, char := range name {
		if (char < 'a' || char > 'z') && (char < '0' || char > '9') && char != '-' {
			return false
		}
	}
	return true
}

// CanonicalPackageDigest computes the cross-service identity of a normalized Skill file manifest.
func CanonicalPackageDigest(files []PackageFile) [sha256.Size]byte {
	// The version prefix and each file's big-endian path length, path, size, and content digest together form
	// the persisted canonical package hash; any change to field encoding or ordering is a compatibility change.
	orderedFiles := append([]PackageFile(nil), files...)
	sort.Slice(orderedFiles, func(i, j int) bool { return orderedFiles[i].Path < orderedFiles[j].Path })
	hash := sha256.New()
	_, _ = hash.Write([]byte(packageDigestVersion))
	var buffer [8]byte
	for _, file := range orderedFiles {
		binary.BigEndian.PutUint64(buffer[:], uint64(len([]byte(file.Path))))
		_, _ = hash.Write(buffer[:])
		_, _ = hash.Write([]byte(file.Path))
		binary.BigEndian.PutUint64(buffer[:], uint64(file.SizeBytes))
		_, _ = hash.Write(buffer[:])
		_, _ = hash.Write(file.SHA256[:])
	}
	var digest [sha256.Size]byte
	copy(digest[:], hash.Sum(nil))
	return digest
}

// DetectMediaType infers the media type of a package file from its logical file name and content prefix.
// http.DetectContentType only inspects the first 512 bytes, so passing a prefix is equivalent to passing the full content.
func DetectMediaType(filename string, head []byte) string {
	switch strings.ToLower(path.Ext(filename)) {
	case ".md", ".markdown":
		return "text/markdown; charset=utf-8"
	case ".yaml", ".yml":
		return "application/yaml"
	case ".json":
		return "application/json"
	case ".txt", ".py", ".sh", ".js", ".ts", ".css":
		return "text/plain; charset=utf-8"
	case ".html", ".htm":
		return "text/html; charset=utf-8"
	case ".pdf":
		return "application/pdf"
	case ".png":
		return "image/png"
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".gif":
		return "image/gif"
	case ".svg":
		return "image/svg+xml"
	}
	return http.DetectContentType(head)
}
