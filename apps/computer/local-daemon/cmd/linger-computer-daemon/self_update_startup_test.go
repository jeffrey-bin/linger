package main

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// An upgraded daemon that exits before it reads its confirmation marker must
// still return to the previous bundle instead of crash-looping on the new one.
func TestUnconfirmedUpgradeRollsBackBeforeDaemonInitialization(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("self-update is not supported on Windows")
	}
	if testing.Short() {
		t.Skip("builds the daemon binary")
	}
	binary := filepath.Join(t.TempDir(), "linger-computer-daemon")
	build := exec.Command("go", "build", "-ldflags",
		"-X github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/transport.ReleaseVersion=2.0.0",
		"-o", binary, ".")
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build daemon: %v\n%s", err, output)
	}
	content, err := os.ReadFile(binary)
	if err != nil {
		t.Fatal(err)
	}

	cases := []struct {
		name      string
		createdAt time.Time
		failures  int
	}{
		{name: "deadline passed", createdAt: time.Now().Add(-time.Hour), failures: 0},
		{name: "restart loop", createdAt: time.Now(), failures: 2},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			daemon := filepath.Join(root, "lib-new", "daemon", "linger-computer-daemon")
			writeStartupFile(t, daemon, content, 0o755)
			appSHA256 := strings.Repeat("a", 64)
			writeStartupFile(t, filepath.Join(root, "lib-new", "app-sha256"), []byte(appSHA256+"\n"), 0o600)
			started := filepath.Join(root, "previous-started")
			writeStartupFile(t, filepath.Join(root, "lib-old", "daemon", "linger-computer-daemon"),
				[]byte("#!/bin/sh\nprintf '%s\\n' \"$@\" > '"+started+"'\n"), 0o755)
			writeStartupFile(t, filepath.Join(root, "active-bundle"), []byte("lib-new\n"), 0o600)
			marker, err := json.Marshal(map[string]any{
				"previous_bundle": "lib-old", "target_app_sha256": appSHA256,
				"created_at": tc.createdAt.UTC().Format(time.RFC3339),
			})
			if err != nil {
				t.Fatal(err)
			}
			writeStartupFile(t, filepath.Join(root, "upgrade-pending"), marker, 0o600)
			// A missing config makes the new daemon exit before it reaches selfupdate.New.
			config := filepath.Join(root, "missing-config.json")

			for attempt := 0; attempt < tc.failures; attempt++ {
				if output, err := startDaemon(daemon, config); err == nil {
					t.Fatalf("start %d succeeded; want the new daemon to fail\n%s", attempt+1, output)
				}
				if _, err := os.Stat(started); err == nil {
					t.Fatalf("rolled back after %d starts; want %d failures first", attempt+1, tc.failures)
				}
			}
			if output, err := startDaemon(daemon, config); err != nil {
				t.Fatalf("start after %d failures: %v\n%s", tc.failures, err, output)
			}
			got, err := os.ReadFile(started)
			if err != nil {
				t.Fatalf("previous daemon was not started: %v", err)
			}
			if string(got) != "--config\n"+config+"\n" {
				t.Fatalf("previous daemon args = %q", got)
			}
			if active, _ := os.ReadFile(filepath.Join(root, "active-bundle")); string(active) != "lib-old\n" {
				t.Fatalf("active-bundle = %q, want lib-old", active)
			}
			if _, err := os.Stat(filepath.Join(root, "upgrade-pending")); !os.IsNotExist(err) {
				t.Fatalf("marker not removed: %v", err)
			}
		})
	}
}

func startDaemon(daemon, config string) ([]byte, error) {
	command := exec.Command(daemon, "--config", config)
	command.Env = []string{"PATH=" + os.Getenv("PATH"), "HOME=" + filepath.Dir(config)}
	return command.CombinedOutput()
}

func writeStartupFile(t *testing.T, path string, content []byte, mode os.FileMode) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, content, mode); err != nil {
		t.Fatal(err)
	}
}
