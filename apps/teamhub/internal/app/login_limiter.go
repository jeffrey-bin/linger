package app

import (
	"sync"
	"time"
)

const (
	loginFailureLimit  = 10
	loginFailureWindow = 15 * time.Minute
	// Each Argon2id computation holds 64 MiB. Login, password change and the
	// decoy hash for a missing Account share these permits.
	passwordHashPermits = 2
	passwordHashWait    = 5 * time.Second
)

// loginFailures counts failed logins per client address. A deployment runs
// one TeamHub process, so the counts live in memory and reset on restart.
// Counting per address rather than per Account keeps one person's typos from
// locking the deployment's only Account for everyone.
type loginFailures struct {
	mu      sync.Mutex
	windows map[string]failureWindow
	pruned  time.Time
	now     func() time.Time
}

type failureWindow struct {
	started time.Time
	count   int
}

func newLoginFailures() *loginFailures {
	return &loginFailures{windows: map[string]failureWindow{}, now: time.Now}
}

// retryAfter returns how long the address must wait, or zero when it may log in.
func (f *loginFailures) retryAfter(address string) time.Duration {
	f.mu.Lock()
	defer f.mu.Unlock()
	window, ok := f.windows[address]
	if !ok || window.count < loginFailureLimit {
		return 0
	}
	return max(0, window.started.Add(loginFailureWindow).Sub(f.now()))
}

// fail counts a failed login. Expired windows are dropped at most once per
// window length, so many addresses cost one scan per window.
func (f *loginFailures) fail(address string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	now := f.now()
	if now.Sub(f.pruned) >= loginFailureWindow {
		for key, window := range f.windows {
			if !now.Before(window.started.Add(loginFailureWindow)) {
				delete(f.windows, key)
			}
		}
		f.pruned = now
	}
	window, ok := f.windows[address]
	if !ok || !now.Before(window.started.Add(loginFailureWindow)) {
		window = failureWindow{started: now}
	}
	window.count++
	f.windows[address] = window
}

// succeed clears the address after a successful login.
func (f *loginFailures) succeed(address string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.windows, address)
}
