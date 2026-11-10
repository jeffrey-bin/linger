//go:build !windows

package workspace

import "os"

func recoverProjectionLink(_, _ string, _ bool, linkError error) error { return linkError }

// CreateDirectoryLink creates link as a symbolic link to the target directory.
func CreateDirectoryLink(target, link string) error { return os.Symlink(target, link) }
