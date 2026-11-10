//go:build windows

package provider

import (
	"os"
	"path/filepath"
	"testing"
)

func createTestModelFileLink(t *testing.T, link string) error {
	root := os.Getenv("LINGER_TEST_PROVIDER_LINK_ROOT")
	if root == "" {
		return os.Symlink(`C:\missing`, link)
	}
	prepared := filepath.Join(root, "model", "roundtrip-link")
	assertProviderFixtureLink(t, prepared, filepath.Join(root, "model", "retained"))
	return os.Rename(prepared, link)
}
