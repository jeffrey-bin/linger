package native

import (
	"bytes"
	"context"
	"errors"
	"go/ast"
	"go/parser"
	"go/token"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestLaunchTelemetryLogsNoArgvToken(t *testing.T) {
	invocation := NewInvocation("/opt/fixture/codex", []string{"wrapper-private"})
	cmd := ownedCommand(context.Background(), invocation, "app-server", "--secret-name=private-value", "--unknown-secret-flag", "private prompt text")
	for _, format := range []string{"text", "json"} {
		var buf bytes.Buffer
		var handler slog.Handler = slog.NewTextHandler(&buf, nil)
		if format == "json" {
			handler = slog.NewJSONHandler(&buf, nil)
		}
		logRuntimeLaunch(slog.New(handler), "codex", "app-server", cmd)
		logged := buf.String()
		for _, secret := range []string{"wrapper-private", "--secret-name", "private-value", "--unknown-secret-flag", "private prompt text"} {
			if strings.Contains(logged, secret) {
				t.Fatalf("%s log leaked %q: %s", format, secret, logged)
			}
		}
		for _, want := range []string{"runtime launch", "app-server", "arg_count", "codex"} {
			if !strings.Contains(logged, want) {
				t.Fatalf("%s log missing %q: %s", format, want, logged)
			}
		}
	}
	var buf bytes.Buffer
	logRuntimeLaunch(slog.New(slog.NewTextHandler(&buf, nil)), "codex", "app-server", nil)
	if buf.Len() != 0 {
		t.Fatalf("nil command logged %q", buf.String())
	}
}

// Every OS child goes through ownedCommand in launch.go.
func TestOnlyLaunchBoundaryConstructsCommands(t *testing.T) {
	files, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range files {
		if strings.HasSuffix(path, "_test.go") || path == "launch.go" {
			continue
		}
		parsed, err := parser.ParseFile(token.NewFileSet(), path, nil, 0)
		if err != nil {
			t.Fatal(err)
		}
		ast.Inspect(parsed, func(node ast.Node) bool {
			switch node := node.(type) {
			case *ast.SelectorExpr:
				if ident, ok := node.X.(*ast.Ident); ok {
					call := ident.Name + "." + node.Sel.Name
					switch call {
					case "exec.Command", "exec.CommandContext", "os.StartProcess", "syscall.ForkExec", "syscall.StartProcess":
						t.Errorf("%s constructs a child with %s", path, call)
					}
				}
			case *ast.CompositeLit:
				if selector, ok := node.Type.(*ast.SelectorExpr); ok {
					if ident, ok := selector.X.(*ast.Ident); ok && ident.Name == "exec" && selector.Sel.Name == "Cmd" {
						t.Errorf("%s builds an exec.Cmd literal", path)
					}
				}
			}
			return true
		})
	}
}

func TestHelperRunWithCancelledContextFails(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	missing := filepath.Join(t.TempDir(), "missing-cli")
	if _, err := runOutput(ctx, ownedCommand(ctx, NewInvocation(missing, nil))); err == nil {
		t.Fatal("cancelled helper run succeeded")
	}
}

func TestHelperOutputRejectsAssignedStreams(t *testing.T) {
	cmd := ownedCommand(context.Background(), NewInvocation(os.Args[0], nil))
	cmd.Stdout = &bytes.Buffer{}
	if _, err := runOutput(context.Background(), cmd); err == nil || cmd.Process != nil {
		t.Fatalf("output mode ran with assigned stdout: %v", err)
	}
	cmd = ownedCommand(context.Background(), NewInvocation(os.Args[0], nil))
	cmd.Stderr = &bytes.Buffer{}
	if _, err := runCombined(context.Background(), cmd); err == nil || cmd.Process != nil {
		t.Fatalf("combined mode ran with assigned stderr: %v", err)
	}
}

func TestFixtureChildSeesOnlyInvocationEnvironment(t *testing.T) {
	t.Setenv("LINGER_GATEWAY_TOKEN", "daemon-secret")
	invocation := fixtureInvocation(t, "print", map[string]string{"FIXTURE_STDOUT": "ok"})
	output, err := runOutput(context.Background(), ownedCommand(context.Background(), invocation))
	if err != nil || string(output) != "ok" {
		t.Fatalf("output %q, err %v", output, err)
	}
	var exitErr *exec.ExitError
	invocation = fixtureInvocation(t, "print", map[string]string{"FIXTURE_EXIT": "5"})
	if _, err := runOutput(context.Background(), ownedCommand(context.Background(), invocation)); err == nil || !errors.As(err, &exitErr) || exitErr.ExitCode() != 5 {
		t.Fatalf("exit error = %v", err)
	}
}
