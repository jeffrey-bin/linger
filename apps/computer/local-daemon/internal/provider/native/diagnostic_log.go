package native

import (
	"bytes"
	"log/slog"
	"strings"
	"sync"
)

const (
	diagnosticLineLimit   = 64 << 10
	diagnosticLineDropped = "[diagnostic line exceeded capture limit]"
	claudeStderrPrefix    = "[claude:stderr] "
)

// diagnosticLog turns a byte stream into Debug records, one per line. Lines
// are assembled across writes before redaction, so a credential split over
// two writes is still redacted whole.
type diagnosticLog struct {
	mu         sync.Mutex
	logger     *slog.Logger
	prefix     string
	pending    []byte
	discarding bool
}

func newDiagnosticLog(logger *slog.Logger, prefix string) *diagnosticLog {
	if logger == nil {
		logger = slog.Default()
	}
	return &diagnosticLog{logger: logger, prefix: prefix}
}

func (w *diagnosticLog) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	rest := p
	for len(rest) > 0 {
		newline := bytes.IndexByte(rest, '\n')
		chunk := rest
		if newline >= 0 {
			chunk = rest[:newline]
		}
		if !w.discarding {
			w.pending = append(w.pending, chunk...)
			if len(w.pending) > diagnosticLineLimit {
				w.pending, w.discarding = nil, true
			}
		}
		if newline < 0 {
			break
		}
		w.finishLine()
		rest = rest[newline+1:]
	}
	return len(p), nil
}

func (w *diagnosticLog) finishLine() {
	if w.discarding {
		w.discarding = false
		w.logger.Debug(w.prefix + diagnosticLineDropped)
		return
	}
	line := strings.TrimSpace(sanitizeDiagnostic(string(w.pending)))
	w.pending = w.pending[:0]
	if line != "" {
		w.logger.Debug(w.prefix + line)
	}
}
