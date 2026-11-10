package provider

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/process"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider/native"
	localworkspace "github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/workspace"
)

const maxProbeOutputBytes = 1024 * 1024

var errProbeOutputLimit = errors.New("Runtime probe output exceeded one MiB")

type runtimeProbeOutcome struct {
	Status           string
	Code             string
	Message          string
	protocolVerified bool
}

func probeRuntime(ctx context.Context, runtimeType, executable string, environment map[string]string, timeout time.Duration, version string, runtimeHomeRoot ...string) runtimeProbeOutcome {
	policy := runtimeDetectionPolicies[runtimeType]
	authentication := runtimeProbeOutcome{Status: "ready"}
	if policy.authenticationBeforeProtocol && policy.authenticationProbe != nil {
		authentication = probeRuntimeAuthentication(ctx, runtimeType, executable, environment, timeout, version, runtimeHomeRoot...)
		if authentication.Status != "ready" {
			return authentication
		}
	}
	if err := probeRuntimeProtocol(ctx, runtimeType, executable, environment, timeout, version); err != nil {
		if ctx.Err() != nil || errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
			return runtimeProbeOutcome{Status: "error", Code: "RUNTIME_DIAGNOSTIC_FAILED", Message: "Runtime protocol handshake could not be completed within its deadline"}
		}
		return runtimeProbeOutcome{Status: "incompatible", Code: "RUNTIME_INCOMPATIBLE", Message: "Runtime protocol handshake failed"}
	}
	if !policy.authenticationBeforeProtocol && policy.authenticationProbe != nil {
		authentication = probeRuntimeAuthentication(ctx, runtimeType, executable, environment, timeout, version, runtimeHomeRoot...)
	}
	authentication.protocolVerified = true
	return authentication
}

// codexProbeArgs skips plugin startup. Plugin and remote-control init can
// consume the authentication budget before account/read runs, which the
// Room reports as an unverified Codex login even when auth is already valid.
// Conversation launches already pass the same flag.
func codexProbeArgs(version string) []string {
	return native.CodexAppServerArgs(version)
}

func probeRuntimeProtocol(ctx context.Context, runtimeType, executable string, environment map[string]string, timeout time.Duration, version string) error {
	var args []string
	var payload string
	switch runtimeType {
	case "pi":
		args = append([]string{"--mode", "rpc", "--no-session"}, native.PiRPCResourceArgs()...)
		payload = `{"id":"linger-probe","type":"get_state"}` + "\n"
	case "codex":
		args = codexProbeArgs(version)
		// Codex emits the initialize response before accepting the initialized
		// notification. Sending both frames back-to-back can race startup and
		// make the probe report a false protocol incompatibility.
		payload = `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"linger-computer-doctor","title":"Linger Computer Doctor","version":"1.0.0"},"capabilities":null}}` + "\n"

	case "claude":
		args = []string{
			"-p", "--output-format", "stream-json", "--input-format", "stream-json", "--verbose",
			"--bare", "--safe-mode", "--no-session-persistence", "--disable-slash-commands",
			"--strict-mcp-config", "--mcp-config", `{"mcpServers":{}}`, "--tools", "",
		}
		payload = `{"type":"control_request","request_id":"linger-computer-doctor","request":{"subtype":"initialize"}}` + "\n"
	default:
		return errors.New("unsupported Runtime protocol probe")
	}
	stdout, _, runErr := runBoundedProbe(ctx, executable, args, environment, payload, timeout)
	if errors.Is(runErr, errProbeOutputLimit) {
		return runErr
	}
	if runErr != nil && len(stdout) == 0 {
		return runErr
	}
	if runErr != nil && !errors.Is(runErr, context.DeadlineExceeded) && !errors.Is(runErr, context.Canceled) {
		return runErr
	}
	matched := false
	for _, line := range strings.Split(stdout, "\n") {
		var response map[string]any
		if json.Unmarshal([]byte(strings.TrimSpace(line)), &response) == nil && protocolProbeResponseMatches(runtimeType, response) {
			matched = true
			break
		}
	}
	if !matched {
		if runErr != nil {
			return runErr
		}
		return errors.New("Runtime capability probe closed without initialize response")
	}
	return nil
}

func protocolProbeResponseMatches(runtimeType string, response map[string]any) bool {
	switch runtimeType {
	case "pi":
		data, ok := response["data"].(map[string]any)
		_, streaming := data["isStreaming"].(bool)
		return ok && streaming && response["id"] == "linger-probe" && response["type"] == "response" && response["command"] == "get_state" && response["success"] == true
	case "claude":
		control, ok := response["response"].(map[string]any)
		return ok && response["type"] == "control_response" && control["subtype"] == "success" && control["request_id"] == "linger-computer-doctor"
	case "codex":
		_, result := response["result"].(map[string]any)
		return response["id"] == float64(1) && result

	default:
		return false
	}
}

