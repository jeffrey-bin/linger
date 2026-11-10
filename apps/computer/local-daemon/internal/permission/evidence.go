package permission

import (
	"crypto/sha256"
	"encoding/hex"
	"io"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"
)

// maxScriptBytes bounds the script a command runs that is attached as
// evidence; a longer script is cut and marked so the judge stays cautious.
const maxScriptBytes = 64 << 10

var scriptInterpreters = map[string]bool{
	"python": true, "python3": true, "node": true, "bash": true, "sh": true, "zsh": true,
	"ruby": true, "perl": true, "deno": true, "bun": true, "tsx": true, "ts-node": true,
}

// ScriptEvidence attaches the script a shell command runs, so the judge sees
// what `python send.py` actually does. It recognizes only the plain
// "<interpreter> [flags] <file>" shape; anything else attaches nothing and the
// judge works from the command alone. A named script that cannot be read from
// the workspace is reported missing.
func ScriptEvidence(command, workspace string) *Evidence {
	fields := strings.Fields(command)
	if len(fields) < 2 || !scriptInterpreters[filepath.Base(fields[0])] {
		return nil
	}
	script := ""
	for _, field := range fields[1:] {
		if strings.HasPrefix(field, "-") {
			if field == "-c" || field == "-e" || field == "--eval" {
				return nil
			}
			continue
		}
		script = strings.Trim(field, `"'`)
		break
	}
	if script == "" || workspace == "" {
		return nil
	}
	path := script
	if !filepath.IsAbs(path) {
		path = filepath.Join(workspace, path)
	}
	path = filepath.Clean(path)
	relative, err := filepath.Rel(workspace, path)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return &Evidence{Missing: []string{script + " is outside the workspace and was not read"}}
	}
	root, err := os.OpenRoot(workspace)
	if err != nil {
		return &Evidence{Missing: []string{script + " could not be read"}}
	}
	defer root.Close()
	file, err := root.Open(relative)
	if err != nil {
		return &Evidence{Missing: []string{script + " could not be read"}}
	}
	defer file.Close()
	body, err := io.ReadAll(io.LimitReader(file, maxScriptBytes+1))
	if err != nil || !utf8.Valid(body) {
		return &Evidence{Missing: []string{script + " could not be read as text"}}
	}
	sum := sha256.Sum256(body)
	evidence := &Evidence{Script: &Script{Path: script, SHA256: hex.EncodeToString(sum[:])}}
	if len(body) > maxScriptBytes {
		body = body[:maxScriptBytes]
		evidence.Missing = []string{script + " is longer than the evidence limit; the rest was not shown"}
	}
	evidence.Script.Body = string(body)
	return evidence
}
