//go:build !windows

package localtools

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/mcpproxy"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/process"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider"
)

type browserCloseFixture struct {
	browser      *nativeBrowser
	cancel       context.CancelFunc
	stopCalls    atomic.Int32
	closeCalls   atomic.Int32
	suppressStop atomic.Bool
	flushed      string
	signaled     string
}

func newBrowserCloseFixture(t *testing.T, mode string) *browserCloseFixture {
	t.Helper()
	root := t.TempDir()
	f := &browserCloseFixture{flushed: filepath.Join(root, "flushed"), signaled: filepath.Join(root, "signaled")}
	ctx, cancel := context.WithCancel(context.Background())
	f.cancel = cancel
	cmd := exec.Command("/bin/sh", "-c", `trap 'printf term > "$2"; exit 0' TERM
printf r
while IFS= read -r line; do
 if [ "$line" = close ]; then printf flushed > "$1"; exit 0; fi
done`, "owned-browser", f.flushed, f.signaled)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	b := &nativeBrowser{done: make(chan struct{})}
	f.browser = b
	b.stop = func() {
		f.stopCalls.Add(1)
		if !f.suppressStop.Load() {
			cancel()
		}
	}
	go func() { b.err = process.Run(ctx, cmd, time.Second); close(b.done) }()
	t.Cleanup(func() {
		cancel()
		_ = stdin.Close()
		select {
		case <-b.done:
		case <-time.After(8 * time.Second):
			t.Error("owned fixture process cleanup unconfirmed")
		}
	})
	ready := make(chan error, 1)
	go func() { var marker [1]byte; _, e := io.ReadFull(stdout, marker[:]); ready <- e }()
	select {
	case e := <-ready:
		if e != nil {
			t.Fatal(e)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("owned fixture not ready")
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/devtools/browser/owned" {
			t.Error("shutdown rediscovered or used a different browser path")
			http.NotFound(w, r)
			return
		}
		socket, e := (&websocket.Upgrader{}).Upgrade(w, r, nil)
		if e != nil {
			return
		}
		defer socket.Close()
		var request struct {
			ID     int    `json:"id"`
			Method string `json:"method"`
		}
		if socket.ReadJSON(&request) != nil {
			return
		}
		if request.ID != 1 || request.Method != "Browser.close" {
			t.Errorf("unexpected shutdown request: %+v", request)
			return
		}
		f.closeCalls.Add(1)
		if mode == "eof" {
			return
		}
		_ = socket.WriteJSON(map[string]any{"id": 1, "result": map[string]any{}})
		if mode == "graceful" {
			_, _ = io.WriteString(stdin, "close\n")
		}
		_, _, _ = socket.ReadMessage()
	}))
	t.Cleanup(server.Close)
	b.webSocketEndpoint = "ws" + strings.TrimPrefix(server.URL, "http") + "/devtools/browser/owned"
	return f
}

func TestNativeBrowserCloseFlushesBeforeProcessGroupSignal(t *testing.T) {
	f := newBrowserCloseFixture(t, "graceful")
	if err := f.browser.close(); err != nil {
		t.Fatal(err)
	}
	if data, err := os.ReadFile(f.flushed); err != nil || string(data) != "flushed" {
		t.Fatalf("normal browser exit did not flush: %q %v", data, err)
	}
	if _, err := os.Stat(f.signaled); !errors.Is(err, os.ErrNotExist) || f.stopCalls.Load() != 0 {
		t.Fatal("process-group signal preempted graceful exit")
	}
	if f.closeCalls.Load() != 1 {
		t.Fatal("owned Browser.close was not sent")
	}
	if err := f.browser.close(); err != nil || f.closeCalls.Load() != 1 {
		t.Fatalf("closed browser was contacted again: %v", err)
	}
}

