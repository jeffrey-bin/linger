package computercli

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

type syncBuilder struct {
	mu      sync.Mutex
	builder strings.Builder
}

func (b *syncBuilder) Write(data []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.builder.Write(data)
}

func (b *syncBuilder) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.builder.String()
}

func TestDaemonLogRotatesUnlessADaemonHoldsTheLease(t *testing.T) {
	state := t.TempDir()
	logPath := filepath.Join(state, "daemon.log")
	writeFile(t, logPath, "previous run\n")
	if err := os.Mkdir(filepath.Join(state, "daemon.lock"), 0o700); err != nil {
		t.Fatal(err)
	}
	rotateDaemonLog(state)
	if _, err := os.Stat(logPath); err != nil {
		t.Fatal("a running Daemon's log was rotated")
	}
	if err := os.Remove(filepath.Join(state, "daemon.lock")); err != nil {
		t.Fatal(err)
	}
	rotateDaemonLog(state)
	if data, err := os.ReadFile(logPath + ".1"); err != nil || string(data) != "previous run\n" {
		t.Fatalf("rotated=%q err=%v", data, err)
	}
}

type statusClient struct {
	fakeClient
	statuses []object
	errs     []error
}

func (c *statusClient) Status(context.Context) (object, error) {
	if len(c.errs) > 0 {
		err := c.errs[0]
		c.errs = c.errs[1:]
		return nil, err
	}
	status := c.statuses[0]
	if len(c.statuses) > 1 {
		c.statuses = c.statuses[1:]
	}
	return status, nil
}

func TestStartWaitsForThisLaunchNonce(t *testing.T) {
	client := &statusClient{errs: []error{errControlRefused, errControlRefused}, statuses: []object{object{}.with("launch_nonce", "nonce-1")}}
	if err := waitUntilReachableOrExit(context.Background(), client, "nonce-1", make(chan string), time.Second, "linger-computer"); err != nil {
		t.Fatal(err)
	}
	other := &statusClient{statuses: []object{object{}.with("launch_nonce", "other")}}
	if err := waitUntilReachableOrExit(context.Background(), other, "nonce-1", make(chan string), time.Second, "linger-computer"); !errors.Is(err, errExistingDaemon) {
		t.Fatalf("existing daemon err=%v", err)
	}
	exited := make(chan string, 1)
	exited <- "1"
	unreachable := &statusClient{errs: []error{errControlRefused}}
	if err := waitUntilReachableOrExit(context.Background(), unreachable, "nonce-1", exited, time.Second, "linger-computer"); err == nil || err.Error() != "Computer daemon exited before becoming ready (1)" {
		t.Fatalf("early exit err=%v", err)
	}
	never := &statusClient{errs: []error{errControlRefused, errControlRefused, errControlRefused, errControlRefused}}
	err := waitUntilReachableOrExit(context.Background(), never, "nonce-1", make(chan string), 60*time.Millisecond, "linger-computer-dev")
	if failure := asCLIError(err); failure.category != categoryDaemonLifecycle || failure.message != "Computer daemon did not become ready; inspect linger-computer-dev daemon logs" {
		t.Fatalf("timeout err=%v", err)
	}
}

func TestWaitUntilDaemonStopsNeedsControlAndProcessGone(t *testing.T) {
	client := &statusClient{errs: []error{errControlRefused}}
	if err := waitUntilDaemonStops(context.Background(), client, 1<<30); err != nil {
		t.Fatal(err)
	}
}

func TestDaemonExecutableRequiresAnAbsoluteDevelopmentPath(t *testing.T) {
	if _, err := daemonExecutable(map[string]string{"LINGER_GO_LOCAL_DAEMON_PATH": "relative/daemon"}); err == nil {
		t.Fatal("relative daemon path accepted")
	}
	explicit := filepath.Join(t.TempDir(), "daemon")
	if got, err := daemonExecutable(map[string]string{"LINGER_GO_LOCAL_DAEMON_PATH": explicit}); err != nil || got != explicit {
		t.Fatalf("daemon=%q err=%v", got, err)
	}
	if _, err := daemonExecutable(map[string]string{}); err == nil || err.Error() != "LINGER_GO_LOCAL_DAEMON_PATH is required for source development" {
		t.Fatalf("source run err=%v", err)
	}
}

func TestInstalledServiceCommandBindsTheStableLauncher(t *testing.T) {
	root := t.TempDir()
	bundle := "lib-0123456789abcdef-1"
	executable := filepath.Join(root, bundle, "cli", "linger-computer.exe")
	if err := os.MkdirAll(filepath.Dir(executable), 0o700); err != nil {
		t.Fatal(err)
	}
	writeFile(t, executable, "binary")
	writeFile(t, filepath.Join(root, "active-bundle"), bundle+"\n")
	launchers := filepath.Join(t.TempDir(), "bin")
	if err := os.Mkdir(launchers, 0o700); err != nil {
		t.Fatal(err)
	}
	launcher := filepath.Join(launchers, "linger-computer-dev.exe")
	writeFile(t, launcher, "MZ linger-native-cli-launcher-v1")
	writeFile(t, filepath.Join(launchers, "linger-computer-dev.launcher.json"), `{"schemaVersion":1,"dataRoot":`+quote(root)+`}`)
	resolved, _ := filepath.EvalSymlinks(executable)
	got, err := boundLauncher(resolved, "/data/config.json", root, launcher)
	if err != nil || strings.Join(got, " ") != launcher+" --config /data/config.json" {
		t.Fatalf("command=%v err=%v", got, err)
	}
	if got, _ := boundLauncher("/elsewhere/linger-computer.exe", "/data/config.json", root, launcher); got != nil {
		t.Fatalf("a source launch was bound: %v", got)
	}
	writeFile(t, launcher, "not a launcher")
	if got, _ := boundLauncher(resolved, "/data/config.json", root, launcher); got != nil {
		t.Fatalf("a foreign launcher was bound: %v", got)
	}
	if runtime.GOOS != "windows" {
		if got, _ := installedWindowsServiceCommand(resolved, "/data/config.json", root, launcher); got != nil {
			t.Fatal("non-Windows launch bound a Windows launcher")
		}
	}
}
