package selfupdate

import (
	"context"
	"errors"
	"fmt"
	"hash/fnv"
	"io/fs"
	"log/slog"
	"math/rand/v2"
	"os"
	"runtime"
	"sync"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/transport"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/protocol"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider/redact"
)

const (
	defaultIdleInterval  = 15 * time.Second
	defaultConfirmWindow = 3 * time.Minute
	defaultRetryDelay    = time.Hour
	// defaultStartDelayWindow spreads the first prepare of a fleet-wide release
	// so the download load on the Agent Service does not arrive in one burst.
	defaultStartDelayWindow = 10 * time.Minute
	// maxTransientRetryDelay caps the transient backoff schedule with jitter.
	maxTransientRetryDelay = time.Hour
	// maxPendingStarts is how often the upgraded daemon may start without a
	// confirmation. Supervisors give up after a few fast exits (supervisord
	// after three), so the rollback must come before that.
	maxPendingStarts = 2
	// maxConfirmationWait bounds how long an unavailable Gateway may postpone
	// the confirmation, counted from the switch. It outlasts a Gateway deploy
	// or a short network outage, while a release whose own regression looks
	// like an outage keeps the Computer offline for at most this long; a wrong
	// rollback only costs the failedRetryCooldown.
	maxConfirmationWait = time.Hour
	// failedRetryCooldown is how long a rolled-back target waits before the
	// daemon stages it again; a failure may have been local and transient.
	failedRetryCooldown = 12 * time.Hour
)

// Admission is the daemon surface the upgrade needs: close admissions only when
// idle, and reopen them when an attempt is abandoned.
type Admission interface {
	DrainIfIdle() int
	ResumeAdmission()
}

// Options wires the manager to the running process. Stop cancels the daemon's
// Run loop; the caller then performs the shutdown and any Handoff.
type Options struct {
	// ReleaseVersion is the linked release version, logged with a skip. A
	// development build never upgrades itself because it does not run from an
	// installed bundle with an app-sha256.
	ReleaseVersion string
	GOOS           string
	// Executable is os.Executable(); it must sit at <root>/lib-*/daemon/.
	Executable string
	// ConfigPath is the absolute --config path, reused in the rebuilt service command.
	ConfigPath string
	// Args and Env are the process arguments and environment to hand over.
	Args      []string
	Env       []string
	Admission Admission
	Stager    Stager
	Stop      func()
	Logger    *slog.Logger
	// ComputerID seeds the deterministic start delay that spreads fleet upgrades.
	ComputerID string

	IdleInterval  time.Duration
	ConfirmWindow time.Duration
	Now           func() time.Time
	// RetryDelay applies to failures that retrying soon will not fix.
	RetryDelay time.Duration
	// StartDelayWindow spreads the first prepare over this window; zero or less
	// selects defaultStartDelayWindow and a window under a second disables it.
	StartDelayWindow time.Duration
	// TransientBackoff is the schedule for network failures; empty selects
	// transientBackoff.
	TransientBackoff []time.Duration
	// Rand returns a value in [0, 1) for the backoff jitter; nil selects math/rand.
	Rand func() float64
}

// transientBackoff is the retry schedule for network failures, before jitter.
var transientBackoff = []time.Duration{time.Minute, 5 * time.Minute, 15 * time.Minute, time.Hour}

type phase int

const (
	phaseIdle phase = iota
	phaseRunning
	phaseBackoff
	phaseHandoff
)

