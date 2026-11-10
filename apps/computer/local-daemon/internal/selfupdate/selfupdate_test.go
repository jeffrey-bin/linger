package selfupdate

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/transport"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/protocol"
)

type fakeAdmission struct {
	mu      sync.Mutex
	busy    []int
	active  int
	drains  int
	resumes int
	// onDrain runs before each drain, outside the lock, with the 1-based call count.
	onDrain func(call int)
}

func (f *fakeAdmission) DrainIfIdle() int {
	f.mu.Lock()
	f.drains++
	call := f.drains
	f.mu.Unlock()
	if f.onDrain != nil {
		f.onDrain(call)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.busy) > 0 {
		active := f.busy[0]
		f.busy = f.busy[1:]
		return active
	}
	return f.active
}

func (f *fakeAdmission) setActive(active int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.active = active
}

func (f *fakeAdmission) ResumeAdmission() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.resumes++
}

func (f *fakeAdmission) counts() (drains, resumes int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.drains, f.resumes
}

type fakeStager struct {
	calls    atomic.Int32
	stage    func(ctx context.Context, request StageRequest) error
	activate func(ctx context.Context, prepared *Prepared) error
	mu       sync.Mutex
	last     StageRequest
	// prepareTargets and activateTargets record the target of every call.
	prepareTargets  []string
	activateTargets []string
}

func (f *fakeStager) Prepare(ctx context.Context, request StageRequest) (*Prepared, error) {
	f.calls.Add(1)
	f.mu.Lock()
	f.last = request
	f.prepareTargets = append(f.prepareTargets, request.App.SHA256)
	f.mu.Unlock()
	if f.stage != nil {
		if err := f.stage(ctx, request); err != nil {
			return nil, err
		}
	}
	return &Prepared{request: request}, nil
}

func (f *fakeStager) Activate(ctx context.Context, prepared *Prepared) error {
	f.mu.Lock()
	f.activateTargets = append(f.activateTargets, prepared.request.App.SHA256)
	f.mu.Unlock()
	if f.activate != nil {
		return f.activate(ctx, prepared)
	}
	return nil
}

func (f *fakeStager) targets() (prepared, activated []string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.prepareTargets...), append([]string(nil), f.activateTargets...)
}

func (f *fakeStager) activations() int {
	_, activated := f.targets()
	return len(activated)
}

type stopSignal struct {
	once sync.Once
	ch   chan struct{}
}

func newStopSignal() *stopSignal {
	return &stopSignal{ch: make(chan struct{})}
}

func (s *stopSignal) stop() {
	s.once.Do(func() { close(s.ch) })
}

func (s *stopSignal) wait(t *testing.T) {
	t.Helper()
	select {
	case <-s.ch:
	case <-time.After(5 * time.Second):
		t.Fatal("daemon was not asked to stop")
	}
}

func (s *stopSignal) fired() bool {
	select {
	case <-s.ch:
		return true
	default:
		return false
	}
}

func eventually(t *testing.T, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !condition() {
		if time.Now().After(deadline) {
			t.Fatal("condition was not reached")
		}
		time.Sleep(time.Millisecond)
	}
}

// installRoot builds <root>/<running>/daemon and an active-bundle pointer.
func installRoot(t *testing.T, running string) (root, executable string) {
	t.Helper()
	root = t.TempDir()
	writeBundle(t, root, running)
	writeFile(t, filepath.Join(root, "active-bundle"), running+"\n", 0o600)
	writeFile(t, filepath.Join(root, "web-origin"), "https://web.example.test\n", 0o600)
	return root, filepath.Join(root, running, "daemon", daemonEntry)
}

// buildSHA is the fixed app sha256 of a named build; a bundle written by
// writeBundle carries the sha of its own name.
func buildSHA(name string) string {
	digest := sha256.Sum256([]byte(name))
	return hex.EncodeToString(digest[:])
}

// target is a welcome target_release naming build for this platform.
func target(build string) *protocol.TargetRelease {
	platform, err := releaseTarget("darwin", runtime.GOARCH)
	if err != nil {
		panic(err)
	}
	return &protocol.TargetRelease{Targets: map[string]protocol.TargetReleaseFiles{
		platform:      {App: protocol.ReleaseFile{SHA256: buildSHA(build), Size: 1024}, Deps: protocol.ReleaseFile{SHA256: buildSHA("deps"), Size: 4096}},
		"linux-riscv": {App: protocol.ReleaseFile{SHA256: buildSHA("other-platform"), Size: 1}, Deps: protocol.ReleaseFile{SHA256: buildSHA("deps"), Size: 1}},
	}}
}

// windowsTarget is a welcome target_release naming build for Windows.
func windowsTarget(build string) *protocol.TargetRelease {
	platform, err := releaseTarget("windows", runtime.GOARCH)
	if err != nil {
		panic(err)
	}
	return &protocol.TargetRelease{Targets: map[string]protocol.TargetReleaseFiles{
		platform: {App: protocol.ReleaseFile{SHA256: buildSHA(build), Size: 1024}, Deps: protocol.ReleaseFile{SHA256: buildSHA("deps"), Size: 4096}},
	}}
}

// shas maps build names to their app sha256 values.
func shas(builds ...string) []string {
	result := make([]string, 0, len(builds))
	for _, build := range builds {
		result = append(result, buildSHA(build))
	}
	return result
}

func writeBundle(t *testing.T, root, bundle string) {
	t.Helper()
	writeFile(t, filepath.Join(root, bundle, appSHA256File), buildSHA(bundle)+"\n", 0o600)
	writeFile(t, filepath.Join(root, bundle, "daemon", daemonEntry), "#!/bin/sh\nexit 0\n", 0o755)
	writeFile(t, filepath.Join(root, bundle, "cli", "linger-computer"), "", 0o755)
	writeFile(t, filepath.Join(root, bundle, "runtime", "bin", "node"), "", 0o755)
}

func writeFile(t *testing.T, path, content string, mode os.FileMode) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), mode); err != nil {
		t.Fatal(err)
	}
}

func readFileString(t *testing.T, path string) string {
	t.Helper()
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(content)
}

func testOptions(executable string, admission Admission, stager Stager, stop func()) Options {
	return Options{
		ReleaseVersion: "1.2.3",
		GOOS:           "darwin",
		Executable:     executable,
		ConfigPath:     "/cfg/config.json",
		Args:           []string{executable, "--config", "/cfg/config.json"},
		Env:            []string{"PATH=/bin", "KEEP=1", "LINGER_COMPUTER_SERVICE_COMMAND=[\"old\"]"},
		Admission:      admission,
		Stager:         stager,
		Stop:           stop,
		Logger:         slog.New(slog.NewTextHandler(io.Discard, nil)),
		IdleInterval:   time.Millisecond,
		ConfirmWindow:  time.Hour,
		RetryDelay:     time.Hour,
		// A sub-second window disables the start delay so welcome-triggered tests run at once.
		StartDelayWindow: time.Nanosecond,
	}
}

// switchingActivate simulates the installer's activate mode: it writes the new
// bundle and then points active-bundle at it.
func switchingActivate(t *testing.T, root, bundle string) func(context.Context, *Prepared) error {
	return func(_ context.Context, _ *Prepared) error {
		writeBundle(t, root, bundle)
		writeFile(t, filepath.Join(root, "active-bundle"), bundle+"\n", 0o600)
		return nil
	}
}

func TestTriggerSkips(t *testing.T) {
	cases := []struct {
		name    string
		target  *protocol.TargetRelease
		prepare func(t *testing.T, root string, options *Options)
	}{
		{name: "running build", target: target("lib-old")},
		{name: "no target_release", target: nil},
		{name: "no entry for this platform", target: &protocol.TargetRelease{Targets: map[string]protocol.TargetReleaseFiles{}}},
		{name: "invalid sha256", target: func() *protocol.TargetRelease {
			release := target("2.0.0")
			for platform, files := range release.Targets {
				files.App.SHA256 = "../x"
				release.Targets[platform] = files
			}
			return release
		}()},
		{name: "windows without installed-checksum", target: windowsTarget("2.0.0"), prepare: func(_ *testing.T, _ string, o *Options) { o.GOOS = "windows" }},
		{name: "bundle without app-sha256", target: target("2.0.0"), prepare: func(t *testing.T, root string, _ *Options) {
			if err := os.Remove(filepath.Join(root, "lib-old", appSHA256File)); err != nil {
				t.Fatal(err)
			}
		}},
		{name: "non-HTTP web origin", target: target("2.0.0"), prepare: func(t *testing.T, root string, _ *Options) {
			writeFile(t, filepath.Join(root, "web-origin"), "ftp://web.example.test\n", 0o600)
		}},
		{name: "missing web origin", target: target("2.0.0"), prepare: func(t *testing.T, root string, _ *Options) {
			if err := os.Remove(filepath.Join(root, "web-origin")); err != nil {
				t.Fatal(err)
			}
		}},
		{name: "active bundle names another bundle", target: target("2.0.0"), prepare: func(t *testing.T, root string, _ *Options) {
			writeBundle(t, root, "lib-other")
			writeFile(t, filepath.Join(root, "active-bundle"), "lib-other\n", 0o600)
		}},
		{name: "daemon outside a bundle", target: target("2.0.0"), prepare: func(t *testing.T, _ string, o *Options) {
			o.Executable = filepath.Join(t.TempDir(), "bin", daemonEntry)
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			root, executable := installRoot(t, "lib-old")
			admission := &fakeAdmission{}
			stager := &fakeStager{}
			stop := newStopSignal()
			options := testOptions(executable, admission, stager, stop.stop)
			if tc.prepare != nil {
				tc.prepare(t, root, &options)
			}
			manager := New(options)
			manager.WelcomeAccepted(context.Background(), tc.target)
			time.Sleep(10 * time.Millisecond)
			if n := stager.calls.Load(); n != 0 {
				t.Fatalf("stage calls = %d, want 0", n)
			}
			if drains, _ := admission.counts(); drains != 0 {
				t.Fatalf("drain attempts = %d, want 0", drains)
			}
			if manager.Handoff() != nil || stop.fired() {
				t.Fatal("unexpected handoff")
			}
		})
	}
}

