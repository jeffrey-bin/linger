package computercli

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/platform/privatefs"
)

// productNodeVersion is the bundled Node that runs the teamhub CLI and the
// managed Computer tools.
const productNodeVersion = "26.5.0"

// doctorCheck is one doctor line; JSON keeps this field order.
type doctorCheck struct {
	Name     string `json:"name"`
	Category string `json:"category"`
	Status   string `json:"status"`
	Detail   string `json:"detail"`
}

type doctorReport struct {
	Version int           `json:"version"`
	OK      bool          `json:"ok"`
	Checks  []doctorCheck `json:"checks"`
}

func (c *cli) runDoctor(ctx context.Context, parsed command) (doctorReport, error) {
	checks := []doctorCheck{c.deps.productRuntime()}
	config := inspectComputerConfig(parsed.configPath, c.deps.environment, c.command)
	checks = append(checks, config.configCheck, config.credentialCheck)
	if config.configCheck.Status == "fail" {
		return doctorReport{Version: 1, OK: false, Checks: checks}, nil
	}
	checks = append(checks, inspectStateDirectory(config.stateDirectory))
	checks = append(checks, c.deps.probeGateway(ctx, config.gatewayURL))
	checks = append(checks, c.deps.inspectDaemon(ctx, config.stateDirectory))
	configuredPaths := parsed.runtimePaths
	if configuredPaths == nil {
		configuredPaths = config.runtimePaths
	}
	environment := c.deps.environment
	if config.codexHome != "" {
		environment = withVariable(environment, "CODEX_HOME", config.codexHome)
	}
	diagnostics, err := c.deps.diagnoseRuntimes(ctx, configuredPaths, environment, config.enabledRuntimes)
	if err != nil {
		return doctorReport{}, err
	}
	anyAvailable := false
	for _, diagnostic := range diagnostics {
		anyAvailable = anyAvailable || (diagnostic.Available && diagnostic.Status == "ready")
	}
	enabled := config.enabledRuntimes
	if enabled == nil {
		enabled = runtimeTypes
	}
	for _, runtimeType := range enabled {
		var found *runtimeDiagnostic
		for index := range diagnostics {
			if diagnostics[index].Type == runtimeType {
				found = &diagnostics[index]
			}
		}
		available := found != nil && found.Available && found.Status == "ready"
		check := doctorCheck{Name: "runtime:" + runtimeType, Category: categoryRuntimeUnavailable}
		if available || (found != nil && found.ExecutablePath != "") {
			check.Category = categoryCapabilityProbe
		}
		switch {
		case available:
			check.Status = "pass"
		case anyAvailable:
			check.Status = "warn"
		default:
			check.Status = "fail"
		}
		switch {
		case available:
			version := ""
			if found.Version != "" {
				version = " (" + found.Version + ")"
			}
			check.Detail = found.ExecutablePath + version + "; Runtime preflight passed; remote model access not verified"
		case found != nil && found.ErrorMessage != "":
			check.Detail = found.ErrorMessage
		default:
			check.Detail = "Runtime was not diagnosed"
		}
		checks = append(checks, check)
	}
	if config.enrollmentCheck != nil {
		checks = append(checks, *config.enrollmentCheck)
	}
	return doctorReport{Version: 1, OK: allPass(checks), Checks: checks}, nil
}

func allPass(checks []doctorCheck) bool {
	for _, check := range checks {
		if check.Status == "fail" {
			return false
		}
	}
	return true
}

func formatDoctorReport(report doctorReport) string {
	lines := make([]string, 0, len(report.Checks))
	for _, check := range report.Checks {
		status := "FAIL"
		if check.Status == "pass" {
			status = "PASS"
		} else if check.Status == "warn" {
			status = "WARN"
		}
		lines = append(lines, status+"\t"+check.Name+"\t"+check.Detail)
	}
	return strings.Join(lines, "\n") + "\n"
}

// bundledNodeCheck reports the Node runtime installed beside this CLI.
func bundledNodeCheck() doctorCheck {
	found := "none"
	if executable, err := os.Executable(); err == nil {
		node := filepath.Join(filepath.Dir(filepath.Dir(executable)), "runtime", "bin", "node")
		if strings.HasSuffix(strings.ToLower(executable), ".exe") {
			node += ".exe"
		}
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if output, err := exec.CommandContext(ctx, node, "--version").Output(); err == nil {
			found = strings.TrimPrefix(strings.TrimSpace(string(output)), "v")
		}
	}
	return productRuntimeCheck(found)
}

func productRuntimeCheck(version string) doctorCheck {
	if version == productNodeVersion {
		return doctorCheck{Name: "product-runtime", Category: categoryConfiguration, Status: "pass", Detail: "Bundled Node " + version}
	}
	return doctorCheck{Name: "product-runtime", Category: categoryConfiguration, Status: "fail", Detail: "Bundled Node " + productNodeVersion + " is required; found " + version}
}

func inspectStateDirectory(stateDirectory string) doctorCheck {
	if err := privatefs.CheckPath(stateDirectory, "directory", true); err != nil {
		detail := "State directory must be an owner-only directory"
		if errors.Is(err, os.ErrNotExist) {
			detail = err.Error()
		}
		return doctorCheck{Name: "state-directory", Category: categoryConfiguration, Status: "fail", Detail: detail}
	}
	return doctorCheck{Name: "state-directory", Category: categoryConfiguration, Status: "pass", Detail: stateDirectory}
}

