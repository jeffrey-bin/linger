package provider

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/url"
	"path/filepath"
	"regexp"
	"strings"
	"sync"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/platform/privatefs"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider/redact"
)

type localDiagnosticHandler struct {
	path    string
	mu      *sync.Mutex
	secrets []string
	attrs   []slog.Attr
}

var diagnosticSecretKey = regexp.MustCompile(`(?i)token|secret|password|authorization|api.?key`)
var diagnosticURL = regexp.MustCompile(`https?://[^\s"'<>]+`)
var diagnosticBearer = regexp.MustCompile(`(?i)\b(Bearer|Basic)\s+[^\s"',;]+`)
var diagnosticCredential = regexp.MustCompile(`(?i)((?:token|api[_-]?key|password|secret|authorization)["']?\s*[:=]\s*["']?)[^\s"',;}]+`)

func localDiagnosticLogger(directory string, spec OperationSpec, environment map[string]string) *slog.Logger {
	handler := &localDiagnosticHandler{path: filepath.Join(directory, "runner-diagnostics.log"), mu: &sync.Mutex{}}
	for key, value := range environment {
		if diagnosticSecretKey.MatchString(key) && len(value) >= 4 {
			handler.secrets = append(handler.secrets, value)
		}
	}
	return slog.New(handler).With("execution_run_ref", spec.ExecutionRunRef, "operation_id", spec.TaskID, "computer_id", spec.ComputerID, "agent_id", spec.AgentID, "registration_id", spec.RegistrationID, "runtime_type", spec.Provider)
}

func (h *localDiagnosticHandler) Enabled(context.Context, slog.Level) bool { return true }

func (h *localDiagnosticHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	clone := *h
	clone.attrs = append(append([]slog.Attr(nil), h.attrs...), attrs...)
	return &clone
}

func (h *localDiagnosticHandler) WithGroup(string) slog.Handler { return h }

func (h *localDiagnosticHandler) redact(value string) string {
	for _, secret := range h.secrets {
		value = strings.ReplaceAll(value, secret, "[REDACTED]")
	}
	value = diagnosticURL.ReplaceAllStringFunc(value, func(raw string) string {
		parsed, err := url.Parse(raw)
		if err != nil {
			return "[REDACTED_URL]"
		}
		parsed.User, parsed.RawQuery, parsed.Fragment = nil, "", ""
		return parsed.String()
	})
	value = diagnosticBearer.ReplaceAllString(value, "$1 [REDACTED]")
	value = diagnosticCredential.ReplaceAllString(value, "${1}[REDACTED]")
	value = redact.Text(value)
	if len(value) > 4096 {
		value = value[:4096]
	}
	return strings.ToValidUTF8(value, "")
}

func (h *localDiagnosticHandler) Handle(_ context.Context, record slog.Record) error {
	row := map[string]any{"time": record.Time, "level": record.Level.String(), "event": h.redact(record.Message)}
	add := func(attr slog.Attr) bool {
		switch attr.Key {
		case "outcome", "attempts", "latency_ms", "type", "tool", "call_id", "content_len", "output_len",
			"spawns", "session_starts", "session_resumes", "rebounds", "recycles":
			row[attr.Key] = h.redact(attr.Value.String())
		case "operation_id", "execution_run_ref", "computer_id", "agent_id", "registration_id", "runtime_type", "phase", "kind", "method", "thread_id", "session_id", "turn_id", "duration_ms", "latency", "sent_at_unix_ms", "acknowledged_at_unix_ms", "emitted_at_unix_ms", "received_at_unix_ms", "code", "pid", "signal", "id", "request_id", "error", "status", "cleanup_confirmed", "external_exit", "cause", "reason", "mismatch":
			row[attr.Key] = h.redact(attr.Value.String())
		}
		return true
	}
	for _, attr := range h.attrs {
		add(attr)
	}
	record.Attrs(add)
	encoded, err := json.Marshal(row)
	if err != nil {
		return nil
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	file, err := privatefs.OpenLog(h.path)
	if err != nil {
		return nil
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return nil
	}
	if info.Size()+int64(len(encoded))+1 > 2*1024*1024 {
		if file.Truncate(0) != nil {
			return nil
		}
		if _, err := file.Seek(0, 0); err != nil {
			return nil
		}
	}
	_, _ = file.Write(append(encoded, '\n'))
	return nil
}
