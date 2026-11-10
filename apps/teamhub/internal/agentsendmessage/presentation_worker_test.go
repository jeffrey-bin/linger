package agentsendmessage

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// passRecorder records when drivePresentation runs a pass and answers with
// scripted waits and errors.
type passRecorder struct {
	mu     sync.Mutex
	times  []time.Time
	answer func(call int) (time.Duration, error)
	calls  chan int
}

func newPassRecorder(answer func(call int) (time.Duration, error)) *passRecorder {
	return &passRecorder{answer: answer, calls: make(chan int, 64)}
}

func (r *passRecorder) pass(context.Context) (time.Duration, error) {
	r.mu.Lock()
	r.times = append(r.times, time.Now())
	call := len(r.times)
	r.mu.Unlock()
	r.calls <- call
	return r.answer(call)
}

func (r *passRecorder) waitCall(t *testing.T, want int, within time.Duration) time.Time {
	t.Helper()
	deadline := time.After(within)
	for {
		select {
		case call := <-r.calls:
			if call == want {
				r.mu.Lock()
				defer r.mu.Unlock()
				return r.times[call-1]
			}
		case <-deadline:
			t.Fatalf("pass %d did not run within %v", want, within)
		}
	}
}

func startDriver(t *testing.T, wake chan struct{}, idle, retry time.Duration, recorder *passRecorder, report func(error)) {
	t.Helper()
	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan struct{})
	go func() {
		defer close(done)
		drivePresentation(ctx, wake, idle, retry, recorder.pass, report)
	}()
	t.Cleanup(func() {
		cancel()
		<-done
	})
}

func TestDrivePresentationRunsAtOnceAfterWake(t *testing.T) {
	wake := make(chan struct{}, 1)
	recorder := newPassRecorder(func(int) (time.Duration, error) { return time.Hour, nil })
	startDriver(t, wake, time.Hour, time.Second, recorder, nil)
	recorder.waitCall(t, 1, 30*time.Second)
	woken := time.Now()
	wake <- struct{}{}
	if ran := recorder.waitCall(t, 2, 30*time.Second); ran.Sub(woken) > time.Second {
		t.Fatalf("pass after wake took %v", ran.Sub(woken))
	}
}

func TestDrivePresentationSleepsUntilTheNextDueItem(t *testing.T) {
	const due = 200 * time.Millisecond
	recorder := newPassRecorder(func(call int) (time.Duration, error) {
		if call == 1 {
			return due, nil
		}
		return time.Hour, nil
	})
	startDriver(t, make(chan struct{}, 1), time.Hour, time.Second, recorder, nil)
	first := recorder.waitCall(t, 1, 30*time.Second)
	if second := recorder.waitCall(t, 2, 30*time.Second); second.Sub(first) < due {
		t.Fatalf("pass ran %v after the previous one, before the item was due", second.Sub(first))
	}
}

func TestDrivePresentationFallsBackWithoutWake(t *testing.T) {
	const idle = 100 * time.Millisecond
	recorder := newPassRecorder(func(int) (time.Duration, error) { return time.Hour, nil })
	startDriver(t, make(chan struct{}, 1), idle, time.Second, recorder, nil)
	first := recorder.waitCall(t, 1, 30*time.Second)
	if second := recorder.waitCall(t, 2, 30*time.Second); second.Sub(first) < idle {
		t.Fatalf("fallback pass ran after %v, want at least %v", second.Sub(first), idle)
	}
}

func TestDrivePresentationBacksOffAfterErrors(t *testing.T) {
	const retry = 40 * time.Millisecond
	const idle = 160 * time.Millisecond
	failure := errors.New("database unavailable")
	var reported atomic.Int32
	recorder := newPassRecorder(func(int) (time.Duration, error) { return 0, failure })
	startDriver(t, make(chan struct{}, 1), idle, retry, recorder, func(err error) {
		if !errors.Is(err, failure) {
			t.Errorf("reported %v", err)
		}
		reported.Add(1)
	})
	times := make([]time.Time, 5)
	for call := range times {
		times[call] = recorder.waitCall(t, call+1, 30*time.Second)
	}
	// Each failed pass is reported before the driver sleeps.
	if got := reported.Load(); got < 4 {
		t.Fatalf("reported %d failures, want at least 4", got)
	}
	for call, want := range []time.Duration{retry, 2 * retry, idle, idle} {
		if gap := times[call+1].Sub(times[call]); gap < want {
			t.Fatalf("retry %d ran after %v, want at least %v", call+1, gap, want)
		}
	}
}