// The target is a build, not a version: a build the Agent rolled back to is
// installed like any other, and a plain HTTP origin counts too.
func TestAnyOtherBuildIsATarget(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX handoff and directory sync are not used by Windows upgrades")
	}
	cases := map[string]func(t *testing.T, root string, options *Options){
		"build of an older version": func(_ *testing.T, _ string, o *Options) { o.ReleaseVersion = "9.0.0" },
		"plain HTTP origin": func(t *testing.T, root string, _ *Options) {
			writeFile(t, filepath.Join(root, "web-origin"), "http://10.0.0.5:31037\n", 0o600)
		},
	}
	for name, prepare := range cases {
		t.Run(name, func(t *testing.T) {
			root, executable := installRoot(t, "lib-old")
			stop := newStopSignal()
			stager := &fakeStager{activate: switchingActivate(t, root, "lib-new")}
			options := testOptions(executable, &fakeAdmission{}, stager, stop.stop)
			prepare(t, root, &options)
			manager := New(options)

			manager.WelcomeAccepted(context.Background(), target("0.1.0"))
			stop.wait(t)
			if got := stager.last.App.SHA256; got != buildSHA("0.1.0") {
				t.Fatalf("staged app sha256 = %q", got)
			}
			if want := readFileString(t, filepath.Join(root, "web-origin")); stager.last.WebOrigin+"\n" != want {
				t.Fatalf("stage origin = %q, want %q", stager.last.WebOrigin, want)
			}
		})
	}
}

func TestSingleFlightWaitsWhileBusy(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX handoff and directory sync are not used by Windows upgrades")
	}
	root, executable := installRoot(t, "lib-old")
	writeBundle(t, root, "lib-new")
	admission := &fakeAdmission{busy: []int{2, 1}}
	release := make(chan struct{})
	stop := newStopSignal()
	var drainsAtPrepare, drainsAtActivate int
	stager := &fakeStager{
		stage: func(ctx context.Context, _ StageRequest) error {
			drainsAtPrepare, _ = admission.counts()
			select {
			case <-release:
			case <-ctx.Done():
				return ctx.Err()
			}
			return nil
		},
		activate: func(ctx context.Context, prepared *Prepared) error {
			drainsAtActivate, _ = admission.counts()
			return switchingActivate(t, root, "lib-new")(ctx, prepared)
		},
	}
	manager := New(testOptions(executable, admission, stager, stop.stop))

	manager.WelcomeAccepted(context.Background(), target("2.0.0"))
	manager.WelcomeAccepted(context.Background(), target("2.0.0"))
	eventually(t, func() bool { return stager.calls.Load() == 1 })
	manager.WelcomeAccepted(context.Background(), target("2.0.0"))
	close(release)
	stop.wait(t)

	if n := stager.calls.Load(); n != 1 {
		t.Fatalf("prepare calls = %d, want 1", n)
	}
	if drainsAtPrepare != 0 {
		t.Fatalf("drain attempts during prepare = %d, want 0: admissions must stay open", drainsAtPrepare)
	}
	if drainsAtActivate != 3 {
		t.Fatalf("drain attempts before activating = %d, want 3 (two busy, one idle)", drainsAtActivate)
	}
	if manager.Handoff() == nil {
		t.Fatal("expected a handoff after activating")
	}
}

func TestSuccessYieldsExecTargetWithRebuiltEnvironment(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX handoff and directory sync are not used by Windows upgrades")
	}
	root, executable := installRoot(t, "lib-old")
	stop := newStopSignal()
	stager := &fakeStager{activate: switchingActivate(t, root, "lib-new")}
	options := testOptions(executable, &fakeAdmission{}, stager, stop.stop)
	manager := New(options)

	manager.WelcomeAccepted(context.Background(), target("2.0.0"))
	stop.wait(t)

	want := StageRequest{
		ID:   buildSHA("2.0.0"),
		Root: root, WebOrigin: "https://web.example.test", Target: "darwin-" + map[string]string{"amd64": "x64", "arm64": "arm64"}[runtime.GOARCH],
		App: protocol.ReleaseFile{SHA256: buildSHA("2.0.0"), Size: 1024}, Deps: protocol.ReleaseFile{SHA256: buildSHA("deps"), Size: 4096},
	}
	if got := stager.last; got != want {
		t.Fatalf("stage request = %+v, want %+v", got, want)
	}
	var handoff *Handoff
	ok := errors.As(manager.Handoff(), &handoff)
	if !ok || handoff == nil {
		t.Fatalf("handoff = %v, want *Handoff", manager.Handoff())
	}
	newDaemon := filepath.Join(root, "lib-new", "daemon", daemonEntry)
	if handoff.Path != newDaemon || handoff.Args[0] != newDaemon || len(handoff.Args) != 3 || handoff.Args[2] != "/cfg/config.json" {
		t.Fatalf("handoff path/args = %q %q", handoff.Path, handoff.Args)
	}
	assertServiceCommand(t, handoff.Env, root, "lib-new")
	if !containsEnv(handoff.Env, "KEEP=1") || !containsEnv(handoff.Env, "PATH=/bin") {
		t.Fatalf("handoff environment dropped entries: %q", handoff.Env)
	}
}

func TestStageFailureResumesAdmissionAndBacksOff(t *testing.T) {
	_, executable := installRoot(t, "lib-old")
	admission := &fakeAdmission{}
	stager := &fakeStager{stage: func(context.Context, StageRequest) error {
		return &StageError{Stage: "install", ExitCode: 3, Err: errors.New("exit status 3")}
	}}
	stop := newStopSignal()
	manager := New(testOptions(executable, admission, stager, stop.stop))

	manager.WelcomeAccepted(context.Background(), target("2.0.0"))
	eventually(t, func() bool { _, resumes := admission.counts(); return resumes == 1 })
	manager.WelcomeAccepted(context.Background(), target("2.0.0"))
	time.Sleep(10 * time.Millisecond)

	if n := stager.calls.Load(); n != 1 {
		t.Fatalf("stage calls = %d, want 1 during backoff", n)
	}
	if manager.Handoff() != nil || stop.fired() {
		t.Fatal("failed upgrade must not restart the daemon")
	}
}

func TestStageRetriesAfterBackoff(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX handoff and directory sync are not used by Windows upgrades")
	}
	root, executable := installRoot(t, "lib-old")
	writeBundle(t, root, "lib-new")
	admission := &fakeAdmission{}
	stop := newStopSignal()
	var attempts atomic.Int32
	stager := &fakeStager{
		stage: func(context.Context, StageRequest) error {
			if attempts.Add(1) == 1 {
				return &StageError{Stage: "download", Err: errors.New("HTTP 404")}
			}
			return nil
		},
		activate: switchingActivate(t, root, "lib-new"),
	}
	options := testOptions(executable, admission, stager, stop.stop)
	options.TransientBackoff = []time.Duration{10 * time.Millisecond}
	manager := New(options)

	manager.WelcomeAccepted(context.Background(), target("2.0.0"))
	stop.wait(t)
	if n := stager.calls.Load(); n != 2 {
		t.Fatalf("stage calls = %d, want 2", n)
	}
	if manager.Handoff() == nil {
		t.Fatal("expected handoff after retry succeeded")
	}
}

func TestVerifyFailsWhenActiveBundleUnchanged(t *testing.T) {
	_, executable := installRoot(t, "lib-old")
	admission := &fakeAdmission{}
	stager := &fakeStager{}
	stop := newStopSignal()
	manager := New(testOptions(executable, admission, stager, stop.stop))

	manager.WelcomeAccepted(context.Background(), target("2.0.0"))
	eventually(t, func() bool { _, resumes := admission.counts(); return resumes == 1 })
	if manager.Handoff() != nil || stop.fired() {
		t.Fatal("unchanged active-bundle must not restart the daemon")
	}
}

func TestConfirmedWelcomeRemovesMarkerAndKeepsBundle(t *testing.T) {
	root, executable := installRoot(t, "lib-new")
	writeBundle(t, root, "lib-old")
	writeMarker(t, root, "lib-old", "lib-new")
	stop := newStopSignal()
	options := testOptions(executable, &fakeAdmission{}, &fakeStager{}, stop.stop)
	options.ConfirmWindow = 20 * time.Millisecond
	manager := New(options)

	manager.WelcomeAccepted(context.Background(), nil)
	if _, err := os.Stat(filepath.Join(root, "upgrade-pending")); !os.IsNotExist(err) {
		t.Fatalf("marker still present after welcome: %v", err)
	}
	time.Sleep(60 * time.Millisecond)
	if stop.fired() || manager.Handoff() != nil {
		t.Fatal("confirmed upgrade must not roll back")
	}
	if got := readFileString(t, filepath.Join(root, "active-bundle")); got != "lib-new\n" {
		t.Fatalf("active-bundle = %q", got)
	}
}

func TestRollbackOnConfirmationTimeout(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX handoff and directory sync are not used by Windows upgrades")
	}
	root, executable := installRoot(t, "lib-new")
	writeBundle(t, root, "lib-old")
	writeMarker(t, root, "lib-old", "lib-new")
	stop := newStopSignal()
	options := testOptions(executable, &fakeAdmission{}, &fakeStager{}, stop.stop)
	options.ConfirmWindow = 20 * time.Millisecond
	manager := New(options)

	stop.wait(t)
	var handoff *Handoff
	ok := errors.As(manager.Handoff(), &handoff)
	if !ok {
		t.Fatalf("handoff = %v, want rollback handoff", manager.Handoff())
	}
	assertRolledBack(t, root, handoff, "lib-old")
}

