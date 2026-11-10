package native

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"io"
	"log/slog"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf8"
)

func TestRunContextBudget(t *testing.T) {
	parent, cancelParent := context.WithCancel(context.Background())
	unbounded, cancelUnbounded := budgetContext(parent, 0)
	defer cancelUnbounded()
	if _, ok := unbounded.Deadline(); ok {
		t.Fatal("zero budget has a deadline")
	}
	if _, ok := mustContext(budgetContext(parent, -time.Second)).Deadline(); ok {
		t.Fatal("negative budget has a deadline")
	}
	bounded, cancelBounded := budgetContext(parent, time.Minute)
	defer cancelBounded()
	if deadline, ok := bounded.Deadline(); !ok || time.Until(deadline) > time.Minute {
		t.Fatalf("deadline = %v, %v", deadline, ok)
	}
	cancelParent()
	for _, ctx := range []context.Context{unbounded, bounded} {
		select {
		case <-ctx.Done():
		case <-time.After(time.Second):
			t.Fatal("parent cancellation did not propagate")
		}
	}
	if interruptedStatus(bounded) != statusAborted {
		t.Fatal("parent cancellation must be aborted")
	}
	expiring, cancel := budgetContext(context.Background(), time.Millisecond)
	defer cancel()
	<-expiring.Done()
	if interruptedStatus(expiring) != statusTimeout {
		t.Fatal("expired budget must be timeout")
	}
}

func mustContext(ctx context.Context, cancel context.CancelFunc) context.Context {
	cancel()
	return ctx
}

func scanAll(reader io.Reader) ([]string, error) {
	scanner := newFrameScanner(reader)
	var frames []string
	for scanner.Scan() {
		frames = append(frames, string(scanner.Bytes()))
	}
	return frames, scanner.Err()
}

func TestFrameScannerRoundTripsFrameSizes(t *testing.T) {
	for _, size := range []int{0, 1, 65535, 65536, 65537, 12 << 20} {
		body := strings.Repeat("a", size)
		frames, err := scanAll(strings.NewReader(body + "\r\nfinal"))
		if err != nil || len(frames) != 2 || frames[0] != body || frames[1] != "final" {
			t.Fatalf("size %d: %d frames, err %v", size, len(frames), err)
		}
	}
	if frames, err := scanAll(strings.NewReader("")); err != nil || len(frames) != 0 {
		t.Fatalf("empty stream = %q, %v", frames, err)
	}
	if frames, _ := scanAll(strings.NewReader("a\n\nb\n")); !reflect.DeepEqual(frames, []string{"a", "", "b"}) {
		t.Fatalf("frames = %q", frames)
	}
}

func TestFrameScannerRejectsOversizedFrameForGood(t *testing.T) {
	input := io.MultiReader(strings.NewReader(strings.Repeat("x", frameLimit)), strings.NewReader("!\nnext\n"))
	scanner := newFrameScanner(input)
	if scanner.Scan() {
		t.Fatal("oversized frame was returned")
	}
	if !errors.Is(scanner.Err(), bufio.ErrTooLong) || len(scanner.Bytes()) != 0 {
		t.Fatalf("err = %v, bytes = %d", scanner.Err(), len(scanner.Bytes()))
	}
	if scanner.Scan() {
		t.Fatal("scanner resumed after an oversized frame")
	}
	// A frame of exactly the limit, newline included, still fits.
	frames, err := scanAll(strings.NewReader(strings.Repeat("y", frameLimit-1) + "\n"))
	if err != nil || len(frames) != 1 {
		t.Fatalf("limit frame: %d frames, %v", len(frames), err)
	}
}

type brokenReader struct {
	data []byte
	err  error
}

func (r *brokenReader) Read(p []byte) (int, error) {
	if len(r.data) > 0 {
		n := copy(p, r.data)
		r.data = r.data[n:]
		return n, nil
	}
	return 0, r.err
}

func TestFrameScannerHidesPartialFrameOnReadError(t *testing.T) {
	broken := errors.New("pipe broke")
	scanner := newFrameScanner(&brokenReader{data: []byte("partial"), err: broken})
	if scanner.Scan() {
		t.Fatal("partial frame exposed")
	}
	if !errors.Is(scanner.Err(), broken) || scanner.Bytes() != nil {
		t.Fatalf("err = %v, bytes = %q", scanner.Err(), scanner.Bytes())
	}
}

type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

func debugLogger(out io.Writer) *slog.Logger {
	return slog.New(slog.NewTextHandler(out, &slog.HandlerOptions{Level: slog.LevelDebug}))
}

