package provider

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestPiAuthenticationBoundsUnresponsiveModelCatalog(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fixture uses a POSIX shell")
	}
	root := t.TempDir()
	executable := filepath.Join(root, "pi")
	if err := os.WriteFile(executable, []byte("#!/bin/sh\necho \"$$\" > \"$HOME/pi-probe.pid\"\nexec /bin/sleep 60\n"), 0700); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	result := make(chan runtimeProbeOutcome, 1)
	go func() {
		result <- probePiAuthentication(ctx, executable, map[string]string{"HOME": root, "PATH": root}, 5*time.Second)
	}()
	select {
	case outcome := <-result:
		if outcome.Status != "error" || outcome.Code != "RUNTIME_DIAGNOSTIC_FAILED" {
			t.Fatalf("unresponsive model catalog: %+v", outcome)
		}
		if ctx.Err() != nil {
			t.Fatalf("probe canceled the resident context: %v", ctx.Err())
		}
	case <-time.After(20 * time.Second):
		cancel()
		<-result
		t.Fatal("authentication refresh blocked on an unresponsive model catalog")
	}
	pidBytes, err := os.ReadFile(filepath.Join(root, "pi-probe.pid"))
	if err != nil {
		t.Fatal(err)
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(pidBytes)))
	if err != nil {
		t.Fatal(err)
	}
	process, err := os.FindProcess(pid)
	if err != nil {
		t.Fatal(err)
	}
	defer process.Release()
	if err := process.Signal(syscall.Signal(0)); err == nil {
		t.Fatalf("model catalog process %d survived the probe deadline", pid)
	}
}

func TestPiDiscoveryAndAuthenticationRecovery(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fixture uses a POSIX shell")
	}
	root := t.TempDir()
	executable := filepath.Join(root, "pi")
	script := `#!/bin/sh
if [ "$1" = "--version" ]; then echo '1.2.0'; exit 0; fi
if [ "$1" = "auth" ]; then
 [ "$2 $3 $4 $5" = "check --model fixture/model --json" ] || exit 41
 [ "$PI_CODING_AGENT_DIR" = "$HOME/.pi/agent" ] || exit 42
 if [ -f "$HOME/logged-in" ]; then echo '{"status":"ready"}'; else echo '{"status":"not_ready"}'; exit 1; fi
 exit 0
fi
case " $* " in *" --no-extensions "*) ;; *) exit 43 ;; esac
case " $* " in *" --no-mcp "*) ;; *) exit 44 ;; esac
while IFS= read -r line; do
 case "$line" in
 *linger-probe*) echo '{"type":"response","id":"linger-probe","command":"get_state","success":true,"data":{"isStreaming":false}}' ;;
 *linger-state*) echo '{"type":"response","id":"linger-state","command":"get_state","success":true,"data":{"model":{"provider":"fixture","id":"model"},"thinkingLevel":"off"}}' ;;
 *linger-models*)
   if [ -f "$HOME/broken" ]; then echo '{"type":"response","id":"linger-models","command":"get_available_models","success":false}';
   elif [ -f "$HOME/logged-in" ]; then echo '{"type":"response","id":"linger-models","command":"get_available_models","success":true,"data":{"models":[{"provider":"fixture","id":"model","reasoning":true,"thinkingLevelMap":{"xhigh":null,"max":null}}]}}';
   else echo '{"type":"response","id":"linger-models","command":"get_available_models","success":true,"data":{"models":[]}}'; fi ;;
 esac
done
`
	if err := os.WriteFile(executable, []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	options := DiscoveryOptions{Environment: map[string]string{"HOME": root, "PATH": root}, ConfiguredPaths: map[string]string{"pi": executable}, Timeout: 5 * time.Second}
	initial, err := Discover(context.Background(), options)
	if err != nil {
		t.Fatal(err)
	}
	if d := initial.Diagnostics[2]; d.Status != "authentication_required" || len(d.Models) != 0 {
		t.Fatalf("signed-out Pi: %+v", d)
	}
	if err := os.WriteFile(filepath.Join(root, "logged-in"), []byte("fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	refreshed, err := RefreshRuntimeAuthentication(context.Background(), initial, options)
	if err != nil {
		t.Fatal(err)
	}
	d := refreshed.Diagnostics[2]
	if d.Status != "ready" || len(d.Models) != 1 || d.Models[0].ID != "fixture/model" || d.Models[0].DefaultReasoningEffort != "none" || len(d.Models[0].AllowedReasoningEffort) != 4 {
		t.Fatalf("login did not refresh exact model capabilities: %+v", d)
	}
	if err := os.WriteFile(filepath.Join(root, "broken"), []byte("fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	broken, err := Discover(context.Background(), options)
	if err != nil {
		t.Fatal(err)
	}
	if d := broken.Diagnostics[2]; d.Status != "error" || len(d.Models) != 0 {
		t.Fatalf("broken model catalog invented a usable fallback: %+v", d)
	}
}