func TestRollbackOnProtocolRejectionBeforeWelcome(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX handoff and directory sync are not used by Windows upgrades")
	}
	root, executable := installRoot(t, "lib-new")
	writeBundle(t, root, "lib-old")
	writeMarker(t, root, "lib-old", "lib-new")
	stop := newStopSignal()
	manager := New(testOptions(executable, &fakeAdmission{}, &fakeStager{}, stop.stop))

	manager.ConnectionFailed(errors.New("upgrade_required: 2.0.0"), transport.FailureIncompatible)
	stop.wait(t)
	var handoff *Handoff
	ok := errors.As(manager.Handoff(), &handoff)
	if !ok {
		t.Fatalf("handoff = %v, want rollback handoff", manager.Handoff())
	}
	assertRolledBack(t, root, handoff, "lib-old")
}

func TestRejectionWithoutPendingUpgradeDoesNothing(t *testing.T) {
	_, executable := installRoot(t, "lib-old")
	stop := newStopSignal()
	manager := New(testOptions(executable, &fakeAdmission{}, &fakeStager{}, stop.stop))

	manager.ConnectionFailed(errors.New("upgrade_required: 2.0.0"), transport.FailureIncompatible)
	if stop.fired() || manager.Handoff() != nil {
		t.Fatal("rejection without a pending upgrade must not restart the daemon")
	}
}

func TestRollbackWithoutPreviousBundleKeepsCurrentBundle(t *testing.T) {
	root, executable := installRoot(t, "lib-new")
	writeMarker(t, root, "lib-missing", "lib-new")
	stop := newStopSignal()
	manager := New(testOptions(executable, &fakeAdmission{}, &fakeStager{}, stop.stop))

	manager.ConnectionFailed(errors.New("rejected"), transport.FailureIncompatible)
	if stop.fired() || manager.Handoff() != nil {
		t.Fatal("rollback without a previous bundle must not restart the daemon")
	}
	if _, err := os.Stat(filepath.Join(root, "upgrade-pending")); !os.IsNotExist(err) {
		t.Fatal("marker should be discarded when there is nothing to restore")
	}
	if got := readFileString(t, filepath.Join(root, "active-bundle")); got != "lib-new\n" {
		t.Fatalf("active-bundle = %q", got)
	}
}

func TestStaleAndMalformedMarkersAreRemoved(t *testing.T) {
	cases := map[string]string{
		"stale":      `{"previous_bundle":"lib-old","target_app_sha256":"` + buildSHA("lib-other") + `","created_at":"2026-10-22T00:00:00Z"}`,
		"malformed":  `{"previous_bundle":`,
		"bad-name":   `{"previous_bundle":"../x","target_app_sha256":"` + buildSHA("lib-new") + `","created_at":"2026-10-22T00:00:00Z"}`,
		"bad-sha256": `{"previous_bundle":"lib-old","target_app_sha256":"../x","created_at":"2026-10-22T00:00:00Z"}`,
	}
	for name, content := range cases {
		t.Run(name, func(t *testing.T) {
			root, executable := installRoot(t, "lib-new")
			writeBundle(t, root, "lib-old")
			writeFile(t, filepath.Join(root, "upgrade-pending"), content, 0o600)
			stop := newStopSignal()
			options := testOptions(executable, &fakeAdmission{}, &fakeStager{}, stop.stop)
			options.ConfirmWindow = 10 * time.Millisecond
			New(options)

			if _, err := os.Stat(filepath.Join(root, "upgrade-pending")); !os.IsNotExist(err) {
				t.Fatalf("marker not removed: %v", err)
			}
			time.Sleep(30 * time.Millisecond)
			if stop.fired() {
				t.Fatal("discarded marker must not roll back")
			}
		})
	}
}

// writeMarker records an upgrade from previous to the bundle named build.
func writeMarker(t *testing.T, root, previous, build string) {
	t.Helper()
	marker, err := json.Marshal(upgradePending{
		// RFC3339 drops sub-seconds; a second ahead keeps the whole short test
		// window ahead instead of already expired at load.
		PreviousBundle: previous, TargetAppSHA256: buildSHA(build), CreatedAt: time.Now().Add(time.Second).UTC().Format(time.RFC3339),
	})
	if err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(root, "upgrade-pending"), string(marker), 0o600)
}

func assertRolledBack(t *testing.T, root string, handoff *Handoff, previous string) {
	t.Helper()
	if got := readFileString(t, filepath.Join(root, "active-bundle")); got != previous+"\n" {
		t.Fatalf("active-bundle = %q, want %s", got, previous)
	}
	if _, err := os.Stat(filepath.Join(root, "upgrade-pending")); !os.IsNotExist(err) {
		t.Fatal("marker not removed after rollback")
	}
	if handoff.Path != filepath.Join(root, previous, "daemon", daemonEntry) {
		t.Fatalf("handoff path = %q", handoff.Path)
	}
	assertServiceCommand(t, handoff.Env, root, previous)
}

func assertServiceCommand(t *testing.T, environment []string, root, bundle string) {
	t.Helper()
	var found []string
	for _, entry := range environment {
		if strings.HasPrefix(entry, serviceCommandEnv+"=") {
			found = append(found, entry)
		}
	}
	if len(found) != 1 {
		t.Fatalf("service command entries = %d, want 1", len(found))
	}
	var command []string
	if err := json.Unmarshal([]byte(strings.TrimPrefix(found[0], serviceCommandEnv+"=")), &command); err != nil {
		t.Fatal(err)
	}
	want := []string{filepath.Join(root, bundle, "cli", "linger-computer"), "--config", "/cfg/config.json"}
	if strings.Join(command, "\x00") != strings.Join(want, "\x00") {
		t.Fatalf("service command = %q, want %q", command, want)
	}
}

func containsEnv(environment []string, entry string) bool {
	for _, item := range environment {
		if item == entry {
			return true
		}
	}
	return false
}

func TestRollbackRecordsFailedTarget(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX handoff and directory sync are not used by Windows upgrades")
	}
	root, executable := installRoot(t, "lib-new")
	writeBundle(t, root, "lib-old")
	writeMarker(t, root, "lib-old", "lib-new")
	stop := newStopSignal()
	options := testOptions(executable, &fakeAdmission{}, &fakeStager{}, stop.stop)
	manager := New(options)

	manager.ConnectionFailed(errors.New("rejected"), transport.FailureIncompatible)
	stop.wait(t)
	if manager.failedSHA256 != buildSHA("lib-new") {
		t.Fatalf("in-memory failed target = %q", manager.failedSHA256)
	}
	record := readFileString(t, filepath.Join(root, "upgrade-failed"))
	var decoded upgradeFailed
	if err := json.Unmarshal([]byte(record), &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded.AppSHA256 != buildSHA("lib-new") {
		t.Fatalf("failed app_sha256 = %q, want the rolled-back build", decoded.AppSHA256)
	}
	if _, err := time.Parse(time.RFC3339, decoded.FailedAt); err != nil {
		t.Fatalf("failed_at = %q: %v", decoded.FailedAt, err)
	}
	info, err := os.Stat(filepath.Join(root, "upgrade-failed"))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("mode = %v, want 0600", info.Mode().Perm())
	}
}

func TestRestartedManagerSkipsFailedTargetButNotAnotherBuild(t *testing.T) {
	root, executable := installRoot(t, "lib-old")
	writeFile(t, filepath.Join(root, "upgrade-failed"), `{"app_sha256":"`+buildSHA("2.0.0")+`","failed_at":"2026-10-22T00:00:00Z"}`, 0o600)
	admission := &fakeAdmission{}
	stager := &fakeStager{stage: func(context.Context, StageRequest) error {
		return &StageError{Stage: "install", ExitCode: 1, Err: errors.New("exit status 1")}
	}}
	options := testOptions(executable, admission, stager, newStopSignal().stop)
	// Within the retry cooldown of the recorded rollback.
	options.Now = func() time.Time { return time.Date(2026, 10, 22, 1, 0, 0, 0, time.UTC) }
	manager := New(options)

	manager.WelcomeAccepted(context.Background(), target("2.0.0"))
	time.Sleep(10 * time.Millisecond)
	if n := stager.calls.Load(); n != 0 {
		t.Fatalf("stage calls for rolled-back target = %d, want 0", n)
	}
	if drains, _ := admission.counts(); drains != 0 {
		t.Fatalf("drain attempts for rolled-back target = %d, want 0", drains)
	}

	manager.WelcomeAccepted(context.Background(), target("2.1.0"))
	eventually(t, func() bool { return stager.calls.Load() == 1 })
	stager.mu.Lock()
	staged := stager.last.App.SHA256
	stager.mu.Unlock()
	if staged != buildSHA("2.1.0") {
		t.Fatalf("staged target = %q, want 2.1.0", staged)
	}
}

func TestFailedRecordClearedWhenRunningTheFailedBuild(t *testing.T) {
	root, executable := installRoot(t, "lib-old")
	writeFile(t, filepath.Join(root, "upgrade-failed"), `{"app_sha256":"`+buildSHA("lib-old")+`","failed_at":"2026-10-22T00:00:00Z"}`, 0o600)
	options := testOptions(executable, &fakeAdmission{}, &fakeStager{}, newStopSignal().stop)
	manager := New(options)

	if _, err := os.Stat(filepath.Join(root, "upgrade-failed")); !os.IsNotExist(err) {
		t.Fatalf("record not cleared: %v", err)
	}
	if manager.failedSHA256 != "" {
		t.Fatalf("failed target = %q, want empty", manager.failedSHA256)
	}
}