// Manager runs at most one upgrade attempt per process and decides whether a
// staged bundle has been confirmed or must be rolled back.
type Manager struct {
	options   Options
	logger    *slog.Logger
	layout    layout
	layoutErr error
	// appSHA256 is the running bundle's identity; appSHA256Err reports why it
	// is unreadable.
	appSHA256    string
	appSHA256Err error

	mu           sync.Mutex
	phase        phase
	pending      *upgradePending
	confirmTimer *time.Timer
	retryTimer   *time.Timer
	// cooldownTimer retries a rolled-back target once its cooldown ends.
	cooldownTimer *time.Timer
	handoff       *Handoff
	// failedSHA256 is the app sha256 of the rolled-back build in cooldown.
	failedSHA256 string
	failedAt     time.Time
	// gatewayUnavailable reports that the last connection before welcome
	// ended for a reason that says nothing about this release.
	gatewayUnavailable bool
	// attemptStartedAt is when the connection attempt in flight started; zero
	// once it ended.
	attemptStartedAt time.Time
	// pendingSince is when this process loaded the marker; it bounds the
	// postponements when the wall clock was set back.
	pendingSince time.Time
	skipLogged   map[string]bool
	// asked is the latest target the Agent sent; retries follow it.
	asked *protocol.TargetRelease
	// wantTarget is the build the current attempt works toward; empty when the
	// Agent's latest target is the running build or names none for this
	// platform. An attempt in flight checks it before each drain and stops when
	// it changed.
	wantTarget StageRequest
	// transientFailures counts consecutive network failures for the backoff.
	transientFailures int
}

// New resolves the install layout and, when a previous upgrade is awaiting
// confirmation, arms the rollback deadline.
func New(options Options) *Manager {
	options = options.withDefaults()
	manager := &Manager{options: options, logger: options.Logger, skipLogged: map[string]bool{}}
	manager.layout, manager.layoutErr = layoutFor(options.Executable)
	if manager.layoutErr == nil {
		if options.GOOS == "windows" {
			manager.appSHA256, manager.appSHA256Err = manager.layout.readWindowsReleaseID()
		} else {
			manager.appSHA256, manager.appSHA256Err = manager.layout.readAppSHA256(manager.layout.bundle)
		}
		manager.mu.Lock()
		manager.loadPending()
		manager.loadFailed()
		manager.mu.Unlock()
	}
	return manager
}

func (o Options) withDefaults() Options {
	if o.Logger == nil {
		o.Logger = slog.Default()
	}
	if o.Now == nil {
		o.Now = time.Now
	}
	if o.IdleInterval <= 0 {
		o.IdleInterval = defaultIdleInterval
	}
	if o.ConfirmWindow <= 0 {
		o.ConfirmWindow = defaultConfirmWindow
	}
	if o.RetryDelay <= 0 {
		o.RetryDelay = defaultRetryDelay
	}
	if o.StartDelayWindow <= 0 {
		o.StartDelayWindow = defaultStartDelayWindow
	}
	if len(o.TransientBackoff) == 0 {
		o.TransientBackoff = transientBackoff
	}
	if o.Rand == nil {
		o.Rand = rand.Float64
	}
	return o
}

// RecoverAtStartup runs before any daemon initialization that can fail. It
// counts the start of an unconfirmed upgrade and rolls it back when its
// confirmation deadline has passed or the upgraded daemon keeps restarting,
// which covers a daemon that exits before New reads the marker. The caller
// must execute a returned Handoff at once.
func RecoverAtStartup(options Options) *Handoff {
	options = options.withDefaults()
	if options.GOOS == "windows" {
		return nil
	}
	installed, err := layoutFor(options.Executable)
	if err != nil {
		return nil //nolint:nilerr // outside the managed install layout there is no upgrade to recover
	}
	// New discards unreadable and stale markers.
	marker, err := installed.readPending()
	if err != nil {
		return nil //nolint:nilerr // New discards an unreadable marker; nothing to roll back here
	}
	if own, err := installed.readAppSHA256(installed.bundle); err != nil || own != marker.TargetAppSHA256 {
		return nil //nolint:nilerr // only the upgrade target counts its starts; New discards a stale marker
	}
	marker.StartAttempts++
	reason := ""
	if marker.StartAttempts > maxPendingStarts {
		reason = fmt.Sprintf("the upgraded daemon started %d times without runner.welcome", marker.StartAttempts)
	} else if !options.Now().Before(marker.deadline(options.ConfirmWindow)) {
		reason = "no runner.welcome before the confirmation deadline"
	}
	if reason == "" {
		if err := installed.writePending(marker); err != nil {
			options.Logger.Warn("record Computer upgrade start failed", "error", redact.Text(err.Error()))
		}
		return nil
	}
	handoff, _ := rollbackTo(installed, options, marker, reason)
	return handoff
}

