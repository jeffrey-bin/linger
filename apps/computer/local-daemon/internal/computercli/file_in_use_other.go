//go:build !windows

package computercli

// fileInUse is always false where an open file never blocks its removal.
func fileInUse(error) bool { return false }
