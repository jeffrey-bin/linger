//go:build !windows

package localskills

import "os"

func createTestDirectoryLink(target, link string) error { return os.Symlink(target, link) }