func (m *Manager) loadPending() {
	marker, err := m.layout.readPending()
	if errors.Is(err, fs.ErrNotExist) {
		return
	}
	if err != nil {
		m.logger.Warn("discarded Computer upgrade marker", "error", redact.Text(err.Error()))
		m.layout.removePending(m.logger)
		return
	}
	if marker.TargetAppSHA256 != m.appSHA256 {
		m.logger.Info("discarded stale Computer upgrade marker", "target_app_sha256", marker.TargetAppSHA256, "app_sha256", m.appSHA256)
		m.layout.removePending(m.logger)
		return
	}
	m.pending = marker
	m.pendingSince = m.options.Now()
	// Only what is left of the window since the switch; a clock set back must
	// not stretch it beyond its length.
	remaining := min(max(marker.deadline(m.options.ConfirmWindow).Sub(m.options.Now()), 0), m.options.ConfirmWindow)
	m.confirmTimer = time.AfterFunc(remaining, m.confirmationDeadline)
	m.logger.Info("Computer upgrade awaiting confirmation", "target_app_sha256", marker.TargetAppSHA256)
}

// loadFailed restores the rolled-back target unless the running bundle is that
// build, in which case the record is obsolete.
func (m *Manager) loadFailed() {
	record, err := m.layout.readFailed()
	if errors.Is(err, fs.ErrNotExist) {
		return
	}
	if err != nil {
		m.logger.Warn("discarded Computer upgrade failure record", "error", redact.Text(err.Error()))
		m.removeFailed()
		return
	}
	if record.AppSHA256 == m.appSHA256 {
		m.removeFailed()
		return
	}
	m.failedSHA256 = record.AppSHA256
	m.failedAt, _ = time.Parse(time.RFC3339, record.FailedAt)
}

func (m *Manager) removeFailed() {
	if err := os.Remove(m.layout.failedPath()); err != nil && !errors.Is(err, fs.ErrNotExist) {
		m.logger.Warn("remove Computer upgrade failure record failed", "error", redact.Text(err.Error()))
	}
	m.failedSHA256 = ""
}

func (l layout) removePending(logger *slog.Logger) {
	if err := os.Remove(l.pendingPath()); err != nil && !errors.Is(err, fs.ErrNotExist) {
		logger.Warn("remove Computer upgrade marker failed", "error", redact.Text(err.Error()))
	}
}

// WelcomeAccepted confirms a pending upgrade and starts an upgrade when the
// Agent targets another build for this platform.
func (m *Manager) WelcomeAccepted(ctx context.Context, target *protocol.TargetRelease) {
	m.mu.Lock()
	if m.pending != nil {
		m.confirmTimer.Stop()
		m.pending = nil
		m.layout.removePending(m.logger)
		m.logger.Info("Computer upgrade confirmed", "app_sha256", m.appSHA256)
	}
	m.asked = target
	m.mu.Unlock()
	m.maybeUpgrade(ctx, target, true)
}

// ConnectionStarted reports a new connection attempt.
func (m *Manager) ConnectionStarted() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.attemptStartedAt = m.options.Now()
}

