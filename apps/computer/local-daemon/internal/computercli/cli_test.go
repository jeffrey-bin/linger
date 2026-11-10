package computercli

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/control"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/transport"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider"
)

func contains(t *testing.T, output, want string) {
	t.Helper()
	if !strings.Contains(output, want) {
		t.Fatalf("output does not contain %q:\n%s", want, output)
	}
}

func decodeJSON(t *testing.T, text string) map[string]any {
	t.Helper()
	var value map[string]any
	if err := json.Unmarshal([]byte(text), &value); err != nil {
		t.Fatalf("invalid JSON %q: %v", text, err)
	}
	return value
}

func TestLoginLimitsDiagnosticsAndSetupToTheEnabledRuntime(t *testing.T) {
	f := newFixture(t)
	var requested []string
	f.deps.diagnoseRuntimes = func(_ context.Context, _, _ map[string]string, enabled []string) ([]runtimeDiagnostic, error) {
		requested = enabled
		return onlyRuntime("codex"), nil
	}
	if code := f.run("login", "--enabled-runtime", "codex"); code != 0 {
		t.Fatalf("exit=%d stderr=%s", code, f.stderr.String())
	}
	if !reflect.DeepEqual(requested, []string{"codex"}) || !reflect.DeepEqual(f.setupOptions[0].enabledRuntimes, []string{"codex"}) {
		t.Fatalf("requested=%v setup=%v", requested, f.setupOptions[0].enabledRuntimes)
	}
}

func TestLoginConnectsWithOnlySelectedPiAbsent(t *testing.T) {
	f := newFixture(t)
	f.deps.diagnoseRuntimes = func(context.Context, map[string]string, map[string]string, []string) ([]runtimeDiagnostic, error) {
		return onlyRuntime("pi"), nil
	}
	if code := f.run("login", "--enabled-runtime", "pi"); code != 0 {
		t.Fatalf("exit=%d stderr=%s", code, f.stderr.String())
	}
	if options := f.setupOptions[0]; !reflect.DeepEqual(options.enabledRuntimes, []string{"pi"}) || len(options.runtimePaths) != 0 {
		t.Fatalf("setup=%+v", options)
	}
}

func TestLoginPreservesAnUnselectedExecutableOverride(t *testing.T) {
	f := newFixture(t)
	f.deps.diagnoseRuntimes = func(context.Context, map[string]string, map[string]string, []string) ([]runtimeDiagnostic, error) {
		return onlyRuntime("codex"), nil
	}
	selected, other := filepath.Join(f.root, "selected-codex"), filepath.Join(f.root, "unselected-claude")
	if code := f.run("login", "--enabled-runtime", "codex", "--codex-path", selected, "--claude-path", other); code != 0 {
		t.Fatalf("exit=%d stderr=%s", code, f.stderr.String())
	}
	if paths := f.setupOptions[0].runtimePaths; paths["codex"] != selected || paths["claude"] != other {
		t.Fatalf("paths=%v", paths)
	}
}

func TestLoginRejectsMissingSelectedExecutableAndEmptyDiscovery(t *testing.T) {
	f := newFixture(t)
	f.deps.diagnoseRuntimes = func(context.Context, map[string]string, map[string]string, []string) ([]runtimeDiagnostic, error) {
		return onlyRuntime("pi"), nil
	}
	if code := f.run("login", "--enabled-runtime", "pi", "--pi-path", filepath.Join(f.root, "missing-pi")); code != 14 {
		t.Fatalf("explicit missing executable exit=%d", code)
	}
	f.deps.diagnoseRuntimes = func(context.Context, map[string]string, map[string]string, []string) ([]runtimeDiagnostic, error) {
		return nil, nil
	}
	if code := f.run("login", "--enabled-runtime", "pi"); code != 13 {
		t.Fatalf("empty discovery exit=%d", code)
	}
	if len(f.setupOptions) != 0 {
		t.Fatal("setup ran")
	}
}

func TestLoginConnectsBeforeRuntimeInstallation(t *testing.T) {
	f := newFixture(t)
	f.deps.diagnoseRuntimes = func(context.Context, map[string]string, map[string]string, []string) ([]runtimeDiagnostic, error) {
		var absent []runtimeDiagnostic
		for _, runtimeType := range runtimeTypes {
			absent = append(absent, runtimeDiagnostic{Type: runtimeType, Status: "not_installed", ErrorMessage: "Runtime executable not found"})
		}
		return absent, nil
	}
	if code := f.run("login"); code != 0 {
		t.Fatalf("exit=%d stderr=%s", code, f.stderr.String())
	}
	if len(f.setupOptions) != 1 || len(f.setupOptions[0].runtimePaths) != 0 {
		t.Fatalf("setup=%+v", f.setupOptions)
	}
	output := f.stdout.String()
	contains(t, output, "Opening Linger in your browser...\n")
	contains(t, output, "is authorized; daemon started.")
	contains(t, output, "\nNo runtime is ready yet. To see what to install or sign in to, run:\n  linger-computer runtime check\n")
	if strings.Contains(output, "linger-computer daemon start") {
		t.Fatal("login pointed at daemon start")
	}
}