func TestConfirmationDeadlineCountsFromMarkerCreation(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX handoff and directory sync are not used by Windows upgrades")
	}
	root, executable := installRoot(t, "lib-new")
	writeBundle(t, root, "lib-old")
	createdAt := time.Date(2026, 10, 22, 6, 0, 0, 0, time.UTC)
	writeFile(t, filepath.Join(root, "upgrade-pending"), `{"previous_bundle":"lib-old","target_app_sha256":"`+buildSHA("lib-new")+`","created_at":"`+
		createdAt.Format(time.RFC3339)+`"}`, 0o600)
	stop := newStopSignal()
	options := testOptions(executable, &fakeAdmission{}, &fakeStager{}, stop.stop)
	// A restarted daemon must only wait for what is left of the window.
	options.Now = func() time.Time { return createdAt.Add(time.Hour - 20*time.Millisecond) }
	manager := New(options)

	stop.wait(t)
	var handoff *Handoff
	ok := errors.As(manager.Handoff(), &handoff)
	if !ok {
		t.Fatalf("handoff = %v, want rollback handoff", manager.Handoff())
	}
	assertRolledBack(t, root, handoff, "lib-old")
}

func TestRecoverAtStartupCountsStartsUntilLimit(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX handoff and directory sync are not used by Windows upgrades")
	}
	root, executable := installRoot(t, "lib-new")
	writeBundle(t, root, "lib-old")
	writeMarker(t, root, "lib-old", "lib-new")
	options := testOptions(executable, nil, nil, nil)

	for start := 1; start <= maxPendingStarts; start++ {
		if handoff := RecoverAtStartup(options); handoff != nil {
			t.Fatalf("start %d rolled back early", start)
		}
		marker, err := layout{root: root}.readPending()
		if err != nil {
			t.Fatal(err)
		}
		if marker.StartAttempts != start {
			t.Fatalf("start_attempts = %d, want %d", marker.StartAttempts, start)
		}
	}
	handoff := RecoverAtStartup(options)
	if handoff == nil {
		t.Fatal("restart loop did not roll back")
	}
	assertRolledBack(t, root, handoff, "lib-old")
	if _, err := os.Stat(filepath.Join(root, "upgrade-failed")); err != nil {
		t.Fatalf("failed record missing: %v", err)
	}
	// The restored daemon finds no marker and starts normally.
	if RecoverAtStartup(options) != nil {
		t.Fatal("rolled-back start must not hand off again")
	}
}

func TestRecoverAtStartupLeavesOtherReleasesAndFutureMarkers(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX handoff and directory sync are not used by Windows upgrades")
	}
	root, executable := installRoot(t, "lib-new")
	writeBundle(t, root, "lib-old")
	writeMarker(t, root, "lib-old", "lib-other")
	options := testOptions(executable, nil, nil, nil)
	if RecoverAtStartup(options) != nil {
		t.Fatal("a marker for another build must be left to New")
	}
	if marker, err := (layout{root: root}).readPending(); err != nil || marker.StartAttempts != 0 {
		t.Fatalf("stale marker changed: %+v, %v", marker, err)
	}

	// A clock set back puts created_at in the future: no rollback at startup,
	// and the in-process window still lasts at most ConfirmWindow.
	createdAt := time.Now().Add(24 * time.Hour).UTC()
	writeFile(t, filepath.Join(root, "upgrade-pending"), `{"previous_bundle":"lib-old","target_app_sha256":"`+buildSHA("lib-new")+`","created_at":"`+
		createdAt.Format(time.RFC3339)+`"}`, 0o600)
	if RecoverAtStartup(options) != nil {
		t.Fatal("future created_at must not roll back at startup")
	}
	stop := newStopSignal()
	options = testOptions(executable, &fakeAdmission{}, &fakeStager{}, stop.stop)
	options.ConfirmWindow = 20 * time.Millisecond
	manager := New(options)
	stop.wait(t)
	if !errors.As(manager.Handoff(), new(*Handoff)) {
		t.Fatalf("handoff = %v, want rollback handoff", manager.Handoff())
	}
}

func TestUnavailableGatewayPostponesConfirmation(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX handoff and directory sync are not used by Windows upgrades")
	}
	root, executable := installRoot(t, "lib-new")
	writeBundle(t, root, "lib-old")
	writeMarker(t, root, "lib-old", "lib-new")
	stop := newStopSignal()
	options := testOptions(executable, &fakeAdmission{}, &fakeStager{}, stop.stop)
	options.ConfirmWindow = 30 * time.Millisecond
	manager := New(options)

	// Offline, asleep, or a revoked credential: no evidence against the release.
	manager.ConnectionFailed(errors.New("dial tcp: network is unreachable"), transport.FailureUnavailable)
	eventually(t, func() bool {
		marker, err := layout{root: root}.readPending()
		return err == nil && marker.ConfirmBy != ""
	})
	if stop.fired() || manager.Handoff() != nil {
		t.Fatal("an unavailable Gateway must not roll back the upgrade")
	}
	marker, err := layout{root: root}.readPending()
	if err != nil {
		t.Fatal(err)
	}
	// A postponement must not reset the start count, or the restart limit
	// would never trigger while the Gateway stays unavailable.
	if marker.StartAttempts != 0 {
		t.Fatalf("start_attempts = %d, want 0 unchanged by the postponement", marker.StartAttempts)
	}
	if _, err := os.Stat(filepath.Join(root, "upgrade-failed")); !os.IsNotExist(err) {
		t.Fatalf("postponed upgrade must not be recorded as failed: %v", err)
	}

	// Once the Gateway answers and still no welcome arrives, the next deadline rolls back.
	manager.ConnectionFailed(errors.New("decode Runner Gateway command"), transport.FailureOther)
	stop.wait(t)
	var handoff *Handoff
	ok := errors.As(manager.Handoff(), &handoff)
	if !ok {
		t.Fatalf("handoff = %v, want rollback handoff", manager.Handoff())
	}
	assertRolledBack(t, root, handoff, "lib-old")
}

func TestPostponedDeadlineSurvivesRestart(t *testing.T) {
	root, executable := installRoot(t, "lib-new")
	writeBundle(t, root, "lib-old")
	createdAt := time.Now().Add(-30 * time.Minute).UTC()
	writeFile(t, filepath.Join(root, "upgrade-pending"), `{"previous_bundle":"lib-old","target_app_sha256":"`+buildSHA("lib-new")+`","created_at":"`+
		createdAt.Format(time.RFC3339)+`","confirm_by":"`+time.Now().Add(time.Hour).UTC().Format(time.RFC3339)+
		`"}`, 0o600)
	options := testOptions(executable, nil, nil, nil)
	options.ConfirmWindow = 3 * time.Minute
	if RecoverAtStartup(options) != nil {
		t.Fatal("a postponed deadline must not roll back at startup")
	}
}

func TestRolledBackTargetIsRetriedAfterCooldown(t *testing.T) {
	root, executable := installRoot(t, "lib-old")
	failedAt := time.Date(2026, 10, 22, 0, 0, 0, 0, time.UTC)
	writeFile(t, filepath.Join(root, "upgrade-failed"), `{"app_sha256":"`+buildSHA("2.0.0")+`","failed_at":"`+failedAt.Format(time.RFC3339)+`"}`, 0o600)
	stager := &fakeStager{stage: func(context.Context, StageRequest) error {
		return &StageError{Stage: "install", ExitCode: 1, Err: errors.New("exit status 1")}
	}}
	options := testOptions(executable, &fakeAdmission{}, stager, newStopSignal().stop)
	// The cooldown ends 30ms after the daemon learns about the target.
	offset := time.Until(failedAt.Add(failedRetryCooldown - 30*time.Millisecond))
	options.Now = func() time.Time { return time.Now().Add(offset) }
	manager := New(options)

	manager.WelcomeAccepted(context.Background(), target("2.0.0"))
	if n := stager.calls.Load(); n != 0 {
		t.Fatalf("stage calls during cooldown = %d, want 0", n)
	}
	eventually(t, func() bool { return stager.calls.Load() == 1 })
}

// The installer was killed after switching active-bundle; its trap never ran.
// The next start of the new bundle restores the previous bundle from the marker.
func TestStartupRepairsInstallerKilledAfterSwitch(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX handoff and directory sync are not used by Windows upgrades")
	}
	root, executable := installRoot(t, "lib-new")
	writeBundle(t, root, "lib-old")
	writeFile(t, filepath.Join(root, "upgrade-pending"), `{"previous_bundle":"lib-old","target_app_sha256":"`+buildSHA("lib-new")+`","created_at":"`+
		time.Now().Add(-time.Hour).UTC().Format(time.RFC3339)+`"}`, 0o600)

	handoff := RecoverAtStartup(testOptions(executable, nil, nil, nil))
	if handoff == nil {
		t.Fatal("killed staging was not rolled back")
	}
	assertRolledBack(t, root, handoff, "lib-old")
}

// testClock is a wall clock the test moves; timers still run in real time.
type testClock struct {
	mu  sync.Mutex
	now time.Time
}

func (c *testClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *testClock) set(now time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = now
}

func writeMarkerAt(t *testing.T, root string, createdAt time.Time, startAttempts int) {
	t.Helper()
	marker, err := json.Marshal(upgradePending{
		PreviousBundle: "lib-old", TargetAppSHA256: buildSHA("lib-new"), CreatedAt: createdAt.UTC().Format(time.RFC3339),
		StartAttempts: startAttempts,
	})
	if err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(root, "upgrade-pending"), string(marker), 0o600)
}

func waitForPostponement(t *testing.T, root string) *upgradePending {
	t.Helper()
	var marker *upgradePending
	eventually(t, func() bool {
		var err error
		marker, err = layout{root: root}.readPending()
		return err == nil && marker.ConfirmBy != ""
	})
	return marker
}