// ConnectionFailed reports a connection that ended before welcome. While an
// upgrade awaits confirmation, a protocol refusal rolls it back at once.
func (m *Manager) ConnectionFailed(err error, failure transport.ConnectionFailure) {
	if failure == transport.FailureIncompatible {
		m.rollback("Gateway rejected this release before welcome: " + redact.Text(err.Error()))
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.gatewayUnavailable = failure == transport.FailureUnavailable
	m.attemptStartedAt = time.Time{}
}

// confirmationDeadline rolls back an unconfirmed upgrade unless the last
// connection could not reach the Gateway. That is no evidence against the new
// release, so the deadline moves one window on, up to maxConfirmationWait
// after the switch, and is kept across restarts.
func (m *Manager) confirmationDeadline() {
	m.mu.Lock()
	now := m.options.Now()
	// An attempt in flight for a whole window has not ended with an outage, so
	// the earlier outage no longer explains the missing welcome.
	unavailable := m.gatewayUnavailable && (m.attemptStartedAt.IsZero() || now.Sub(m.attemptStartedAt) < m.options.ConfirmWindow)
	if m.pending != nil && m.handoff == nil && unavailable {
		marker := m.pending
		limit := marker.postponeLimit()
		if now.Before(limit) && now.Sub(m.pendingSince) < maxConfirmationWait {
			confirmBy := now.Add(m.options.ConfirmWindow)
			if limit.Before(confirmBy) {
				confirmBy = limit
			}
			// The start count is kept: a restart loop after a postponement
			// still rolls back at the start limit.
			marker.ConfirmBy = confirmBy.UTC().Format(time.RFC3339)
			if err := m.layout.writePending(marker); err != nil {
				m.logger.Warn("record Computer upgrade confirmation deadline failed", "error", redact.Text(err.Error()))
			}
			m.confirmTimer = time.AfterFunc(confirmBy.Sub(now), m.confirmationDeadline)
			m.logger.Info("Computer upgrade confirmation waits for the Gateway", "target_app_sha256", marker.TargetAppSHA256, "confirm_by", marker.ConfirmBy)
			m.mu.Unlock()
			return
		}
		m.mu.Unlock()
		m.rollback("no runner.welcome within the confirmation limit while the Gateway was unavailable")
		return
	}
	m.mu.Unlock()
	m.rollback("no runner.welcome before the confirmation deadline")
}

func (m *Manager) rollback(reason string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.pending == nil || m.handoff != nil {
		return
	}
	marker := m.pending
	m.confirmTimer.Stop()
	handoff, settled := rollbackTo(m.layout, m.options, marker, reason)
	if !settled {
		return
	}
	m.pending = nil
	if handoff == nil {
		return
	}
	m.failedSHA256 = marker.TargetAppSHA256
	m.failedAt = m.options.Now()
	m.setHandoff(handoff)
}

// rollbackTo returns the install to the marker's previous bundle and records
// the target as failed. settled reports that the marker is gone; the handoff
// is nil when there is no previous daemon to run.
func rollbackTo(installed layout, options Options, marker *upgradePending, reason string) (*Handoff, bool) {
	logger := options.Logger
	if !isExecutableFile(installed.daemonPath(marker.PreviousBundle)) {
		logger.Error("previous Computer bundle is missing; staying on the upgraded bundle", "previous_bundle", marker.PreviousBundle)
		installed.removePending(logger)
		return nil, true
	}
	handoff, err := handoffFor(installed, options, marker.PreviousBundle)
	if err != nil {
		logger.Error("prepare rollback handoff failed", "error", redact.Text(err.Error()))
		return nil, false
	}
	if err := installed.writeActiveBundle(marker.PreviousBundle); err != nil {
		logger.Error("restore previous Computer bundle failed", "previous_bundle", marker.PreviousBundle, "error", redact.Text(err.Error()))
		return nil, false
	}
	installed.removePending(logger)
	if err := installed.writeFailed(marker.TargetAppSHA256, options.Now()); err != nil {
		logger.Error("record failed Computer upgrade failed", "target_app_sha256", marker.TargetAppSHA256, "error", redact.Text(err.Error()))
	}
	logger.Warn("rolled back Computer upgrade", "reason", reason, "target_app_sha256", marker.TargetAppSHA256, "previous_bundle", marker.PreviousBundle)
	return handoff, true
}

// Handoff returns the process replacement to run after shutdown, or nil.
func (m *Manager) Handoff() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.handoff == nil {
		return nil
	}
	return m.handoff
}

func (m *Manager) setHandoff(handoff *Handoff) {
	m.handoff = handoff
	m.phase = phaseHandoff
	if m.options.Stop != nil {
		m.options.Stop()
	}
}

