package computercli

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/control"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider"
)

// fakeClient stands in for the Daemon control API with the fields the TS
// CLI tests used.
type fakeClient struct {
	f *fixture
}

func mustObject(value string) object {
	result, err := decodeObject([]byte(value))
	if err != nil {
		panic(err)
	}
	return result
}

func (c fakeClient) Status(context.Context) (object, error) {
	if c.f.statusError != nil {
		return nil, c.f.statusError
	}
	reconciled := c.f.gatewayState == "connected"
	encoded, _ := json.Marshal(map[string]any{
		"pid": 42, "computer_id": "computer-local", "state": "running", "gateway_state": c.f.gatewayState,
		"reconciled": reconciled, "active_runners": 1, "capacity": 2, "active_operations": c.f.activeOperations,
	})
	return decodeObject(encoded)
}

func (c fakeClient) Runtimes(context.Context) ([]object, error) {
	return []object{mustObject(`{"type":"codex","status":"ready","version":"1.2.3"}`)}, nil
}

func (c fakeClient) Runners(context.Context) ([]object, error) {
	return []object{mustObject(`{"agent_id":"agent-a","state":"running","pid":84}`)}, nil
}

func (c fakeClient) Runner(_ context.Context, agentID string) (object, error) {
	c.f.inspected = append(c.f.inspected, agentID)
	return mustObject(`{"agent_id":"agent-a","state":"running","pid":84}`), nil
}

func (c fakeClient) StopRunner(_ context.Context, agentID string) (object, error) {
	c.f.stopped = append(c.f.stopped, agentID)
	return mustObject(`{"agent_id":"agent-a","state":"running","pid":84}`), nil
}

func (c fakeClient) Services(context.Context) ([]object, error) { return []object{}, nil }

func (c fakeClient) StartService(_ context.Context, input control.ServiceStart) (object, error) {
	c.f.serviceStarts = append(c.f.serviceStarts, input)
	encoded, _ := json.Marshal(map[string]any{"command": input.Command, "cwd": input.Cwd, "logPath": "/tmp/preview.log", "name": input.Name, "pid": 123, "state": "running"})
	return decodeObject(encoded)
}

func (c fakeClient) StopService(_ context.Context, name string) (object, error) {
	return object{}.with("name", name).with("state", "stopped"), nil
}

func (c fakeClient) Shutdown(context.Context) (object, error) {
	c.f.shutdowns++
	return mustObject(`{"accepted":true}`), nil
}

func (c fakeClient) ShutdownIfIdle(context.Context) (object, error) {
	c.f.idleShutdowns++
	return mustObject(`{"accepted":true}`), nil
}

type fixture struct {
	t          *testing.T
	root, home string
	configPath string
	deps       deps
	stdout     strings.Builder
	stderr     strings.Builder
	stdin      string

	started          []string
	inspected        []string
	stopped          []string
	serviceStarts    []control.ServiceStart
	setupOptions     []setupOptions
	diagnoseInputs   []map[string]string
	logRequests      []logRequest
	shutdowns        int
	idleShutdowns    int
	waitedForStop    int
	unreachableStops int
	confirmedStopped bool
	activeOperations int
	statusError      error
	waitError        error
	gatewayState     string
}

