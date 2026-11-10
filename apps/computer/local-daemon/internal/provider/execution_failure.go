package provider

import (
	"regexp"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider/native"
)

type RuntimeExecutionFailure struct {
	Code           string `json:"code"`
	RuntimeType    string `json:"runtime_type"`
	RuntimeVersion string `json:"runtime_version,omitempty"`
}

// A CLI reports its version as a whole line, and every CLI decorates it
// differently: Codex prints "codex-cli 0.153.4" while Claude prints
// "2.1.275 (Claude Code)". The pattern stays anchored — the captured version
// reaches a public diagnostic, so an unanchored search would let any
// version-shaped token in an arbitrary string through — and instead names both
// decorations it must tolerate. Without the trailing one, every Claude failure
// reached people as a bare "Claude: ..." while Codex kept its version.
var executionVersionPattern = regexp.MustCompile(`^(?:[A-Za-z][A-Za-z0-9-]{0,31} )?v?([0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?)(?: \([A-Za-z0-9][A-Za-z0-9 .-]{0,39}\))?\s*$`)

// ClassifyExecutionFailure derives the public failure code only from
// structured signals: a code the runtime adapter set from a runtime-specific
// signal, then a local execution deadline, else the sanitized diagnostics.
// Error text never decides the code, because its wording belongs to the CLI
// and changes between versions.
func ClassifyExecutionFailure(runtimeType, version, status, failureCode string, diagnostics native.RuntimeFailureDiagnostics) RuntimeExecutionFailure {
	failure := RuntimeExecutionFailure{Code: failureCode, RuntimeType: runtimeType}
	if failure.Code == "" && status == "timeout" {
		failure.Code = "timeout"
	}
	if failure.Code == "" {
		failure.Code = diagnosticFailureCode(diagnostics)
	}
	if match := executionVersionPattern.FindStringSubmatch(version); len(match) == 2 && len(match[1]) <= 80 {
		failure.RuntimeVersion = match[1]
	}
	return failure
}

func diagnosticFailureCode(diagnostics native.RuntimeFailureDiagnostics) string {
	if status := diagnostics.StatusCode; status != nil {
		switch *status {
		case 401, 403:
			return "authentication_required"
		case 429:
			return "rate_limited"
		}
		if *status >= 500 {
			return "model_service_error"
		}
	}
	switch diagnostics.Code {
	case "unauthorized":
		return "authentication_required"
	case "usageLimitExceeded":
		return "rate_limited"
	case "contextWindowExceeded":
		return "context_too_long"
	case "internalServerError", "serverOverloaded":
		return "model_service_error"
	case "httpConnectionFailed", "responseStreamConnectionFailed", "responseStreamDisconnected":
		// A connection failure that carries an HTTP status reached the
		// service; only one without a status is a network failure.
		if diagnostics.StatusCode == nil {
			return "network_error"
		}
	}
	return "execution_failed"
}