// maybeUpgrade starts an attempt toward this platform's build in release, or
// records it as the wanted target when an attempt is already running.
// delayStart is false only for a backoff retry, which must not wait the start
// delay again.
func (m *Manager) maybeUpgrade(ctx context.Context, release *protocol.TargetRelease, delayStart bool) {
	if release == nil {
		return
	}
	request, reason := m.targetFor(release)
	if reason != "" {
		m.skipOnce(reason)
		return
	}
	if request.ID == "" || request.ID == m.appSHA256 {
		// No build for this platform, or the running one: any attempt toward
		// another build stops.
		m.mu.Lock()
		m.wantTarget = StageRequest{}
		m.stopBackoffLocked()
		m.mu.Unlock()
		return
	}
	m.mu.Lock()
	failed, failedAt := m.failedSHA256, m.failedAt
	m.mu.Unlock()
	if failed == request.ID {
		retryAt := failedAt.Add(failedRetryCooldown)
		// A clock set back must not stretch the cooldown.
		if wait := min(retryAt.Sub(m.options.Now()), failedRetryCooldown); wait > 0 {
			m.skipOnce("Computer upgrade to app " + failed + " was rolled back; retrying after " + retryAt.UTC().Format(time.RFC3339))
			m.retryAfterCooldown(ctx, wait)
			return
		}
	}
	origin, reason := m.preconditions()
	if reason != "" {
		m.skipOnce(reason)
		return
	}
	request.Root, request.WebOrigin = m.layout.root, origin
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.wantTarget.ID != request.ID {
		// A backoff toward another build is abandoned; the new target starts now.
		m.stopBackoffLocked()
	}
	m.wantTarget = request
	if m.phase != phaseIdle {
		return
	}
	m.phase = phaseRunning
	go m.upgrade(ctx, delayStart)
}

// targetFor picks this platform's archives from release, or returns why the
// daemon cannot tell. ID is empty when release has no entry for it.
func (m *Manager) targetFor(release *protocol.TargetRelease) (StageRequest, string) {
	target, err := releaseTarget(m.options.GOOS, runtime.GOARCH)
	if err != nil {
		return StageRequest{}, err.Error()
	}
	if m.layoutErr != nil {
		return StageRequest{}, m.layoutErr.Error()
	}
	if m.appSHA256Err != nil {
		return StageRequest{}, "running bundle app-sha256 is unavailable: " + m.appSHA256Err.Error()
	}
	files, ok := release.Targets[target]
	if !ok {
		return StageRequest{}, ""
	}
	if !digestPattern.MatchString(files.App.SHA256) || files.App.Size <= 0 ||
		!digestPattern.MatchString(files.Deps.SHA256) || files.Deps.Size <= 0 {
		return StageRequest{}, "target_release entry for " + target + " is invalid"
	}
	id := files.App.SHA256
	if m.options.GOOS == "windows" {
		id = windowsReleaseID(files.App.SHA256, files.Deps.SHA256)
	}
	return StageRequest{ID: id, Target: target, App: files.App, Deps: files.Deps}, ""
}

// preconditions returns the Web origin to fetch from, or the reason the daemon
// must not upgrade itself.
func (m *Manager) preconditions() (string, string) {
	active, err := m.layout.readActiveBundle()
	if err != nil {
		return "", "active-bundle is unavailable: " + err.Error()
	}
	if active != m.layout.bundle {
		return "", "active-bundle does not name the running daemon's bundle"
	}
	origin, err := m.layout.readWebOrigin()
	if err != nil {
		return "", err.Error()
	}
	return origin, ""
}

func (m *Manager) skipOnce(reason string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.skipLogged[reason] {
		return
	}
	m.skipLogged[reason] = true
	m.logger.Info("Computer self-update skipped", "reason", reason, "release_version", m.options.ReleaseVersion, "app_sha256", m.appSHA256)
}

