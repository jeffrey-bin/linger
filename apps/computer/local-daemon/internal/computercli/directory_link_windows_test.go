//go:build windows

package computercli

import (
	"os"

	"github.com/Microsoft/go-winio"
	"golang.org/x/sys/windows"
)

func createTestDirectoryLink(target, link string) error {
	if err := os.Mkdir(link, 0o700); err != nil {
		return err
	}
	name, err := windows.UTF16PtrFromString(link)
	if err != nil {
		return err
	}
	handle, err := windows.CreateFile(name, windows.GENERIC_WRITE, 0, nil, windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS|windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return err
	}
	defer windows.CloseHandle(handle)
	data := winio.EncodeReparsePoint(&winio.ReparsePoint{Target: target, IsMountPoint: true})
	var returned uint32
	return windows.DeviceIoControl(handle, windows.FSCTL_SET_REPARSE_POINT, &data[0], uint32(len(data)), nil, 0, &returned, nil)
}