func TestLoginMapsTokenInputAndRuntimeOverrides(t *testing.T) {
	f := newFixture(t)
	codexPath := filepath.Join(f.root, "bin", "codex")
	claudePath := filepath.Join(f.root, "bin", "claude")
	f.stdin = "  linger-connect-v1.payload\n"
	code := f.run("login", "--config", f.configPath, "--gateway-url", "wss://gateway.example.test/v1/runner-gateway",
		"--max-concurrent-runs", "4", "--token-stdin", "--codex-path", codexPath, "--claude-path", claudePath)
	if code != 0 {
		t.Fatalf("exit=%d stderr=%s", code, f.stderr.String())
	}
	want := map[string]string{"codex": codexPath, "claude": claudePath}
	if !reflect.DeepEqual(f.diagnoseInputs, []map[string]string{want}) {
		t.Fatalf("diagnosed=%v", f.diagnoseInputs)
	}
	options := f.setupOptions[0]
	if options.configPath != f.configPath || options.stateDirectory != filepath.Join(f.root, "state") ||
		options.gatewayURL != "wss://gateway.example.test/v1/runner-gateway" || options.maxRuns == nil || *options.maxRuns != 4 ||
		options.serverToken != "linger-connect-v1.payload" || !reflect.DeepEqual(options.runtimePaths, want) {
		t.Fatalf("setup=%+v", options)
	}
	contains(t, f.stdout.String(), "Connecting Local Computer...\n")
	contains(t, f.stdout.String(), "Computer computer-local is authorized; daemon started.\n")
	if strings.Contains(f.stdout.String(), "payload") {
		t.Fatal("token reached output")
	}
}

func TestLoginRejectsTokensInArgumentsAndRemovedTokenInputs(t *testing.T) {
	f := newFixture(t)
	for _, args := range [][]string{{"login", "--token", "secret"}, {"login", "--token=secret"}} {
		f.clear()
		if code := f.run(args...); code != 2 {
			t.Fatalf("%v exit=%d", args, code)
		}
		contains(t, f.stderr.String(), "Secrets are not accepted in command arguments; use --token-stdin")
		if strings.Contains(f.stderr.String(), "secret\n") {
			t.Fatal("secret echoed")
		}
	}
	for _, args := range [][]string{{"login", "--token-file", "token.json"}, {"login", "--token-prompt"}, {"auth", "provision", "--name", "Remote", "--output", "server.json"}} {
		f.clear()
		if code := f.run(args...); code != 2 {
			t.Fatalf("%v exit=%d", args, code)
		}
		contains(t, f.stderr.String(), "Unknown command")
	}
	f.stdin = "   "
	f.clear()
	if code := f.run("login", "--token-stdin"); code != 11 {
		t.Fatalf("empty token exit=%d", code)
	}
	if len(f.setupOptions) != 0 {
		t.Fatal("setup ran")
	}
}

func TestLoginRunLimitOptions(t *testing.T) {
	f := newFixture(t)
	if code := f.run("login", "--no-max-concurrent-runs", "--config", f.configPath); code != 0 {
		t.Fatalf("exit=%d", code)
	}
	if options := f.setupOptions[0]; !options.maxRunsSet || options.maxRuns != nil {
		t.Fatalf("clear limit=%+v", options)
	}
	for _, limit := range []string{"0", "101", "1.5"} {
		f.clear()
		if code := f.run("login", "--max-concurrent-runs", limit); code != 2 {
			t.Fatalf("limit %s exit=%d", limit, code)
		}
		contains(t, f.stderr.String(), "--max-concurrent-runs must be an integer between 1 and 100")
	}
	f.clear()
	if code := f.run("login", "--max-concurrent-runs", "3", "--no-max-concurrent-runs"); code != 2 {
		t.Fatalf("conflict exit=%d", code)
	}
	contains(t, f.stderr.String(), "Use only one of --max-concurrent-runs or --no-max-concurrent-runs")
	if len(f.setupOptions) != 1 {
		t.Fatalf("setup runs=%d", len(f.setupOptions))
	}
}

func TestLoginRejectsTheRemovedWorkspaceOption(t *testing.T) {
	f := newFixture(t)
	if code := f.run("login", "--workspace", f.home); code != 2 {
		t.Fatalf("exit=%d", code)
	}
	if got := f.stderr.String(); got != "Unknown command: login --workspace "+f.home+"\nRun \"linger-computer --help\" for usage.\n" {
		t.Fatalf("stderr=%q", got)
	}
}

func TestElevatedSessionBlocksOnlyStateChangingCommands(t *testing.T) {
	for _, command := range [][]string{{"login"}, {"daemon", "start"}, {"daemon", "restart"}} {
		f := newFixture(t)
		f.stdin = "credential must remain unread"
		checks := 0
		f.deps.checkUserSession = func() error {
			checks++
			return newError(categoryConfiguration, "Use a non-elevated terminal")
		}
		f.deps.newClient = func(string) controlClient { t.Fatal("contacted the daemon"); return nil }
		args := append(append([]string(nil), command...), "--config", f.configPath)
		if command[0] == "login" {
			args = append(args, "--token-stdin")
		}
		if code := f.run(args...); code != 10 || checks != 1 {
			t.Fatalf("%v exit=%d checks=%d", command, code, checks)
		}
		if len(f.setupOptions) != 0 || len(f.diagnoseInputs) != 0 || len(f.started) != 0 || f.shutdowns != 0 || f.unreachableStops != 0 {
			t.Fatalf("%v changed state", command)
		}
		contains(t, f.stderr.String(), "non-elevated terminal")
	}
	for _, command := range [][]string{{"daemon", "stop"}, {"daemon", "status"}, {"doctor"}, {"daemon", "logs"}, {"auth", "status"}, {"runtime", "check"}, {"help"}, {"version"}} {
		f := newFixture(t)
		f.deps.checkUserSession = func() error { t.Fatal("recovery command checked the session"); return nil }
		args := command
		if command[0] != "help" && command[0] != "version" {
			args = append(append([]string(nil), command...), "--config", f.configPath)
		}
		if code := f.run(args...); code != 0 {
			t.Fatalf("%v exit=%d stderr=%s", command, code, f.stderr.String())
		}
	}
}

