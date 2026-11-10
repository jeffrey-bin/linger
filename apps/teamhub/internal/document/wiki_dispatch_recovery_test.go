package document

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/jobs"
)

func TestWikiDispatchDeterministicErrorsAreTerminal(t *testing.T) {
	for _, err := range []error{ErrInvalidInput, ErrWikiCandidateTerminal, ErrWikiCandidateInvalidRequest} {
		if !isWikiCandidateTerminal(fmt.Errorf("wrapped: %w", err)) {
			t.Fatalf("not terminal: %v", err)
		}
	}
	if isWikiCandidateTerminal(errors.New("network timeout")) {
		t.Fatal("transport should remain retryable")
	}
}

func TestWikiDispatchWaitsForOfflineComputerWithoutSpendingAttempts(t *testing.T) {
	now := time.Date(2026, 11, 3, 12, 0, 0, 0, time.UTC)
	offline := fmt.Errorf("wrapped: %w", ErrWikiCandidateComputerOffline)
	for _, testCase := range []struct {
		name      string
		err       error
		attempt   int
		createdAt time.Time
		want      wikiDispatchAction
	}{
		{name: "offline waits", err: offline, attempt: 1, createdAt: now.Add(-time.Hour), want: wikiDispatchWaitForComputer},
		{name: "offline on the last attempt still waits", err: offline, attempt: 5, createdAt: now.Add(-time.Hour), want: wikiDispatchWaitForComputer},
		{name: "offline past the wait limit fails", err: offline, attempt: 1, createdAt: now.Add(-jobs.ComputerOfflineWaitLimit), want: wikiDispatchFail},
		{name: "transport retries", err: errors.New("timeout"), attempt: 1, createdAt: now, want: wikiDispatchRetry},
		{name: "transport on the last attempt fails", err: errors.New("timeout"), attempt: 5, createdAt: now, want: wikiDispatchFail},
		{name: "terminal fails", err: ErrWikiCandidateTerminal, attempt: 1, createdAt: now, want: wikiDispatchFail},
		{name: "a stopping LLM Wiki waits", err: ErrWikiCandidateServiceStopping, attempt: 5, createdAt: now.Add(-time.Hour), want: wikiDispatchWaitForRestart},
		{name: "a stopping LLM Wiki past the wait limit fails", err: ErrWikiCandidateServiceStopping, attempt: 1, createdAt: now.Add(-jobs.ComputerOfflineWaitLimit), want: wikiDispatchFail},
		{name: "replaced frozen source fails at once", err: &wikiSourceReadError{code: "object_mismatch", err: errFrozenWikiSourceReplaced}, attempt: 1, createdAt: now, want: wikiDispatchFail},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			if got := wikiDispatchFailureAction(testCase.err, testCase.attempt, 5, testCase.createdAt, now); got != testCase.want {
				t.Fatalf("action=%d want %d", got, testCase.want)
			}
		})
	}
	_, _, code, err := validateWikiCandidateGenerationResult("refresh", WikiCandidateGenerationResult{}, offline)
	if code != "candidate_unavailable" || !errors.Is(err, ErrWikiCandidateComputerOffline) || isWikiCandidateTerminal(err) {
		t.Fatalf("code=%s error=%v", code, err)
	}
}

func TestWikiCandidateGenerationResultPreservesFailureCodeAndRetrySemantics(t *testing.T) {
	transportErr := errors.New("LLM transport failed")
	sourceErr := errors.New("frozen source could not be read")
	valid := WikiCandidateGenerationResult{RefreshID: "refresh", Pages: []WikiPageCandidate{
		{PageKey: "index.md", Markdown: []byte("# Index\n")},
	}}
	for _, testCase := range []struct {
		name         string
		result       WikiCandidateGenerationResult
		err          error
		wantCode     string
		wantCause    error
		wantRuntime  bool
		wantTerminal bool
	}{
		{name: "valid", result: valid},
		{name: "terminal", result: valid, err: fmt.Errorf("wrapped: %w", ErrWikiCandidateTerminal), wantCode: "candidate_unavailable", wantCause: ErrWikiCandidateTerminal, wantTerminal: true},
		{name: "invalid frozen input", result: valid, err: fmt.Errorf("wrapped: %w", ErrWikiCandidateInvalidRequest), wantCode: "candidate_invalid", wantCause: ErrWikiCandidateInvalidRequest, wantTerminal: true},
		{name: "transport", result: valid, err: transportErr, wantCode: "candidate_unavailable", wantCause: transportErr, wantRuntime: true},
		{name: "source read", result: valid, err: fmt.Errorf("wrapped: %w", &wikiSourceReadError{code: "object_unavailable", err: sourceErr}), wantCode: "object_unavailable", wantCause: sourceErr},
		{name: "wrong refresh", result: WikiCandidateGenerationResult{RefreshID: "other", Pages: valid.Pages}, wantCode: "candidate_unavailable", wantCause: ErrRuntimeUnavailable, wantRuntime: true},
		{name: "request TeamHub refuses", result: valid, err: fmt.Errorf("wrapped: %w", ErrInvalidInput), wantCode: "candidate_invalid", wantCause: ErrInvalidInput, wantTerminal: true},
		{name: "invalid page", result: WikiCandidateGenerationResult{RefreshID: "refresh", Pages: []WikiPageCandidate{{PageKey: "index.md"}}}, wantCode: "candidate_invalid", wantCause: ErrWikiCandidateInvalidRequest, wantTerminal: true},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			pages, _, code, err := validateWikiCandidateGenerationResult("refresh", testCase.result, testCase.err)
			if code != testCase.wantCode || isWikiCandidateTerminal(err) != testCase.wantTerminal {
				t.Fatalf("code=%s terminal=%t error=%v", code, isWikiCandidateTerminal(err), err)
			}
			if testCase.wantCause == nil {
				if err != nil || len(pages) != 1 || pages[0].PageKey != "index.md" || string(pages[0].Markdown) != "# Index\n" {
					t.Fatalf("pages=%+v error=%v", pages, err)
				}
				return
			}
			if len(pages) != 0 || !errors.Is(err, testCase.wantCause) || errors.Is(err, ErrRuntimeUnavailable) != testCase.wantRuntime {
				t.Fatalf("pages=%+v error=%v cause=%v runtime=%t", pages, err, testCase.wantCause, errors.Is(err, ErrRuntimeUnavailable))
			}
		})
	}
}

