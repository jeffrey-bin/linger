// Package computercli implements linger-computer, the control CLI that
// authorizes this Computer, manages its Daemon, and diagnoses Runtimes.
package computercli

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/control"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/transport"
)

const maxTokenBytes = 64 * 1024

// deps are the CLI's process boundaries; tests replace them.
type deps struct {
	// connectionWait bounds how long daemon start waits for the server to
	// confirm the connection.
	connectionWait   time.Duration
	environment      map[string]string
	homeDirectory    string
	hostName         string
	goos             string
	workingDirectory string
	stdin            io.Reader
	stdout, stderr   io.Writer
	// rawTerminal switches stdin to raw mode when it is a terminal so a pasted
	// token is not echoed; ok is false for pipes and files.
	rawTerminal func() (restore func(), ok bool, err error)

	checkUserSession      func() error
	checkRuntime          func(ctx context.Context, runtimeType string, request runtimeRequest) (runtimeCheck, error)
	diagnoseRuntimes      func(ctx context.Context, configuredPaths, environment map[string]string, enabled []string) ([]runtimeDiagnostic, error)
	newClient             func(stateDirectory string) controlClient
	inspectDaemon         func(ctx context.Context, stateDirectory string) doctorCheck
	probeGateway          func(ctx context.Context, gatewayURL string) doctorCheck
	productRuntime        func() doctorCheck
	readLogs              func(ctx context.Context, request logRequest, output io.Writer) error
	setup                 func(ctx context.Context, options setupOptions) (setupResult, error)
	startDaemon           func(ctx context.Context, configPath string) error
	confirmDaemonStopped  func(ctx context.Context, configPath string) (bool, error)
	stopUnreachableDaemon func(ctx context.Context, configPath string) (bool, error)
	waitForDaemonStop     func(ctx context.Context, client controlClient, pid int) error
}

type cli struct {
	deps    deps
	command string
	mu      sync.Mutex
}

// Run executes one command line and returns its exit code.
func Run(ctx context.Context, args []string, deps deps) int {
	c := &cli{deps: deps, command: commandName(deps.environment)}
	parsed, err := parseArguments(args, parseOptions{
		goos: deps.goos, environment: deps.environment, homeDirectory: deps.homeDirectory,
		hostName: deps.hostName, workingDirectory: deps.workingDirectory, commandName: c.command,
	})
	if err == nil {
		var code int
		if code, err = c.execute(ctx, parsed); err == nil {
			return code
		}
	}
	failure := asCLIError(err)
	c.write(c.deps.stderr, failure.message+"\n")
	return failure.exitCode()
}

func (c *cli) write(output io.Writer, text string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	_, _ = io.WriteString(output, text)
}

func (c *cli) out(text string) { c.write(c.deps.stdout, text) }

func (c *cli) execute(ctx context.Context, parsed command) (int, error) {
	if parsed.name == "login" || parsed.name == "daemon-start" || parsed.name == "daemon-restart" {
		if err := c.deps.checkUserSession(); err != nil {
			return 0, err
		}
	}
	switch parsed.name {
	case "help":
		c.out(usage(parsed.topic, c.command))
		return 0, nil
	case "version":
		c.out("linger-computer " + transport.ReleaseVersion + "\n")
		return 0, nil
	case "login":
		return c.executeLogin(ctx, parsed)
	case "auth-status":
		return c.executeAuthStatus(parsed)
	case "runtime-check":
		return c.executeRuntimeCheck(ctx, parsed)
	case "daemon-start", "daemon-restart":
		if parsed.name == "daemon-restart" {
			if _, err := c.stopDaemon(ctx, parsed.configPath, false); err != nil {
				return 0, err
			}
		}
		if err := c.deps.startDaemon(ctx, parsed.configPath); err != nil {
			return 0, err
		}
		if parsed.name == "daemon-start" {
			c.out("Computer daemon started.\n")
		} else {
			c.out("Computer daemon restarted.\n")
		}
		return c.reportConnection(ctx, parsed.configPath)
	case "daemon-stop":
		stopped, err := c.stopDaemon(ctx, parsed.configPath, parsed.ifIdle)
		if err != nil {
			return 0, err
		}
		if stopped {
			c.out("Computer daemon stopped\n")
		} else {
			c.out("Computer daemon is not running\n")
		}
		return 0, nil
	case "doctor":
		if parsed.prune {
			return c.executeDoctorPrune(ctx, parsed)
		}
		report, err := c.runDoctor(ctx, parsed)
		if err != nil {
			return 0, err
		}
		report.Checks = append(report.Checks, inspectBrowserMode(c.deps.homeDirectory, c.deps.environment, c.deps.goos))
		report.OK = allPass(report.Checks)
		if parsed.json {
			c.out(marshalReport(report))
		} else {
			c.out(formatDoctorReport(report))
		}
		for _, check := range report.Checks {
			if check.Status == "fail" {
				return exitCodes[check.Category], nil
			}
		}
		return 0, nil
	case "daemon-logs":
		return 0, c.deps.readLogs(ctx, logRequest{configPath: parsed.configPath, follow: parsed.follow, lines: parsed.lines}, writerFunc(c.out))
	case "daemon-status":
		code, report := c.statusReport(ctx, parsed.configPath)
		if parsed.json {
			c.out(marshalReport(report))
		} else {
			c.out(c.formatStatus(report))
		}
		return code, nil
	case "service-list", "service-start", "service-stop":
		return c.executeService(ctx, parsed)
	}
	return c.executeRunner(ctx, parsed)
}