// A broken release can keep the Gateway looking unavailable (a proxy or TLS
// regression, a connection that never completes). Postponements stop one hour
// after the switch and the upgrade rolls back.
func TestUnavailableGatewayRollsBackAfterConfirmationLimit(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX handoff and directory sync are not used by Windows upgrades")
	}
	root, executable := installRoot(t, "lib-new")
	writeBundle(t, root, "lib-old")
	createdAt := time.Date(2026, 10, 22, 6, 0, 0, 0, time.UTC)
	writeMarkerAt(t, root, createdAt, 1)
	clock := &testClock{now: createdAt}
	stop := newStopSignal()
	options := testOptions(executable, &fakeAdmission{}, &fakeStager{}, stop.stop)
	options.ConfirmWindow = 50 * time.Millisecond
	options.Now = clock.Now
	manager := New(options)

	manager.ConnectionFailed(errors.New("dial tcp: i/o timeout"), transport.FailureUnavailable)
	waitForPostponement(t, root)
	if stop.fired() {
		t.Fatal("the first deadline must still be postponed")
	}
	clock.set(createdAt.Add(time.Hour))
	stop.wait(t)
	var handoff *Handoff
	ok := errors.As(manager.Handoff(), &handoff)
	if !ok {
		t.Fatalf("handoff = %v, want rollback handoff", manager.Handoff())
	}
	assertRolledBack(t, root, handoff, "lib-old")
	if _, err := os.Stat(filepath.Join(root, "upgrade-failed")); err != nil {
		t.Fatalf("failed record missing: %v", err)
	}
}

// A TeamHub that keeps closing with 1011 "Runner credential verification
// unavailable", alone or between network failures, postpones the deadline
// only until one hour after the switch. Every failure goes through the real
// classifier.
func TestRepeatedUnavailableFailuresRollBackAtConfirmationLimit(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX handoff and directory sync are not used by Windows upgrades")
	}
	verificationUnavailable := &websocket.CloseError{Code: websocket.CloseInternalServerErr, Text: "Runner credential verification unavailable"}
	unreachable := &transport.GatewayUnreachableError{Err: errors.New("connect Runner Gateway: no route to host")}
	reset := &net.OpError{Op: "read", Err: errors.New("connection reset")}
	cases := []struct {
		name     string
		failures []error
	}{
		{"credential verification unavailable", []error{verificationUnavailable}},
		{"verification unavailable between network failures", []error{verificationUnavailable, unreachable, verificationUnavailable, reset}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			root, executable := installRoot(t, "lib-new")
			writeBundle(t, root, "lib-old")
			createdAt := time.Date(2026, 10, 22, 6, 0, 0, 0, time.UTC)
			writeMarkerAt(t, root, createdAt, 1)
			clock := &testClock{now: createdAt}
			stop := newStopSignal()
			options := testOptions(executable, &fakeAdmission{}, &fakeStager{}, stop.stop)
			options.ConfirmWindow = 50 * time.Millisecond
			options.Now = clock.Now
			manager := New(options)

			fail := func(attempt int) {
				t.Helper()
				err := tc.failures[attempt%len(tc.failures)]
				failure := transport.ClassifyConnectionFailure(err)
				if failure != transport.FailureUnavailable {
					t.Fatalf("ClassifyConnectionFailure(%v) = %v, want FailureUnavailable", err, failure)
				}
				manager.ConnectionStarted()
				manager.ConnectionFailed(err, failure)
			}
			offsets := []time.Duration{0, 10 * time.Minute, 20 * time.Minute, 30 * time.Minute, 40 * time.Minute, 50 * time.Minute, 59*time.Minute + 59*time.Second}
			for attempt, offset := range offsets {
				now := createdAt.Add(offset)
				clock.set(now)
				fail(attempt)
				// The deadline moves with the clock, so this failure was
				// postponed at this time rather than rolled back.
				want := now.Add(options.ConfirmWindow).UTC().Format(time.RFC3339)
				eventually(t, func() bool {
					marker, err := layout{root: root}.readPending()
					return err == nil && marker.ConfirmBy == want
				})
				if stop.fired() || manager.Handoff() != nil {
					t.Fatalf("rolled back %v after the switch, before the confirmation limit", offset)
				}
			}

			clock.set(createdAt.Add(time.Hour))
			fail(len(offsets))
			stop.wait(t)
			var handoff *Handoff
			ok := errors.As(manager.Handoff(), &handoff)
			if !ok {
				t.Fatalf("handoff = %v, want rollback handoff", manager.Handoff())
			}
			assertRolledBack(t, root, handoff, "lib-old")
			if _, err := os.Stat(filepath.Join(root, "upgrade-failed")); err != nil {
				t.Fatalf("failed record missing: %v", err)
			}
		})
	}
}

// The limit holds across restarts: a confirm_by written past it does not
// keep the upgrade at startup.
func TestRecoverAtStartupCapsPostponedDeadline(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX handoff and directory sync are not used by Windows upgrades")
	}
	root, executable := installRoot(t, "lib-new")
	writeBundle(t, root, "lib-old")
	createdAt := time.Now().Add(-time.Hour).UTC()
	writeFile(t, filepath.Join(root, "upgrade-pending"), `{"previous_bundle":"lib-old","target_app_sha256":"`+buildSHA("lib-new")+`","created_at":"`+
		createdAt.Format(time.RFC3339)+`","confirm_by":"`+time.Now().Add(time.Hour).UTC().Format(time.RFC3339)+
		`"}`, 0o600)
	options := testOptions(executable, nil, nil, nil)
	options.ConfirmWindow = 3 * time.Minute
	handoff := RecoverAtStartup(options)
	if handoff == nil {
		t.Fatal("a deadline postponed past the limit must roll back at startup")
	}
	assertRolledBack(t, root, handoff, "lib-old")
}

// Rejections caused by this daemon's own credential header or hello do not
// postpone the deadline.
func TestSelfCausedRejectionsDoNotPostponeConfirmation(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX handoff and directory sync are not used by Windows upgrades")
	}
	cases := []struct {
		name     string
		err      error
		postpone bool
	}{
		{"HTTP 401", &transport.AuthenticationError{StatusCode: 401}, false},
		{"HTTP 403", &transport.AuthenticationError{StatusCode: 403}, false},
		{"credential scope violation", &websocket.CloseError{Code: websocket.ClosePolicyViolation, Text: "Runner credential scope violation"}, false},
		{"credential verification unavailable", &websocket.CloseError{Code: websocket.CloseInternalServerErr, Text: "Runner credential verification unavailable"}, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			root, executable := installRoot(t, "lib-new")
			writeBundle(t, root, "lib-old")
			createdAt := time.Date(2026, 10, 22, 6, 0, 0, 0, time.UTC)
			writeMarkerAt(t, root, createdAt, 1)
			stop := newStopSignal()
			options := testOptions(executable, &fakeAdmission{}, &fakeStager{}, stop.stop)
			options.ConfirmWindow = 50 * time.Millisecond
			options.Now = func() time.Time { return createdAt }
			manager := New(options)

			manager.ConnectionFailed(tc.err, transport.ClassifyConnectionFailure(tc.err))
			if tc.postpone {
				waitForPostponement(t, root)
				if stop.fired() {
					t.Fatal("a TeamHub outage must postpone the deadline")
				}
				manager.ConnectionFailed(errors.New("decode Runner Gateway command"), transport.FailureOther)
			}
			stop.wait(t)
			var handoff *Handoff
			ok := errors.As(manager.Handoff(), &handoff)
			if !ok {
				t.Fatalf("handoff = %v, want rollback handoff", manager.Handoff())
			}
			assertRolledBack(t, root, handoff, "lib-old")
		})
	}
}

// A process that postponed its deadline still counts toward the start limit:
// a later restart loop rolls back before the postponed deadline.
func TestPostponementKeepsStartLimit(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX handoff and directory sync are not used by Windows upgrades")
	}
	root, executable := installRoot(t, "lib-new")
	writeBundle(t, root, "lib-old")
	createdAt := time.Date(2026, 10, 22, 6, 0, 0, 0, time.UTC)
	writeMarkerAt(t, root, createdAt, maxPendingStarts)
	// The marker is fresh, so the outage below is reported before its deadline.
	running := createdAt
	stop := newStopSignal()
	options := testOptions(executable, &fakeAdmission{}, &fakeStager{}, stop.stop)
	options.ConfirmWindow = 50 * time.Millisecond
	options.Now = func() time.Time { return running }
	manager := New(options)
	manager.ConnectionFailed(errors.New("dial tcp: network is unreachable"), transport.FailureUnavailable)
	marker := waitForPostponement(t, root)
	if marker.StartAttempts != maxPendingStarts {
		t.Fatalf("start_attempts = %d, want %d", marker.StartAttempts, maxPendingStarts)
	}
	postponed := readFileString(t, filepath.Join(root, "upgrade-pending"))
	// End this process's timers before its install is reused below.
	manager.ConnectionFailed(errors.New("upgrade_required: 2.0.0"), transport.FailureIncompatible)
	stop.wait(t)

	// The next start of the same install comes before the postponed deadline.
	root, executable = installRoot(t, "lib-new")
	writeBundle(t, root, "lib-old")
	writeFile(t, filepath.Join(root, "upgrade-pending"), postponed, 0o600)
	restart := testOptions(executable, nil, nil, nil)
	restart.ConfirmWindow = 3 * time.Minute
	restart.Now = func() time.Time { return running.Add(-time.Minute) }
	handoff := RecoverAtStartup(restart)
	if handoff == nil {
		t.Fatal("a restart loop after a postponement must roll back")
	}
	assertRolledBack(t, root, handoff, "lib-old")
}

