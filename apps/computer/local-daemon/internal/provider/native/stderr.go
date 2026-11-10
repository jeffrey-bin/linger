package native

import (
	"io"
	"strings"
	"sync"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider/redact"
)

const defaultStderrTail = 2048

// errorTail forwards writes to an inner writer and keeps the last bytes the
// inner writer accepted in a fixed ring. A nil inner writer discards.
type errorTail struct {
	mu    sync.Mutex
	inner io.Writer
	ring  []byte
	next  int
	full  bool
	total int64
}

func newErrorTail(inner io.Writer, capacity int) *errorTail {
	if capacity <= 0 {
		capacity = defaultStderrTail
	}
	return &errorTail{inner: inner, ring: make([]byte, capacity)}
}

func (t *errorTail) Write(p []byte) (int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	n, err := len(p), error(nil)
	if t.inner != nil {
		n, err = t.inner.Write(p)
	}
	if n < 0 || n > len(p) {
		return 0, io.ErrShortWrite
	}
	t.record(p[:n])
	if err == nil && n < len(p) {
		err = io.ErrShortWrite
	}
	return n, err
}

func (t *errorTail) record(p []byte) {
	t.total += int64(len(p))
	if len(p) >= len(t.ring) {
		copy(t.ring, p[len(p)-len(t.ring):])
		t.next, t.full = 0, true
		return
	}
	copied := copy(t.ring[t.next:], p)
	if copied < len(p) {
		copy(t.ring, p[copied:])
		t.full = true
	}
	t.next = (t.next + len(p)) % len(t.ring)
	if t.next == 0 && len(p) > 0 {
		t.full = true
	}
}

// raw returns the retained bytes in write order.
func (t *errorTail) raw() []byte {
	t.mu.Lock()
	defer t.mu.Unlock()
	if !t.full {
		return append([]byte(nil), t.ring[:t.next]...)
	}
	out := make([]byte, 0, len(t.ring))
	out = append(out, t.ring[t.next:]...)
	return append(out, t.ring[:t.next]...)
}

// Tail returns the retained text without invalid UTF-8 and outer whitespace.
// It is not sanitized; use sanitizeDiagnostic before logging or reporting it.
func (t *errorTail) Tail() string {
	return strings.TrimSpace(strings.ToValidUTF8(string(t.raw()), ""))
}

func (t *errorTail) Total() int64 {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.total
}

func (t *errorTail) Reset() {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.next, t.full, t.total = 0, false, 0
}

// sanitizeDiagnostic strips control characters other than newline and tab,
// then redacts credentials. All stderr text passes through it before it
// reaches an error or a log.
func sanitizeDiagnostic(text string) string {
	cleaned := strings.Map(func(r rune) rune {
		if r < 0x20 && r != '\n' && r != '\t' {
			return -1
		}
		return r
	}, text)
	return redact.Text(cleaned)
}

// withStderr appends "; <label> stderr: <sanitized tail>" to an Outcome
// error. An empty tail leaves the error unchanged.
func withStderr(message, label, tail string) string {
	tail = strings.TrimSpace(sanitizeDiagnostic(tail))
	if tail == "" {
		return message
	}
	return message + "; " + label + " stderr: " + tail
}