func TestNativeBrowserCloseDoesNotTreatCDPReplyOrEOFAsExit(t *testing.T) {
	for _, mode := range []string{"ack-without-exit", "eof"} {
		t.Run(mode, func(t *testing.T) {
			f := newBrowserCloseFixture(t, mode)
			started := time.Now()
			if err := f.browser.close(); err != nil {
				t.Fatal(err)
			}
			if time.Since(started) > 12*time.Second {
				t.Fatal("browser cleanup exceeded its bounded fallback")
			}
			if f.stopCalls.Load() != 1 || f.closeCalls.Load() != 1 {
				t.Fatal("missing original process-tree fallback")
			}
			if _, err := os.Stat(f.signaled); err != nil {
				t.Fatal("fixture did not observe its termination signal")
			}
			if _, err := os.Stat(f.flushed); !errors.Is(err, os.ErrNotExist) {
				t.Fatal("a non-exiting CDP peer was treated as a graceful browser exit")
			}
			select {
			case <-f.browser.done:
			default:
				t.Fatal("process-tree exit was not confirmed")
			}
		})
	}
}

func TestNativeBrowserReadinessFailureRetainsUnknownProcess(t *testing.T) {
	f := newBrowserCloseFixture(t, "ack-without-exit")
	f.suppressStop.Store(true)
	m := &Manager{browsers: map[string]*nativeBrowser{}}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	started := time.Now()
	owner, err := m.awaitNativeBrowser(ctx, "fixture", f.browser, filepath.Join(t.TempDir(), "missing-port-file"))
	if !errors.Is(err, mcpproxy.ErrCleanupUnconfirmed) || owner != f.browser || m.browsers["fixture"] != f.browser {
		t.Fatalf("startup dropped unknown browser ownership: %v", err)
	}
	if time.Since(started) > 12*time.Second {
		t.Fatal("unknown startup cleanup exceeded its bounded return")
	}
	select {
	case <-f.browser.done:
		t.Fatal("test requires an actually live, unconfirmed process")
	default:
	}
	// The injected stop failure leaves a real owned process alive. Only its
	// original controller may now confirm cleanup; do not replace the owner.
	f.cancel()
	select {
	case <-f.browser.done:
	case <-time.After(8 * time.Second):
		t.Fatal("original process did not exit")
	}
	if err := owner.close(); err != nil {
		t.Fatalf("late original-owner cleanup failed: %v", err)
	}
}

func TestNativeBrowserFailedTreeReceiptKeepsActionBlocked(t *testing.T) {
	f := newBrowserCloseFixture(t, "graceful")
	if err := f.browser.close(); err != nil {
		t.Fatal(err)
	}
	// The real child has exited. Inject a failed whole-tree receipt to prove
	// that a closed done channel alone never authorizes another browser action.
	f.browser.err = errors.New("whole-tree cleanup not confirmed")
	journal, err := openJournal(filepath.Join(t.TempDir(), "action.json"))
	if err != nil {
		t.Fatal(err)
	}
	m := &Manager{journal: journal, browsers: map[string]*nativeBrowser{"fixture": f.browser}, operations: map[*operation]bool{}}
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	op := &operation{manager: m, spec: provider.OperationSpec{AgentID: "fixture"}, identity: mcpproxy.OperationIdentity{OperationID: "next-action"}, ctx: ctx, cancel: cancel}
	op.label = "fixture"
	if _, err := op.nativeBrowserCall(ctx, "browser_snapshot", json.RawMessage(`{}`)); !errors.Is(err, mcpproxy.ErrCleanupUnconfirmed) {
		t.Fatalf("failed whole-tree receipt was accepted: %v", err)
	}
	if op.nativeBrowser != f.browser || m.browsers["fixture"] != f.browser || !laneBlocked(t, m, browserLane("fixture")) || journal.blocked() {
		t.Fatal("unknown owner or action fence was lost")
	}
	if f.closeCalls.Load() != 1 {
		t.Fatal("a new browser action escaped the unknown cleanup fence")
	}
}