func TestSessionCheckFailureLeavesTheDaemonAlone(t *testing.T) {
	f := newFixture(t)
	f.deps.checkUserSession = func() error { return errors.New("Native token query failed") }
	if code := f.run("daemon", "restart", "--config", f.configPath); code != 1 {
		t.Fatalf("exit=%d", code)
	}
	if len(f.started) != 0 || f.shutdowns != 0 || f.unreachableStops != 0 {
		t.Fatal("daemon state changed")
	}
	contains(t, f.stderr.String(), "Native token query failed")
}

func TestDaemonStartShowsProcessConnectionAndRuntimes(t *testing.T) {
	f := newFixture(t)
	if code := f.run("daemon", "start", "--config", f.configPath); code != 0 {
		t.Fatalf("exit=%d", code)
	}
	want := "Computer daemon started.\n" +
		"Process     Running (pid 42)\n" +
		"Connection  Connecting...\n" +
		"Runtimes    Codex READY\n" +
		"Runners     1 active\n" +
		"\nThe server has not confirmed the connection yet. Check again with:\n  linger-computer daemon status\n"
	if got := f.stdout.String(); got != want {
		t.Fatalf("stdout=%q", got)
	}
	f.clear()
	f.gatewayState = "connected"
	if code := f.run("daemon", "start", "--config", f.configPath); code != 0 {
		t.Fatalf("exit=%d", code)
	}
	contains(t, f.stdout.String(), "Connection  Connected\n")
	if strings.Contains(f.stdout.String(), "has not confirmed") {
		t.Fatal("connected daemon reported pending")
	}
	f.clear()
	f.gatewayState = "authentication-failed"
	if code := f.run("daemon", "start", "--config", f.configPath); code != 11 {
		t.Fatalf("exit=%d", code)
	}
	contains(t, f.stdout.String(), "Connection  Rejected by the server. Run linger-computer login to authorize again.\n")
}

func TestDefaultConfigLocations(t *testing.T) {
	f := newFixture(t)
	if code := f.run("daemon", "start"); code != 0 {
		t.Fatalf("exit=%d", code)
	}
	data := filepath.Join(f.root, "isolated")
	f.deps.environment["LINGER_COMPUTER_DATA_DIR"] = data
	f.run("daemon", "start")
	f.deps.environment["LINGER_COMPUTER_CONFIG"] = "relative.json"
	f.run("daemon", "start")
	want := []string{
		filepath.Join(f.home, ".local/share/linger/computer/config.json"),
		filepath.Join(data, "config.json"),
		filepath.Join(f.root, "relative.json"),
	}
	if !reflect.DeepEqual(f.started, want) {
		t.Fatalf("started=%v", f.started)
	}
	windows := parseOptions{goos: "windows", environment: map[string]string{"LOCALAPPDATA": filepath.Join(f.root, "Local")}, homeDirectory: f.home, workingDirectory: f.root}
	if got := resolveConfigPath("", windows); got != filepath.Join(f.root, "Local", "Linger", "Computer", "config.json") {
		t.Fatalf("windows default=%s", got)
	}
	windows.environment = map[string]string{}
	if got := resolveConfigPath("", windows); got != filepath.Join(f.home, "AppData", "Local", "Linger", "Computer", "config.json") {
		t.Fatalf("windows fallback=%s", got)
	}
}

func TestDaemonStopStartAndRestartThroughControl(t *testing.T) {
	f := newFixture(t)
	for _, args := range [][]string{{"daemon", "start"}, {"daemon", "stop"}, {"daemon", "restart"}} {
		if code := f.run(append(args, "--config", f.configPath)...); code != 0 {
			t.Fatalf("%v exit=%d", args, code)
		}
	}
	if !reflect.DeepEqual(f.started, []string{f.configPath, f.configPath}) || f.shutdowns != 2 || f.waitedForStop != 2 {
		t.Fatalf("started=%v shutdowns=%d waited=%d", f.started, f.shutdowns, f.waitedForStop)
	}
	contains(t, f.stdout.String(), "Computer daemon stopped\n")
	contains(t, f.stdout.String(), "Computer daemon restarted.\n")
}

