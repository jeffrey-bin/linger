//go:build windows

package workspace

func createTestDirectoryLink(target, link string) error { return CreateDirectoryLink(target, link) }