func probeCodexAuthentication(ctx context.Context, executable string, environment map[string]string, timeout time.Duration) runtimeProbeOutcome {
	return probeCodexAuthenticationVersion(ctx, executable, environment, timeout, "")
}

func probeCodexAuthenticationVersion(ctx context.Context, executable string, environment map[string]string, timeout time.Duration, version string) runtimeProbeOutcome {
	initialize := `{"id":1,"method":"initialize","params":{"clientInfo":{"name":"linger-computer-doctor","version":"1.0.0"},"capabilities":null}}` + "\n"
	var accountResponse map[string]any
	initialized := false
	rpcFailed := false
	_, _, err := runBoundedProbeExchange(ctx, executable, codexProbeArgs(version), environment, initialize, boundedAuthTimeout(timeout), func(response map[string]any) (string, bool) {
		if response["id"] == float64(1) && !initialized {
			rpcFailed = response["error"] != nil
			if !protocolProbeResponseMatches("codex", response) || rpcFailed {
				return "", true
			}
			initialized = true
			return "{\"method\":\"initialized\"}\n{\"id\":2,\"method\":\"account/read\",\"params\":{\"refreshToken\":false}}\n", false
		}
		if initialized && response["id"] == float64(2) {
			rpcFailed = response["error"] != nil
			accountResponse, _ = response["result"].(map[string]any)
			return "", true
		}
		return "", false
	})
	failure := runtimeProbeOutcome{Status: "error", Code: "RUNTIME_DIAGNOSTIC_FAILED", Message: "Codex authentication probe returned an invalid response"}
	// Keep diagnostics categorical: process errors and RPC payloads can contain
	// credentials, provider responses, or local paths.
	if ctx.Err() != nil || errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
		failure.Message = "Codex authentication probe timed out or was canceled"
		return failure
	}
	if rpcFailed || (err != nil && !errors.Is(err, errProbeOutputLimit)) {
		failure.Message = "Codex authentication probe process or RPC failed"
		return failure
	}
	if err != nil || accountResponse == nil {
		return failure
	}
	requiresAuth, valid := accountResponse["requiresOpenaiAuth"].(bool)
	if !valid {
		return failure
	}
	if !requiresAuth {
		return runtimeProbeOutcome{Status: "ready"}
	}
	account, present := accountResponse["account"]
	if !present {
		return failure
	}
	if account == nil {
		return runtimeProbeOutcome{Status: "authentication_required", Code: "RUNTIME_AUTHENTICATION_REQUIRED", Message: "Codex authentication is required"}
	}
	if details, valid := account.(map[string]any); valid {
		if kind, valid := details["type"].(string); valid && kind != "" {
			return runtimeProbeOutcome{Status: "ready"}
		}
	}
	return failure
}

func probeClaudeAuthentication(ctx context.Context, executable string, environment map[string]string, timeout time.Duration) runtimeProbeOutcome {
	// Probe the credentials an Operation will see, not the ones the daemon
	// happens to sit next to: execution moves CLAUDE_CONFIG_DIR to an isolated
	// Context Runtime home, so a probe against the Host configuration can
	// report ready for a Runtime that cannot authenticate once it runs.
	prepared, release, err := localworkspace.ClaudeProbeEnvironment(environment)
	if err != nil {
		return runtimeProbeOutcome{Status: "error", Code: "RUNTIME_DIAGNOSTIC_FAILED", Message: "Claude authentication status could not be verified"}
	}
	defer release()
	return probeClaudeAuthStatus(ctx, executable, prepared, timeout)
}

func probeClaudeAuthStatus(ctx context.Context, executable string, prepared map[string]string, timeout time.Duration) runtimeProbeOutcome {
	stdout, _, err := runBoundedProbe(ctx, executable, []string{"auth", "status", "--json"}, prepared, "", boundedAuthTimeout(timeout))
	var status struct {
		LoggedIn *bool `json:"loggedIn"`
	}
	if json.Unmarshal([]byte(strings.TrimSpace(stdout)), &status) != nil || status.LoggedIn == nil {
		return runtimeProbeOutcome{Status: "error", Code: "RUNTIME_DIAGNOSTIC_FAILED", Message: "Claude authentication status could not be verified"}
	}
	if *status.LoggedIn && err == nil {
		return runtimeProbeOutcome{Status: "ready"}
	}
	var exitErr *exec.ExitError
	if !*status.LoggedIn && errors.As(err, &exitErr) && exitErr.ExitCode() == 1 {
		return runtimeProbeOutcome{Status: "authentication_required", Code: "RUNTIME_AUTHENTICATION_REQUIRED", Message: "Claude Code login is required"}
	}
	return runtimeProbeOutcome{Status: "error", Code: "RUNTIME_DIAGNOSTIC_FAILED", Message: "Claude authentication status probe failed"}
}

