//go:build darwin

package integration_test

import "golang.org/x/sys/unix"

// cloneIntegrationArtifactRoot clones the template tree with one APFS clonefile
// call. dst must not exist; the clone is copy-on-write and fails on non-APFS or
// cross-device volumes, so the caller falls back to hard links.
func cloneIntegrationArtifactRoot(template, dst string) error {
	return unix.Clonefile(template, dst, 0)
}
