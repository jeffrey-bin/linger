//go:build windows

package localskills

import (
	"bytes"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/platform/privatefs"
)

func fileOwnerUID(fs.FileInfo) (int, bool) { return 0, false }
func assertSafePath(path string, info fs.FileInfo, _ int) error {
	kind := "file"
	if info.IsDir() {
		kind = "directory"
	}
	if err := privatefs.CheckPath(path, kind, false); err != nil {
		return &catalogError{Code: "LOCAL_SKILL_PERMISSIONS_UNSAFE", Message: "Local Skill ownership or permissions are unsafe"}
	}
	return nil
}

func openSkillFile(path string) (*os.File, error) { return privatefs.OpenRead(path, false) }
func skillFileExecutable(path string, _ fs.FileInfo, content []byte) bool {
	switch strings.ToLower(filepath.Ext(path)) {
	case ".exe", ".com", ".bat", ".cmd", ".ps1":
		return true
	}
	return bytes.HasPrefix(content, []byte("#!"))
}
