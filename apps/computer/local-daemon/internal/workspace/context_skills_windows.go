//go:build windows

package workspace

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"unsafe"

	"github.com/Microsoft/go-winio"
	"golang.org/x/sys/windows"
)

// A volume-relative junction reaches only the already-opened Skill snapshot.
// Both link creation and validation use directory handles obtained through Root.
func ensureClaudeProjectSkills(root *os.Root) error {
	source, err := root.Open(".agents/skills")
	if err != nil {
		return err
	}
	defer source.Close()
	buf := make([]uint16, 32768)
	n, err := windows.GetFinalPathNameByHandle(windows.Handle(source.Fd()), &buf[0], uint32(len(buf)), 0)
	if err != nil {
		return err
	}
	if n >= uint32(len(buf)) {
		return errors.New("Claude Skill snapshot path is too long")
	}
	sourcePath := windows.UTF16ToString(buf[:n])
	if info, err := root.Lstat(".claude/skills"); err == nil {
		attributes, ok := info.Sys().(*syscall.Win32FileAttributeData)
		if !ok || attributes.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT == 0 {
			return errors.New("Claude Skill projection conflicts with local files")
		}
		linked, err := root.Readlink(".claude/skills")
		if err != nil || !strings.EqualFold(filepath.Clean(strings.TrimPrefix(sourcePath, `\\?\`)), filepath.Clean(strings.TrimPrefix(linked, `\\?\`))) {
			return errors.New("Claude Skill projection is unsafe")
		}
		return nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	parent, err := root.Open(".claude")
	if err != nil {
		return err
	}
	defer parent.Close()
	name, err := windows.NewNTUnicodeString("skills")
	if err != nil {
		return err
	}
	oa := windows.OBJECT_ATTRIBUTES{RootDirectory: windows.Handle(parent.Fd()), ObjectName: name, Attributes: windows.OBJ_CASE_INSENSITIVE}
	oa.Length = uint32(unsafe.Sizeof(oa))
	var handle windows.Handle
	var status windows.IO_STATUS_BLOCK
	if err := windows.NtCreateFile(&handle, windows.FILE_GENERIC_READ|windows.FILE_GENERIC_WRITE|windows.DELETE, &oa, &status, nil, windows.FILE_ATTRIBUTE_DIRECTORY, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, windows.FILE_CREATE, windows.FILE_DIRECTORY_FILE|windows.FILE_OPEN_REPARSE_POINT, 0, 0); err != nil {
		return err
	}
	defer windows.CloseHandle(handle)
	data := winio.EncodeReparsePoint(&winio.ReparsePoint{Target: sourcePath, IsMountPoint: true})
	var returned uint32
	return windows.DeviceIoControl(handle, windows.FSCTL_SET_REPARSE_POINT, &data[0], uint32(len(data)), nil, 0, &returned, nil)
}