// An outage reported earlier must not postpone the deadline forever while a
// later connection attempt hangs without ending.
func TestHungConnectionStopsPostponingConfirmation(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX handoff and directory sync are not used by Windows upgrades")
	}
	root, executable := installRoot(t, "lib-new")
	writeBundle(t, root, "lib-old")
	createdAt := time.Date(2026, 10, 22, 6, 0, 0, 0, time.UTC)
	writeMarkerAt(t, root, createdAt, 1)
	clock := &testClock{now: createdAt}
	stop := newStopSignal()
	options := testOptions(executable, &fakeAdmission{}, &fakeStager{}, stop.stop)
	options.ConfirmWindow = 50 * time.Millisecond
	options.Now = clock.Now
	manager := New(options)

	manager.ConnectionFailed(errors.New("dial tcp: network is unreachable"), transport.FailureUnavailable)
	manager.ConnectionStarted()
	// The new attempt has been in flight for longer than a window.
	clock.set(createdAt.Add(time.Minute))
	stop.wait(t)
	var handoff *Handoff
	ok := errors.As(manager.Handoff(), &handoff)
	if !ok {
		t.Fatalf("handoff = %v, want rollback handoff", manager.Handoff())
	}
	assertRolledBack(t, root, handoff, "lib-old")
}

// An attempt that just started after an outage keeps the postponement: a slow
// dial during an outage is no evidence against the release.
func TestRecentConnectionAttemptKeepsPostponement(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX handoff and directory sync are not used by Windows upgrades")
	}
	root, executable := installRoot(t, "lib-new")
	writeBundle(t, root, "lib-old")
	createdAt := time.Date(2026, 10, 22, 6, 0, 0, 0, time.UTC)
	writeMarkerAt(t, root, createdAt, 1)
	stop := newStopSignal()
	options := testOptions(executable, &fakeAdmission{}, &fakeStager{}, stop.stop)
	options.ConfirmWindow = 50 * time.Millisecond
	options.Now = func() time.Time { return createdAt }
	manager := New(options)

	manager.ConnectionFailed(errors.New("dial tcp: network is unreachable"), transport.FailureUnavailable)
	manager.ConnectionStarted()
	waitForPostponement(t, root)
	if stop.fired() {
		t.Fatal("a fresh attempt after an outage must not roll back")
	}
	manager.ConnectionFailed(errors.New("upgrade_required: 2.0.0"), transport.FailureIncompatible)
	stop.wait(t)
}

// lockedBuffer collects structured logs written from the manager's goroutines.
type lockedBuffer struct {
	mu     sync.Mutex
	buffer bytes.Buffer
}

func (b *lockedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buffer.Write(p)
}

func (b *lockedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buffer.String()
}

// logRecords decodes the JSON log lines written so far.
func logRecords(t *testing.T, logs *lockedBuffer) []map[string]any {
	t.Helper()
	var records []map[string]any
	for _, line := range strings.Split(strings.TrimSpace(logs.String()), "\n") {
		if line == "" {
			continue
		}
		var record map[string]any
		if err := json.Unmarshal([]byte(line), &record); err != nil {
			t.Fatal(err)
		}
		records = append(records, record)
	}
	return records
}

func failedRecords(t *testing.T, logs *lockedBuffer) []map[string]any {
	t.Helper()
	var failed []map[string]any
	for _, record := range logRecords(t, logs) {
		if record["msg"] == "Computer upgrade failed; retrying after backoff" {
			failed = append(failed, record)
		}
	}
	return failed
}

func waitForPhase(t *testing.T, manager *Manager, want phase) {
	t.Helper()
	eventually(t, func() bool {
		manager.mu.Lock()
		defer manager.mu.Unlock()
		return manager.phase == want
	})
}

// curlStageError is an installer exit that curl reports for a dropped download.
func curlStageError() error {
	return &StageError{Stage: "install", ExitCode: 18, Err: errors.New("exit status 18")}
}

func TestStartDelayIsDeterministicPerComputer(t *testing.T) {
	const window = 10 * time.Minute
	distinct := map[time.Duration]bool{}
	for i := range 20 {
		id := "computer-" + strings.Repeat("x", i)
		first := startDelay(id, window)
		if again := startDelay(id, window); again != first {
			t.Fatalf("startDelay(%q) changed from %s to %s", id, first, again)
		}
		if first < 0 || first >= window {
			t.Fatalf("startDelay(%q) = %s, want within [0, %s)", id, first, window)
		}
		distinct[first] = true
	}
	if len(distinct) < 2 {
		t.Fatalf("start delays collapsed to %d distinct values", len(distinct))
	}
	if startDelay("computer-a", 0) != 0 || startDelay("computer-a", -time.Minute) != 0 || startDelay("computer-a", 500*time.Millisecond) != 0 {
		t.Fatal("empty windows must not delay")
	}
}

func TestWelcomeWaitsStartDelayButBackoffRetryDoesNot(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX handoff and directory sync are not used by Windows upgrades")
	}
	// A window of a few seconds keeps the test short; the ID is chosen so the
	// delay is long enough to tell a retry apart from the first attempt.
	const window = 3 * time.Second
	computerID := ""
	for i := range 100 {
		candidate := "computer-" + strings.Repeat("y", i)
		if startDelay(candidate, window) >= 2*time.Second {
			computerID = candidate
			break
		}
	}
	if computerID == "" {
		t.Fatal("no computer ID with a long start delay")
	}
	delay := startDelay(computerID, window)

	root, executable := installRoot(t, "lib-old")
	stop := newStopSignal()
	var mu sync.Mutex
	var prepareTimes []time.Time
	stager := &fakeStager{
		stage: func(context.Context, StageRequest) error {
			mu.Lock()
			prepareTimes = append(prepareTimes, time.Now())
			attempt := len(prepareTimes)
			mu.Unlock()
			if attempt == 1 {
				return &StageError{Stage: "download", Err: errors.New("HTTP 503")}
			}
			return nil
		},
		activate: switchingActivate(t, root, "lib-new"),
	}
	options := testOptions(executable, &fakeAdmission{}, stager, stop.stop)
	options.ComputerID = computerID
	options.StartDelayWindow = window
	options.TransientBackoff = []time.Duration{10 * time.Millisecond}
	manager := New(options)

	welcomed := time.Now()
	manager.WelcomeAccepted(context.Background(), target("2.0.0"))
	stop.wait(t)

	mu.Lock()
	defer mu.Unlock()
	if len(prepareTimes) != 2 {
		t.Fatalf("prepare calls = %d, want 2", len(prepareTimes))
	}
	if wait := prepareTimes[0].Sub(welcomed); wait < delay {
		t.Fatalf("first prepare after %s, want at least the start delay %s", wait, delay)
	}
	if gap := prepareTimes[1].Sub(prepareTimes[0]); gap >= delay {
		t.Fatalf("retry waited %s, must not repeat the start delay %s", gap, delay)
	}
}

