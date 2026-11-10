//go:build !windows && !darwin

package localtools

func interactiveSession() error { return nil }

func desktopReady() error { return nil }
