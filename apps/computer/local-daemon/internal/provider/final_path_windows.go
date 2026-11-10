//go:build windows

package provider

import (
	"errors"
	"strings"

	"golang.org/x/sys/windows"
)

// filepath.EvalSymlinks stops at directory junctions since Go 1.23, and the
// standalone Codex installer reaches its bin through junctions. Ask Windows for
// the path of the file it actually opens.
func resolveFinalPath(path string) (string, error) {
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return "", err
	}
	handle, err := windows.CreateFile(name, 0, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil, windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS, 0)
	if err != nil {
		return "", err
	}
	defer windows.CloseHandle(handle)
	buffer := make([]uint16, windows.MAX_LONG_PATH)
	n, err := windows.GetFinalPathNameByHandle(handle, &buffer[0], uint32(len(buffer)), 0) // normalized DOS path
	if err != nil {
		return "", err
	}
	if n >= uint32(len(buffer)) {
		return "", errors.New("Runtime executable path is too long")
	}
	final := windows.UTF16ToString(buffer[:n])
	if share, ok := strings.CutPrefix(final, `\\?\UNC\`); ok {
		return `\\` + share, nil
	}
	return strings.TrimPrefix(final, `\\?\`), nil
}
