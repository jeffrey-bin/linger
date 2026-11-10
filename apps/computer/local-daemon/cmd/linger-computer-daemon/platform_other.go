//go:build !windows

package main

// platformEntry handles the Windows-only helper subcommands; elsewhere every
// argument list is a Daemon launch.
func platformEntry([]string) (bool, error) { return false, nil }