var errControlRefused = &os.SyscallError{Syscall: "connect", Err: syscall.ECONNREFUSED}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	root := t.TempDir()
	f := &fixture{t: t, root: root, home: filepath.Join(root, "home"), configPath: filepath.Join(root, "config.json"), gatewayState: "connecting"}
	if err := os.Mkdir(filepath.Join(root, "state"), 0o700); err != nil {
		t.Fatal(err)
	}
	credential := filepath.Join(root, "runner-token")
	writeFile(t, credential, "runner-secret")
	f.writeConfig(nil)
	f.deps = deps{
		environment: map[string]string{}, goos: "darwin", workingDirectory: root, homeDirectory: f.home, hostName: "Test Mac",
		stdin: strings.NewReader(""), stdout: &f.stdout, stderr: &f.stderr,
		rawTerminal:      func() (func(), bool, error) { return nil, false, nil },
		checkUserSession: func() error { return nil },
		checkRuntime: func(_ context.Context, runtimeType string, request runtimeRequest) (runtimeCheck, error) {
			f.diagnoseInputs = append(f.diagnoseInputs, request.configuredPaths)
			for _, diagnostic := range runtimeFixtures(request.configuredPaths) {
				if diagnostic.Type == runtimeType {
					check := runtimeCheck{diagnostic: diagnostic}
					if request.live && diagnostic.Status == "ready" {
						check.live = &provider.LiveCheck{Passed: true, Reply: "OK", DurationMS: 5}
					}
					return check, nil
				}
			}
			return runtimeCheck{}, errors.New("missing fixture")
		},
		diagnoseRuntimes: func(_ context.Context, configuredPaths, _ map[string]string, _ []string) ([]runtimeDiagnostic, error) {
			f.diagnoseInputs = append(f.diagnoseInputs, configuredPaths)
			return runtimeFixtures(configuredPaths), nil
		},
		newClient: func(string) controlClient { return fakeClient{f: f} },
		inspectDaemon: func(context.Context, string) doctorCheck {
			return doctorCheck{Name: "daemon", Category: categoryDaemonLifecycle, Status: "pass", Detail: "running pid=42"}
		},
		probeGateway: func(context.Context, string) doctorCheck {
			return doctorCheck{Name: "gateway-network", Category: categoryNetwork, Status: "pass", Detail: "reachable"}
		},
		productRuntime: func() doctorCheck { return productRuntimeCheck(productNodeVersion) },
		readLogs: func(_ context.Context, request logRequest, output io.Writer) error {
			f.logRequests = append(f.logRequests, request)
			_, err := io.WriteString(output, "redacted log\n")
			return err
		},
		setup: func(_ context.Context, options setupOptions) (setupResult, error) {
			f.setupOptions = append(f.setupOptions, options)
			return setupResult{computerID: "computer-local", configPath: options.configPath, tenantID: "tenant-acme"}, nil
		},
		startDaemon: func(_ context.Context, configPath string) error {
			f.started = append(f.started, configPath)
			return nil
		},
		confirmDaemonStopped: func(context.Context, string) (bool, error) { return f.confirmedStopped, nil },
		stopUnreachableDaemon: func(context.Context, string) (bool, error) {
			f.unreachableStops++
			return true, nil
		},
		waitForDaemonStop: func(context.Context, controlClient, int) error {
			f.waitedForStop++
			return f.waitError
		},
	}
	return f
}

func (f *fixture) writeConfig(extra map[string]any) {
	f.t.Helper()
	config := map[string]any{
		"runner_id": "computer-local", "max_concurrent_operations": 2,
		"state_directory":  filepath.Join(f.root, "state"),
		"gateway":          map[string]any{"url": "wss://gateway.example.test/v1/runner-gateway", "token_file": filepath.Join(f.root, "runner-token")},
		"runtime_paths":    map[string]any{},
		"workspace_grants": []any{map[string]any{"tenant_id": "tenant-acme"}},
	}
	for key, value := range extra {
		config[key] = value
	}
	encoded, _ := json.Marshal(config)
	writeFile(f.t, f.configPath, string(encoded))
}

func (f *fixture) run(args ...string) int {
	f.deps.stdin = strings.NewReader(f.stdin)
	return Run(context.Background(), args, f.deps)
}

func (f *fixture) clear() {
	f.stdout.Reset()
	f.stderr.Reset()
}

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, 0o600); err != nil {
		t.Fatal(err)
	}
}

// runtimeFixtures mirrors the TS CLI fixture: Codex ready, Claude ready only
// with an explicit path, Pi absent.
func runtimeFixtures(configuredPaths map[string]string) []runtimeDiagnostic {
	codex := runtimeDiagnostic{Type: "codex", Status: "ready", Available: true, Version: "1.2.3", EntryPath: "/usr/local/bin/codex", ExecutablePath: "/usr/local/bin/codex"}
	if configuredPaths["codex"] != "" {
		codex.EntryPath, codex.ExecutablePath = configuredPaths["codex"], "/canonical/codex"
	}
	claude := runtimeDiagnostic{Type: "claude", Status: "not_installed", ErrorMessage: "Runtime executable not found"}
	if configuredPaths["claude"] != "" {
		claude = runtimeDiagnostic{Type: "claude", Status: "ready", Available: true, EntryPath: configuredPaths["claude"], ExecutablePath: "/canonical/claude"}
	}
	pi := runtimeDiagnostic{Type: "pi", Status: "not_installed", ErrorMessage: "Runtime executable not found"}
	return []runtimeDiagnostic{codex, claude, pi}
}

func onlyRuntime(runtimeType string) []runtimeDiagnostic {
	for _, diagnostic := range runtimeFixtures(nil) {
		if diagnostic.Type == runtimeType {
			return []runtimeDiagnostic{diagnostic}
		}
	}
	return nil
}