func TestDaemonStopIdleAndRecovery(t *testing.T) {
	f := newFixture(t)
	if code := f.run("daemon", "stop", "--if-idle", "--config", f.configPath); code != 0 || f.idleShutdowns != 1 || f.shutdowns != 0 || f.waitedForStop != 1 {
		t.Fatalf("idle stop exit=%d idle=%d", code, f.idleShutdowns)
	}

	f = newFixture(t)
	f.statusError = errControlRefused
	if code := f.run("daemon", "stop", "--config", f.configPath); code != 0 || f.unreachableStops != 1 {
		t.Fatalf("unreachable stop exit=%d stops=%d", code, f.unreachableStops)
	}
	contains(t, f.stdout.String(), "Computer daemon stopped\n")

	f = newFixture(t)
	f.statusError = errControlRefused
	if code := f.run("daemon", "stop", "--if-idle", "--config", f.configPath); code != 15 || f.unreachableStops != 0 || f.idleShutdowns != 0 {
		t.Fatalf("unproven idle stop exit=%d", code)
	}
	contains(t, f.stderr.String(), "Cannot safely stop --if-idle: Daemon state is unknown; no process was terminated")

	f = newFixture(t)
	if err := os.Remove(f.configPath); err != nil {
		t.Fatal(err)
	}
	if code := f.run("daemon", "stop", "--if-idle", "--config", f.configPath); code == 0 || f.unreachableStops != 0 {
		t.Fatalf("missing config idle stop exit=%d", code)
	}

	f = newFixture(t)
	f.statusError = errControlRefused
	f.confirmedStopped = true
	if code := f.run("daemon", "stop", "--if-idle", "--config", f.configPath); code != 0 || f.unreachableStops != 0 {
		t.Fatalf("proven idle stop exit=%d", code)
	}
	contains(t, f.stdout.String(), "Computer daemon is not running\n")

	f = newFixture(t)
	f.waitError = errors.New("graceful shutdown timed out")
	if code := f.run("daemon", "stop", "--if-idle", "--config", f.configPath); code != 0 || f.idleShutdowns != 1 || f.waitedForStop != 1 || f.unreachableStops != 1 {
		t.Fatalf("recovered stop exit=%d", code)
	}
	contains(t, f.stdout.String(), "Computer daemon stopped\n")
}

func TestDaemonStatusJSONKeepsItsShape(t *testing.T) {
	f := newFixture(t)
	if code := f.run("daemon", "status", "--json", "--config", f.configPath); code != 0 {
		t.Fatalf("exit=%d", code)
	}
	got := decodeJSON(t, f.stdout.String())
	want := decodeJSON(t, `{"version":1,"config":{"configured":true,"path":`+quote(f.configPath)+`},
		"daemon":{"state":"running","pid":42,"computer_id":"computer-local","gateway_state":"connecting","reconciled":false,"active_operations":0,"active_runners":1,"capacity":2},
		"runtimes":[{"type":"codex","status":"ready","version":"1.2.3"}],
		"runners":[{"agent_id":"agent-a","state":"running","pid":84}]}`)
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("status=%v", got)
	}
	if !strings.HasPrefix(f.stdout.String(), "{\n  \"version\": 1,\n  \"config\": {\n    \"configured\": true,") || !strings.Contains(f.stdout.String(), "\"daemon\": {\n    \"state\": \"running\",") {
		t.Fatalf("status layout=%s", f.stdout.String())
	}

	writeFile(t, f.configPath, "{invalid")
	f.clear()
	if code := f.run("daemon", "status", "--json", "--config", f.configPath); code != 10 {
		t.Fatalf("invalid config exit=%d", code)
	}
	report := decodeJSON(t, f.stdout.String())
	if report["daemon"].(map[string]any)["state"] != "error" || report["error"].(map[string]any)["category"] != "configuration" {
		t.Fatalf("invalid config status=%v", report)
	}

	f.clear()
	if code := f.run("daemon", "status", "--config", filepath.Join(f.root, "none.json")); code != 10 {
		t.Fatalf("unconfigured exit=%d", code)
	}
	if got := f.stdout.String(); got != "This computer is not logged in.\n\nNext:\n  linger-computer login\n" {
		t.Fatalf("unconfigured=%q", got)
	}
}

func TestStoppedStatusPointsToDaemonStart(t *testing.T) {
	f := newFixture(t)
	f.statusError = errControlRefused
	if code := f.run("daemon", "status", "--config", f.configPath); code != 0 {
		t.Fatalf("exit=%d", code)
	}
	if got := f.stdout.String(); got != "Process     Stopped\nConnection  Not connected\n\nNext:\n  linger-computer daemon start\n" {
		t.Fatalf("stdout=%q", got)
	}
}

func quote(value string) string {
	encoded, _ := json.Marshal(value)
	return string(encoded)
}

func TestRunnerCommandsRouteByAgentID(t *testing.T) {
	f := newFixture(t)
	if code := f.run("daemon", "runners", "inspect", "agent-a", "--config", f.configPath); code != 0 {
		t.Fatalf("exit=%d", code)
	}
	if !strings.HasPrefix(f.stdout.String(), "{\n  \"version\": 1,\n  \"runner\": {\n    \"agent_id\": \"agent-a\",") {
		t.Fatalf("inspect=%s", f.stdout.String())
	}
	f.clear()
	if code := f.run("daemon", "runners", "stop", "agent-a", "--config", f.configPath); code != 0 {
		t.Fatalf("exit=%d", code)
	}
	if got := f.stdout.String(); got != "agent-a\trunning\tpid=84\n" {
		t.Fatalf("stop=%q", got)
	}
	if !reflect.DeepEqual(f.inspected, []string{"agent-a"}) || !reflect.DeepEqual(f.stopped, []string{"agent-a"}) {
		t.Fatalf("inspected=%v stopped=%v", f.inspected, f.stopped)
	}
	f.clear()
	if code := f.run("daemon", "runners", "--json", "--config", f.configPath); code != 0 {
		t.Fatalf("exit=%d", code)
	}
	if runners := decodeJSON(t, f.stdout.String())["runners"].([]any); runners[0].(map[string]any)["agent_id"] != "agent-a" {
		t.Fatalf("runners=%v", runners)
	}
	f.deps.newClient = func(string) controlClient { return failingRunnerClient{fakeClient{f: f}} }
	f.clear()
	if code := f.run("daemon", "runners", "--config", f.configPath); code != 16 {
		t.Fatalf("failed runner command exit=%d", code)
	}
	contains(t, f.stderr.String(), "Agent Runner command failed: Runner not found")
}

