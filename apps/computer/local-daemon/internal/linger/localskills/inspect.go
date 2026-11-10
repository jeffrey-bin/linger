package localskills

import (
	yaml "gopkg.in/yaml.v3"

	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"

	"golang.org/x/text/unicode/norm"
)

const (
	maxFiles                = 256
	maxFileBytes            = 8 * 1024 * 1024
	maxTotalBytes           = 32 * 1024 * 1024
	maxPathBytes            = 1024
	maxDepth                = 16
	maxManifestExcerptBytes = 16 * 1024
	maxManifestExcerptRunes = 4096
)

var packageNamePattern = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$`)

var supportedFrontmatterKeys = map[string]bool{
	"name": true, "description": true, "license": true, "compatibility": true,
	"metadata": true, "allowed-tools": true,
}

type SkillFile struct {
	RelativePath string
	Content      []byte
	Executable   bool
	SHA256       string
}

type InspectedSkill struct {
	Name, Description, PackageSHA256 string
	Files                            []SkillFile
	SizeBytes                        int64
	Normalizations                   []string
	RiskFlags                        []string
}

// Native Skill roots follow the installed tools' public directory conventions.
func skillRoots(home, runtimeType string) []string {
	namespaces := map[string][]string{"codex": {".agents", ".codex"}, "claude": {".claude"}}
	var roots []string
	for _, namespace := range namespaces[runtimeType] {
		roots = append(roots, filepath.Join(home, namespace, "skills"))
	}
	return roots
}

func immediateDirectories(root string) ([]string, error) {
	entries, err := os.ReadDir(root)
	if errors.Is(err, os.ErrNotExist) {
		return []string{}, nil
	}
	if err != nil {
		return nil, err
	}
	result := make([]string, 0, len(entries))
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".") {
			continue
		}
		if entry.IsDir() || entry.Type()&(os.ModeSymlink|os.ModeIrregular) != 0 {
			result = append(result, filepath.Join(root, entry.Name()))
		}
	}
	return result, nil
}

func inspectCandidate(root, source string, currentUID int) *Candidate {
	candidateRef, err := newCandidateRef()
	if err != nil {
		return nil
	}
	fallbackName := safeCandidateName(filepath.Base(source))
	sourceInfo, sourceInfoErr := os.Lstat(source)
	irregularSource := sourceInfoErr == nil && sourceInfo.Mode()&os.ModeIrregular != 0
	canonicalRoot, rootErr := filepath.EvalSymlinks(root)
	canonicalSource, sourceErr := filepath.EvalSymlinks(source)
	if !irregularSource && rootErr == nil && sourceErr == nil && isPathInside(canonicalRoot, canonicalSource) {
		if err := assertOwnedAndPrivate(canonicalRoot, canonicalSource, currentUID); err == nil {
			if inspected, err := inspectSkill(canonicalSource, currentUID); err == nil {
				return &Candidate{
					CandidateRef: candidateRef, Name: inspected.Name, Description: inspected.Description,
					PackageSHA256: inspected.PackageSHA256, FileCount: len(inspected.Files), SizeBytes: inspected.SizeBytes,
					Normalizations: append([]string{}, inspected.Normalizations...),
					RiskFlags:      append([]string{}, inspected.RiskFlags...), Importability: "ready",
				}
			}
		}
	}
	if !containsSkillManifest(source) {
		return nil
	}
	errorCode, errorDetail := "LOCAL_SKILL_INVALID", "Local Skill does not satisfy the import contract"
	if irregularSource || rootErr != nil || sourceErr != nil || !isPathInside(canonicalRoot, canonicalSource) {
		errorCode, errorDetail = "LOCAL_SKILL_UNSAFE_PATH", "Skill source resolves outside an allowed Skill root"
	} else if err := assertOwnedAndPrivate(canonicalRoot, canonicalSource, currentUID); err != nil {
		if typed := asCatalogError(err); typed != nil {
			errorCode, errorDetail = typed.Code, typed.Message
		}
	} else if _, err := inspectSkill(canonicalSource, currentUID); err != nil {
		if typed := asCatalogError(err); typed != nil {
			errorCode, errorDetail = typed.Code, typed.Message
		}
	}
	return &Candidate{
		CandidateRef: candidateRef, Name: fallbackName,
		Description:   "This local Skill cannot be imported safely.",
		PackageSHA256: strings.Repeat("0", 64), FileCount: 1, SizeBytes: 1,
		Normalizations: []string{}, RiskFlags: []string{}, Importability: "unsupported",
		ErrorCode: errorCode, ErrorDetail: errorDetail,
		ManifestExcerpt: readSafeManifestExcerpt(canonicalRoot, canonicalSource, currentUID),
	}
}

func inspectSkill(source string, currentUID int) (*InspectedSkill, error) {
	files := make([]SkillFile, 0)
	total := int64(0)
	if err := collectFiles(source, source, currentUID, &files, &total); err != nil {
		return nil, err
	}
	sort.Slice(files, func(i, j int) bool {
		return bytes.Compare([]byte(files[i].RelativePath), []byte(files[j].RelativePath)) < 0
	})
	var manifest *SkillFile
	for index := range files {
		if files[index].RelativePath == "SKILL.md" {
			manifest = &files[index]
			break
		}
	}
	if manifest == nil {
		return nil, &catalogError{Code: "LOCAL_SKILL_MANIFEST_MISSING", Message: "Local Skill does not contain SKILL.md"}
	}
	name, description, err := parseSkillFrontmatter(manifest.Content)
	if err != nil {
		return nil, err
	}
	if filepath.Base(source) != name {
		return nil, &catalogError{Code: "LOCAL_SKILL_NAME_MISMATCH", Message: "Local Skill name does not match its directory"}
	}
	risks := make([]string, 0, 2)
	containsScripts, containsExecutables := false, false
	for _, file := range files {
		containsScripts = containsScripts || strings.HasPrefix(file.RelativePath, "scripts/")
		containsExecutables = containsExecutables || file.Executable
	}
	if containsScripts {
		risks = append(risks, "contains_scripts")
	}
	if containsExecutables {
		risks = append(risks, "contains_executables")
	}
	return &InspectedSkill{
		Name: name, Description: description, Files: files, SizeBytes: total,
		PackageSHA256: canonicalPackageDigest(files), Normalizations: []string{}, RiskFlags: risks,
	}, nil
}

func collectFiles(root, directory string, currentUID int, files *[]SkillFile, total *int64) error {
	directoryInfo, err := os.Lstat(directory)
	if err != nil {
		return err
	}
	if err := assertSafePath(directory, directoryInfo, currentUID); err != nil {
		return err
	}
	if directoryInfo.Mode()&os.ModeSymlink != 0 {
		return &catalogError{Code: "LOCAL_SKILL_SYMLINK_UNSUPPORTED", Message: "Local Skill contains a symbolic link"}
	}
	if !directoryInfo.IsDir() {
		return &catalogError{Code: "LOCAL_SKILL_SPECIAL_FILE_UNSUPPORTED", Message: "Local Skill contains an unsupported file type"}
	}
	entries, err := os.ReadDir(directory)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if len(*files) >= maxFiles {
			return &catalogError{Code: "LOCAL_SKILL_LIMIT_EXCEEDED", Message: "Local Skill contains too many files"}
		}
		absolute := filepath.Join(directory, entry.Name())
		relative, err := filepath.Rel(root, absolute)
		if err != nil {
			return err
		}
		relative = filepath.ToSlash(relative)
		if err := validateRelativePath(relative); err != nil {
			return err
		}
		info, err := os.Lstat(absolute)
		if err != nil {
			return err
		}
		if err := assertSafePath(absolute, info, currentUID); err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return &catalogError{Code: "LOCAL_SKILL_SYMLINK_UNSUPPORTED", Message: "Local Skill contains a symbolic link"}
		}
		if info.IsDir() {
			if err := collectFiles(root, absolute, currentUID, files, total); err != nil {
				return err
			}
			continue
		}
		if !info.Mode().IsRegular() {
			return &catalogError{Code: "LOCAL_SKILL_SPECIAL_FILE_UNSUPPORTED", Message: "Local Skill contains an unsupported file type"}
		}
		if !isSupportedPackagePath(relative) {
			return &catalogError{Code: "LOCAL_SKILL_FILE_UNSUPPORTED", Message: "Local Skill contains a file outside supported package directories"}
		}
		if info.Size() > maxFileBytes {
			return &catalogError{Code: "LOCAL_SKILL_LIMIT_EXCEEDED", Message: "Local Skill contains an oversized file"}
		}
		file, err := openSkillFile(absolute)
		if err != nil {
			return err
		}
		content, readErr := io.ReadAll(io.LimitReader(file, maxFileBytes+1))
		closeErr := file.Close()
		if readErr != nil {
			return readErr
		}
		if closeErr != nil {
			return closeErr
		}
		if len(content) > maxFileBytes {
			return &catalogError{Code: "LOCAL_SKILL_LIMIT_EXCEEDED", Message: "Local Skill contains an oversized file"}
		}
		if *total+int64(len(content)) > maxTotalBytes {
			return &catalogError{Code: "LOCAL_SKILL_LIMIT_EXCEEDED", Message: "Local Skill exceeds the total size limit"}
		}
		*total += int64(len(content))
		digest := sha256.Sum256(content)
		*files = append(*files, SkillFile{
			RelativePath: relative, Content: content, Executable: skillFileExecutable(absolute, info, content),
			SHA256: hex.EncodeToString(digest[:]),
		})
	}
	return nil
}

func parseSkillFrontmatter(content []byte) (string, string, error) {
	if !utf8.Valid(content) {
		return "", "", &catalogError{Code: "LOCAL_SKILL_MANIFEST_INVALID", Message: "SKILL.md must be valid UTF-8"}
	}
	text := strings.ReplaceAll(string(content), "\r\n", "\n")
	if !strings.HasPrefix(text, "---\n") {
		return "", "", &catalogError{Code: "LOCAL_SKILL_MANIFEST_INVALID", Message: "SKILL.md frontmatter is missing"}
	}
	end := strings.Index(text[4:], "\n---\n")
	if end < 0 && strings.HasSuffix(text, "\n---") {
		end = len(text) - 4 - len("\n---")
	}
	if end < 0 {
		return "", "", &catalogError{Code: "LOCAL_SKILL_MANIFEST_INVALID", Message: "SKILL.md frontmatter is missing"}
	}
	var document yaml.Node
	if err := yaml.Unmarshal([]byte(text[4:4+end]), &document); err != nil || len(document.Content) != 1 {
		return "", "", &catalogError{Code: "LOCAL_SKILL_MANIFEST_INVALID", Message: "SKILL.md frontmatter is invalid"}
	}
	mapping := document.Content[0]
	if mapping.Kind != yaml.MappingNode {
		return "", "", &catalogError{Code: "LOCAL_SKILL_MANIFEST_INVALID", Message: "SKILL.md frontmatter must be an object"}
	}
	if !uniqueMappingKeys(mapping) {
		return "", "", &catalogError{Code: "LOCAL_SKILL_MANIFEST_INVALID", Message: "SKILL.md frontmatter is invalid"}
	}
	values := make(map[string]*yaml.Node)
	for index := 0; index < len(mapping.Content); index += 2 {
		key, value := mapping.Content[index], mapping.Content[index+1]
		if key.Kind != yaml.ScalarNode || values[key.Value] != nil {
			return "", "", &catalogError{Code: "LOCAL_SKILL_MANIFEST_INVALID", Message: "SKILL.md frontmatter is invalid"}
		}
		if !supportedFrontmatterKeys[key.Value] {
			return "", "", &catalogError{Code: "LOCAL_SKILL_FRONTMATTER_UNSUPPORTED", Message: "SKILL.md contains unsupported frontmatter fields"}
		}
		values[key.Value] = value
	}
	nameNode, descriptionNode := values["name"], values["description"]
	if nameNode == nil || descriptionNode == nil || nameNode.Kind != yaml.ScalarNode || descriptionNode.Kind != yaml.ScalarNode ||
		nameNode.Tag != "!!str" || descriptionNode.Tag != "!!str" {
		return "", "", invalidManifestContract()
	}
	name, description := nameNode.Value, strings.TrimSpace(descriptionNode.Value)
	if !validPackageName(name) || description == "" || len([]rune(description)) > 1024 {
		return "", "", invalidManifestContract()
	}
	if metadata := values["metadata"]; metadata != nil {
		if metadata.Kind != yaml.MappingNode {
			return "", "", invalidManifestContract()
		}
		for index := 0; index < len(metadata.Content); index += 2 {
			if metadata.Content[index].Kind != yaml.ScalarNode || metadata.Content[index+1].Kind != yaml.ScalarNode || metadata.Content[index+1].Tag != "!!str" {
				return "", "", invalidManifestContract()
			}
		}
	}
	return name, description, nil
}

func assertOwnedAndPrivate(root, source string, currentUID int) error {
	relative, err := filepath.Rel(root, source)
	if err != nil {
		return err
	}
	current := root
	info, err := os.Stat(current)
	if err != nil {
		return err
	}
	if err := assertSafePath(current, info, currentUID); err != nil {
		return err
	}
	for _, segment := range strings.Split(relative, string(filepath.Separator)) {
		if segment == "" || segment == "." {
			continue
		}
		current = filepath.Join(current, segment)
		info, err = os.Stat(current)
		if err != nil {
			return err
		}
		if err := assertSafePath(current, info, currentUID); err != nil {
			return err
		}
	}
	return nil
}

func assertSafeStat(info fs.FileInfo, currentUID int) error {
	if uid, available := fileOwnerUID(info); available && currentUID >= 0 && uid != currentUID {
		return &catalogError{Code: "LOCAL_SKILL_OWNER_UNSAFE", Message: "Local Skill is not owned by the current user"}
	}
	if info.Mode().Perm()&0o022 != 0 {
		return &catalogError{Code: "LOCAL_SKILL_PERMISSIONS_UNSAFE", Message: "Local Skill is writable by another user"}
	}
	return nil
}

func validateRelativePath(path string) error {
	segments := strings.Split(path, "/")
	unsafe := path == "" || norm.NFC.String(path) != path || len([]byte(path)) > maxPathBytes || len(segments) > maxDepth
	for _, segment := range segments {
		if segment == "" || segment == "." || segment == ".." || strings.IndexFunc(segment, unicode.IsControl) >= 0 {
			unsafe = true
		}
	}
	if unsafe {
		return &catalogError{Code: "LOCAL_SKILL_PATH_UNSAFE", Message: "Local Skill contains an unsafe path"}
	}
	return nil
}

func isSupportedPackagePath(path string) bool {
	if path == "SKILL.md" {
		return true
	}
	for _, prefix := range []string{"agents/", "scripts/", "references/", "assets/"} {
		if strings.HasPrefix(path, prefix) {
			return true
		}
	}
	return false
}

func validPackageName(value string) bool {
	return len([]rune(value)) <= 64 && packageNamePattern.MatchString(value) && !strings.Contains(value, "--")
}

func safeCandidateName(value string) string {
	runes := []rune(value)
	if len(runes) > 64 {
		runes = runes[:64]
	}
	if len(runes) == 0 {
		return "local-skill"
	}
	return string(runes)
}

func isPathInside(root, candidate string) bool {
	relative, err := filepath.Rel(root, candidate)
	return err == nil && relative != "." && relative != ".." && !filepath.IsAbs(relative) && !strings.HasPrefix(relative, ".."+string(filepath.Separator))
}

func containsSkillManifest(source string) bool {
	info, err := os.Lstat(filepath.Join(source, "SKILL.md"))
	return err == nil && info.Mode().IsRegular()
}

func readSafeManifestExcerpt(root, source string, currentUID int) string {
	if root == "" || source == "" || !isPathInside(root, source) || assertOwnedAndPrivate(root, source, currentUID) != nil {
		return ""
	}
	path := filepath.Join(source, "SKILL.md")
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || assertSafePath(path, info, currentUID) != nil {
		return ""
	}
	file, err := openSkillFile(path)
	if err != nil {
		return ""
	}
	defer file.Close()
	content := make([]byte, min(int(info.Size()), maxManifestExcerptBytes))
	read, _ := file.Read(content)
	text := strings.ToValidUTF8(string(content[:read]), "�")
	if normalized := strings.ReplaceAll(text, "\r\n", "\n"); strings.HasPrefix(normalized, "---\n") {
		if end := strings.Index(normalized[4:], "\n---\n"); end >= 0 {
			text = normalized[:4+end+5]
		}
	}
	runes := []rune(text)
	if len(runes) > maxManifestExcerptRunes {
		runes = runes[:maxManifestExcerptRunes]
	}
	return string(runes)
}

func invalidManifestContract() error {
	return &catalogError{Code: "LOCAL_SKILL_MANIFEST_INVALID", Message: "SKILL.md frontmatter does not satisfy the import contract"}
}

func uniqueMappingKeys(node *yaml.Node) bool {
	if node.Kind == yaml.MappingNode {
		seen := make(map[string]bool, len(node.Content)/2)
		for index := 0; index < len(node.Content); index += 2 {
			key, value := node.Content[index], node.Content[index+1]
			if key.Kind != yaml.ScalarNode || seen[key.Value] || !uniqueMappingKeys(value) {
				return false
			}
			seen[key.Value] = true
		}
		return true
	}
	for _, child := range node.Content {
		if !uniqueMappingKeys(child) {
			return false
		}
	}
	return true
}

func asCatalogError(err error) *catalogError {
	var typed *catalogError
	if errors.As(err, &typed) {
		return typed
	}
	return nil
}
