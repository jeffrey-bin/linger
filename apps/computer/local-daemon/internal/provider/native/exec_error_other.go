//go:build !windows

package native

func badExeFormat(error) bool { return false }
