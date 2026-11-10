package document

import (
	"context"
	"errors"
	"testing"
	"testing/synctest"
	"time"
)

func TestWikiSourceImportWaitKeepsDefaultBudgetAndPollingInterval(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		started := time.Now()
		calls := 0
		err := waitForWikiSourceImports(t.Context(), func(awaitImports bool) (bool, error) {
			elapsed := time.Since(started)
			if want := time.Duration(calls) * 100 * time.Millisecond; elapsed != want {
				t.Fatalf("poll %d at %s, want %s", calls, elapsed, want)
			}
			if awaitImports != (elapsed < 5*time.Second) {
				t.Fatalf("awaitImports=%t after %s", awaitImports, elapsed)
			}
			calls++
			return !awaitImports, nil
		})
		if err != nil || time.Since(started) != 5*time.Second || calls != 51 {
			t.Fatalf("wait error=%v elapsed=%s polls=%d", err, time.Since(started), calls)
		}
	})
}

func TestWikiSourceImportWaitStopsWhenReadyOrPreparationFails(t *testing.T) {
	for _, testCase := range []struct {
		name      string
		readyPoll int
		err       error
	}{
		{name: "already ready", readyPoll: 1},
		{name: "import completes", readyPoll: 3},
		{name: "preparation fails", readyPoll: 2, err: errors.New("binding failed")},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				started := time.Now()
				calls := 0
				err := waitForWikiSourceImports(t.Context(), func(awaitImports bool) (bool, error) {
					if !awaitImports {
						t.Fatal("source preparation reached the import deadline")
					}
					calls++
					if calls == testCase.readyPoll {
						return true, testCase.err
					}
					return false, nil
				})
				if !errors.Is(err, testCase.err) || calls != testCase.readyPoll ||
					time.Since(started) != time.Duration(testCase.readyPoll-1)*100*time.Millisecond {
					t.Fatalf("wait error=%v elapsed=%s polls=%d", err, time.Since(started), calls)
				}
			})
		})
	}
}

func TestWikiSourceImportWaitHonorsCancellationAndCallerDeadline(t *testing.T) {
	for _, testCase := range []struct {
		name string
		err  error
	}{
		{name: "cancelled", err: context.Canceled},
		{name: "deadline", err: context.DeadlineExceeded},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				var ctx context.Context
				var cancel context.CancelFunc
				if errors.Is(testCase.err, context.Canceled) {
					ctx, cancel = context.WithCancel(t.Context())
					go func() {
						time.Sleep(250 * time.Millisecond)
						cancel()
					}()
				} else {
					ctx, cancel = context.WithTimeout(t.Context(), 250*time.Millisecond)
				}
				defer cancel()
				calls := 0
				err := waitForWikiSourceImports(ctx, func(awaitImports bool) (bool, error) {
					if !awaitImports {
						t.Fatal("cancelled request reached exclusion/admission")
					}
					calls++
					return false, nil
				})
				if !errors.Is(err, testCase.err) || calls != 3 {
					t.Fatalf("wait error=%v polls=%d", err, calls)
				}
			})
		})
	}
}
