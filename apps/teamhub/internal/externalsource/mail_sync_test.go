package externalsource

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/composio"
)

func TestMailSyncDueIsTheLatestNightlyTime(t *testing.T) {
	night := time.Date(2026, 11, 4, 23, 30, 0, 0, time.Local)
	for now, want := range map[time.Time]time.Time{
		time.Date(2026, 11, 4, 23, 45, 0, 0, time.Local): night,
		night: night,
		time.Date(2026, 11, 4, 23, 29, 59, 0, time.Local): night.AddDate(0, 0, -1),
		time.Date(2026, 11, 5, 8, 0, 0, 0, time.Local):    night,
		time.Date(2026, 11, 5, 0, 5, 0, 0, time.Local):    night,
	} {
		if got := mailSyncDue(now); !got.Equal(want) {
			t.Errorf("mailSyncDue(%s)=%s, want %s", now, got, want)
		}
	}
}

func TestMailSyncFailureRetriesOnlyWhatRetryingCanFix(t *testing.T) {
	service := &Service{logger: slog.New(slog.DiscardHandler)}
	job := &importRun{ConnectionID: "connection", Provider: "gmail"}
	for _, test := range []struct {
		name  string
		cause error
		retry bool
	}{
		{name: "server error", cause: composio.RemoteStatusError("read mail import message", http.StatusBadGateway), retry: true},
		{name: "rate limit", cause: &composio.RateLimitError{RetryAfter: time.Minute}, retry: true},
		{name: "stale revision", cause: ErrStaleRevision},
		{name: "auth", cause: composio.RemoteStatusError("read mail import message", http.StatusUnauthorized)},
		{name: "budget exhausted", cause: composio.ErrProviderCallBudgetExhausted},
	} {
		t.Run(test.name, func(t *testing.T) {
			err := service.mailSyncFailure(context.Background(), job, test.cause)
			if (err != nil) != test.retry || err != nil && !errors.Is(err, test.cause) {
				t.Fatalf("mailSyncFailure()=%v, want retry=%t", err, test.retry)
			}
		})
	}
}
