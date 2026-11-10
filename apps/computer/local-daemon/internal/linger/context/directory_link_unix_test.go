//go:build !windows

package lingercontext

import (
	"os"
	"testing"
)

func createTestDirectoryLink(target, link string) error {
	return os.Symlink(target, link)
}

func createTestFileLink(_ *testing.T, target, link string) error {
	return os.Symlink(target, link)
}

func createTestRepositoryLink(_ *testing.T, target, link string) error {
	return os.Symlink(target, link)
}
