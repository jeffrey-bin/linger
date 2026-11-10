package daemon

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/transport"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/protocol"
)

type recordingSelfUpdater struct {
	mu        sync.Mutex
	welcomes  []*protocol.TargetRelease
	rejection []error
	failures  []transport.ConnectionFailure
	// events orders connection starts and failures as "start" and "failed".
	events []string
}

func (r *recordingSelfUpdater) ConnectionStarted() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.events = append(r.events, "start")
}

func (r *recordingSelfUpdater) WelcomeAccepted(_ context.Context, target *protocol.TargetRelease) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.welcomes = append(r.welcomes, target)
}

func (r *recordingSelfUpdater) ConnectionFailed(err error, failure transport.ConnectionFailure) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.rejection = append(r.rejection, err)
	r.failures = append(r.failures, failure)
	r.events = append(r.events, "failed")
}

func (r *recordingSelfUpdater) snapshot() ([]*protocol.TargetRelease, []error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]*protocol.TargetRelease(nil), r.welcomes...), append([]error(nil), r.rejection...)
}

func TestDaemonForwardsWelcomeTargetToSelfUpdater(t *testing.T) {
	device, err := transport.GenerateIdentity()
	if err != nil {
		t.Fatal(err)
	}
	release := &protocol.TargetRelease{Targets: map[string]protocol.TargetReleaseFiles{
		"linux-x64": {App: protocol.ReleaseFile{SHA256: strings.Repeat("a", 64), Size: 10}, Deps: protocol.ReleaseFile{SHA256: strings.Repeat("d", 64), Size: 20}},
	}}
	stream := &fakeStream{commands: []protocol.Command{{
		Type: "runner.welcome", ConnectionEpoch: 1, TargetRelease: release,
	}}}
	updater := &recordingSelfUpdater{}
	daemon, err := newTestDaemon(t, Options{
		ComputerID: "computer-1", ControlPlane: fakeControlPlane{stream: stream},
		IdentityStore: fakeStore{value: device}, OperationResolver: fakeOperationResolver{},
		RetryDelay: func(int) time.Duration { return 0 },
	})
	if err != nil {
		t.Fatal(err)
	}
	daemon.SetSelfUpdater(updater)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- daemon.Run(ctx) }()
	waitForSelfUpdate(t, func() bool {
		welcomes, _ := updater.snapshot()
		return len(welcomes) > 0
	})
	cancel()
	<-done
	if welcomes, _ := updater.snapshot(); welcomes[0] != release {
		t.Fatalf("welcome target = %+v, want %+v", welcomes[0], release)
	}
}

func TestDaemonReportsProtocolRejectionBeforeWelcome(t *testing.T) {
	device, err := transport.GenerateIdentity()
	if err != nil {
		t.Fatal(err)
	}
	stream := &fakeStream{receiveErr: &transport.UpgradeRequiredError{Reason: "upgrade_required: protocol"}}
	updater := &recordingSelfUpdater{}
	daemon, err := newTestDaemon(t, Options{
		ComputerID: "computer-1", ControlPlane: fakeControlPlane{stream: stream},
		IdentityStore: fakeStore{value: device}, OperationResolver: fakeOperationResolver{},
		RetryDelay: func(int) time.Duration { return 0 },
	})
	if err != nil {
		t.Fatal(err)
	}
	daemon.SetSelfUpdater(updater)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- daemon.Run(ctx) }()
	waitForGatewayState(t, daemon, "upgrade-required")
	cancel()
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatalf("Run() error = %v, want context cancellation", err)
	}
	if _, rejections := updater.snapshot(); len(rejections) != 1 {
		t.Fatalf("rejections = %d, want 1", len(rejections))
	}
	if updater.failures[0] != transport.FailureIncompatible {
		t.Fatalf("failure = %v, want incompatible", updater.failures[0])
	}
}

func TestDaemonReportsCredentialCloseAsGatewayUnavailable(t *testing.T) {
	device, err := transport.GenerateIdentity()
	if err != nil {
		t.Fatal(err)
	}
	stream := &fakeStream{receiveErr: &websocket.CloseError{Code: websocket.ClosePolicyViolation, Text: "Runner credential revoked"}}
	updater := &recordingSelfUpdater{}
	daemon, err := newTestDaemon(t, Options{
		ComputerID: "computer-1", ControlPlane: fakeControlPlane{stream: stream},
		IdentityStore: fakeStore{value: device}, OperationResolver: fakeOperationResolver{},
		RetryDelay: func(int) time.Duration { return time.Hour },
	})
	if err != nil {
		t.Fatal(err)
	}
	daemon.SetSelfUpdater(updater)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- daemon.Run(ctx) }()
	waitForSelfUpdate(t, func() bool {
		_, rejections := updater.snapshot()
		return len(rejections) > 0
	})
	cancel()
	<-done
	updater.mu.Lock()
	defer updater.mu.Unlock()
	if updater.failures[0] != transport.FailureUnavailable {
		t.Fatalf("failure = %v, want unavailable", updater.failures[0])
	}
}

// A pending upgrade must not keep crediting an earlier Gateway outage while a
// later connection attempt hangs, so every attempt is reported when it starts.
func TestDaemonReportsEachConnectionStartBeforeItsFailure(t *testing.T) {
	device, err := transport.GenerateIdentity()
	if err != nil {
		t.Fatal(err)
	}
	stream := &fakeStream{receiveErr: &websocket.CloseError{Code: websocket.CloseAbnormalClosure}}
	updater := &recordingSelfUpdater{}
	daemon, err := newTestDaemon(t, Options{
		ComputerID: "computer-1", ControlPlane: fakeControlPlane{stream: stream},
		IdentityStore: fakeStore{value: device}, OperationResolver: fakeOperationResolver{},
		RetryDelay: func(int) time.Duration { return time.Millisecond },
	})
	if err != nil {
		t.Fatal(err)
	}
	daemon.SetSelfUpdater(updater)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- daemon.Run(ctx) }()
	waitForSelfUpdate(t, func() bool {
		_, rejections := updater.snapshot()
		return len(rejections) >= 2
	})
	cancel()
	<-done
	updater.mu.Lock()
	defer updater.mu.Unlock()
	if len(updater.events) < 4 || updater.events[0] != "start" || updater.events[1] != "failed" ||
		updater.events[2] != "start" || updater.events[3] != "failed" {
		t.Fatalf("events = %v, want each attempt reported as start then failed", updater.events)
	}
}

func TestResumeAdmissionReopensOnlyBeforeShutdown(t *testing.T) {
	device, err := transport.GenerateIdentity()
	if err != nil {
		t.Fatal(err)
	}
	daemon, err := newTestDaemon(t, Options{
		ComputerID: "computer-1", ControlPlane: fakeControlPlane{stream: &fakeStream{}},
		IdentityStore: fakeStore{value: device}, OperationResolver: fakeOperationResolver{},
	})
	if err != nil {
		t.Fatal(err)
	}
	if got := daemon.DrainIfIdle(); got != 0 {
		t.Fatalf("DrainIfIdle() = %d, want 0", got)
	}
	daemon.ResumeAdmission()
	if daemon.draining {
		t.Fatal("ResumeAdmission should reopen admissions")
	}
	daemon.DrainIfIdle()
	daemon.Drain()
	daemon.ResumeAdmission()
	if !daemon.draining {
		t.Fatal("ResumeAdmission must not reopen admissions after shutdown started")
	}
}

func waitForSelfUpdate(t *testing.T, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !condition() {
		if time.Now().After(deadline) {
			t.Fatal("self-update condition was not reached")
		}
		time.Sleep(time.Millisecond)
	}
}
