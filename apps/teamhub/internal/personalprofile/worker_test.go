package personalprofile

import (
	"testing"
	"time"
)

func TestEmptyImportFailureCodeUsesPermissionError(t *testing.T) {
	if got := emptyImportFailureCode(true); got != "PROVIDER_AUTH_FAILED" {
		t.Fatalf("auth failed code=%q", got)
	}
	if got := emptyImportFailureCode(false); got != "NO_IMPORT_CONTENT" {
		t.Fatalf("empty import code=%q", got)
	}
}

func TestAttemptsExhaustedCapsUnsettledRuns(t *testing.T) {
	for attempt := 1; attempt <= MaxGenerationAttempts; attempt++ {
		if attemptsExhausted(attempt) {
			t.Fatalf("attempt %d must still run", attempt)
		}
	}
	if !attemptsExhausted(MaxGenerationAttempts + 1) {
		t.Fatalf("attempt %d after %d unsettled runs must settle the generation instead of running", MaxGenerationAttempts+1, MaxGenerationAttempts)
	}
}

func TestImportWaitExpiresAfterDeadline(t *testing.T) {
	started := time.Date(2026, 10, 16, 10, 0, 0, 0, time.UTC)
	if importWaitExpired(started, started.Add(ImportWaitDeadline-time.Second)) {
		t.Fatal("import wait expired before the deadline")
	}
	if !importWaitExpired(started, started.Add(ImportWaitDeadline)) {
		t.Fatal("import wait must fail at the deadline instead of requeueing forever")
	}
	if importWaitExpired(time.Time{}, started) {
		t.Fatal("an unstarted generation has no import wait to expire")
	}
}

func TestDefaultInputBudgetsFitTheirModelContexts(t *testing.T) {
	options := New(nil, nil, nil).options
	if options.MaxInput != 512<<10 || options.MaxInsightInput != 128<<10 {
		t.Fatalf("MaxInput=%d MaxInsightInput=%d", options.MaxInput, options.MaxInsightInput)
	}
}