type writerFunc func(string)

func (w writerFunc) Write(data []byte) (int, error) { w(string(data)); return len(data), nil }

func (c *cli) configuredClient(configPath string) (controlClient, error) {
	stateDirectory, err := loadStateDirectory(configPath)
	if err != nil {
		return nil, err
	}
	return c.deps.newClient(stateDirectory), nil
}

func (c *cli) executeService(ctx context.Context, parsed command) (int, error) {
	client, err := c.configuredClient(parsed.configPath)
	if err != nil {
		return 0, err
	}
	switch parsed.name {
	case "service-list":
		services, err := client.Services(ctx)
		if err != nil {
			return 0, err
		}
		switch {
		case parsed.json:
			c.out(marshalReport(struct {
				Version  int      `json:"version"`
				Services []object `json:"services"`
			}{1, services}))
		case len(services) == 0:
			c.out("No managed services\n")
		default:
			for _, service := range services {
				c.out(formatService(service))
			}
		}
	case "service-start":
		service, err := client.StartService(ctx, control.ServiceStart{Name: parsed.serviceName, Command: parsed.executable, Args: parsed.serviceArgs, Cwd: parsed.cwd})
		if err != nil {
			return 0, err
		}
		c.out("Managed service started: " + formatService(service))
	default:
		service, err := client.StopService(ctx, parsed.serviceName)
		if err != nil {
			return 0, err
		}
		c.out("Managed service stopped: " + service.text("name") + "\n")
	}
	return 0, nil
}

func formatService(service object) string {
	return service.text("name") + "\tpid=" + service.text("pid") + "\t" + service.text("command") + "\tlog=" + service.text("logPath") + "\n"
}

func (c *cli) executeRunner(ctx context.Context, parsed command) (int, error) {
	client, err := c.configuredClient(parsed.configPath)
	if err != nil {
		return 0, err
	}
	var runners []object
	var runner object
	switch parsed.name {
	case "daemon-runners":
		runners, err = client.Runners(ctx)
	case "runner-inspect":
		runner, err = client.Runner(ctx, parsed.agentID)
	default:
		runner, err = client.StopRunner(ctx, parsed.agentID)
	}
	if err != nil {
		return 0, wrapError(categoryRunnerLifecycle, "Agent Runner command failed: "+err.Error(), err)
	}
	if parsed.json || parsed.name == "runner-inspect" {
		if parsed.name == "daemon-runners" {
			c.out(marshalReport(struct {
				Version int      `json:"version"`
				Runners []object `json:"runners"`
			}{1, runners}))
		} else {
			c.out(marshalReport(struct {
				Version int    `json:"version"`
				Runner  object `json:"runner"`
			}{1, runner}))
		}
		return 0, nil
	}
	if parsed.name != "daemon-runners" {
		runners = []object{runner}
	}
	for _, item := range runners {
		id := item.textOr("agent_id", item.textOr("operation_id", "unknown"))
		c.out(id + "\t" + item.textOr("state", "unknown") + "\tpid=" + item.textOr("pid", "-") + "\n")
	}
	return 0, nil
}