type failingRunnerClient struct{ fakeClient }

func (failingRunnerClient) Runners(context.Context) ([]object, error) {
	return nil, &controlError{Code: "runner_not_found", Message: "Runner not found", Status: 404}
}

func TestServiceCommands(t *testing.T) {
	f := newFixture(t)
	code := f.run("daemon", "service", "start", "preview", "--config", f.configPath, "--", "python3", "-m", "http.server", "4173")
	if code != 0 {
		t.Fatalf("exit=%d stderr=%s", code, f.stderr.String())
	}
	want := []control.ServiceStart{{Name: "preview", Command: "python3", Args: []string{"-m", "http.server", "4173"}, Cwd: f.root}}
	if !reflect.DeepEqual(f.serviceStarts, want) {
		t.Fatalf("starts=%+v", f.serviceStarts)
	}
	if got := f.stdout.String(); got != "Managed service started: preview\tpid=123\tpython3\tlog=/tmp/preview.log\n" {
		t.Fatalf("start=%q", got)
	}
	f.clear()
	f.run("daemon", "service", "list", "--config", f.configPath)
	f.run("daemon", "service", "list", "--json", "--config", f.configPath)
	f.run("daemon", "service", "stop", "preview", "--config", f.configPath)
	if got := f.stdout.String(); got != "No managed services\n{\n  \"version\": 1,\n  \"services\": []\n}\nManaged service stopped: preview\n" {
		t.Fatalf("service output=%q", got)
	}
	for _, args := range [][]string{{"daemon", "service", "start", "preview"}, {"daemon", "service", "stop"}, {"daemon", "service", "list", "--", "x"}} {
		f.clear()
		if code := f.run(args...); code != 2 {
			t.Fatalf("%v exit=%d", args, code)
		}
	}
}

func TestRuntimeCheckWorksWithoutLoginOrDaemon(t *testing.T) {
	f := newFixture(t)
	f.deps.newClient = func(string) controlClient { t.Fatal("runtime check contacted the daemon"); return nil }
	if code := f.run("runtime", "check", "--config", filepath.Join(f.root, "missing", "config.json")); code != 0 {
		t.Fatalf("exit=%d", code)
	}
	output := f.stdout.String()
	contains(t, output, "Checking Codex, Claude Code, Pi...\n")
	for _, progress := range []string{"  Codex         READY (1.2.3)\n", "  Claude Code   NOT_INSTALLED\n", "  Pi            NOT_INSTALLED\n"} {
		contains(t, output, progress)
	}
	want := "\nRuntime       Status          Next step\n" +
		"Codex         READY           —\n" +
		"Claude Code   NOT_INSTALLED   Install: curl -fsSL https://claude.ai/install.sh | bash\n" +
		"Pi            NOT_INSTALLED   Install: npm install -g @earendil-works/pi-coding-agent\n" +
		"\n1/3 runtimes ready. This computer can run agents.\n" +
		"Model reply not verified. Run linger-computer runtime check <name> --live to verify it.\n"
	if !strings.HasSuffix(output, want) {
		t.Fatalf("runtime check=%q", output)
	}
}

func TestSingleRuntimeCheckExitCodeAndJSON(t *testing.T) {
	f := newFixture(t)
	if code := f.run("runtime", "check", "pi", "--json", "--config", f.configPath); code != 13 {
		t.Fatalf("exit=%d", code)
	}
	want := "{\n  \"version\": 1,\n  \"ready\": 0,\n  \"total\": 1,\n  \"model_reply_checked\": false,\n  \"runtimes\": [\n    {\n      \"runtime\": \"pi\",\n      \"name\": \"Pi\",\n      \"status\": \"NOT_INSTALLED\",\n      \"next_step\": \"Install: npm install -g @earendil-works/pi-coding-agent\",\n      \"model_reply_verified\": null\n    }\n  ]\n}\n"
	if got := f.stdout.String(); got != want {
		t.Fatalf("json=%q", got)
	}
	f.clear()
	if code := f.run("runtime", "check", "codex", "--live", "--config", f.configPath); code != 0 {
		t.Fatalf("live exit=%d", code)
	}
	contains(t, f.stdout.String(), "Checking Codex with a model reply...\n")
	contains(t, f.stdout.String(), "Codex is ready.\nModel reply verified.\n")
	f.deps.checkRuntime = func(_ context.Context, runtimeType string, _ runtimeRequest) (runtimeCheck, error) {
		return runtimeCheck{diagnostic: onlyRuntime(runtimeType)[0], live: &provider.LiveCheck{Passed: false, Message: "401 Unauthorized", DurationMS: 9}}, nil
	}
	f.clear()
	if code := f.run("runtime", "check", "codex", "--live", "--config", f.configPath); code != 1 {
		t.Fatalf("failed live exit=%d", code)
	}
	contains(t, f.stdout.String(), "Codex         ERROR           Check that Codex can reach its model\n\nCodex: 401 Unauthorized\n\nCodex is not ready.\n")
	f.clear()
	if code := f.run("runtime", "check", "gemini"); code != 2 {
		t.Fatalf("unknown runtime exit=%d", code)
	}
	contains(t, f.stderr.String(), "Unknown runtime: gemini. Use codex, claude, or pi.")
	f.deps.checkRuntime = func(context.Context, string, runtimeRequest) (runtimeCheck, error) {
		return runtimeCheck{}, errors.New("discovery crashed")
	}
	f.clear()
	if code := f.run("runtime", "check", "claude-code", "--config", f.configPath); code != 1 {
		t.Fatalf("errored exit=%d", code)
	}
	contains(t, f.stdout.String(), "Claude Code   ERROR           Fix the error below, then check again\n\nClaude Code: discovery crashed\n")
}