// upgrade prepares the wanted build while admissions stay open, then drains
// and activates it. A changed target seen before the drain replaces the
// prepared build, so only the Agent's latest one is ever activated.
func (m *Manager) upgrade(ctx context.Context, delayStart bool) {
	if delayStart {
		delay := startDelay(m.options.ComputerID, m.options.StartDelayWindow)
		m.logger.Info("Computer upgrade scheduled", "target_app_sha256", m.currentTarget().ID, "start_delay", delay.String())
		if !sleepContext(ctx, delay) {
			m.setPhase(phaseIdle)
			return
		}
	}
	for {
		request := m.currentTarget()
		target := request.ID
		if target == "" {
			m.logger.Info("Computer upgrade abandoned; the target changed", "app_sha256", m.appSHA256)
			m.setPhase(phaseIdle)
			return
		}
		m.logger.Info("Computer upgrade preparing", "target_app_sha256", target)
		prepared, err := m.options.Stager.Prepare(ctx, request)
		if err != nil {
			m.fail(ctx, target, err, transientStageFailure(err))
			return
		}
		m.mu.Lock()
		m.transientFailures = 0
		m.mu.Unlock()
		switch m.waitForIdle(ctx, target) {
		case idleCanceled:
			m.setPhase(phaseIdle)
			return
		case idleChanged:
			continue
		}
		// Activate runs no network step, so none of its failures is transient.
		if err := m.options.Stager.Activate(ctx, prepared); err != nil {
			if ctx.Err() != nil {
				// The daemon is stopping; on Windows the installer stopped it.
				return
			}
			m.fail(ctx, target, err, false)
			return
		}
		m.activated(ctx, target)
		return
	}
}

// activated hands off to the switched bundle once Activate succeeded.
func (m *Manager) activated(ctx context.Context, target string) {
	bundle, err := m.stagedBundle()
	if err != nil {
		m.fail(ctx, target, &StageError{Stage: "verify", Err: err}, false)
		return
	}
	handoff, err := handoffFor(m.layout, m.options, bundle)
	if err != nil {
		m.fail(ctx, target, &StageError{Stage: "verify", Err: err}, false)
		return
	}
	m.mu.Lock()
	if m.failedSHA256 != "" {
		m.removeFailed()
	}
	m.setHandoff(handoff)
	m.mu.Unlock()
	m.logger.Info("Computer upgrade staged; restarting into the new bundle", "target_app_sha256", target, "bundle", bundle)
}

type idleResult int

const (
	idleDrained idleResult = iota
	idleCanceled
	idleChanged
)

// waitForIdle closes admissions as soon as no Operation is active or prepared.
// Until then admissions stay open and the Agent keeps dispatching. It
// checks for a changed target before each drain, so a superseded build is never
// activated; a canceled context returns before closing admissions.
func (m *Manager) waitForIdle(ctx context.Context, target string) idleResult {
	logged := false
	for {
		if ctx.Err() != nil {
			return idleCanceled
		}
		if m.currentTarget().ID != target {
			return idleChanged
		}
		active := m.options.Admission.DrainIfIdle()
		if active == 0 {
			return idleDrained
		}
		if !logged {
			logged = true
			m.logger.Info("Computer upgrade waiting for active Operations", "target_app_sha256", target, "active_operations", active)
		}
		if !sleepContext(ctx, m.options.IdleInterval) {
			return idleCanceled
		}
	}
}

func (m *Manager) currentTarget() StageRequest {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.wantTarget
}

