//go:build !windows

package computercli

import "os"

func createTestDirectoryLink(target, link string) error { return os.Symlink(target, link) }
