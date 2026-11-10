package main

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestInstalledTeamHubCLIBinUsesPlatformLauncher(t *testing.T) {
	release := filepath.Join(t.TempDir(), "release with spaces")
	directory := filepath.Join(release, "cli")
	executable := filepath.Join(release, "bin", "linger-computer-daemon")
	if err := os.MkdirAll(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	if got := installedTeamHubCLIBinAt(executable); got != "" {
		t.Fatalf("missing CLI was published: %q", got)
	}
	launcher := "teamhub"
	mode := os.FileMode(0o700)
	if runtime.GOOS == "windows" {
		launcher += ".exe"
		mode = 0o600
	}
	path := filepath.Join(directory, launcher)
	if err := os.WriteFile(path, []byte("platform launcher fixture"), mode); err != nil {
		t.Fatal(err)
	}
	if got := installedTeamHubCLIBinAt(executable); got != directory {
		t.Fatalf("installed CLI directory = %q, want %q", got, directory)
	}
	if runtime.GOOS != "windows" {
		if err := os.Chmod(path, 0o600); err != nil {
			t.Fatal(err)
		}
		if got := installedTeamHubCLIBinAt(executable); got != "" {
			t.Fatalf("non-executable Unix CLI was published: %q", got)
		}
	}
}
