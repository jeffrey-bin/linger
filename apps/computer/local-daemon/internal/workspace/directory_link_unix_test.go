//go:build !windows

package workspace

import "os"

func createTestDirectoryLink(target, link string) error { return os.Symlink(target, link) }