func TestRuntimeCheckUsesConfiguredPathsAndCodexHome(t *testing.T) {
	f := newFixture(t)
	codexPath := filepath.Join(f.root, "bin", "codex")
	authHome := filepath.Join(f.root, "custom", "codex")
	explicitPath := filepath.Join(f.root, "explicit", "codex")
	f.writeConfig(map[string]any{"runtime_paths": map[string]any{"codex": codexPath}, "codex": map[string]any{"auth_file": filepath.Join(authHome, "auth.json")}})
	var seen runtimeRequest
	f.deps.checkRuntime = func(_ context.Context, runtimeType string, request runtimeRequest) (runtimeCheck, error) {
		seen = request
		return runtimeCheck{diagnostic: onlyRuntime(runtimeType)[0]}, nil
	}
	f.run("runtime", "check", "codex", "--config", f.configPath)
	if seen.configuredPaths["codex"] != codexPath || seen.environment["CODEX_HOME"] != authHome {
		t.Fatalf("request=%+v", seen)
	}
	f.run("runtime", "check", "codex", "--codex-path", explicitPath, "--config", f.configPath)
	if seen.configuredPaths["codex"] != explicitPath {
		t.Fatalf("explicit=%+v", seen)
	}
}

func TestAuthStatusShowsTheSavedAuthorization(t *testing.T) {
	f := newFixture(t)
	f.deps.environment["LINGER_WEB_URL"] = "https://app.example.test"
	f.deps.newClient = func(string) controlClient { t.Fatal("auth status contacted the daemon"); return nil }
	if code := f.run("auth", "status", "--config", f.configPath); code != 0 {
		t.Fatalf("exit=%d", code)
	}
	want := "Status      Authorized\nSite        https://app.example.test\nComputer     (computer-local)\nWorkspace   tenant-acme\nGateway     wss://gateway.example.test/v1/runner-gateway\n"
	if got := f.stdout.String(); got != want {
		t.Fatalf("stdout=%q", got)
	}
	f.clear()
	if code := f.run("auth", "status", "--json", "--config", f.configPath); code != 0 {
		t.Fatalf("exit=%d", code)
	}
	wantJSON := "{\n  \"version\": 1,\n  \"authorized\": true,\n  \"config_path\": " + quote(f.configPath) + ",\n  \"site\": \"https://app.example.test\",\n  \"computer_id\": \"computer-local\",\n  \"computer_name\": \"\",\n  \"workspace_id\": \"tenant-acme\",\n  \"gateway_url\": \"wss://gateway.example.test/v1/runner-gateway\"\n}\n"
	if got := f.stdout.String(); got != wantJSON {
		t.Fatalf("json=%q", got)
	}
	f.clear()
	if code := f.run("auth", "status", "--config", filepath.Join(f.root, "none.json")); code != 10 {
		t.Fatalf("missing exit=%d", code)
	}
	if got := f.stdout.String(); got != "This computer is not logged in.\n\nNext:\n  linger-computer login\n" {
		t.Fatalf("missing=%q", got)
	}
	if err := os.Remove(filepath.Join(f.root, "runner-token")); err != nil {
		t.Fatal(err)
	}
	f.clear()
	if code := f.run("auth", "status", "--config", f.configPath); code != 11 {
		t.Fatalf("missing credential exit=%d", code)
	}
	contains(t, f.stdout.String(), "Status      Not authorized\n")
	contains(t, f.stdout.String(), "Error       Gateway credential file is unavailable or has unsafe permissions\n\nNext:\n  linger-computer login\n")
}

func TestDoctorReportsEveryCheck(t *testing.T) {
	f := newFixture(t)
	if code := f.run("doctor", "--json", "--config", f.configPath); code != 0 {
		t.Fatalf("exit=%d stdout=%s", code, f.stdout.String())
	}
	var report doctorReport
	if err := json.Unmarshal([]byte(f.stdout.String()), &report); err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, check := range report.Checks {
		names = append(names, check.Name+"="+check.Status)
	}
	want := []string{"product-runtime=pass", "config=pass", "credential=pass", "state-directory=pass", "gateway-network=pass", "daemon=pass", "runtime:codex=pass", "runtime:claude=warn", "runtime:pi=warn", "enrollment=pass"}
	if !report.OK || !reflect.DeepEqual(names[:len(want)], want) || report.Checks[len(want)].Name != "browser" {
		t.Fatalf("checks=%v", names)
	}
	if report.Checks[0].Detail != "Bundled Node 26.5.0" || report.Checks[6].Detail != "/usr/local/bin/codex (1.2.3); Runtime preflight passed; remote model access not verified" ||
		report.Checks[7].Detail != "Runtime executable not found" || !strings.Contains(report.Checks[9].Detail, "computer_id=computer-local tenant_id=tenant-acme gateway=wss://gateway.example.test/v1/runner-gateway") {
		t.Fatalf("details=%+v", report.Checks)
	}
	f.clear()
	f.run("doctor", "--config", f.configPath)
	if !strings.HasPrefix(f.stdout.String(), "PASS\tproduct-runtime\tBundled Node 26.5.0\nPASS\tconfig\t"+f.configPath+"\n") {
		t.Fatalf("text=%q", f.stdout.String())
	}
}

