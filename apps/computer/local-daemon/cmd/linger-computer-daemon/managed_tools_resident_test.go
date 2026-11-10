package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/computerconfig"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/daemon"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/assignment"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/registration"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/transport"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/protocol"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider"
)

type managedFixturePlane struct{ ready chan struct{} }

func (p managedFixturePlane) Connect(context.Context, transport.Hello) (transport.Stream, error) {
	return &managedFixtureStream{ready: p.ready}, nil
}

type managedFixtureStream struct {
	ready    chan struct{}
	welcomed bool
}

func (s *managedFixtureStream) Receive(ctx context.Context) (protocol.Command, error) {
	if !s.welcomed {
		s.welcomed = true
		return protocol.Command{Type: "runner.welcome", ConnectionEpoch: 1}, nil
	}
	close(s.ready)
	<-ctx.Done()
	return protocol.Command{}, ctx.Err()
}
func (managedFixtureStream) Send(context.Context, protocol.Event) error { return nil }
func (managedFixtureStream) Close() error                               { return nil }

type managedFixtureIdentity struct{ value transport.Identity }

func (s managedFixtureIdentity) LoadOrCreate(context.Context) (transport.Identity, error) {
	return s.value, nil
}

type managedFixtureResolver struct{}

func (managedFixtureResolver) Resolve(context.Context, protocol.Command, json.RawMessage) (provider.OperationSpec, error) {
	return provider.OperationSpec{}, errors.New("fixture has no remote Operations")
}

type managedFixtureResult struct {
	PID          int    `json:"pid"`
	GatewayState string `json:"gateway_state"`
	Output       string `json:"output"`
	Error        string `json:"error"`
}