func TestTransientStageFailureClassification(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want bool
	}{
		{name: "curl 18 during install", err: curlStageError(), want: true},
		{name: "download", err: &StageError{Stage: "download", Err: errors.New("EOF")}, want: true},
		{name: "timeout", err: &StageError{Stage: "timeout", Err: context.DeadlineExceeded}, want: true},
		{name: "verify", err: &StageError{Stage: "verify", Err: errors.New("bad signature")}},
		{name: "install exit 1", err: &StageError{Stage: "install", ExitCode: 1, Err: errors.New("exit status 1")}},
		{name: "activate", err: &StageError{Stage: "activate", ExitCode: 18, Err: errors.New("exit status 18")}},
		{name: "plain error", err: errors.New("boom")},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := transientStageFailure(tc.err); got != tc.want {
				t.Fatalf("transient = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestTransientRetryDelaySchedule(t *testing.T) {
	for failures, want := range []time.Duration{time.Minute, 5 * time.Minute, 15 * time.Minute, time.Hour, time.Hour, time.Hour} {
		if got := transientRetryDelay(failures+1, transientBackoff, 0.5); got != want {
			t.Fatalf("failure %d delay = %s, want %s", failures+1, got, want)
		}
	}
	if got := transientRetryDelay(1, transientBackoff, 0); got != 48*time.Second {
		t.Fatalf("lowest jitter delay = %s, want 48s", got)
	}
	if got := transientRetryDelay(4, transientBackoff, 0.999999); got != time.Hour {
		t.Fatalf("highest jitter delay = %s, want the one hour cap", got)
	}
}

func TestTransientFailuresBackOffAndNonTransientUsesRetryDelay(t *testing.T) {
	_, executable := installRoot(t, "lib-old")
	logs := &lockedBuffer{}
	admission := &fakeAdmission{}
	var attempts atomic.Int32
	stager := &fakeStager{stage: func(context.Context, StageRequest) error {
		switch attempts.Add(1) {
		case 1, 2:
			return curlStageError()
		default:
			return &StageError{Stage: "install", ExitCode: 1, Err: errors.New("exit status 1")}
		}
	}}
	options := testOptions(executable, admission, stager, newStopSignal().stop)
	options.Logger = slog.New(slog.NewJSONHandler(logs, nil))
	options.Rand = func() float64 { return 0.5 }
	options.TransientBackoff = []time.Duration{10 * time.Millisecond, 20 * time.Millisecond, 40 * time.Millisecond}
	manager := New(options)

	manager.WelcomeAccepted(context.Background(), target("2.0.0"))
	eventually(t, func() bool { return stager.calls.Load() == 3 })
	waitForPhase(t, manager, phaseBackoff)
	if n := stager.calls.Load(); n != 3 {
		t.Fatalf("prepare calls = %d, want 3", n)
	}
	if _, resumes := admission.counts(); resumes != 3 {
		t.Fatalf("admission resumes = %d, want 3", resumes)
	}
	failed := failedRecords(t, logs)
	if len(failed) != 3 {
		t.Fatalf("failure logs = %d, want 3", len(failed))
	}
	wantRetry := []string{"10ms", "20ms", "1h0m0s"}
	wantTransient := []any{true, true, false}
	for index, record := range failed {
		if record["retry_in"] != wantRetry[index] || record["transient"] != wantTransient[index] {
			t.Fatalf("failure %d retry_in=%v transient=%v, want %s %v", index+1, record["retry_in"], record["transient"], wantRetry[index], wantTransient[index])
		}
	}
}

func TestActivateFailureResumesAdmissionAndDoesNotHandOff(t *testing.T) {
	_, executable := installRoot(t, "lib-old")
	logs := &lockedBuffer{}
	admission := &fakeAdmission{}
	stop := newStopSignal()
	stager := &fakeStager{activate: func(context.Context, *Prepared) error {
		return &StageError{Stage: "activate", ExitCode: 1, Err: errors.New("exit status 1")}
	}}
	options := testOptions(executable, admission, stager, stop.stop)
	options.Logger = slog.New(slog.NewJSONHandler(logs, nil))
	manager := New(options)

	manager.WelcomeAccepted(context.Background(), target("2.0.0"))
	waitForPhase(t, manager, phaseBackoff)
	if _, resumes := admission.counts(); resumes != 1 {
		t.Fatalf("admission resumes = %d, want 1", resumes)
	}
	failed := failedRecords(t, logs)
	if len(failed) != 1 || failed[0]["stage"] != "activate" || failed[0]["transient"] != false {
		t.Fatalf("failure logs = %v", failed)
	}
	if manager.Handoff() != nil || stop.fired() {
		t.Fatal("failed activation must not restart the daemon")
	}
}

func TestPrepareFailureResumesAdmissionAndLogsTransient(t *testing.T) {
	_, executable := installRoot(t, "lib-old")
	logs := &lockedBuffer{}
	admission := &fakeAdmission{}
	stager := &fakeStager{stage: func(context.Context, StageRequest) error { return curlStageError() }}
	options := testOptions(executable, admission, stager, newStopSignal().stop)
	options.Logger = slog.New(slog.NewJSONHandler(logs, nil))
	manager := New(options)

	manager.WelcomeAccepted(context.Background(), target("2.0.0"))
	waitForPhase(t, manager, phaseBackoff)
	if _, resumes := admission.counts(); resumes != 1 {
		t.Fatalf("admission resumes = %d, want 1", resumes)
	}
	if drains, _ := admission.counts(); drains != 0 {
		t.Fatalf("drain attempts = %d, want 0 when prepare fails", drains)
	}
	failed := failedRecords(t, logs)
	if len(failed) != 1 || failed[0]["transient"] != true || failed[0]["exit_code"] != float64(18) {
		t.Fatalf("failure logs = %v", failed)
	}
}

func TestCanceledWhileWaitingForIdleReturnsToIdle(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX handoff and directory sync are not used by Windows upgrades")
	}
	root, executable := installRoot(t, "lib-old")
	admission := &fakeAdmission{active: 1}
	stop := newStopSignal()
	stager := &fakeStager{activate: switchingActivate(t, root, "lib-new")}
	manager := New(testOptions(executable, admission, stager, stop.stop))

	ctx, cancel := context.WithCancel(context.Background())
	manager.WelcomeAccepted(ctx, target("2.0.0"))
	eventually(t, func() bool { drains, _ := admission.counts(); return drains >= 2 })
	cancel()
	waitForPhase(t, manager, phaseIdle)
	if n := stager.activations(); n != 0 {
		t.Fatalf("activations = %d, want 0", n)
	}
	if manager.Handoff() != nil || stop.fired() {
		t.Fatal("canceled upgrade must not hand off")
	}

	admission.setActive(0)
	manager.WelcomeAccepted(context.Background(), target("2.0.0"))
	stop.wait(t)
	if manager.Handoff() == nil {
		t.Fatal("a later welcome must be able to start the upgrade again")
	}
}

func TestNewerTargetDuringPrepareIsPreparedNext(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX handoff and directory sync are not used by Windows upgrades")
	}
	root, executable := installRoot(t, "lib-old")
	release := make(chan struct{})
	var attempts atomic.Int32
	stop := newStopSignal()
	stager := &fakeStager{
		stage: func(context.Context, StageRequest) error {
			if attempts.Add(1) == 1 {
				<-release
			}
			return nil
		},
		activate: switchingActivate(t, root, "lib-new"),
	}
	manager := New(testOptions(executable, &fakeAdmission{}, stager, stop.stop))

	manager.WelcomeAccepted(context.Background(), target("2.0.0"))
	eventually(t, func() bool { return stager.calls.Load() == 1 })
	manager.WelcomeAccepted(context.Background(), target("2.0.1"))
	close(release)
	stop.wait(t)

	prepared, activated := stager.targets()
	if want := shas("2.0.0", "2.0.1"); !slices.Equal(prepared, want) {
		t.Fatalf("prepared targets = %v, want %v", prepared, want)
	}
	if want := shas("2.0.1"); !slices.Equal(activated, want) {
		t.Fatalf("activated targets = %v, want %v", activated, want)
	}
}

func TestNewerTargetWhileWaitingForIdleIsPreparedNext(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX handoff and directory sync are not used by Windows upgrades")
	}
	root, executable := installRoot(t, "lib-old")
	var manager *Manager
	admission := &fakeAdmission{busy: []int{1}, onDrain: func(call int) {
		if call == 1 {
			manager.WelcomeAccepted(context.Background(), target("2.0.1"))
		}
	}}
	stop := newStopSignal()
	stager := &fakeStager{activate: switchingActivate(t, root, "lib-new")}
	manager = New(testOptions(executable, admission, stager, stop.stop))

	manager.WelcomeAccepted(context.Background(), target("2.0.0"))
	stop.wait(t)

	prepared, activated := stager.targets()
	if want := shas("2.0.0", "2.0.1"); !slices.Equal(prepared, want) {
		t.Fatalf("prepared targets = %v, want %v", prepared, want)
	}
	if want := shas("2.0.1"); !slices.Equal(activated, want) {
		t.Fatalf("activated targets = %v, want %v", activated, want)
	}
}

func TestConnectionLossDuringPrepareDoesNotCancelIt(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX handoff and directory sync are not used by Windows upgrades")
	}
	root, executable := installRoot(t, "lib-old")
	started := make(chan struct{}, 1)
	release := make(chan struct{})
	stop := newStopSignal()
	stager := &fakeStager{
		stage: func(ctx context.Context, _ StageRequest) error {
			started <- struct{}{}
			<-release
			return ctx.Err()
		},
		activate: switchingActivate(t, root, "lib-new"),
	}
	manager := New(testOptions(executable, &fakeAdmission{}, stager, stop.stop))

	manager.WelcomeAccepted(context.Background(), target("2.0.0"))
	<-started
	manager.ConnectionFailed(errors.New("gateway unreachable"), transport.FailureUnavailable)
	close(release)
	stop.wait(t)
	if manager.Handoff() == nil {
		t.Fatal("staging must complete after the connection was lost")
	}
}

func TestActivateTimeoutUsesRetryDelay(t *testing.T) {
	_, executable := installRoot(t, "lib-old")
	logs := &lockedBuffer{}
	stager := &fakeStager{activate: func(context.Context, *Prepared) error {
		return &StageError{Stage: "timeout", Err: context.DeadlineExceeded}
	}}
	options := testOptions(executable, &fakeAdmission{}, stager, newStopSignal().stop)
	options.Logger = slog.New(slog.NewJSONHandler(logs, nil))
	options.TransientBackoff = []time.Duration{10 * time.Millisecond}
	manager := New(options)

	manager.WelcomeAccepted(context.Background(), target("2.0.0"))
	waitForPhase(t, manager, phaseBackoff)
	failed := failedRecords(t, logs)
	if len(failed) != 1 || failed[0]["stage"] != "timeout" || failed[0]["transient"] != false || failed[0]["retry_in"] != "1h0m0s" {
		t.Fatalf("failure logs = %v, want a non-transient activate timeout", failed)
	}
}

func TestRunningBuildTargetWhileWaitingForIdleAbandonsAttempt(t *testing.T) {
	root, executable := installRoot(t, "lib-old")
	var manager *Manager
	admission := &fakeAdmission{busy: []int{1}, onDrain: func(call int) {
		if call == 1 {
			// The Agent rolled its target back to the running build.
			manager.WelcomeAccepted(context.Background(), target("lib-old"))
		}
	}}
	stop := newStopSignal()
	stager := &fakeStager{activate: switchingActivate(t, root, "lib-new")}
	manager = New(testOptions(executable, admission, stager, stop.stop))

	manager.WelcomeAccepted(context.Background(), target("2.0.0"))
	waitForPhase(t, manager, phaseIdle)
	prepared, activated := stager.targets()
	if want := shas("2.0.0"); !slices.Equal(prepared, want) || len(activated) != 0 {
		t.Fatalf("prepared=%v activated=%v, want only 2.0.0 prepared and nothing activated", prepared, activated)
	}
	if manager.Handoff() != nil || stop.fired() {
		t.Fatal("an abandoned upgrade must not hand off")
	}
}

func TestRunningBuildTargetDuringBackoffCancelsRetry(t *testing.T) {
	_, executable := installRoot(t, "lib-old")
	stager := &fakeStager{stage: func(context.Context, StageRequest) error { return curlStageError() }}
	options := testOptions(executable, &fakeAdmission{}, stager, newStopSignal().stop)
	options.TransientBackoff = []time.Duration{50 * time.Millisecond}
	manager := New(options)

	manager.WelcomeAccepted(context.Background(), target("2.0.0"))
	waitForPhase(t, manager, phaseBackoff)
	manager.WelcomeAccepted(context.Background(), target("lib-old"))
	waitForPhase(t, manager, phaseIdle)
	time.Sleep(150 * time.Millisecond)
	if n := stager.calls.Load(); n != 1 {
		t.Fatalf("prepare calls = %d, want the retry of 2.0.0 abandoned", n)
	}
}