func TestDiagnosticLogRedactsAcrossWrites(t *testing.T) {
	secret := "sk-" + strings.Repeat("Q", 30)
	input := "fixture failure api_key=" + secret + "\n"
	for split := 0; split <= len(input); split++ {
		var out syncBuffer
		writer := newDiagnosticLog(debugLogger(&out), claudeStderrPrefix)
		for _, part := range []string{input[:split], input[split:]} {
			if n, err := writer.Write([]byte(part)); n != len(part) || err != nil {
				t.Fatalf("write = %d, %v", n, err)
			}
		}
		logged := out.String()
		if strings.Contains(logged, strings.Repeat("Q", 30)) || !strings.Contains(logged, "REDACTED") || !strings.Contains(logged, "fixture failure") {
			t.Fatalf("split %d logged %q", split, logged)
		}
	}
}

func TestDiagnosticLogDropsOverlongLine(t *testing.T) {
	var out syncBuffer
	writer := newDiagnosticLog(debugLogger(&out), claudeStderrPrefix)
	_, _ = writer.Write(bytes.Repeat([]byte("Z"), diagnosticLineLimit))
	_, _ = writer.Write([]byte("secret\nnext line\n\n"))
	logged := out.String()
	if strings.Contains(logged, "secret") || strings.Contains(logged, "ZZZZ") {
		t.Fatalf("overlong content logged: %.200q", logged)
	}
	if !strings.Contains(logged, "next line") || !strings.Contains(logged, diagnosticLineDropped) {
		t.Fatalf("log = %q", logged)
	}
	if strings.Count(logged, "level=DEBUG") != 2 {
		t.Fatalf("expected two records: %q", logged)
	}
}

func TestStderrTailKeepsLastBytes(t *testing.T) {
	var forwarded bytes.Buffer
	tail := newErrorTail(&forwarded, 17)
	var all []byte
	for _, part := range []string{"abcd", strings.Repeat("0123456789", 10), "last", "€"} {
		if n, err := tail.Write([]byte(part)); n != len(part) || err != nil {
			t.Fatalf("write = %d, %v", n, err)
		}
		all = append(all, part...)
		want := all
		if len(want) > 17 {
			want = want[len(want)-17:]
		}
		if got, expected := tail.Tail(), strings.ToValidUTF8(string(want), ""); got != expected {
			t.Fatalf("tail = %q, want %q", got, expected)
		}
		if tail.Total() != int64(len(all)) {
			t.Fatalf("total = %d", tail.Total())
		}
	}
	if !bytes.Equal(forwarded.Bytes(), all) {
		t.Fatal("forwarded bytes changed")
	}
	tail.Reset()
	if tail.Tail() != "" || tail.Total() != 0 {
		t.Fatal("reset kept data")
	}
	_, _ = tail.Write([]byte("new"))
	if tail.Tail() != "new" {
		t.Fatalf("tail after reset = %q", tail.Tail())
	}
	if !utf8.ValidString(tail.Tail()) {
		t.Fatal("invalid UTF-8")
	}
}

type shortWriter struct{ n int }

func (w shortWriter) Write([]byte) (int, error) { return w.n, nil }

func TestStderrTailRecordsOnlyAcceptedBytes(t *testing.T) {
	tail := newErrorTail(shortWriter{n: 2}, 8)
	if n, err := tail.Write([]byte("abcd")); n != 2 || !errors.Is(err, io.ErrShortWrite) || tail.Tail() != "ab" {
		t.Fatalf("short write = %d, %v, %q", n, err, tail.Tail())
	}
	tail = newErrorTail(shortWriter{n: 9}, 8)
	if n, err := tail.Write([]byte("abcd")); n != 0 || !errors.Is(err, io.ErrShortWrite) || tail.Total() != 0 {
		t.Fatalf("out-of-range write = %d, %v", n, err)
	}
	if n, err := newErrorTail(nil, 0).Write([]byte("x")); n != 1 || err != nil {
		t.Fatalf("nil inner write = %d, %v", n, err)
	}
}

func TestStderrSuffix(t *testing.T) {
	if got := withStderr("boom", "codex", "  "); got != "boom" {
		t.Fatalf("empty tail = %q", got)
	}
	got := withStderr("boom", "claude", "bad\x07 token sk-"+strings.Repeat("A", 30))
	if !strings.HasPrefix(got, "boom; claude stderr: bad token ") || strings.Contains(got, strings.Repeat("A", 30)) || strings.Contains(got, "\x07") {
		t.Fatalf("suffix = %q", got)
	}
}

// blockingHandler blocks every record until released.
type blockingHandler struct {
	entered chan string
	release chan struct{}
	block   string
}

func (h *blockingHandler) Enabled(context.Context, slog.Level) bool { return true }
func (h *blockingHandler) Handle(_ context.Context, record slog.Record) error {
	if h.block == "" || record.Message == h.block {
		h.entered <- record.Message
		<-h.release
	}
	return nil
}
func (h *blockingHandler) WithAttrs([]slog.Attr) slog.Handler { return h }
func (h *blockingHandler) WithGroup(string) slog.Handler      { return h }

