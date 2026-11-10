//go:build windows

package localskills

import "github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/workspace"

func createTestDirectoryLink(target, link string) error {
	return workspace.CreateDirectoryLink(target, link)
}
