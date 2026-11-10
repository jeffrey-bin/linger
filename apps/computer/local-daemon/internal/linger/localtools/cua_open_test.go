package localtools

import (
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/mcpproxy"
)

// fakeCuaClient is an mcpClient whose child already exited. Its close result
// is fixed by cleanupErr, so no real Cua process is needed.
func fakeCuaClient(cleanupErr error) *mcpClient {
	exited := make(chan struct{})
	close(exited)
	_, writer := io.Pipe()
	return &mcpClient{stdin: writer, stop: func() {}, exited: exited, err: cleanupErr}
}

// fakeCuaOpen returns a session for every open. Like startClient, a cancelled
// context fails the open after the client has started.
func fakeCuaOpen(opens *atomic.Int32, cleanupErr error) func(context.Context, *operation) (*cuaSession, []tool, error) {
	return func(ctx context.Context, op *operation) (*cuaSession, []tool, error) {
		opens.Add(1)
		session := &cuaSession{op: op, client: fakeCuaClient(cleanupErr), label: "test"}
		if err := ctx.Err(); err != nil {
			return session, nil, err
		}
		return session, nil, nil
	}
}

func newCuaTestOperation(t *testing.T, open func(context.Context, *operation) (*cuaSession, []tool, error)) *operation {
	t.Helper()
	m := &Manager{operations: map[*operation]bool{}, openCuaSession: open}
	return &operation{manager: m, directory: t.TempDir(), cancel: func() {}}
}

func TestEnsureCuaConcurrentFirstCallsOpenOnce(t *testing.T) {
	var opens atomic.Int32
	release := make(chan struct{})
	open := fakeCuaOpen(&opens, nil)
	op := newCuaTestOperation(t, func(ctx context.Context, op *operation) (*cuaSession, []tool, error) {
		<-release
		return open(ctx, op)
	})
	const callers = 8
	sessions := make([]*cuaSession, callers)
	errs := make([]error, callers)
	var wg sync.WaitGroup
	for i := range callers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			sessions[i], errs[i] = op.ensureCua(context.Background())
		}()
	}
	close(release)
	wg.Wait()
	if got := opens.Load(); got != 1 {
		t.Fatalf("opens = %d, want 1", got)
	}
	for i := range callers {
		if errs[i] != nil || sessions[i] != sessions[0] {
			t.Fatalf("caller %d: session %p err %v, want shared session %p", i, sessions[i], errs[i], sessions[0])
		}
	}
	if err := op.close(); err != nil {
		t.Fatalf("close: %v", err)
	}
}

func TestEnsureCuaRetriesAfterFailedOpenWithCleanClose(t *testing.T) {
	var opens atomic.Int32
	openErr := errors.New("tools/list failed")
	op := newCuaTestOperation(t, func(ctx context.Context, op *operation) (*cuaSession, []tool, error) {
		if opens.Add(1) == 1 {
			return &cuaSession{op: op, client: fakeCuaClient(nil), label: "first"}, nil, openErr
		}
		return &cuaSession{op: op, client: fakeCuaClient(nil), label: "second"}, nil, nil
	})
	if _, err := op.ensureCua(context.Background()); !errors.Is(err, openErr) {
		t.Fatalf("first ensureCua err = %v, want %v", err, openErr)
	}
	if op.cua != nil {
		t.Fatal("a cleanly closed failed open must not be cached")
	}
	session, err := op.ensureCua(context.Background())
	if err != nil {
		t.Fatalf("retry ensureCua: %v", err)
	}
	if session.label != "second" || opens.Load() != 2 {
		t.Fatalf("retry session %q after %d opens, want second after 2", session.label, opens.Load())
	}
	if err := op.close(); err != nil {
		t.Fatalf("close: %v", err)
	}
}

func TestEnsureCuaCancelledFirstCallDoesNotPoisonLaterCalls(t *testing.T) {
	var opens atomic.Int32
	op := newCuaTestOperation(t, fakeCuaOpen(&opens, nil))
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := op.ensureCua(cancelled); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled ensureCua err = %v, want context.Canceled", err)
	}
	session, err := op.ensureCua(context.Background())
	if err != nil || session == nil {
		t.Fatalf("later ensureCua session %v err %v, want a started session", session, err)
	}
	if opens.Load() != 2 {
		t.Fatalf("opens = %d, want 2", opens.Load())
	}
	if err := op.close(); err != nil {
		t.Fatalf("close: %v", err)
	}
}

func TestEnsureCuaUnconfirmedFailedCleanupKeepsSessionForClose(t *testing.T) {
	var opens atomic.Int32
	openErr := errors.New("initialize failed")
	cleanupErr := errors.New("child still active")
	op := newCuaTestOperation(t, func(ctx context.Context, op *operation) (*cuaSession, []tool, error) {
		opens.Add(1)
		return &cuaSession{op: op, client: fakeCuaClient(cleanupErr), label: "stuck"}, nil, openErr
	})
	_, err := op.ensureCua(context.Background())
	if !errors.Is(err, openErr) || !errors.Is(err, cleanupErr) {
		t.Fatalf("ensureCua err = %v, want the open and cleanup errors", err)
	}
	if op.cua == nil || op.cua.label != "stuck" {
		t.Fatal("unconfirmed cleanup must retain the session for op.close")
	}
	if _, err := op.ensureCua(context.Background()); err == nil {
		t.Fatal("ensureCua after unconfirmed cleanup must fail")
	}
	if opens.Load() != 1 {
		t.Fatalf("opens = %d, want no second client", opens.Load())
	}
	if err := op.close(); !errors.Is(err, mcpproxy.ErrCleanupUnconfirmed) {
		t.Fatalf("close err = %v, want ErrCleanupUnconfirmed", err)
	}
}

func TestEnsureCuaReopensAfterTheServiceExits(t *testing.T) {
	exited := exec.Command("/bin/sh", "-c", "exit 0")
	if err := exited.Run(); err != nil {
		t.Skip(err)
	}
	var opens atomic.Int32
	op := newCuaTestOperation(t, fakeCuaOpen(&opens, nil))
	first, err := op.ensureCua(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	close(done)
	first.client.done = done
	// A live service keeps the session: its call may still be running.
	first.servicePID = os.Getpid()
	if first.driverStopped() {
		t.Fatal("a live service was treated as stopped")
	}
	first.servicePID = exited.Process.Pid
	if !first.driverStopped() || !first.retired() {
		t.Fatal("an exited service did not retire the session")
	}
	second, err := op.ensureCua(context.Background())
	if err != nil || second == first || opens.Load() != 2 {
		t.Fatalf("second open: session %p err %v opens %d", second, err, opens.Load())
	}
}