// The real Daemon core stays resident against an in-memory Gateway. The fixture
// executes tools with the exact startup/provider environment, without sockets.
func TestManagedToolsResidentDaemonFixture(t *testing.T) {
	if os.Getenv("MANAGED_TOOLS_DAEMON_FIXTURE") != "1" {
		return
	}
	environment := computerconfig.ProcessEnvironment()
	root := os.Getenv("MANAGED_TOOLS_FIXTURE_BUNDLE")
	if _, err := prepareManagedToolsEnvironment(t.Context(), environment, filepath.Join(root, "daemon", "linger-computer-daemon")); err != nil {
		t.Fatal(err)
	}
	device, err := transport.GenerateIdentity()
	if err != nil {
		t.Fatal(err)
	}
	ready := make(chan struct{})
	ledger := daemon.NewMemoryLedger()
	registrations := registration.NewMemoryStore()
	assignments := assignment.NewMemoryStore()
	d, err := daemon.New(daemon.Options{
		ComputerID: "fixture", ControlPlane: managedFixturePlane{ready: ready}, IdentityStore: managedFixtureIdentity{value: device},
		OperationResolver: managedFixtureResolver{}, Ledger: ledger, Registrations: registrations, Assignments: assignments,
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	var runError error
	done := make(chan struct{})
	go func() { runError = d.Run(ctx); close(done) }()
	defer func() { cancel(); <-done }()
	select {
	case <-ready:
	case <-done:
		t.Fatalf("daemon startup: %v", runError)
	}
	scanner := bufio.NewScanner(os.Stdin)
	for scanner.Scan() {
		command := exec.CommandContext(ctx, "/bin/sh", "-c", scanner.Text()+" probe")
		for key, value := range runtimeProviderEnvironment(environment, "", "") {
			command.Env = append(command.Env, key+"="+value)
		}
		output, err := command.CombinedOutput()
		result := managedFixtureResult{PID: os.Getpid(), GatewayState: d.GatewayState(), Output: string(output)}
		if err != nil {
			result.Error = err.Error()
		}
		_ = json.NewEncoder(os.Stdout).Encode(result)
	}
	if err := scanner.Err(); err != nil {
		t.Fatal(err)
	}
}

func TestManagedToolsUpdateKeepsResidentDaemonPID(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("Linux fixture; macOS acceptance remains preview")
	}
	node, err := exec.LookPath("node")
	if err != nil {
		t.Fatal(err)
	}
	_, testFile, _, _ := runtime.Caller(0)
	repository := filepath.Clean(filepath.Join(filepath.Dir(testFile), "../../../../.."))
	root := t.TempDir()
	source, toolsRoot := filepath.Join(root, "fixture releases"), filepath.Join(root, "managed tools")
	fixtureURL := "file://" + filepath.ToSlash(filepath.Join(repository, "scripts/test-fixtures/managed-tools-fixture.mjs"))
	script := fmt.Sprintf("import {managedToolsFixture} from %q; await managedToolsFixture(process.argv[1], 'first'); await managedToolsFixture(process.argv[1], 'second', '0.6.0', '0.6.1');", fixtureURL)
	if output, err := exec.Command(node, "--input-type=module", "-e", script, source).CombinedOutput(); err != nil {
		t.Fatalf("fixture: %s %v", output, err)
	}
	for _, directory := range []string{"runtime/bin", "cli"} {
		if err := os.MkdirAll(filepath.Join(root, directory), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Symlink(node, filepath.Join(root, "runtime/bin/node")); err != nil {
		t.Fatal(err)
	}
	adapter := filepath.Join(repository, "scripts/managed-tools-runtime.mjs")
	for _, name := range []string{"managed-tools-runtime", "managed-tools-install", "managed-tools-launchers", "managed-tools-archive", "managed-tools-lock", "local-computer-node-distributions"} {
		content, err := os.ReadFile(filepath.Join(repository, "scripts", name+".mjs"))
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(root, "cli", name+".mjs"), content, 0o600); err != nil {
			t.Fatal(err)
		}
	}

	env := append(os.Environ(), "LINGER_TOOLS_ROOT="+toolsRoot, "LINGER_CLI_RELEASES_BASE_URL="+source, "LINGER_CLI_RELEASE_ID=first", "LINGER_LEV8_VERSION=0.6.0", "MANAGED_TOOLS_DAEMON_FIXTURE=1", "MANAGED_TOOLS_FIXTURE_BUNDLE="+root)
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	child := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestManagedToolsResidentDaemonFixture$")
	child.Env = env
	child.Stderr = os.Stderr
	stdin, err := child.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout, err := child.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() {
		_ = stdin.Close()
		if err := child.Wait(); err != nil {
			t.Errorf("daemon child: %v", err)
		}
	}()
	scanner := bufio.NewScanner(stdout)
	invoke := func(tool string) managedFixtureResult {
		t.Helper()
		if _, err := fmt.Fprintln(stdin, tool); err != nil {
			t.Fatal(err)
		}
		if !scanner.Scan() {
			t.Fatalf("daemon output missing: %v", scanner.Err())
		}
		var result managedFixtureResult
		if err := json.Unmarshal(scanner.Bytes(), &result); err != nil {
			firstLine := scanner.Text()
			var remaining strings.Builder
			for scanner.Scan() {
				remaining.WriteString(scanner.Text() + "\n")
			}
			t.Fatalf("invalid daemon output %q %s: %v", firstLine, remaining.String(), err)
		}
		if result.Error != "" || result.PID != child.Process.Pid || result.GatewayState != "connected" {
			t.Fatalf("Runtime invocation: %+v", result)
		}
		return result
	}
	first := invoke("lev8")
	firstPath := strings.TrimSpace(strings.Split(first.Output, "\n")[0])
	if !filepath.IsAbs(firstPath) || !strings.HasPrefix(firstPath, filepath.Join(toolsRoot, "releases")+string(filepath.Separator)) || !strings.HasSuffix(first.Output, "\n0.6.0\n") {
		t.Fatalf("first managed executable: %q", first.Output)
	}
	if err := os.Remove(firstPath); err != nil {
		t.Fatal(err)
	}
	repaired := invoke("lev8")
	if repaired.PID != first.PID || repaired.Output == first.Output {
		t.Fatalf("missing tool was not repaired: %+v", repaired)
	}
	update := exec.CommandContext(ctx, node, adapter, "update", "second")
	update.Env = env
	output, err := update.CombinedOutput()
	if err != nil {
		t.Fatalf("update: %s %v", output, err)
	}
	var installed struct {
		Current struct {
			Directory string `json:"directory"`
		} `json:"current"`
	}
	if err := json.Unmarshal(output, &installed); err != nil {
		t.Fatal(err)
	}
	second := invoke("teamhub")
	expected := filepath.Join(installed.Current.Directory, "teamhub", "teamhub") + "\n0.6.1\n"
	if second.PID != first.PID || second.Output != expected {
		t.Fatalf("daemon switched identity or executable: %+v want %q", second, expected)
	}
	_ = stdin.Close()
	_, _ = io.Copy(io.Discard, stdout)
}
