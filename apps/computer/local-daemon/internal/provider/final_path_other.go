//go:build !windows

package provider

import "path/filepath"

func resolveFinalPath(path string) (string, error) {
	return filepath.EvalSymlinks(path)
}