func TestDoctorFailures(t *testing.T) {
	f := newFixture(t)
	f.deps.productRuntime = func() doctorCheck { return productRuntimeCheck("26.6.0") }
	if code := f.run("doctor", "--json", "--config", f.configPath); code != 10 {
		t.Fatalf("node exit=%d", code)
	}
	if !strings.Contains(f.stdout.String(), `"detail": "Bundled Node 26.5.0 is required; found 26.6.0"`) || !strings.Contains(f.stdout.String(), `"ok": false`) {
		t.Fatalf("node report=%s", f.stdout.String())
	}

	f = newFixture(t)
	f.writeConfig(map[string]any{"enabled_runtimes": []any{}})
	probed := false
	f.deps.diagnoseRuntimes = func(context.Context, map[string]string, map[string]string, []string) ([]runtimeDiagnostic, error) {
		probed = true
		return nil, nil
	}
	if code := f.run("doctor", "--json", "--config", f.configPath); code == 0 || probed {
		t.Fatalf("invalid scope exit=%d probed=%v", code, probed)
	}

	f = newFixture(t)
	codexHome := filepath.Join(f.root, "custom-codex")
	f.writeConfig(map[string]any{"codex": map[string]any{"auth_file": filepath.Join(codexHome, "auth.json")}, "credential_expires_at": "2026-01-01T00:00:00.000Z"})
	var environment map[string]string
	f.deps.diagnoseRuntimes = func(_ context.Context, _ map[string]string, probeEnvironment map[string]string, _ []string) ([]runtimeDiagnostic, error) {
		environment = probeEnvironment
		diagnostics := runtimeFixtures(nil)
		diagnostics[0].Status, diagnostics[0].ErrorMessage = "authentication_required", "Codex authentication is required"
		return diagnostics, nil
	}
	if code := f.run("doctor", "--json", "--config", f.configPath); code != 14 {
		t.Fatalf("auth required exit=%d", code)
	}
	if environment["CODEX_HOME"] != codexHome {
		t.Fatalf("CODEX_HOME=%q", environment["CODEX_HOME"])
	}
	contains(t, f.stdout.String(), "{\n      \"name\": \"runtime:codex\",\n      \"category\": \"capabilityProbe\",\n      \"status\": \"fail\",\n      \"detail\": \"Codex authentication is required\"\n    }")
	contains(t, f.stdout.String(), "{\n      \"name\": \"credential\",\n      \"category\": \"credential\",\n      \"status\": \"pass\",")
}

func TestDoctorPrune(t *testing.T) {
	f := newFixture(t)
	revisions := filepath.Join(f.root, "setup-revisions")
	bundle := filepath.Join(f.root, "lib-release")
	for _, directory := range []string{revisions, bundle} {
		if err := os.Mkdir(directory, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	writeFile(t, filepath.Join(revisions, "credential"), "secret")
	writeFile(t, filepath.Join(f.root, "active-bundle"), "lib-release\n")
	sealed := filepath.Join(f.root, "state", "context-views", "view")
	if err := os.MkdirAll(sealed, 0o700); err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(sealed, "input.md"), "projected")
	if err := os.Chmod(sealed, 0o500); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(f.root, 0o700); err != nil {
		t.Fatal(err)
	}
	if code := f.run("doctor", "--prune", "--config", f.configPath); code != 0 {
		t.Fatalf("exit=%d stderr=%s", code, f.stderr.String())
	}
	for _, removed := range []string{f.configPath, filepath.Join(f.root, "state"), revisions} {
		if _, err := os.Lstat(removed); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("%s remains: %v", removed, err)
		}
	}
	if _, err := os.Lstat(bundle); err != nil {
		t.Fatal(err)
	}
	if f.idleShutdowns != 1 {
		t.Fatalf("idle shutdowns=%d", f.idleShutdowns)
	}
	if got := f.stdout.String(); got != "Local Computer enrollment was removed from this machine.\nRun linger-computer login to connect it again.\nThe Computer record in Agent Service was not deleted.\n" {
		t.Fatalf("stdout=%q", got)
	}
}

func TestDoctorPruneRefusals(t *testing.T) {
	f := newFixture(t)
	if err := os.Chmod(f.root, 0o700); err != nil {
		t.Fatal(err)
	}
	f.activeOperations = 1
	if code := f.run("doctor", "--prune", "--config", f.configPath); code != 15 {
		t.Fatalf("active exit=%d", code)
	}
	contains(t, f.stderr.String(), "Cannot prune Local Computer enrollment while 1 active Operation is running")

	f = newFixture(t)
	if err := os.Chmod(f.root, 0o700); err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(f.root, "outside")
	if err := os.Mkdir(outside, 0o700); err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(outside, "keep"), "keep")
	if err := os.RemoveAll(filepath.Join(f.root, "state")); err != nil {
		t.Fatal(err)
	}
	if err := createTestDirectoryLink(outside, filepath.Join(f.root, "state")); err != nil {
		t.Fatal(err)
	}
	if code := f.run("doctor", "--prune", "--config", f.configPath); code != 10 {
		t.Fatalf("symlink exit=%d", code)
	}
	contains(t, f.stderr.String(), "unsafe")
	if _, err := os.Stat(filepath.Join(outside, "keep")); err != nil {
		t.Fatal(err)
	}

	f = newFixture(t)
	if err := os.Chmod(f.root, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(f.configPath, filepath.Join(f.root, "config-linked.json")); err != nil {
		t.Fatal(err)
	}
	if code := f.run("doctor", "--prune", "--config", f.configPath); code != 10 {
		t.Fatalf("hard link exit=%d", code)
	}
	contains(t, f.stderr.String(), "unsafe")
	if _, err := os.Lstat(f.configPath); err != nil {
		t.Fatal(err)
	}
}

