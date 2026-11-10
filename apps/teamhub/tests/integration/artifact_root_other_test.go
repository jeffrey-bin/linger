//go:build !darwin

package integration_test

import "errors"

// cloneIntegrationArtifactRoot is unsupported off macOS; the caller hard-links
// the template objects instead.
func cloneIntegrationArtifactRoot(_, _ string) error {
	return errors.New("clonefile is only available on darwin")
}
