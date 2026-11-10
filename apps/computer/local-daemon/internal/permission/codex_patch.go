package permission

import (
	"os"
	"path/filepath"
	"strings"
)

// protectedPaths are workspace entries whose change alters tooling, history,
// or the Agent's own configuration; a patch touching them is judged.
var protectedPaths = map[string]bool{
	".git": true, ".claude": true, ".codex": true, ".teamhub": true, ".vscode": true, ".husky": true,
	".mcp.json": true, ".bashrc": true, ".bash_profile": true, ".bash_login": true, ".profile": true,
	".zshrc": true, ".zshenv": true, ".zprofile": true, ".zlogin": true, ".envrc": true,
}

// CodexTaskLink is the Context's own shared Task link: its workspace-relative Path
// and the real Task directory it must point at.
type CodexTaskLink struct {
	Path   string
	Target string
}

var patchHeaders = []string{"*** Add File: ", "*** Update File: ", "*** Delete File: ", "*** Move to: "}

// CodexPatchAllowed reports whether an apply_patch call only adds, edits, moves,
// or deletes ordinary files inside the workspace, which Claude's acceptEdits
// allows too. Paths are resolved against the turn's cwd; any path outside the
// workspace, through a symlink, or into a protected entry sends the patch to
// the judge, as does a patch whose headers cannot be read. The one exception
// is taskLinks: the shared Task links the daemon owns for this Context, which a
// patch may pass through only while each still points at its own Task.
func CodexPatchAllowed(patch, cwd, workspace string, taskLinks ...CodexTaskLink) bool {
	if workspace == "" || !filepath.IsAbs(workspace) {
		return false
	}
	if cwd == "" {
		cwd = workspace
	}
	paths := 0
	for _, line := range strings.Split(patch, "\n") {
		line = strings.TrimRight(line, "\r")
		if !strings.HasPrefix(line, "*** ") || line == "*** Begin Patch" || line == "*** End Patch" || line == "*** End of File" {
			continue
		}
		path, known := "", false
		for _, header := range patchHeaders {
			if strings.HasPrefix(line, header) {
				path, known = strings.TrimSpace(strings.TrimPrefix(line, header)), true
			}
		}
		if !known || path == "" || !ordinaryWorkspacePath(path, cwd, workspace, taskLinks) {
			return false
		}
		paths++
	}
	return paths > 0
}

func ordinaryWorkspacePath(path, cwd, workspace string, taskLinks []CodexTaskLink) bool {
	if !filepath.IsAbs(path) {
		path = filepath.Join(cwd, path)
	}
	relative, err := filepath.Rel(workspace, filepath.Clean(path))
	if err != nil || relative == "." || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return false
	}
	current := workspace
	for _, part := range strings.Split(relative, string(filepath.Separator)) {
		if protectedPaths[part] {
			return false
		}
		current = filepath.Join(current, part)
		info, err := os.Lstat(current)
		if os.IsNotExist(err) {
			// The rest of the path is created by the patch itself.
			continue
		}
		if err != nil {
			return false
		}
		if info.Mode()&(os.ModeSymlink|os.ModeIrregular) != 0 && !taskLink(workspace, current, taskLinks) {
			return false
		}
	}
	return true
}

func taskLink(workspace, path string, taskLinks []CodexTaskLink) bool {
	for _, link := range taskLinks {
		if link.Path == "" || link.Target == "" || filepath.Join(workspace, link.Path) != path {
			continue
		}
		// A link the Agent swapped for one to elsewhere is no longer its Task.
		target, err := os.Readlink(path)
		return err == nil && filepath.Clean(target) == filepath.Clean(link.Target)
	}
	return false
}
