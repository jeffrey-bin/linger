//go:build !windows

package native

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

// writeExecutable publishes a script through a closed temp file and rename,
// so no forked child inherits a writable handle to it.
func writeExecutable(t *testing.T, dir, name, body string) string {
	t.Helper()
	staging, err := os.CreateTemp(dir, ".staging-*")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := staging.WriteString(body); err != nil {
		t.Fatal(err)
	}
	if err := staging.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(staging.Name(), 0o700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, name)
	if err := os.Rename(staging.Name(), path); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestProbeVersionWithDescendants(t *testing.T) {
	cases := []struct {
		name, body  string
		budget      time.Duration
		wantToken   string
		wantWaitErr bool
	}{
		{"delayed answer", `(sleep 0.05; echo "fixture-cli 2.3.4") & echo "$$ $!" > "$RECEIPT"` + "\n", 0, "2.3.4", false},
		{"answer, open pipe", `echo "fixture-cli 2.3.4"; sleep 30 & echo "$$ $!" > "$RECEIPT"` + "\n", 0, "2.3.4", false},
		{"banner, open pipe", `echo "starting plugins"; sleep 30 & echo "$$ $!" > "$RECEIPT"` + "\n", 0, "", true},
		{"no answer", `sleep 30 & echo "$$ $!" > "$RECEIPT"; wait` + "\n", 150 * time.Millisecond, "", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			receipt := filepath.Join(dir, "pids")
			program := writeExecutable(t, dir, "fixture-cli", "#!/bin/sh\n"+tc.body)
			if tc.budget > 0 {
				previous := versionProbeBudget
				versionProbeBudget = tc.budget
				defer func() { versionProbeBudget = previous }()
			}
			// A wrapper shell avoids the first-exec scan of a new executable,
			// which can outlast the lowered budget on macOS.
			invocation := NewInvocation("/bin/sh", []string{program}).WithEnvironment(map[string]string{"PATH": "/usr/bin:/bin", "RECEIPT": receipt})
			version, err := ProbeVersion(context.Background(), invocation)
			pids := waitForPIDs(t, receipt, 2)
			switch {
			case tc.wantToken != "":
				token, _, tokenErr := versionToken(version)
				if err != nil || tokenErr != nil || token != tc.wantToken {
					t.Fatalf("version = %q, %v", version, err)
				}
			case tc.wantWaitErr:
				if !errors.Is(err, exec.ErrWaitDelay) || version != "" {
					t.Fatalf("version = %q, err = %v", version, err)
				}
			default:
				if err == nil || version != "" {
					t.Fatalf("version = %q, err = %v", version, err)
				}
			}
			waitGone(t, pids, 5*time.Second)
		})
	}
}
