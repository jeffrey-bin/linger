//go:build !windows

package clicredential

import "os"

func createTestDirectoryLink(target, link string) error { return os.Symlink(target, link) }
