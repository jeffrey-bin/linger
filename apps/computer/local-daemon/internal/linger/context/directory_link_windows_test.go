//go:build windows

package lingercontext

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"

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

func createTestRepositoryLink(t *testing.T, target, link string) error {
	t.Helper()
	root := os.Getenv("LINGER_TEST_WINDOWS_REPOSITORY_LINK_FIXTURE")
	if root == "" {
		return os.Symlink(target, link)
	}
	name := map[string]string{"AGENTS.md": "valid", "unsafe": "cycle", "missing": "dangling", "../rules": "rules", "../.env": "env", "dist/missing/output": "generated", "loop": "loop", "README/inner": "through-file", "../missing": "readonly-dangling"}[filepath.ToSlash(target)]
	if name == "" {
		if !filepath.IsAbs(target) {
			return fmt.Errorf("unknown fixture target %q", target)
		}
		name = "absolute-regular"
		if _, err := os.Stat(target); os.IsNotExist(err) {
			name = "absolute-missing"
		}
	}
	fixture := filepath.Join(root, name)
	info, err := os.Lstat(fixture)
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink == 0 {
		return fmt.Errorf("fixture %q is not a symlink", fixture)
	}
	actual, err := os.Readlink(fixture)
	if err != nil {
		return err
	}
	if name != "absolute-regular" && name != "absolute-missing" && filepath.Clean(actual) != filepath.Clean(target) {
		return fmt.Errorf("fixture target %q differs from %q", actual, target)
	}
	if err := os.Rename(fixture, link); err != nil {
		return err
	}
	t.Cleanup(func() {
		if _, err := os.Lstat(link); err == nil {
			if err := os.Rename(link, fixture); err != nil {
				t.Errorf("restore fixture: %v", err)
			}
		}
	})
	return nil
}

func createTestFileLink(t *testing.T, target, link string) error {
	t.Helper()
	root := os.Getenv("LINGER_TEST_WINDOWS_SYMLINK_FIXTURE")
	if root == "" {
		return os.Symlink(target, link)
	}
	fixture := filepath.Join(root, "config-link.json")
	info, err := os.Lstat(fixture)
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("fixture is not a symbolic link: %s", fixture)
	}
	if err := os.Rename(fixture, link); err != nil {
		return err
	}
	t.Cleanup(func() {
		if err := os.Rename(link, fixture); err != nil {
			t.Errorf("restore symbolic link fixture: %v", err)
		}
	})
	return nil
}