// sleepContext waits for d and reports false when ctx ends first.
func sleepContext(ctx context.Context, d time.Duration) bool {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

// startDelay spreads the first prepare of a build across the fleet. The
// delay is fixed per computer, so restarts do not reshuffle it.
func startDelay(computerID string, window time.Duration) time.Duration {
	if window < time.Second {
		return 0
	}
	seconds := uint64(window / time.Second)
	hash := fnv.New64a()
	_, _ = hash.Write([]byte(computerID))
	return time.Duration(hash.Sum64()%seconds) * time.Second
}

// transientStageFailure reports whether retrying a failed prepare soon may
// succeed: a download or timeout, or an installer exit from curl's network and
// transfer errors. Verification failures are not transient.
func transientStageFailure(err error) bool {
	var stageError *StageError
	if !errors.As(err, &stageError) {
		return false
	}
	switch stageError.Stage {
	case "download", "timeout":
		return true
	case "install":
		switch stageError.ExitCode {
		case 5, 6, 7, 18, 22, 28, 35, 52, 55, 56, 92:
			return true
		}
	}
	return false
}

// transientRetryDelay returns the delay before retry number failures (1-based),
// spread by jitter in [0.8, 1.2) and capped at maxTransientRetryDelay.
func transientRetryDelay(failures int, schedule []time.Duration, jitter float64) time.Duration {
	index := min(failures-1, len(schedule)-1)
	delay := time.Duration(float64(schedule[index]) * (0.8 + 0.4*jitter))
	return min(delay, maxTransientRetryDelay)
}

func (m *Manager) stagedBundle() (string, error) {
	bundle, err := m.layout.readActiveBundle()
	if err != nil {
		return "", err
	}
	if bundle == m.layout.bundle {
		return "", errors.New("active-bundle still names the running bundle")
	}
	if !isExecutableFile(m.layout.daemonPath(bundle)) {
		return "", errors.New("staged bundle has no executable daemon")
	}
	return bundle, nil
}

// fail resumes admissions and schedules the next attempt. Every failure resumes
// them, since a prepare failure never closed them and a failed activate may have.
func (m *Manager) fail(ctx context.Context, target string, err error, transient bool) {
	attributes := []any{"target_app_sha256", target, "stage", "verify", "exit_code", 0, "error", redact.Text(err.Error())}
	var stageError *StageError
	if errors.As(err, &stageError) {
		attributes = []any{"target_app_sha256", target, "stage", stageError.Stage, "exit_code", stageError.ExitCode, "error", redact.Text(err.Error())}
		if stageError.OutputTail != "" {
			attributes = append(attributes, "output_tail", redact.Text(stageError.OutputTail))
		}
	}
	if ctx.Err() == nil {
		m.options.Admission.ResumeAdmission()
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	var delay time.Duration
	if transient {
		m.transientFailures++
		delay = transientRetryDelay(m.transientFailures, m.options.TransientBackoff, m.options.Rand())
	} else {
		delay = m.options.RetryDelay
	}
	attributes = append(attributes, "transient", transient, "retry_in", delay.String())
	m.logger.Warn("Computer upgrade failed; retrying after backoff", attributes...)
	m.phase = phaseBackoff
	m.retryTimer = time.AfterFunc(delay, func() { m.retry(ctx) })
}

// stopBackoffLocked abandons a scheduled retry. The caller holds m.mu.
func (m *Manager) stopBackoffLocked() {
	if m.phase != phaseBackoff {
		return
	}
	m.retryTimer.Stop()
	m.phase = phaseIdle
}

// retryAfterCooldown asks again once the cooldown ends. It leaves the phase
// alone so a newer target can still start meanwhile.
func (m *Manager) retryAfterCooldown(ctx context.Context, wait time.Duration) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.cooldownTimer != nil {
		m.cooldownTimer.Stop()
	}
	m.cooldownTimer = time.AfterFunc(wait, func() {
		if ctx.Err() == nil {
			m.maybeUpgrade(ctx, m.askedTarget(), true)
		}
	})
}

func (m *Manager) retry(ctx context.Context) {
	if ctx.Err() != nil {
		return
	}
	m.mu.Lock()
	if m.phase != phaseBackoff {
		m.mu.Unlock()
		return
	}
	m.phase = phaseIdle
	asked := m.asked
	m.mu.Unlock()
	m.maybeUpgrade(ctx, asked, false)
}

func (m *Manager) askedTarget() *protocol.TargetRelease {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.asked
}

func (m *Manager) setPhase(next phase) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.phase = next
}

func handoffFor(installed layout, options Options, bundle string) (*Handoff, error) {
	command, err := installed.serviceCommandFor(bundle, options.ConfigPath)
	if err != nil {
		return nil, err
	}
	path := installed.daemonPath(bundle)
	args := []string{path}
	if len(options.Args) > 1 {
		args = append(args, options.Args[1:]...)
	}
	return &Handoff{Path: path, Args: args, Env: withEnv(options.Env, serviceCommandEnv, command)}, nil
}
