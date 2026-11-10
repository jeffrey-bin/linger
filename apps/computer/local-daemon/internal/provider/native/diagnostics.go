package native

import (
	"bytes"
	"encoding/json"
	"math"
	"os"
	"regexp"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/process"
)

// RuntimeFailureDiagnostics is logging-only metadata about a terminal
// failure. It never replaces Outcome.Status or Outcome.Error.
type RuntimeFailureDiagnostics struct {
	Code       string `json:"code,omitempty"`
	StatusCode *int   `json:"statusCode,omitempty"`
	ExitCode   *int   `json:"exitCode,omitempty"`
	Signal     string `json:"signal,omitempty"`
}

var (
	diagnosticCodePattern   = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_]{0,63}$`)
	diagnosticSignalPattern = regexp.MustCompile(`^SIG[A-Z0-9]{1,16}$`)
)

// Sanitized returns a copy keeping only valid fields, or nil when none is.
func (d RuntimeFailureDiagnostics) Sanitized() *RuntimeFailureDiagnostics {
	var out RuntimeFailureDiagnostics
	kept := false
	if diagnosticCodePattern.MatchString(d.Code) {
		out.Code, kept = d.Code, true
	}
	if diagnosticSignalPattern.MatchString(d.Signal) {
		out.Signal, kept = d.Signal, true
	}
	if d.StatusCode != nil && validHTTPStatus(int64(*d.StatusCode)) {
		out.StatusCode, kept = intPointer(*d.StatusCode), true
	}
	if d.ExitCode != nil && int64(*d.ExitCode) >= math.MinInt32 && int64(*d.ExitCode) <= math.MaxInt32 {
		out.ExitCode, kept = intPointer(*d.ExitCode), true
	}
	if !kept {
		return nil
	}
	return &out
}

func (d RuntimeFailureDiagnostics) empty() bool {
	return d.Code == "" && d.Signal == "" && d.StatusCode == nil && d.ExitCode == nil
}

func intPointer(value int) *int { return &value }

func validHTTPStatus(value int64) bool { return value >= 100 && value <= 599 }

// processExitDiagnostics describes a reaped process. Call it only for a
// failure that the Daemon's own cancellation or cleanup did not cause.
func processExitDiagnostics(state *os.ProcessState) RuntimeFailureDiagnostics {
	if state == nil {
		return RuntimeFailureDiagnostics{}
	}
	if signal := process.ExitSignal(state); signal != "" {
		return RuntimeFailureDiagnostics{Signal: signal}
	}
	if state.Exited() {
		return RuntimeFailureDiagnostics{ExitCode: intPointer(state.ExitCode())}
	}
	return RuntimeFailureDiagnostics{}
}

// codexErrorDiagnostics maps a Codex error object's codexErrorInfo value:
// a string is the code; a single-key object names the code and may carry an
// httpStatusCode.
func codexErrorDiagnostics(info json.RawMessage) RuntimeFailureDiagnostics {
	info = bytes.TrimSpace(info)
	if len(info) == 0 {
		return RuntimeFailureDiagnostics{}
	}
	var code string
	if json.Unmarshal(info, &code) == nil {
		return RuntimeFailureDiagnostics{Code: code}
	}
	var object map[string]json.RawMessage
	if json.Unmarshal(info, &object) != nil || len(object) != 1 {
		return RuntimeFailureDiagnostics{}
	}
	var out RuntimeFailureDiagnostics
	for key, value := range object {
		out.Code = key
		var detail struct {
			HTTPStatusCode json.RawMessage `json:"httpStatusCode"`
		}
		if json.Unmarshal(value, &detail) != nil {
			continue
		}
		if status, ok := integralNumber(detail.HTTPStatusCode); ok && validHTTPStatus(status) {
			out.StatusCode = intPointer(int(status))
		}
	}
	return out
}

// integralNumber accepts a JSON number literal (not a string) with no
// fractional part.
func integralNumber(raw json.RawMessage) (int64, bool) {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 || raw[0] == '"' {
		return 0, false
	}
	var number float64
	if json.Unmarshal(raw, &number) != nil || number != math.Trunc(number) || math.Abs(number) > 1<<53 {
		return 0, false
	}
	return int64(number), true
}