func (c *cli) executeAuthStatus(parsed command) (int, error) {
	configured, err := fileExists(parsed.configPath)
	if err != nil {
		return 0, err
	}
	var inspection *configInspection
	if configured {
		value := inspectComputerConfig(parsed.configPath, c.deps.environment, c.command)
		inspection = &value
	}
	site := strings.TrimSpace(c.deps.environment["LINGER_WEB_URL"])
	report := object{}.with("version", 1)
	credentialOK := inspection != nil && inspection.credentialCheck.Status == "pass"
	var identity *computerIdentity
	if inspection != nil {
		identity = inspection.identity
	}
	authorized := identity != nil && credentialOK
	report = report.with("authorized", authorized).with("config_path", parsed.configPath)
	if site != "" {
		report = report.with("site", site)
	}
	if identity != nil {
		report = report.with("computer_id", identity.computerID).with("computer_name", identity.displayName).
			with("workspace_id", identity.tenantID).with("gateway_url", identity.gatewayURL)
		if identity.credentialExpiresAt != "" {
			report = report.with("credential_expires_at", identity.credentialExpiresAt)
		}
	}
	errorText := ""
	if inspection != nil && !credentialOK {
		errorText = inspection.configCheck.Detail
		if inspection.configCheck.Status == "pass" {
			errorText = inspection.credentialCheck.Detail
		}
		report = report.with("error", errorText)
	}
	switch {
	case parsed.json:
		c.out(marshalReport(report))
	case !configured:
		c.out("This computer is not logged in.\n\nNext:\n  " + c.command + " login\n")
	default:
		status := "Not authorized"
		if authorized {
			status = "Authorized"
		}
		rows := [][2]string{{"Status", status}}
		if site != "" {
			rows = append(rows, [2]string{"Site", site})
		}
		if identity != nil {
			workspace := identity.tenantID
			if workspace == "" {
				workspace = "unknown"
			}
			rows = append(rows, [2]string{"Computer", identity.displayName + " (" + identity.computerID + ")"}, [2]string{"Workspace", workspace}, [2]string{"Gateway", identity.gatewayURL})
			if identity.credentialExpiresAt != "" {
				rows = append(rows, [2]string{"Expires", identity.credentialExpiresAt})
			}
		}
		if errorText != "" {
			rows = append(rows, [2]string{"Error", errorText})
		}
		c.out(statusRows(rows))
		if !authorized {
			c.out("\nNext:\n  " + c.command + " login\n")
		}
	}
	switch {
	case !configured:
		return exitCodes[categoryConfiguration], nil
	case authorized:
		return 0, nil
	case inspection.configCheck.Status == "pass":
		return exitCodes[categoryCredential], nil
	default:
		return exitCodes[categoryConfiguration], nil
	}
}