func TestTimingQueueNeverBlocks(t *testing.T) {
	handler := &blockingHandler{entered: make(chan string, 1), release: make(chan struct{})}
	defer close(handler.release)
	queue := newTimingQueue(1)
	logger := slog.New(handler)
	queue.enqueue(logger, time.Now(), "first")
	<-handler.entered
	started := time.Now()
	queue.enqueue(logger, time.Now(), "second")
	queue.enqueue(logger, time.Now(), "third")
	if elapsed := time.Since(started); elapsed > 100*time.Millisecond {
		t.Fatalf("enqueue blocked for %s", elapsed)
	}
	if len(queue.records) != 1 {
		t.Fatalf("queue holds %d records", len(queue.records))
	}
}

type captureHandler struct {
	records chan slog.Record
}

func (h *captureHandler) Enabled(_ context.Context, level slog.Level) bool {
	return level >= slog.LevelInfo
}
func (h *captureHandler) Handle(_ context.Context, record slog.Record) error {
	h.records <- record.Clone()
	return nil
}
func (h *captureHandler) WithAttrs([]slog.Attr) slog.Handler { return h }
func (h *captureHandler) WithGroup(string) slog.Handler      { return h }

func TestTimingRecordShape(t *testing.T) {
	handler := &captureHandler{records: make(chan slog.Record, 1)}
	at := time.UnixMilli(1_700_000_000_123)
	recordTiming(slog.New(handler), at, timingCodexTurnCompleted, "turn_id", "t1")
	select {
	case record := <-handler.records:
		attrs := map[string]any{}
		record.Attrs(func(attr slog.Attr) bool {
			attrs[attr.Key] = attr.Value.Any()
			return true
		})
		if record.Message != timingCodexTurnCompleted || record.Level != slog.LevelInfo || !record.Time.Equal(at) ||
			attrs["received_at_unix_ms"] != int64(1_700_000_000_123) || attrs["turn_id"] != "t1" {
			t.Fatalf("record = %v %v", record, attrs)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("timing record was not delivered")
	}
}

func TestFailureDiagnosticsSanitized(t *testing.T) {
	original := RuntimeFailureDiagnostics{Code: "private text", StatusCode: intPointer(429), Signal: "invalid", ExitCode: intPointer(3)}
	sanitized := original.Sanitized()
	if sanitized == nil || sanitized.Code != "" || sanitized.Signal != "" || *sanitized.StatusCode != 429 || *sanitized.ExitCode != 3 {
		t.Fatalf("sanitized = %+v", sanitized)
	}
	if original.Code != "private text" || original.Signal != "invalid" {
		t.Fatal("receiver mutated")
	}
	*sanitized.StatusCode = 500
	if *original.StatusCode != 429 {
		t.Fatal("sanitized copy shares storage")
	}
	if (RuntimeFailureDiagnostics{StatusCode: intPointer(600), Code: "9bad"}).Sanitized() != nil {
		t.Fatal("nothing valid must give nil")
	}
	if got := (RuntimeFailureDiagnostics{Signal: "SIGSEGV", Code: "api_error"}).Sanitized(); got == nil || got.Signal != "SIGSEGV" || got.Code != "api_error" {
		t.Fatalf("valid fields dropped: %+v", got)
	}
}

func TestCodexErrorDiagnostics(t *testing.T) {
	cases := map[string]RuntimeFailureDiagnostics{
		`"usageLimitExceeded"`:                              {Code: "usageLimitExceeded"},
		`{"httpConnectionFailed":{"httpStatusCode":429}}`:   {Code: "httpConnectionFailed", StatusCode: intPointer(429)},
		`{"httpConnectionFailed":{"httpStatusCode":401}}`:   {Code: "httpConnectionFailed", StatusCode: intPointer(401)},
		`{"httpConnectionFailed":{"httpStatusCode":503}}`:   {Code: "httpConnectionFailed", StatusCode: intPointer(503)},
		`{"responseStreamConnectionFailed":{}}`:             {Code: "responseStreamConnectionFailed"},
		`"unauthorized"`:                                    {Code: "unauthorized"},
		`{"responseStreamFailed":{"httpStatusCode":"503"}}`: {Code: "responseStreamFailed"},
		`{"other":{"httpStatusCode":42.5}}`:                 {Code: "other"},
		`{"a":1,"b":2}`:                                     {},
		`[1]`:                                               {},
		``:                                                  {},
	}
	for raw, want := range cases {
		if got := codexErrorDiagnostics([]byte(raw)); !reflect.DeepEqual(got, want) {
			t.Fatalf("%s = %+v, want %+v", raw, got, want)
		}
	}
}
