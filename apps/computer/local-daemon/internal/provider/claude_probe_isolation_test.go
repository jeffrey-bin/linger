package provider

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// The synthetic CLI's auth response owns the test verdict. Never read the
// developer's macOS credential store when probing that synthetic CLI.
func isolateClaudeKeychain(t *testing.T) {
	t.Helper()
	if runtime.GOOS != "darwin" {
		return
	}
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "security"), []byte("#!/bin/sh\nexit 44\n"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", root+string(os.PathListSeparator)+os.Getenv("PATH"))
}