func (c *cli) executeRuntimeCheck(ctx context.Context, parsed command) (int, error) {
	// Login is optional: a saved config only supplies configured paths.
	configured, err := fileExists(parsed.configPath)
	if err != nil {
		return 0, err
	}
	configuredPaths := parsed.runtimePaths
	environment := c.deps.environment
	if configured {
		config := inspectComputerConfig(parsed.configPath, c.deps.environment, c.command)
		if configuredPaths == nil {
			configuredPaths = config.runtimePaths
		}
		if config.codexHome != "" {
			environment = withVariable(environment, "CODEX_HOME", config.codexHome)
		}
	}
	types := runtimeTypes
	if parsed.runtime != "" {
		types = []string{parsed.runtime}
	}
	if !parsed.json {
		names := make([]string, 0, len(types))
		for _, runtimeType := range types {
			names = append(names, runtimeNames[runtimeType])
		}
		suffix := ""
		if parsed.live {
			suffix = " with a model reply"
		}
		c.out("Checking " + strings.Join(names, ", ") + suffix + "...\n")
	}
	rows := make([]runtimeCheckRow, len(types))
	var workers sync.WaitGroup
	for index, runtimeType := range types {
		workers.Go(func() {
			check, err := c.deps.checkRuntime(ctx, runtimeType, runtimeRequest{configuredPaths: configuredPaths, environment: environment, live: parsed.live})
			row := newRuntimeCheckRow(check, c.deps.goos)
			if err != nil {
				row = runtimeCheckRow{Runtime: runtimeType, Name: runtimeNames[runtimeType], Status: "ERROR", NextStep: "Fix the error below, then check again", Detail: err.Error()}
			}
			rows[index] = row
			if !parsed.json {
				c.out(formatRuntimeProgress(row))
			}
		})
	}
	workers.Wait()
	code := runtimeCheckExitCode(rows, parsed.runtime != "")
	if parsed.json {
		ready := 0
		for _, row := range rows {
			if row.Status == "READY" {
				ready++
			}
		}
		c.out(marshalReport(struct {
			Version           int               `json:"version"`
			Ready             int               `json:"ready"`
			Total             int               `json:"total"`
			ModelReplyChecked bool              `json:"model_reply_checked"`
			Runtimes          []runtimeCheckRow `json:"runtimes"`
		}{1, ready, len(rows), parsed.live, rows}))
	} else {
		c.out("\n" + formatRuntimeCheck(rows, parsed.live, c.command))
	}
	return code, nil
}

func (c *cli) executeDoctorPrune(ctx context.Context, parsed command) (int, error) {
	target, err := inspectPruneTarget(parsed.configPath)
	if err != nil {
		return 0, err
	}
	client, err := c.configuredClient(parsed.configPath)
	if err != nil {
		return 0, err
	}
	status, err := client.Status(ctx)
	if err != nil && !unavailable(err) {
		return 0, wrapError(categoryDaemonLifecycle, "Unable to verify the Computer daemon before pruning: "+err.Error(), err)
	}
	if err == nil {
		active, ok := status.integer("active_operations")
		if !ok || active < 0 {
			return 0, newError(categoryDaemonLifecycle, "Computer daemon did not report a valid active Operation count")
		}
		if active > 0 {
			noun := "Operations are"
			if active == 1 {
				noun = "Operation is"
			}
			return 0, newError(categoryDaemonLifecycle, fmt.Sprintf("Cannot prune Local Computer enrollment while %d active %s running", active, noun))
		}
		pid, err := requireDaemonPID(status)
		if err == nil {
			if _, err = client.ShutdownIfIdle(ctx); err == nil {
				err = c.deps.waitForDaemonStop(ctx, client, pid)
			}
		}
		if err != nil {
			return 0, wrapError(categoryDaemonLifecycle, "Unable to stop the Computer daemon before pruning: "+err.Error(), err)
		}
	}
	if err := target.prune(); err != nil {
		return 0, err
	}
	if parsed.json {
		c.out(marshalReport(struct {
			Version  int    `json:"version"`
			Pruned   bool   `json:"pruned"`
			NextStep string `json:"next_step"`
		}{1, true, c.command + " login"}))
	} else {
		c.out("Local Computer enrollment was removed from this machine.\nRun " + c.command + " login to connect it again.\nThe Computer record in Agent Service was not deleted.\n")
	}
	return 0, nil
}

