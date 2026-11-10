//go:build !darwin

package localtools

// cuaServicePID is only meaningful for the macOS Cua service.
func cuaServicePID(string) int { return 0 }
