package app

import (
	"testing"
	"time"
)

func TestLoginFailuresLimitEachAddressForOneWindow(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	failures := newLoginFailures()
	failures.now = func() time.Time { return now }
	for range loginFailureLimit {
		if wait := failures.retryAfter("198.51.100.1"); wait != 0 {
			t.Fatalf("an address under the limit must not wait, got %s", wait)
		}
		failures.fail("198.51.100.1")
	}
	if wait := failures.retryAfter("198.51.100.1"); wait != loginFailureWindow {
		t.Fatalf("retry after = %s, want the rest of the window", wait)
	}
	if wait := failures.retryAfter("198.51.100.2"); wait != 0 {
		t.Fatalf("another address must not wait, got %s", wait)
	}
	failures.fail("198.51.100.2")
	failures.succeed("198.51.100.2")
	if _, ok := failures.windows["198.51.100.2"]; ok {
		t.Fatal("a successful login must clear its address")
	}

	now = now.Add(loginFailureWindow)
	if wait := failures.retryAfter("198.51.100.1"); wait != 0 {
		t.Fatalf("the limit must end with its window, got %s", wait)
	}
	failures.fail("198.51.100.3")
	if _, ok := failures.windows["198.51.100.1"]; ok {
		t.Fatal("an expired window must be dropped")
	}
	if window := failures.windows["198.51.100.3"]; window.count != 1 {
		t.Fatalf("new failure window = %+v", window)
	}
}
