//go:build !windows

package permission

import "os"

func createTestDirectoryLink(target, link string) error { return os.Symlink(target, link) }
