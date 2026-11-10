package provider

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestPiAuthenticationPreservesClosedContextStage(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fixture uses a POSIX shell")
	}
	for _, stage := range []string{"catalog", "auth"} {
		for _, kind := range []string{"deadline", "cancel"} {
			t.Run(stage+"/"+kind, func(t *testing.T) {
				root := t.TempDir()
				program := filepath.Join(root, "pi")
				script := `#!/bin/sh
if [ "$FIXTURE_STAGE" = catalog ] || [ "$1" = auth ]; then echo $$ > "$HOME/pid"; exec /bin/sleep 60; fi
while IFS= read -r line; do
 case "$line" in
 *linger-state*) echo '{"type":"response","id":"linger-state","command":"get_state","success":true,"data":{"model":{"provider":"fixture","id":"model"}}}' ;;
 *linger-models*) echo '{"type":"response","id":"linger-models","command":"get_available_models","success":true,"data":{"models":[{"provider":"fixture","id":"model"}]}}' ;;
 esac
done
`
				if err := os.WriteFile(program, []byte(script), 0700); err != nil {
					t.Fatal(err)
				}
				// macOS scans a new executable on its first run, which can
				// outlast the probe's one second budget.
				primeTestExecutable(t, program)
				ctx, cancel := context.WithCancelCause(t.Context())
				defer cancel(nil)
				done := make(chan runtimeProbeOutcome, 1)
				go func() {
					done <- probePiAuthentication(ctx, program, map[string]string{"HOME": root, "PATH": root, "FIXTURE_STAGE": stage}, time.Second)
				}()
				var encoded []byte
				deadline := time.Now().Add(3 * time.Second)
				for time.Now().Before(deadline) {
					// The shell creates the file before it writes the pid.
					if data, err := os.ReadFile(filepath.Join(root, "pid")); err == nil && strings.HasSuffix(string(data), "\n") {
						encoded = data
						break
					}
					time.Sleep(5 * time.Millisecond)
				}
				if len(encoded) == 0 {
					t.Fatal("stage child did not start")
				}
				suffix := "timed out"
				if kind == "cancel" {
					suffix = "was canceled"
					cancel(errors.New("secret-cancel-cause"))
				}
				outcome := <-done
				label := "model catalog"
				if stage == "auth" {
					label = "authentication check"
				}
				if outcome.Status != "error" || outcome.Code != "RUNTIME_DIAGNOSTIC_FAILED" || outcome.Message != "Pi "+label+" "+suffix {
					t.Fatalf("context stage not preserved: %+v", outcome)
				}
				pid, err := strconv.Atoi(strings.TrimSpace(string(encoded)))
				if err != nil {
					t.Fatal(err)
				}
				child, err := os.FindProcess(pid)
				if err != nil {
					t.Fatal(err)
				}
				defer child.Release()
				if child.Signal(syscall.Signal(0)) == nil {
					t.Fatal("probe child survived cancellation")
				}
			})
		}
	}
}