func boundedAuthTimeout(timeout time.Duration) time.Duration {
	// A cold CLI can spend more than five seconds starting while the machine
	// is busy, macOS included: a busy MacBook let `claude auth status` miss a
	// five second budget and flipped a working Agent to unavailable. Preserve
	// shorter caller budgets and the enclosing discovery context.
	maximum := 15 * time.Second
	if timeout <= 0 || timeout > maximum {
		return maximum
	}
	return timeout
}

func runBoundedProbe(ctx context.Context, executable string, args []string, environment map[string]string, stdin string, timeout time.Duration) (string, string, error) {
	return runBoundedProbeExchange(ctx, executable, args, environment, stdin, timeout, func(response map[string]any) (string, bool) {
		return "", protocolProbeResponseMatches("pi", response) || protocolProbeResponseMatches("claude", response) || (response["id"] == float64(1) && (response["result"] != nil || response["error"] != nil))
	})
}

func runBoundedProbeExchange(ctx context.Context, executable string, args []string, environment map[string]string, stdin string, timeout time.Duration, onResponse func(map[string]any) (string, bool)) (string, string, error) {
	probeCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	command := exec.CommandContext(probeCtx, executable, args...)
	command.Env = environmentList(environment)
	command.Dir = environment["HOME"]
	stdout := &boundedProbeBuffer{limit: maxProbeOutputBytes}
	stderr := &boundedProbeBuffer{limit: maxProbeOutputBytes}
	if stdin == "" {
		command.Stdin = strings.NewReader(stdin)
	} else {
		input, err := command.StdinPipe()
		if err != nil {
			return "", "", err
		}
		defer input.Close()
		consumed := 0
		complete := false
		stdout.onWrite = func(output []byte) {
			if complete {
				return
			}
			for {
				end := bytes.IndexByte(output[consumed:], '\n')
				if end < 0 {
					return
				}
				line := output[consumed : consumed+end]
				consumed += end + 1
				var response map[string]any
				if json.Unmarshal(line, &response) != nil {
					continue
				}
				next, done := onResponse(response)
				if next != "" {
					if _, err := io.WriteString(input, next); err != nil {
						complete = true
						_ = input.Close()
						return
					}
				}
				if done {
					complete = true
					_ = input.Close()
					return
				}
			}
		}
		if _, err := io.WriteString(input, stdin); err != nil {
			return "", "", err
		}
	}
	command.Stdout = stdout
	command.Stderr = stderr
	err := process.Run(probeCtx, command, time.Second)
	if stdout.overflow || stderr.overflow {
		return stdout.String(), stderr.String(), errProbeOutputLimit
	}
	return stdout.String(), stderr.String(), err
}

type boundedProbeBuffer struct {
	mu       sync.Mutex
	buffer   bytes.Buffer
	limit    int
	overflow bool
	onWrite  func([]byte)
}

func (b *boundedProbeBuffer) Write(value []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	remaining := b.limit - b.buffer.Len()
	if remaining <= 0 || len(value) > remaining {
		if remaining > 0 {
			_, _ = b.buffer.Write(value[:remaining])
		}
		b.overflow = true
		return len(value), nil
	}
	written, err := b.buffer.Write(value)
	if b.onWrite != nil {
		b.onWrite(b.buffer.Bytes())
	}
	return written, err
}

func (b *boundedProbeBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buffer.String()
}

func probeRuntimeAuthentication(ctx context.Context, runtimeType, executable string, environment map[string]string, timeout time.Duration, version string, runtimeHomeRoot ...string) runtimeProbeOutcome {
	if runtimeType == "codex" {
		return probeCodexAuthenticationVersion(ctx, executable, environment, timeout, version)
	}
	outcome := runtimeDetectionPolicies[runtimeType].authenticationProbe(ctx, executable, environment, timeout)
	if runtimeType != "claude" || outcome.Status != "ready" || len(runtimeHomeRoot) == 0 {
		return outcome
	}
	probeCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	err := localworkspace.VisitClaudeAuthEnvironments(probeCtx, runtimeHomeRoot[0], environment, retireClaudeResident, func(prepared map[string]string) error {
		// The host check above already proved the executable and its login
		// work. Only a definite logout in a Context home changes that result;
		// a slow or unreadable probe there proves nothing either way.
		checked := probeClaudeAuthStatus(probeCtx, executable, prepared, timeout)
		if checked.Status == "authentication_required" {
			outcome = checked
		}
		return nil
	})
	if errors.Is(err, context.DeadlineExceeded) && ctx.Err() == nil {
		// Homes the budget did not reach are unknown, not failed; each
		// Operation reconciles its own home before Claude starts.
		slog.Warn("runner.runtime_auth.context_check_incomplete", "runtime_type", runtimeType)
		return outcome
	}
	if err != nil {
		return runtimeProbeOutcome{Status: "error", Code: "RUNTIME_DIAGNOSTIC_FAILED", Message: "Claude Context authentication could not be verified"}
	}
	return outcome
}
