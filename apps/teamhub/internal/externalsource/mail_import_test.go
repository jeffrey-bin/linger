package externalsource

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/composio"
)

func TestMailImportRetryDelayIsBounded(t *testing.T) {
	for attempt, want := range map[int]time.Duration{1: 5 * time.Second, 2: 10 * time.Second, 5: 80 * time.Second, 6: 2 * time.Minute, 25: 2 * time.Minute, 1000: 2 * time.Minute} {
		if got := mailImportRetryDelay(attempt); got != want {
			t.Fatalf("mailImportRetryDelay(%d)=%s want=%s", attempt, got, want)
		}
	}
}

func TestMailImportTransientRetriesOnlyRecoverableProviderFailures(t *testing.T) {
	for _, test := range []struct {
		name  string
		cause error
		want  bool
	}{
		{name: "server error", cause: composio.RemoteStatusError("read mail import message", http.StatusBadGateway), want: true},
		{name: "network", cause: errors.New("Composio read mail import message request failed"), want: true},
		{name: "per-call deadline", cause: fmt.Errorf("call: %w", context.DeadlineExceeded), want: true},
		{name: "stale revision", cause: ErrStaleRevision},
		{name: "cancelled", cause: context.Canceled},
		{name: "budget exhausted", cause: composio.ErrProviderCallBudgetExhausted},
		{name: "auth", cause: composio.RemoteStatusError("read mail import message", http.StatusUnauthorized)},
		{name: "provider terminal", cause: permanentProviderErrorForTest{}},
		{name: "rate limit", cause: &composio.RateLimitError{RetryAfter: time.Minute}},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := mailImportTransient(test.cause); got != test.want {
				t.Fatalf("mailImportTransient()=%t want=%t", got, test.want)
			}
		})
	}
}

type permanentProviderErrorForTest struct{}

func (permanentProviderErrorForTest) Error() string          { return "permanent provider failure" }
func (permanentProviderErrorForTest) ProviderTerminal() bool { return true }
