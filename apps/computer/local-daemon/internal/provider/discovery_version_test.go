package provider

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"testing"
)

func TestVersionProbeTimedOutRejectsOtherFailures(t *testing.T) {
	for _, tc := range []struct {
		name  string
		err   error
		retry bool
	}{
		{"attempt deadline", fmt.Errorf("probe: %w", context.DeadlineExceeded), true},
		{"cancellation", fmt.Errorf("probe: %w", context.Canceled), false},
		{"pipe deadline", exec.ErrWaitDelay, false},
		{"execution failure", errors.New("exit status 7"), false},
		{"unconfirmed cleanup", fmt.Errorf("probe: %w", errors.Join(context.DeadlineExceeded, errors.New("owned command cleanup could not be confirmed"))), false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := versionProbeTimedOut(tc.err); got != tc.retry {
				t.Fatalf("retry=%v, want %v", got, tc.retry)
			}
		})
	}
}
