package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/localtools"
)

type fakeStatusSource struct {
	mu     sync.Mutex
	state  string
	active int
}

func (f *fakeStatusSource) GatewayState() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.state
}

func (f *fakeStatusSource) ActiveOperationCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.active
}

func (f *fakeStatusSource) set(state string, active int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.state, f.active = state, active
}

func TestDesktopChannelShutsDownOnStdinEOF(t *testing.T) {
	reader, writer := io.Pipe()
	channel := newDesktopChannel(io.Discard)
	done := make(chan struct{})
	go channel.read(reader, func() { close(done) })
	if _, err := writer.Write([]byte(`{"type":"hello","features":["permissions.v1"]}` + "\nnot json\n")); err != nil {
		t.Fatal(err)
	}
	select {
	case <-done:
		t.Fatal("shutdown before stdin closed")
	case <-time.After(20 * time.Millisecond):
	}
	_ = writer.Close()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("shutdown did not follow stdin EOF")
	}
	if _, err := channel.LingerPermissions(t.Context(), "status", ""); !errors.Is(err, localtools.ErrLingerBridgeUnavailable) {
		t.Fatalf("a closed channel accepted a request: %v", err)
	}
}

func TestReportDesktopStatusWritesChangesOnly(t *testing.T) {
	source := &fakeStatusSource{state: "connecting"}
	reader, writer := io.Pipe()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	channel := newDesktopChannel(writer)
	go func() {
		reportDesktopStatus(ctx, channel.encode, source, 5*time.Millisecond)
		_ = writer.Close()
	}()
	lines := bufio.NewScanner(reader)
	next := func() desktopStatus {
		t.Helper()
		if !lines.Scan() {
			t.Fatal("status stream ended")
		}
		var status desktopStatus
		if err := json.Unmarshal(lines.Bytes(), &status); err != nil {
			t.Fatalf("line %q: %v", lines.Text(), err)
		}
		return status
	}
	if got := next(); got != (desktopStatus{Type: "status", GatewayState: "connecting"}) {
		t.Fatalf("first = %+v", got)
	}
	source.set("connected", 0)
	if got := next(); got.GatewayState != "connected" || got.ActiveOperations != 0 {
		t.Fatalf("second = %+v", got)
	}
	source.set("connected", 2)
	if got := next(); got.ActiveOperations != 2 {
		t.Fatalf("third = %+v", got)
	}
	cancel()
	if lines.Scan() {
		t.Fatalf("unchanged state was repeated: %q", lines.Text())
	}
}

// fakeDesktop plays the Desktop app on the other end of the stdio pipes.
type fakeDesktop struct {
	channel *desktopChannel
	stdin   *io.PipeWriter
	lines   chan map[string]any
	done    chan struct{}
}

func startFakeDesktop(t *testing.T, timeout time.Duration) *fakeDesktop {
	t.Helper()
	stdinReader, stdinWriter := io.Pipe()
	stdoutReader, stdoutWriter := io.Pipe()
	desktop := &fakeDesktop{channel: newDesktopChannel(stdoutWriter), stdin: stdinWriter, lines: make(chan map[string]any, 64), done: make(chan struct{})}
	desktop.channel.timeout = timeout
	go desktop.channel.read(stdinReader, func() { close(desktop.done) })
	go func() {
		scanner := bufio.NewScanner(stdoutReader)
		for scanner.Scan() {
			var line map[string]any
			if err := json.Unmarshal(scanner.Bytes(), &line); err != nil {
				t.Errorf("stdout line %q is not one JSON object: %v", scanner.Text(), err)
				continue
			}
			desktop.lines <- line
		}
	}()
	t.Cleanup(func() {
		_ = stdinWriter.Close()
		_ = stdoutWriter.Close()
	})
	return desktop
}

func (f *fakeDesktop) send(t *testing.T, line string) {
	t.Helper()
	if _, err := f.stdin.Write([]byte(line + "\n")); err != nil {
		t.Fatal(err)
	}
}

// request returns the next permission request, skipping status lines.
func (f *fakeDesktop) request(t *testing.T) map[string]any {
	t.Helper()
	for {
		select {
		case line := <-f.lines:
			if line["type"] == "permission.request" {
				return line
			}
		case <-time.After(5 * time.Second):
			t.Fatal("no permission request")
		}
	}
}

func TestDesktopChannelWithoutHelloReportsUnavailable(t *testing.T) {
	desktop := startFakeDesktop(t, time.Second)
	if _, err := desktop.channel.LingerPermissions(t.Context(), "status", ""); !errors.Is(err, localtools.ErrLingerBridgeUnavailable) {
		t.Fatalf("err = %v", err)
	}
	desktop.send(t, `{"type":"hello","features":["other"]}`)
	time.Sleep(20 * time.Millisecond)
	if _, err := desktop.channel.LingerPermissions(t.Context(), "status", ""); !errors.Is(err, localtools.ErrLingerBridgeUnavailable) {
		t.Fatalf("a hello without permissions.v1 enabled requests: %v", err)
	}
	// The permission service then reports the app's permissions as unknown.
	service := localtools.NewComputerPermissions(localtools.ComputerPermissionOptions{Platform: "darwin", Desktop: true, Linger: desktop.channel})
	status, err := service.ComputerPermission(t.Context(), "status", "", "")
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range status.Subjects[0].Permissions {
		if item.State != "unknown" || item.Prompt != "settings_only" {
			t.Fatalf("linger = %+v", status.Subjects[0])
		}
	}
}