func (c *cli) executeLogin(ctx context.Context, parsed command) (int, error) {
	var requested map[string]string
	if len(parsed.runtimePaths) > 0 {
		requested = parsed.runtimePaths
	}
	environment := c.deps.environment
	if parsed.codexAuthFile != "" {
		environment = withVariable(environment, "CODEX_HOME", filepath.Dir(parsed.codexAuthFile))
	}
	diagnostics, err := c.deps.diagnoseRuntimes(ctx, requested, environment, parsed.enabledRuntimes)
	if err != nil {
		return 0, wrapError(categoryCapabilityProbe, "Runtime capability probing failed: "+err.Error(), err)
	}
	runtimePaths, err := resolveUsableRuntimePaths(diagnostics, parsed.runtimePaths, parsed.enabledRuntimes)
	if err != nil {
		return 0, err
	}
	token := ""
	if parsed.tokenStdin {
		if token, err = c.readToken(ctx); err != nil {
			return 0, err
		}
		c.out("Connecting Local Computer...\n")
	} else {
		c.out("Opening Linger in your browser...\n")
	}
	result, err := c.deps.setup(ctx, setupOptions{
		configPath: parsed.configPath, stateDirectory: filepath.Join(filepath.Dir(parsed.configPath), "state"),
		webURL: parsed.webURL, displayName: parsed.displayName,
		maxRunsSet: parsed.maxRunsSet, maxRuns: parsed.maxRuns,
		runtimePaths: runtimePaths, enabledRuntimes: parsed.enabledRuntimes,
		codexAuthFile: parsed.codexAuthFile, gatewayURL: parsed.gatewayURL, serverToken: token,
	})
	if err != nil {
		return 0, err
	}
	for _, warning := range result.warnings {
		c.write(c.deps.stderr, "Warning: "+warning+"\n")
	}
	c.out("Computer " + result.computerID + " is authorized; daemon started.\n")
	code, err := c.reportConnection(ctx, parsed.configPath)
	if err != nil {
		return 0, err
	}
	if len(runtimePaths) == 0 {
		c.out("\nNo runtime is ready yet. To see what to install or sign in to, run:\n  " + c.command + " runtime check\n")
	}
	return code, nil
}

func (c *cli) readToken(ctx context.Context) (string, error) {
	data, err := c.readTerminalToken(ctx)
	if err != nil {
		return "", err
	}
	token := strings.TrimSpace(string(data))
	if token == "" {
		return "", newError(categoryCredential, "Server connection token must not be empty")
	}
	return token, nil
}

func (c *cli) readAllToken() ([]byte, error) {
	data, err := io.ReadAll(io.LimitReader(c.deps.stdin, maxTokenBytes+1))
	if err == nil && len(data) > maxTokenBytes {
		err = errors.New("Server connection token exceeds 64 KiB")
	}
	if err != nil {
		return nil, wrapError(categoryCredential, "Server connection token could not be read: "+err.Error(), err)
	}
	return data, nil
}

var errTokenInputCancelled = newError(categoryCredential, "Server connection token input was cancelled")

// readTerminalToken reads one line from a raw-mode terminal without echoing
// it, and falls back to reading all of stdin when it is not a terminal. Raw
// mode disables SIGINT, so Ctrl-C is handled as a byte here.
func (c *cli) readTerminalToken(ctx context.Context) ([]byte, error) {
	restore, ok, err := c.deps.rawTerminal()
	if err != nil {
		return nil, wrapError(categoryCredential, "Server connection token could not be read: "+err.Error(), err)
	}
	if !ok {
		return c.readAllToken()
	}
	// The prompt has no newline, so raw mode's output processing cannot affect it.
	c.write(c.deps.stderr, "Paste the server connection token, then press Enter: ")
	type outcome struct {
		data []byte
		err  error
	}
	done := make(chan outcome, 1)
	go func() {
		data, err := readTerminalLine(bufio.NewReader(c.deps.stdin))
		done <- outcome{data, err}
	}()
	var result outcome
	select {
	case result = <-done:
	case <-ctx.Done():
		result.err = errTokenInputCancelled
	}
	restore()
	c.write(c.deps.stderr, "\n")
	return result.data, result.err
}

func readTerminalLine(reader io.ByteReader) ([]byte, error) {
	var data []byte
	for {
		b, err := reader.ReadByte()
		if errors.Is(err, io.EOF) {
			return data, nil
		}
		if err != nil {
			return nil, wrapError(categoryCredential, "Server connection token could not be read: "+err.Error(), err)
		}
		switch {
		case b == '\r' || b == '\n' || b == 4:
			return data, nil
		case b == 3:
			return nil, errTokenInputCancelled
		case b == 8 || b == 127:
			if len(data) > 0 {
				data = data[:len(data)-1]
			}
		case b < 0x20:
		default:
			if len(data) == maxTokenBytes {
				err := errors.New("Server connection token exceeds 64 KiB")
				return nil, wrapError(categoryCredential, "Server connection token could not be read: "+err.Error(), err)
			}
			data = append(data, b)
		}
	}
}

