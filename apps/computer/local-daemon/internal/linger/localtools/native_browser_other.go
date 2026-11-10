//go:build !linux

package localtools

// reclaimProfile is Linux only: elsewhere the managed Chrome does not outlive
// the Daemon in a way that blocks the next launch.
func reclaimProfile(string) error { return nil }

// checkBrowserDisplay is Linux only: macOS and Windows always have a desktop
// session for the signed-in user.
func checkBrowserDisplay([]string) error { return nil }
