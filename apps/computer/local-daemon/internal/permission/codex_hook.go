package permission

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

// CodexHookTimeout is Codex's limit for one PermissionRequest hook. It stays above
// the Reviewer's own deadline, so a slow review answers unavailable before
// Codex abandons the hook.
const CodexHookTimeout = 90 * time.Second

// maxHookEventBytes bounds one hook request; a patch is the largest input.
const maxHookEventBytes = 4 << 20

// CodexHandler judges one PermissionRequest of a registered Codex thread.
type CodexHandler func(ctx context.Context, event CodexHookEvent) Verdict

// CodexEndpoint receives the PermissionRequest hooks of every Codex thread this
// Daemon runs. A resident app-server keeps a thread, and the hook command
// configured for it, across Operations, so hooks reach one Daemon-wide
// address and are routed by thread to the Operation running it now.
type CodexEndpoint struct {
	url      string
	mu       sync.Mutex
	handlers map[string]*registration
}

type registration struct{ handler CodexHandler }

var (
	sharedOnce     sync.Once
	sharedEndpoint *CodexEndpoint
	sharedErr      error
)

// CodexSharedEndpoint starts the Daemon's endpoint on first use: loopback only, on
// a random port, under a random path that only the hook command knows.
func CodexSharedEndpoint() (*CodexEndpoint, error) {
	sharedOnce.Do(func() { sharedEndpoint, sharedErr = newEndpoint() })
	return sharedEndpoint, sharedErr
}

func newEndpoint() (*CodexEndpoint, error) {
	var secret [24]byte
	if _, err := rand.Read(secret[:]); err != nil {
		return nil, err
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	path := "/permission-request/" + hex.EncodeToString(secret[:])
	endpoint := &CodexEndpoint{url: "http://" + listener.Addr().String() + path, handlers: map[string]*registration{}}
	mux := http.NewServeMux()
	mux.HandleFunc("POST "+path, endpoint.serve)
	server := &http.Server{Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	go func() { _ = server.Serve(listener) }()
	return endpoint, nil
}

// HooksConfig is the Codex `hooks` configuration that sends every
// PermissionRequest to this endpoint through the Daemon's own executable in
// permission-hook mode. Codex runs a Windows hook under `powershell -Command`,
// where a quoted path needs the call operator to run as a command.
func (e *CodexEndpoint) HooksConfig(daemonExecutable string) map[string]any {
	return map[string]any{"PermissionRequest": []any{map[string]any{"hooks": []any{map[string]any{
		"type":           "command",
		"command":        shellQuote(daemonExecutable) + " permission-hook " + shellQuote(e.url),
		"commandWindows": "& " + powerShellQuote(daemonExecutable) + " permission-hook " + powerShellQuote(e.url),
		"timeout":        int(CodexHookTimeout / time.Second),
	}}}}}
}

// Register routes a thread's hooks to handler until the returned function
// runs. A later registration for the same thread replaces it.
func (e *CodexEndpoint) Register(threadID string, handler CodexHandler) func() {
	entry := &registration{handler: handler}
	e.mu.Lock()
	e.handlers[threadID] = entry
	e.mu.Unlock()
	return func() {
		e.mu.Lock()
		if e.handlers[threadID] == entry {
			delete(e.handlers, threadID)
		}
		e.mu.Unlock()
	}
}

func (e *CodexEndpoint) serve(w http.ResponseWriter, r *http.Request) {
	var event CodexHookEvent
	if err := json.NewDecoder(io.LimitReader(r.Body, maxHookEventBytes)).Decode(&event); err != nil || event.SessionID == "" {
		http.Error(w, "invalid PermissionRequest hook input", http.StatusBadRequest)
		return
	}
	e.mu.Lock()
	entry := e.handlers[event.SessionID]
	e.mu.Unlock()
	verdict := Verdict{Decision: Unavailable, Message: UnavailableMessage}
	if entry != nil {
		// The request context ends when Codex abandons the hook.
		verdict = entry.handler(r.Context(), event)
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = io.WriteString(w, CodexHookOutput(verdict))
}

// CodexRunHook is the permission-hook command: it forwards the hook input on stdin
// to the Daemon and prints the answer. Any failure exits 2 with the reason on
// stderr, which Codex treats as a denial with that message.
func CodexRunHook(stdin io.Reader, stdout, stderr io.Writer, endpointURL string) int {
	fail := func(reason string) int {
		_, _ = fmt.Fprintln(stderr, UnavailableMessage+" ("+reason+")")
		return 2
	}
	if !strings.HasPrefix(endpointURL, "http://127.0.0.1:") {
		return fail("invalid endpoint")
	}
	input, err := io.ReadAll(io.LimitReader(stdin, maxHookEventBytes+1))
	if err != nil || len(input) > maxHookEventBytes {
		return fail("invalid input")
	}
	ctx, cancel := context.WithTimeout(context.Background(), CodexHookTimeout-5*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpointURL, bytes.NewReader(input))
	if err != nil {
		return fail("invalid endpoint")
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return fail("daemon unreachable")
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil || response.StatusCode != http.StatusOK {
		return fail(fmt.Sprintf("daemon status %d", response.StatusCode))
	}
	_, _ = stdout.Write(body)
	return 0
}

func shellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", `'\''`) + "'"
}

func powerShellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "''") + "'"
}