func TestLogsAndVersion(t *testing.T) {
	f := newFixture(t)
	if code := f.run("daemon", "logs", "-f", "-n", "25", "--config", f.configPath); code != 0 {
		t.Fatalf("exit=%d", code)
	}
	if !reflect.DeepEqual(f.logRequests, []logRequest{{configPath: f.configPath, follow: true, lines: 25}}) || f.stdout.String() != "redacted log\n" {
		t.Fatalf("requests=%+v stdout=%q", f.logRequests, f.stdout.String())
	}
	for _, lines := range []string{"0", "10001", "x"} {
		f.clear()
		if code := f.run("daemon", "logs", "-n", lines); code != 2 {
			t.Fatalf("lines %s exit=%d", lines, code)
		}
		contains(t, f.stderr.String(), "Log line count must be between 1 and 10000")
	}
	f.clear()
	if code := f.run("version"); code != 0 || f.stdout.String() != "linger-computer "+transport.ReleaseVersion+"\n" {
		t.Fatalf("version=%q", f.stdout.String())
	}
}

func TestEnvironmentCommandNamesHintsAndHelp(t *testing.T) {
	f := newFixture(t)
	f.deps.environment["LINGER_COMPUTER_COMMAND"] = "linger-computer-staging"
	f.run("--help")
	contains(t, f.stdout.String(), "  linger-computer-staging login\n\nRun \"linger-computer-staging <command> --help\" for options.\n")
	f.clear()
	f.run("auth", "status", "--config", filepath.Join(f.root, "none.json"))
	contains(t, f.stdout.String(), "  linger-computer-staging login\n")
	f.deps.environment["LINGER_COMPUTER_COMMAND"] = "other-tool"
	f.clear()
	f.run("--help")
	contains(t, f.stdout.String(), "  linger-computer login\n")
}

func terminalLogin(t *testing.T, ctx context.Context, stdin io.Reader, rawErr error) (*fixture, int, int) {
	t.Helper()
	f := newFixture(t)
	restores := 0
	f.deps.stdin = stdin
	f.deps.rawTerminal = func() (func(), bool, error) {
		if rawErr != nil {
			return nil, false, rawErr
		}
		return func() { restores++ }, true, nil
	}
	code := Run(ctx, []string{"login", "--token-stdin", "--config", f.configPath}, f.deps)
	return f, code, restores
}

func TestLoginTerminalTokenIsHiddenAndEdited(t *testing.T) {
	for name, input := range map[string]string{
		"enter":     "linger-connect-v1.payload\r",
		"backspace": "linger-connect-v1.X\x08x\x7fpay\x1bload\n",
		"eof":       "  linger-connect-v1.payload",
	} {
		t.Run(name, func(t *testing.T) {
			f, code, restores := terminalLogin(t, context.Background(), strings.NewReader(input), nil)
			if code != 0 || len(f.setupOptions) != 1 || f.setupOptions[0].serverToken != "linger-connect-v1.payload" {
				t.Fatalf("code=%d setup=%#v stderr=%s", code, f.setupOptions, f.stderr.String())
			}
			contains(t, f.stderr.String(), "Paste the server connection token, then press Enter: \n")
			if strings.Contains(f.stdout.String()+f.stderr.String(), "payload") {
				t.Fatal("token was echoed")
			}
			if restores != 1 {
				t.Fatalf("restores=%d", restores)
			}
		})
	}
}

func TestLoginTerminalTokenFailures(t *testing.T) {
	blocked, _ := io.Pipe()
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	for name, test := range map[string]struct {
		ctx      context.Context
		stdin    io.Reader
		rawErr   error
		message  string
		restores int
	}{
		"ctrl-c":   {context.Background(), strings.NewReader("linger\x03rest\r"), nil, "input was cancelled", 1},
		"empty":    {context.Background(), strings.NewReader("\r"), nil, "must not be empty", 1},
		"too long": {context.Background(), strings.NewReader(strings.Repeat("a", maxTokenBytes+1)), nil, "exceeds 64 KiB", 1},
		"cancel":   {cancelled, blocked, nil, "input was cancelled", 1},
		"make raw": {context.Background(), strings.NewReader("unread\r"), errors.New("raw refused"), "raw refused", 0},
	} {
		t.Run(name, func(t *testing.T) {
			f, code, restores := terminalLogin(t, test.ctx, test.stdin, test.rawErr)
			if code != exitCodes[categoryCredential] || len(f.setupOptions) != 0 || restores != test.restores {
				t.Fatalf("code=%d setup=%d restores=%d", code, len(f.setupOptions), restores)
			}
			contains(t, f.stderr.String(), test.message)
		})
	}
}