func (c *cli) stopDaemon(ctx context.Context, configPath string, ifIdle bool) (bool, error) {
	client, err := c.configuredClient(configPath)
	if err != nil {
		if unavailable(err) {
			if ifIdle {
				return c.confirmStoppedWithoutRecovery(ctx, configPath)
			}
			return false, nil
		}
		return false, err
	}
	status, err := client.Status(ctx)
	if err != nil {
		if !unavailable(err) {
			return false, wrapError(categoryDaemonLifecycle, "Unable to query the Computer daemon: "+err.Error(), err)
		}
		if ifIdle {
			return c.confirmStoppedWithoutRecovery(ctx, configPath)
		}
		stopped, stopErr := c.deps.stopUnreachableDaemon(ctx, configPath)
		if stopErr != nil {
			return false, wrapError(categoryDaemonLifecycle, "Unable to stop the unreachable Computer daemon: "+stopErr.Error(), stopErr)
		}
		return stopped, nil
	}
	pid, err := requireDaemonPID(status)
	if err != nil {
		return false, err
	}
	if ifIdle {
		_, err = client.ShutdownIfIdle(ctx)
	} else {
		_, err = client.Shutdown(ctx)
	}
	if err != nil {
		return false, err
	}
	if err := c.deps.waitForDaemonStop(ctx, client, pid); err != nil {
		recovered, recoveryErr := c.deps.stopUnreachableDaemon(ctx, configPath)
		if recoveryErr != nil {
			return false, wrapError(categoryDaemonLifecycle, "Computer daemon did not stop and identity recovery failed: "+recoveryErr.Error(), errors.Join(err, recoveryErr))
		}
		if recovered {
			return true, nil
		}
		return false, wrapError(categoryDaemonLifecycle, "Computer daemon did not stop: "+err.Error(), err)
	}
	return true, nil
}

func (c *cli) confirmStoppedWithoutRecovery(ctx context.Context, configPath string) (bool, error) {
	if stopped, err := c.deps.confirmDaemonStopped(ctx, configPath); err == nil && stopped {
		return false, nil
	}
	return false, newError(categoryDaemonLifecycle, "Cannot safely stop --if-idle: Daemon state is unknown; no process was terminated")
}

func requireDaemonPID(status object) (int, error) {
	pid, ok := status.integer("pid")
	if !ok || pid < 1 {
		return 0, errors.New("Daemon status did not include a valid PID")
	}
	return pid, nil
}

type statusConfig struct {
	Configured bool   `json:"configured"`
	Path       string `json:"path"`
}

type statusError struct {
	Category string `json:"category"`
	Message  string `json:"message"`
}

type statusReport struct {
	Version  int          `json:"version"`
	Config   statusConfig `json:"config"`
	Daemon   object       `json:"daemon"`
	Runtimes []object     `json:"runtimes"`
	Runners  []object     `json:"runners"`
	Error    *statusError `json:"error,omitempty"`
}

func (c *cli) statusReport(ctx context.Context, configPath string) (int, statusReport) {
	configured, err := fileExists(configPath)
	if err == nil && !configured {
		return exitCodes[categoryConfiguration], stoppedStatus(configPath, false, &statusError{Category: categoryConfiguration, Message: "Local Computer is not configured"})
	}
	var daemon object
	var runtimes, runners []object
	if err == nil {
		var client controlClient
		if client, err = c.configuredClient(configPath); err == nil {
			if daemon, err = client.Status(ctx); err == nil {
				if runtimes, err = client.Runtimes(ctx); err == nil {
					runners, err = client.Runners(ctx)
				}
			}
		}
	}
	if err == nil {
		running := object{}.with("state", "running")
		for _, item := range daemon {
			running = running.with(item.key, item.value)
		}
		return 0, statusReport{Version: 1, Config: statusConfig{Configured: true, Path: configPath}, Daemon: running, Runtimes: runtimes, Runners: runners}
	}
	if unavailable(err) {
		return 0, stoppedStatus(configPath, true, nil)
	}
	failure := asCLIError(err)
	category := categoryDaemonLifecycle
	if failure.category == categoryConfiguration {
		category = categoryConfiguration
	}
	return exitCodes[category], stoppedStatus(configPath, true, &statusError{Category: category, Message: failure.message})
}

