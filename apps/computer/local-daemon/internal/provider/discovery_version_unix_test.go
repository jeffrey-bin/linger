//go:build !windows

package provider

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestDiscoveryRecoversTransientVersionTimeout(t *testing.T) {
	root := t.TempDir()
	executable := filepath.Join(root, "pi")
	script := `#!/bin/sh
if [ "$1" = "--fixture-warmup" ]; then exit 0; fi
if [ "$1" = "--version" ]; then
 echo version >> "$HOME/attempts"
 if [ ! -f "$HOME/first.pid" ]; then
  /bin/sleep 30 &
  echo "$!" > "$HOME/first.pid"
  wait
 fi
 echo '1.3.0'; exit 0
fi
if [ "$1" = "auth" ]; then echo '{"status":"ready"}'; exit 0; fi
while IFS= read -r line; do
 case "$line" in
 *linger-probe*) echo '{"type":"response","id":"linger-probe","command":"get_state","success":true,"data":{"isStreaming":false}}' ;;
 *linger-state*) echo '{"type":"response","id":"linger-state","command":"get_state","success":true,"data":{"model":{"provider":"fixture","id":"model"},"thinkingLevel":"off"}}' ;;
 *linger-models*) echo '{"type":"response","id":"linger-models","command":"get_available_models","success":true,"data":{"models":[{"provider":"fixture","id":"model"}]}}' ;;
 esac
done
`
	if err := os.WriteFile(executable, []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	warmVersionFixture(t, executable)
	result, err := Discover(t.Context(), DiscoveryOptions{
		Environment:     map[string]string{"HOME": root, "PATH": root},
		ConfiguredPaths: map[string]string{"pi": executable}, Timeout: 500 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	// The timed-out attempt's whole child tree must be gone, even on failure.
	data, err := os.ReadFile(filepath.Join(root, "first.pid"))
	if err != nil {
		t.Fatal(err)
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(data)))
	if err != nil {
		t.Fatal(err)
	}
	process, err := os.FindProcess(pid)
	if err != nil {
		t.Fatal(err)
	}
	defer process.Release()
	if err := process.Signal(syscall.Signal(0)); err == nil {
		t.Fatalf("timed-out version child %d survived", pid)
	}
	if d := result.Diagnostics[2]; d.Status != "ready" || d.Version != "1.3.0" || len(d.Models) != 1 {
		t.Fatalf("Pi did not recover in one discovery: %+v", d)
	}
	attempts, err := os.ReadFile(filepath.Join(root, "attempts"))
	if err != nil {
		t.Fatal(err)
	}
	if string(attempts) != "version\nversion\n" {
		t.Fatalf("version attempts: %q", attempts)
	}
}

func TestDiscoveryVersionFailuresRemainBounded(t *testing.T) {
	for _, tc := range []struct {
		name, body, status string
		attempts           int
		parentTimeout      time.Duration
	}{
		{name: "persistent timeout", body: "/bin/sleep 30", status: "error", attempts: 2},
		{name: "caller deadline", body: "/bin/sleep 30", status: "error", attempts: 1, parentTimeout: 300 * time.Millisecond},
		{name: "caller deadline during retry", body: "/bin/sleep 30", status: "error", attempts: 2, parentTimeout: 800 * time.Millisecond},
		{name: "execution error", body: "exit 7", status: "error", attempts: 1},
		{name: "empty version", body: "exit 0", status: "error", attempts: 1},
		{name: "unparseable version", body: "echo starting", status: "error", attempts: 1},
		{name: "incompatible version", body: "echo 1.0.0", status: "incompatible", attempts: 1},
		{name: "protocol failure", body: "echo 1.3.0", status: "incompatible", attempts: 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			executable := filepath.Join(root, "pi")
			script := "#!/bin/sh\nif [ \"$1\" = \"--fixture-warmup\" ]; then exit 0; fi\nif [ \"$1\" = \"--version\" ]; then\necho version >> \"$HOME/attempts\"\n" + tc.body + "\nexit\nfi\nexit 7\n"
			if err := os.WriteFile(executable, []byte(script), 0700); err != nil {
				t.Fatal(err)
			}
			warmVersionFixture(t, executable)
			ctx := t.Context()
			if tc.parentTimeout > 0 {
				var cancel context.CancelFunc
				ctx, cancel = context.WithTimeout(ctx, tc.parentTimeout)
				defer cancel()
			}
			started := time.Now()
			result, err := Discover(ctx, DiscoveryOptions{Environment: map[string]string{"HOME": root, "PATH": root}, ConfiguredPaths: map[string]string{"pi": executable}, Timeout: 500 * time.Millisecond})
			if err != nil {
				t.Fatal(err)
			}
			if d := result.Diagnostics[2]; d.Status != tc.status {
				t.Fatalf("diagnostic=%+v", d)
			}
			attempts, err := os.ReadFile(filepath.Join(root, "attempts"))
			if err != nil {
				t.Fatal(err)
			}
			if got := strings.Count(string(attempts), "version\n"); got != tc.attempts {
				t.Fatalf("attempts=%d, want %d", got, tc.attempts)
			}
			if elapsed := time.Since(started); elapsed > 5*time.Second {
				t.Fatalf("discovery exceeded bound: %s", elapsed)
			}
		})
	}
}

func warmVersionFixture(t *testing.T, executable string) {
	t.Helper()
	// macOS scans a newly written executable on first launch. Warm that scan
	// outside the lowered probe budget; the measured attempts still run real
	// sleeping children and enforce the production timeout/retry behavior.
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	if err := exec.CommandContext(ctx, executable, "--fixture-warmup").Run(); err != nil {
		t.Fatalf("warm version fixture: %v", err)
	}
}