// Generated pages are checked once, sorted in byte order and hashed as a set,
// so the hash does not depend on the order the generator returned them in.
func TestWikiCandidateGenerationResultSortsAndHashesPages(t *testing.T) {
	pages := []WikiPageCandidate{
		{PageKey: "topics/a_b.md", Markdown: []byte("# B\n")},
		{PageKey: "index.md", Markdown: []byte("# Index\n")},
		{PageKey: "topics/a-b.md", Markdown: []byte("# A\n")},
	}
	sorted, hash, code, err := validateWikiCandidateGenerationResult("refresh", WikiCandidateGenerationResult{RefreshID: "refresh", Pages: pages}, nil)
	if err != nil || code != "" || len(sorted) != 3 || sorted[0].PageKey != "index.md" ||
		sorted[1].PageKey != "topics/a-b.md" || sorted[2].PageKey != "topics/a_b.md" || len(hash) != 64 {
		t.Fatalf("pages=%+v hash=%q code=%q error=%v", sorted, hash, code, err)
	}
	_, reversedHash, _, err := validateWikiCandidateGenerationResult("refresh", WikiCandidateGenerationResult{
		RefreshID: "refresh", Pages: []WikiPageCandidate{pages[2], pages[1], pages[0]},
	}, nil)
	if err != nil || reversedHash != hash {
		t.Fatalf("reordered hash=%q want %q error=%v", reversedHash, hash, err)
	}
}

func TestWikiSourceIntentChangesAfterFailureOrPublication(t *testing.T) {
	first := wikiSourceRefreshIntentKey("sync", "hash", "", "")
	retry := wikiSourceRefreshIntentKey("sync", "hash", "", "failed-a")
	if first == retry || retry == wikiSourceRefreshIntentKey("sync", "hash", "", "failed-b") {
		t.Fatal("failed generation reused its intent")
	}
	if retry == wikiSourceRefreshIntentKey("sync", "hash", "revision-a", "failed-a") {
		t.Fatal("settled generation replayed obsolete admission")
	}
	if retry != wikiSourceRefreshIntentKey("sync", "hash", "", "failed-a") {
		t.Fatal("transport retry changed idempotency")
	}
}

func TestWikiTransactionRetriesSerializationAndDeadlocksOnly(t *testing.T) {
	for _, code := range []string{"40001", "40P01"} {
		calls := 0
		err := retryWikiTransaction(t.Context(), func() error {
			calls++
			if calls == 1 {
				return &pgconn.PgError{Code: code}
			}
			return nil
		})
		if err != nil || calls != 2 {
			t.Fatalf("code=%s calls=%d error=%v", code, calls, err)
		}
	}
	calls := 0
	err := retryWikiTransaction(t.Context(), func() error { calls++; return ErrVersionConflict })
	if !errors.Is(err, ErrVersionConflict) || calls != 1 {
		t.Fatalf("CAS conflict retried: %d %v", calls, err)
	}
	calls = 0
	err = retryWikiTransaction(t.Context(), func() error { calls++; return &pgconn.PgError{Code: "40001"} })
	if err == nil || calls != memoryWikiTransactionAttempts {
		t.Fatalf("unbounded SQLSTATE retries: %d %v", calls, err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	err = retryWikiTransaction(ctx, func() error { return &pgconn.PgError{Code: "40001"} })
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("retry ignored cancellation: %v", err)
	}
}

// A duplicate run whose candidate set differs from the frozen one must retry,
// not fail the refresh: the next attempt reuses the frozen set.
func TestWikiDuplicateCandidateConflictIsRetryable(t *testing.T) {
	if isWikiCandidateTerminal(fmt.Errorf("wrapped: %w", ErrIdempotencyConflict)) {
		t.Fatal("a frozen candidate hash mismatch must be a retryable conflict")
	}
}

// River's rescuer ignores a running job until its own Timeout has elapsed since
// attempted_at (river v0.49 internal/maintenance/job_rescuer.go makeRetryDecision),
// and it looks only at jobs running longer than the client's rescue horizon.
// The dispatch timeout must exceed that horizon so a long generation is not
// rescued while it is still running.
func TestWikiRefreshDispatchTimeoutExceedsRescueHorizon(t *testing.T) {
	horizon := jobs.RescueStuckJobsAfter
	worker := &wikiRefreshDispatchWorker{dispatcher: &WikiRefreshDispatcher{options: WikiRefreshDispatchOptions{
		GenerationTimeout: 4 * time.Hour,
	}}}
	if timeout := worker.Timeout(nil); timeout <= horizon {
		t.Fatalf("dispatch timeout %s must exceed the rescue horizon %s", timeout, horizon)
	}
}