func stoppedStatus(configPath string, configured bool, failure *statusError) statusReport {
	state := "stopped"
	if failure != nil {
		state = "error"
	}
	return statusReport{
		Version: 1, Config: statusConfig{Configured: configured, Path: configPath},
		Daemon: object{}.with("state", state), Runtimes: []object{}, Runners: []object{}, Error: failure,
	}
}

// connected reports the server's welcome followed by replay completion.
func connected(daemon object) bool {
	state, _ := daemon.string("gateway_state")
	return state == "connected" && daemon.boolean("reconciled")
}

func (c *cli) connectionFailure(state string) (string, bool) {
	switch state {
	case "authentication-failed":
		return "Rejected by the server. Run " + c.command + " login to authorize again.", true
	case "upgrade-required":
		return "The server requires a newer Linger Computer. Rerun the installer.", true
	}
	return "", false
}

func (c *cli) waitForConnection(ctx context.Context, configPath string) statusReport {
	deadline := time.Now().Add(c.deps.connectionWait)
	for {
		_, report := c.statusReport(ctx, configPath)
		state, _ := report.Daemon.string("gateway_state")
		running, _ := report.Daemon.string("state")
		_, failed := c.connectionFailure(state)
		if running != "running" || connected(report.Daemon) || failed || !time.Now().Before(deadline) {
			return report
		}
		if sleep(ctx, 500*time.Millisecond) != nil {
			return report
		}
	}
}

// reportConnection waits for the started Daemon to reach the server and
// prints its status.
func (c *cli) reportConnection(ctx context.Context, configPath string) (int, error) {
	report := c.waitForConnection(ctx, configPath)
	c.out(c.formatStatus(report))
	switch state, _ := report.Daemon.string("gateway_state"); state {
	case "authentication-failed":
		return exitCodes[categoryCredential], nil
	case "upgrade-required":
		return exitCodes[categoryConfiguration], nil
	}
	if running, _ := report.Daemon.string("state"); running == "running" && !connected(report.Daemon) {
		c.out("\nThe server has not confirmed the connection yet. Check again with:\n  " + c.command + " daemon status\n")
	}
	return 0, nil
}

func (c *cli) formatStatus(report statusReport) string {
	if !report.Config.Configured {
		return "This computer is not logged in.\n\nNext:\n  " + c.command + " login\n"
	}
	if running, _ := report.Daemon.string("state"); running != "running" {
		process := "Stopped"
		if report.Error != nil {
			process = "Error: " + report.Error.Message
		}
		return statusRows([][2]string{{"Process", process}, {"Connection", "Not connected"}}) + "\nNext:\n  " + c.command + " daemon start\n"
	}
	connection := "Connected"
	if !connected(report.Daemon) {
		connection = "Connecting..."
		if message, failed := c.connectionFailure(report.Daemon.textOr("gateway_state", "unknown")); failed {
			connection = message
		}
	}
	runtimes := "Checking..."
	if len(report.Runtimes) > 0 {
		var parts []string
		for _, runtime := range report.Runtimes {
			runtimeType, _ := runtime.string("type")
			name, supported := runtimeNames[runtimeType]
			if !supported {
				continue
			}
			status, _ := runtime.string("status")
			label, known := runtimeStatuses[status]
			if !known {
				label = runtime.text("status")
			}
			parts = append(parts, name+" "+label)
		}
		runtimes = strings.Join(parts, " · ")
	}
	version := ""
	if raw, ok := report.Daemon.get("daemon_version"); ok && rawText(raw) != "" && string(raw) != "null" && string(raw) != "false" && string(raw) != "0" {
		version = ", version " + rawText(raw)
	}
	return statusRows([][2]string{
		{"Process", "Running (pid " + report.Daemon.textOr("pid", "-") + version + ")"},
		{"Connection", connection},
		{"Runtimes", runtimes},
		{"Runners", fmt.Sprintf("%d active", len(report.Runners))},
	})
}

func statusRows(rows [][2]string) string {
	var builder strings.Builder
	for _, row := range rows {
		fmt.Fprintf(&builder, "%-11s %s\n", row[0], row[1])
	}
	return builder.String()
}

func fileExists(path string) (bool, error) {
	if _, err := os.Stat(path); err != nil {
		if unavailable(err) {
			return false, nil
		}
		return false, err
	}
	return true, nil
}
