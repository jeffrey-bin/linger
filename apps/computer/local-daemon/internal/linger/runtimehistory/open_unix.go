//go:build !windows

package runtimehistory

import (
	"os"
	"syscall"
)

func openNoFollow(path string) (*os.File, error) {
	return os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
}
