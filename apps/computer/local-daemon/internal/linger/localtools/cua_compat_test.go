package localtools

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/mcpproxy"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider"
)

// This opt-in probe never starts a desktop session, captures the screen, or
// requests OS grants. Its private fixture service is stopped after reading.
func TestPinnedCuaReadOnlyPermissions(t *testing.T) {
	path := os.Getenv("LINGER_CUA_COMPAT_EXECUTABLE")
	if runtime.GOOS != "darwin" || path == "" {
		t.Skip("set the pinned signed macOS Cua executable for a read-only permission probe")
	}
	m, err := New(Options{StateDirectory: t.TempDir(), CuaPath: path, Environment: map[string]string{"HOME": os.Getenv("HOME"), "PATH": os.Getenv("PATH"), "USER": os.Getenv("USER")}})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	socket, err := m.ensureCuaService(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		stopCtx, stop := context.WithTimeout(context.Background(), 10*time.Second)
		defer stop()
		if err := exec.CommandContext(stopCtx, path, "stop", "--socket", socket).Run(); err != nil {
			t.Error("fixture Cua service did not confirm stop:", err)
		} else {
			_ = os.RemoveAll(filepath.Dir(socket))
		}
	}()
	op := &operation{manager: m, spec: provider.OperationSpec{AgentID: "permission-fixture", WorkingDirectory: t.TempDir()}, identity: mcpproxy.OperationIdentity{OperationID: "readonly"}}
	c, catalog, err := m.openCua(ctx, op)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := c.close(); err != nil {
			t.Error(err)
		}
	}()
	names := map[string]bool{}
	for _, item := range catalog {
		names[item.Name] = true
		t.Log("trusted tool:", item.Name)
	}
	if !names["check_permissions"] || len(catalog) < 2 {
		t.Fatal("official Cua catalog is incomplete")
	}
	result, err := c.permissions(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var permissions cuaResult
	if json.Unmarshal(result, &permissions) != nil || permissions.IsError || permissions.Structured.Source.Attribution != "driver-daemon" {
		t.Fatalf("no service-attributed permissions: %s", result)
	}
	t.Logf("driver-daemon permissions: accessibility=%v screen_recording=%v", permissions.Structured.Accessibility, permissions.Structured.ScreenRecording)
	if !permissions.Structured.Accessibility || !permissions.Structured.ScreenRecording {
		if _, err := c.call(ctx, "click", json.RawMessage(`{}`)); err == nil || !strings.Contains(err.Error(), "COMPUTER_PERMISSION_REQUIRED") {
			t.Fatalf("missing OS grants were not rejected: %v", err)
		}
		t.Log("missing permissions rejected before session or desktop input")
	}
	if c.started || m.journal.blocked() {
		t.Fatal("read-only probe started a desktop session or left an action receipt")
	}
}
