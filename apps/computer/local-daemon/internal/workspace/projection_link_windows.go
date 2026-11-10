//go:build windows

package workspace

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/Microsoft/go-winio"
	"golang.org/x/sys/windows"
)

// Native junction APIs preserve paths containing shell metacharacters.
// Credentials use an atomic private copy when symlink privilege is absent.
func recoverProjectionLink(src, dst string, directory bool, _ error) error {
	if !directory {
		return copyFile(src, dst)
	}
	return CreateDirectoryLink(src, dst)
}

// CreateDirectoryLink creates link as a directory junction to target. A
// junction needs no symlink privilege; removing it never touches the target.
func CreateDirectoryLink(target, dst string) error {
	absolute, err := filepath.Abs(target)
	if err != nil {
		return err
	}
	if err := os.Mkdir(dst, 0o700); err != nil {
		return err
	}
	committed := false
	defer func() {
		if !committed {
			_ = os.Remove(dst)
		}
	}()
	name, err := windows.UTF16PtrFromString(dst)
	if err != nil {
		return err
	}
	handle, err := windows.CreateFile(name, windows.GENERIC_WRITE, 0, nil, windows.OPEN_EXISTING, windows.FILE_FLAG_OPEN_REPARSE_POINT|windows.FILE_FLAG_BACKUP_SEMANTICS, 0)
	if err != nil {
		return err
	}
	defer windows.CloseHandle(handle)
	data := winio.EncodeReparsePoint(&winio.ReparsePoint{Target: absolute, IsMountPoint: true})
	var returned uint32
	if err := windows.DeviceIoControl(handle, windows.FSCTL_SET_REPARSE_POINT, &data[0], uint32(len(data)), nil, 0, &returned, nil); err != nil {
		return fmt.Errorf("create runtime directory junction: %w", err)
	}
	committed = true
	return nil
}

func copyFile(source, destination string) error {
	data, err := readProjectionSource(source)
	if err != nil {
		return err
	}
	if data == nil {
		return os.ErrNotExist
	}
	root, err := os.OpenRoot(filepath.Dir(destination))
	if err != nil {
		return err
	}
	defer root.Close()
	return replaceProjectionFile(root, filepath.Base(destination), data)
}