// Windows compares the installer's installed-checksum, which covers both
// archives, and leaves the switch to the installer: no handoff follows.
func TestWindowsUpgradesByCombinedIdentityWithoutHandoff(t *testing.T) {
	root, _ := installRoot(t, "lib-old")
	executable := filepath.Join(root, "lib-old", "daemon", daemonEntry+".exe")
	writeFile(t, filepath.Join(root, "installed-checksum"), windowsReleaseID(buildSHA("1.0.0"), buildSHA("deps"))+"\n", 0o600)
	admission := &fakeAdmission{}
	activated := make(chan struct{})
	stager := &fakeStager{activate: func(ctx context.Context, _ *Prepared) error {
		close(activated)
		<-ctx.Done()
		return ctx.Err()
	}}
	stop := newStopSignal()
	options := testOptions(executable, admission, stager, stop.stop)
	options.GOOS = "windows"
	ctx, cancel := context.WithCancel(context.Background())

	New(options).WelcomeAccepted(ctx, windowsTarget("1.0.0"))
	time.Sleep(10 * time.Millisecond)
	if n := stager.calls.Load(); n != 0 {
		t.Fatalf("stage calls for the installed build = %d, want 0", n)
	}

	manager := New(options)
	manager.WelcomeAccepted(ctx, windowsTarget("2.0.0"))
	<-activated
	if got := stager.last.ID; got != windowsReleaseID(buildSHA("2.0.0"), buildSHA("deps")) {
		t.Fatalf("stage ID = %s", got)
	}
	// The installer stops the daemon, which cancels its context.
	cancel()
	time.Sleep(10 * time.Millisecond)
	if _, resumes := admission.counts(); resumes != 0 {
		t.Fatalf("resumes = %d, want 0 while the installer stops the daemon", resumes)
	}
	if manager.Handoff() != nil || stop.fired() {
		t.Fatal("Windows must not hand off")
	}
}

// The Windows installer records a rolled-back release in upgrade-failed; the
// restarted daemon waits out the cooldown for it.
func TestWindowsSkipsReleaseTheInstallerRolledBack(t *testing.T) {
	root, _ := installRoot(t, "lib-old")
	executable := filepath.Join(root, "lib-old", "daemon", daemonEntry+".exe")
	writeFile(t, filepath.Join(root, "installed-checksum"), windowsReleaseID(buildSHA("1.0.0"), buildSHA("deps"))+"\n", 0o600)
	failed := windowsReleaseID(buildSHA("2.0.0"), buildSHA("deps"))
	writeFile(t, filepath.Join(root, upgradeFailedFile), `{"app_sha256":"`+failed+`","failed_at":"`+time.Now().UTC().Format(time.RFC3339Nano)+`"}`+"\n", 0o600)
	stager := &fakeStager{}
	options := testOptions(executable, &fakeAdmission{}, stager, func() {})
	options.GOOS = "windows"

	manager := New(options)
	manager.WelcomeAccepted(context.Background(), windowsTarget("2.0.0"))
	time.Sleep(10 * time.Millisecond)
	if n := stager.calls.Load(); n != 0 {
		t.Fatalf("stage calls = %d, want 0 during the cooldown", n)
	}
	manager.WelcomeAccepted(context.Background(), windowsTarget("3.0.0"))
	eventually(t, func() bool { return stager.calls.Load() == 1 })
}

// Windows activation is owned by the installer; cancellation represents the
// installer stopping this daemon after the common prepare and drain stages.
func windowsManagerFixture(t *testing.T, admission Admission, stager Stager) (*Manager, context.Context, context.CancelFunc) {
	t.Helper()
	root, _ := installRoot(t, "lib-old")
	executable := filepath.Join(root, "lib-old", "daemon", daemonEntry+".exe")
	writeFile(t, filepath.Join(root, windowsReleaseIDFile), windowsReleaseID(buildSHA("lib-old"), buildSHA("deps"))+"\n", 0o600)
	options := testOptions(executable, admission, stager, newStopSignal().stop)
	options.GOOS = "windows"
	ctx, cancel := context.WithCancel(t.Context())
	return New(options), ctx, cancel
}

func TestWindowsSingleFlightWaitsWhileBusy(t *testing.T) {
	admission := &fakeAdmission{busy: []int{2, 1}}
	release := make(chan struct{})
	activated := make(chan struct{})
	var drainsAtPrepare, drainsAtActivate int
	stager := &fakeStager{stage: func(ctx context.Context, _ StageRequest) error {
		drainsAtPrepare, _ = admission.counts()
		select {
		case <-release:
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	}, activate: func(ctx context.Context, _ *Prepared) error {
		drainsAtActivate, _ = admission.counts()
		close(activated)
		<-ctx.Done()
		return ctx.Err()
	}}
	manager, ctx, cancel := windowsManagerFixture(t, admission, stager)
	defer cancel()
	manager.WelcomeAccepted(ctx, windowsTarget("2.0.0"))
	manager.WelcomeAccepted(ctx, windowsTarget("2.0.0"))
	eventually(t, func() bool { return stager.calls.Load() == 1 })
	manager.WelcomeAccepted(ctx, windowsTarget("2.0.0"))
	close(release)
	select {
	case <-activated:
	case <-time.After(5 * time.Second):
		t.Fatal("installer was not activated")
	}
	if stager.calls.Load() != 1 || drainsAtPrepare != 0 || drainsAtActivate != 3 {
		t.Fatalf("prepares=%d prepare drains=%d activate drains=%d", stager.calls.Load(), drainsAtPrepare, drainsAtActivate)
	}
	if manager.Handoff() != nil {
		t.Fatal("Windows must not hand off")
	}
}

func TestWindowsNewerTargetDuringPrepareIsPreparedNext(t *testing.T) {
	release, activated := make(chan struct{}), make(chan struct{})
	var attempts atomic.Int32
	stager := &fakeStager{stage: func(ctx context.Context, _ StageRequest) error {
		if attempts.Add(1) == 1 {
			select {
			case <-release:
			case <-ctx.Done():
				return ctx.Err()
			}
		}
		return nil
	}, activate: func(ctx context.Context, _ *Prepared) error { close(activated); <-ctx.Done(); return ctx.Err() }}
	manager, ctx, cancel := windowsManagerFixture(t, &fakeAdmission{}, stager)
	defer cancel()
	manager.WelcomeAccepted(ctx, windowsTarget("2.0.0"))
	eventually(t, func() bool { return stager.calls.Load() == 1 })
	manager.WelcomeAccepted(ctx, windowsTarget("2.0.1"))
	close(release)
	select {
	case <-activated:
	case <-time.After(5 * time.Second):
		t.Fatal("installer was not activated")
	}
	prepared, actual := stager.targets()
	want := shas("2.0.0", "2.0.1")
	if !slices.Equal(prepared, want) || !slices.Equal(actual, want[1:]) {
		t.Fatalf("prepared=%v activated=%v want=%v", prepared, actual, want)
	}
}

func TestWindowsNewerTargetWhileWaitingForIdleIsPreparedNext(t *testing.T) {
	var manager *Manager
	var ctx context.Context
	admission := &fakeAdmission{busy: []int{1}, onDrain: func(call int) {
		if call == 1 {
			manager.WelcomeAccepted(ctx, windowsTarget("2.0.1"))
		}
	}}
	activated := make(chan struct{})
	stager := &fakeStager{activate: func(ctx context.Context, _ *Prepared) error { close(activated); <-ctx.Done(); return ctx.Err() }}
	var cancel context.CancelFunc
	manager, ctx, cancel = windowsManagerFixture(t, admission, stager)
	defer cancel()
	manager.WelcomeAccepted(ctx, windowsTarget("2.0.0"))
	select {
	case <-activated:
	case <-time.After(5 * time.Second):
		t.Fatal("installer was not activated")
	}
	prepared, actual := stager.targets()
	want := shas("2.0.0", "2.0.1")
	if !slices.Equal(prepared, want) || !slices.Equal(actual, want[1:]) {
		t.Fatalf("prepared=%v activated=%v want=%v", prepared, actual, want)
	}
}

func TestWindowsCanceledWhileWaitingForIdleCanRetry(t *testing.T) {
	admission := &fakeAdmission{active: 1}
	activated := make(chan struct{})
	stager := &fakeStager{activate: func(ctx context.Context, _ *Prepared) error { close(activated); <-ctx.Done(); return ctx.Err() }}
	manager, ctx, cancel := windowsManagerFixture(t, admission, stager)
	manager.WelcomeAccepted(ctx, windowsTarget("2.0.0"))
	eventually(t, func() bool { drains, _ := admission.counts(); return drains >= 2 })
	cancel()
	waitForPhase(t, manager, phaseIdle)
	if stager.activations() != 0 || manager.Handoff() != nil {
		t.Fatal("canceled upgrade activated or handed off")
	}
	admission.setActive(0)
	retry, stop := context.WithCancel(t.Context())
	defer stop()
	manager.WelcomeAccepted(retry, windowsTarget("2.0.0"))
	select {
	case <-activated:
	case <-time.After(5 * time.Second):
		t.Fatal("later welcome did not activate")
	}
}

func TestWindowsConnectionLossDuringPrepareDoesNotCancelIt(t *testing.T) {
	started, release, activated := make(chan struct{}), make(chan struct{}), make(chan struct{})
	stager := &fakeStager{stage: func(ctx context.Context, _ StageRequest) error {
		close(started)
		select {
		case <-release:
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	}, activate: func(ctx context.Context, _ *Prepared) error { close(activated); <-ctx.Done(); return ctx.Err() }}
	manager, ctx, cancel := windowsManagerFixture(t, &fakeAdmission{}, stager)
	defer cancel()
	manager.WelcomeAccepted(ctx, windowsTarget("2.0.0"))
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("prepare did not start")
	}
	manager.ConnectionFailed(errors.New("gateway unreachable"), transport.FailureUnavailable)
	close(release)
	select {
	case <-activated:
	case <-time.After(5 * time.Second):
		t.Fatal("connection loss prevented activation")
	}
}
