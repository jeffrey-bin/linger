package permission

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"
)

// SkillScript reads a script that a Skill ships for run_script, so the model
// passes its path instead of writing the script out on every call. The file
// must be an absolute .js file inside a Skill: its own directory, or one of
// the two above it, holds a SKILL.md. The review attaches the same body as
// evidence, so the judge sees what runs.
func SkillScript(path string) (string, error) {
	if !filepath.IsAbs(path) || filepath.Ext(path) != ".js" {
		return "", errors.New("script_file must be the absolute path of a .js file")
	}
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		return "", errors.New("script_file could not be read")
	}
	if !inSkill(filepath.Dir(resolved)) {
		return "", errors.New("script_file must belong to a Skill: no SKILL.md in its directory or the two above it")
	}
	file, err := os.Open(resolved)
	if err != nil {
		return "", errors.New("script_file could not be read")
	}
	defer file.Close()
	if info, err := file.Stat(); err != nil || !info.Mode().IsRegular() {
		return "", errors.New("script_file is not a regular file")
	}
	body, err := io.ReadAll(io.LimitReader(file, maxScriptBytes+1))
	if err != nil || !utf8.Valid(body) {
		return "", errors.New("script_file could not be read as text")
	}
	if len(body) > maxScriptBytes {
		return "", errors.New("script_file is longer than 64 KiB")
	}
	if strings.TrimSpace(string(body)) == "" {
		return "", errors.New("script_file is empty")
	}
	return string(body), nil
}

func inSkill(dir string) bool {
	for range 3 {
		if info, err := os.Stat(filepath.Join(dir, "SKILL.md")); err == nil && info.Mode().IsRegular() {
			return true
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return false
		}
		dir = parent
	}
	return false
}

// RunScriptEvidence attaches the Skill script a run_script call names.
func RunScriptEvidence(tool string, input map[string]any) *Evidence {
	path, _ := input["script_file"].(string)
	if !strings.HasSuffix(tool, "run_script") || path == "" {
		return nil
	}
	body, err := SkillScript(path)
	if err != nil {
		return &Evidence{Missing: []string{path + ": " + err.Error()}}
	}
	sum := sha256.Sum256([]byte(body))
	return &Evidence{Script: &Script{Path: path, SHA256: hex.EncodeToString(sum[:]), Body: body}}
}