func inspectDaemonHealth(ctx context.Context, client controlClient, commandName string) doctorCheck {
	status, err := client.Status(ctx)
	if err != nil {
		if unavailable(err) {
			return doctorCheck{Name: "daemon", Category: categoryDaemonLifecycle, Status: "warn", Detail: "Computer daemon is stopped"}
		}
		return doctorCheck{Name: "daemon", Category: categoryDaemonLifecycle, Status: "fail", Detail: err.Error()}
	}
	switch state, _ := status.string("gateway_state"); state {
	case "authentication-failed":
		return doctorCheck{
			Name: "daemon", Category: categoryCredential, Status: "fail",
			Detail: fmt.Sprintf("Gateway rejected this enrollment. If the server-side Computer was deleted, run %s doctor --prune, then %s login", commandName, commandName),
		}
	case "upgrade-required":
		return doctorCheck{
			Name: "daemon", Category: categoryConfiguration, Status: "fail",
			Detail: "Agent Service requires a newer Local Computer. Wait for active runs to finish, then rerun the Linger Computer installer",
		}
	}
	return doctorCheck{Name: "daemon", Category: categoryDaemonLifecycle, Status: "pass", Detail: "running pid=" + status.textOr("pid", "unknown")}
}

func probeGatewayNetwork(ctx context.Context, encoded string) doctorCheck {
	parsed, err := url.Parse(encoded)
	if err != nil {
		return doctorCheck{Name: "gateway-network", Category: categoryNetwork, Status: "fail", Detail: "Gateway is unreachable"}
	}
	port := parsed.Port()
	if port == "" {
		port = "80"
		if parsed.Scheme == "wss" {
			port = "443"
		}
	}
	host := parsed.Hostname()
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	address := net.JoinHostPort(host, port)
	var connection net.Conn
	if parsed.Scheme == "wss" {
		connection, err = (&tls.Dialer{Config: &tls.Config{ServerName: host, MinVersion: tls.VersionTLS12}}).DialContext(ctx, "tcp", address)
	} else {
		connection, err = (&net.Dialer{}).DialContext(ctx, "tcp", address)
	}
	if err != nil {
		detail := err.Error()
		if errors.Is(err, context.DeadlineExceeded) {
			detail = "timed out"
		}
		return doctorCheck{Name: "gateway-network", Category: categoryNetwork, Status: "fail", Detail: detail}
	}
	_ = connection.Close()
	return doctorCheck{Name: "gateway-network", Category: categoryNetwork, Status: "pass", Detail: host + ":" + port + " reachable"}
}

// playwrightExtensionID identifies the Playwright Extension in Chrome profiles.
const playwrightExtensionID = "mmlmfjhmonkocbjadbfplnigmagldckm"

// inspectBrowserMode reports whether Chrome and the Playwright Extension are
// present; the browser connection itself lives in the Daemon's private store.
func inspectBrowserMode(homeDirectory string, environment map[string]string, goos string) doctorCheck {
	check := func(status, detail string) doctorCheck {
		return doctorCheck{Name: "browser", Category: categoryConfiguration, Status: status, Detail: detail}
	}
	var executables []string
	userData := ""
	switch goos {
	case "darwin":
		executables = []string{
			"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
			filepath.Join(homeDirectory, "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
		}
		userData = filepath.Join(homeDirectory, "Library", "Application Support", "Google", "Chrome")
	case "windows":
		for _, name := range []string{"LOCALAPPDATA", "PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMW6432"} {
			if base := environmentValue(environment, name); base != "" {
				executables = append(executables, filepath.Join(base, "Google", "Chrome", "Application", "chrome.exe"))
			}
		}
		if local := environmentValue(environment, "LOCALAPPDATA"); local != "" {
			userData = filepath.Join(local, "Google", "Chrome", "User Data")
		}
	default:
		return check("pass", "Browser tools use the Chrome inside each Agent desktop on this Computer")
	}
	chrome := false
	for _, executable := range executables {
		if info, err := os.Stat(executable); err == nil && info.Mode().IsRegular() {
			chrome = true
		}
	}
	if !chrome {
		return check("warn", "Google Chrome is not installed, so browser tools are unavailable; desktop and file tools are unaffected")
	}
	if profiles := profilesWithExtension(userData); len(profiles) > 0 {
		return check("pass", "Google Chrome found; the Playwright Extension is installed in "+strings.Join(profiles, ", ")+". Connect your everyday Chrome from a Room chat with Connect my browser")
	}
	return check("pass", "Google Chrome found; Agents use a dedicated Chrome profile without your sign-ins. To reuse your signed-in Chrome, choose Connect my browser in a Room chat")
}

func profilesWithExtension(root string) []string {
	if root == "" {
		return nil
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		return nil
	}
	var found []string
	for _, entry := range entries {
		if info, err := os.Stat(filepath.Join(root, entry.Name(), "Extensions", playwrightExtensionID)); err == nil && info.IsDir() {
			found = append(found, entry.Name())
		}
	}
	sort.Strings(found)
	return found
}

func environmentValue(environment map[string]string, name string) string {
	for key, value := range environment {
		if strings.EqualFold(key, name) {
			return value
		}
	}
	return ""
}

func withVariable(environment map[string]string, key, value string) map[string]string {
	result := make(map[string]string, len(environment)+1)
	for name, current := range environment {
		result[name] = current
	}
	result[key] = value
	return result
}
