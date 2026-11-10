//go:build !windows

package lingercontext

import (
	"os"
	"syscall"
)

// contextFileOpenFlags keeps a Context file that became a FIFO from blocking the open.
const contextFileOpenFlags = os.O_RDONLY | syscall.O_NONBLOCK

func validatePlatformRelativePath(string) error { return nil }
func validatePlatformMappings([]Mapping) error  { return nil }
func replaceProjectionFile(root *os.Root, source, target string) error {
	return root.Rename(source, target)
}
func syncDirectory(root *os.Root, relative string) error {
	file, err := root.Open(relative)
	if err != nil {
		return err
	}
	defer file.Close()
	return file.Sync()
}
