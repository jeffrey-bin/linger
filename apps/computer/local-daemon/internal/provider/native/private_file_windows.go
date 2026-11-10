//go:build windows

package native

import (
	"io/fs"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/platform/privatefs"
)

// protectPrivateDir applies the owner-only ACL that privatefs checks.
func protectPrivateDir(path string) error { return privatefs.EnsureDir(path) }

// Windows privacy comes from the ACL, not mode bits.
func privateModeMatches(fs.FileInfo, fs.FileMode) bool { return true }

// Windows cannot flush a directory handle; file data is flushed before the
// rename and no directory flush is claimed.
func syncDirectory(string) error { return nil }