func TestDesktopChannelRoundTripsRequestsBesideStatusLines(t *testing.T) {
	desktop := startFakeDesktop(t, 5*time.Second)
	desktop.send(t, `{"type":"hello","features":["permissions.v1"]}`)
	time.Sleep(20 * time.Millisecond)
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	source := &fakeStatusSource{state: "connecting"}
	go reportDesktopStatus(ctx, desktop.channel.encode, source, time.Millisecond)
	go func() {
		for i := 0; ctx.Err() == nil; i++ {
			source.set("connecting", i)
			time.Sleep(time.Millisecond)
		}
	}()

	type answer struct {
		permissions []localtools.LingerPermission
		err         error
	}
	answers := make(chan answer, 2)
	go func() {
		permissions, err := desktop.channel.LingerPermissions(ctx, "prompt", "screen_recording")
		answers <- answer{permissions, err}
	}()
	first := desktop.request(t)
	if first["op"] != "prompt" || first["permission"] != "screen_recording" || first["id"] == "" {
		t.Fatalf("request = %v", first)
	}
	go func() {
		permissions, err := desktop.channel.LingerPermissions(ctx, "status", "")
		answers <- answer{permissions, err}
	}()
	second := desktop.request(t)
	if _, ok := second["permission"]; ok || second["op"] != "status" {
		t.Fatalf("status request = %v", second)
	}
	// Answers arrive out of order; each reaches its own request.
	desktop.send(t, `{"type":"permission.response","id":"`+second["id"].(string)+`","ok":false,"error":"busy"}`)
	desktop.send(t, `{"type":"permission.response","id":"unknown","ok":true,"permissions":[]}`)
	desktop.send(t, `{"type":"permission.response","id":"`+first["id"].(string)+`","ok":true,"permissions":[{"id":"screen_recording","state":"denied","relaunch_required":true},{"id":"accessibility","state":"granted","relaunch_required":false}]}`)
	var refused *localtools.LingerBridgeError
	for range 2 {
		got := <-answers
		switch {
		case errors.As(got.err, &refused):
			if refused.Code != "busy" {
				t.Fatalf("refusal = %+v", refused)
			}
		case got.err != nil:
			t.Fatal(got.err)
		case len(got.permissions) != 2 || got.permissions[0] != (localtools.LingerPermission{ID: "screen_recording", State: "denied", RelaunchRequired: true}):
			t.Fatalf("permissions = %+v", got.permissions)
		}
	}
	if refused == nil {
		t.Fatal("the refusal did not reach its request")
	}
}

func TestDesktopChannelRequestTimesOut(t *testing.T) {
	desktop := startFakeDesktop(t, 30*time.Millisecond)
	desktop.send(t, `{"type":"hello","features":["permissions.v1"]}`)
	time.Sleep(20 * time.Millisecond)
	result := make(chan error, 1)
	go func() {
		_, err := desktop.channel.LingerPermissions(t.Context(), "status", "")
		result <- err
	}()
	request := desktop.request(t)
	if err := <-result; !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("err = %v", err)
	}
	// A late answer finds no waiter and changes nothing.
	desktop.send(t, `{"type":"permission.response","id":"`+request["id"].(string)+`","ok":true,"permissions":[]}`)
	desktop.channel.mu.Lock()
	pending := len(desktop.channel.pending)
	desktop.channel.mu.Unlock()
	if pending != 0 {
		t.Fatalf("pending = %d", pending)
	}

	ctx, cancel := context.WithCancel(t.Context())
	go func() {
		_, err := desktop.channel.LingerPermissions(ctx, "status", "")
		result <- err
	}()
	desktop.request(t)
	cancel()
	if err := <-result; !errors.Is(err, context.Canceled) {
		t.Fatalf("a canceled request kept waiting: %v", err)
	}
}

func TestDesktopChannelFailsPendingRequestsAtEOF(t *testing.T) {
	desktop := startFakeDesktop(t, 5*time.Second)
	desktop.send(t, `{"type":"hello","features":["permissions.v1"]}`)
	time.Sleep(20 * time.Millisecond)
	result := make(chan error, 1)
	go func() {
		_, err := desktop.channel.LingerPermissions(t.Context(), "relaunch", "")
		result <- err
	}()
	desktop.request(t)
	_ = desktop.stdin.Close()
	select {
	case err := <-result:
		if err == nil || !strings.Contains(err.Error(), "closed") {
			t.Fatalf("err = %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("the request outlived stdin")
	}
	<-desktop.done
}
