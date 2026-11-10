package externalsource

import (
	"context"
	"errors"
	"net/http"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/composio"
)

// A run's outcome is only its result: a rate limit leaves it retry_wait for
// the caller to run again, every other provider error fails it.
func TestImportRunSettlesInMemory(t *testing.T) {
	service := &Service{}
	limited := &importRun{Provider: "slack"}
	var retry importRetryError
	if err := service.retryImport(t.Context(), limited, &composio.RateLimitError{RetryAfter: time.Minute}); !errors.As(err, &retry) ||
		limited.result.Status != "retry_wait" || limited.result.LastErrorCode != "provider_rate_limited" {
		t.Fatalf("rate limit: err=%v result=%+v", err, limited.result)
	}
	failed := &importRun{Provider: "slack"}
	if err := service.retryImport(t.Context(), failed, composio.RemoteStatusError("list Slack conversations", http.StatusUnauthorized)); err != nil ||
		failed.result.Status != "failed" || failed.result.LastErrorCode != "provider_auth_failed" {
		t.Fatalf("auth failure: err=%v result=%+v", err, failed.result)
	}
}

func TestImportJobRetryPolicyWaitsOnlyForRateLimits(t *testing.T) {
	// An import has one attempt per Profile run: only a rate
	// limit waits for the next run, every other provider error is terminal.
	tests := []struct {
		name         string
		cause        error
		wantCode     string
		wantTerminal bool
	}{
		{name: "composio rate limit", cause: &composio.RateLimitError{RetryAfter: time.Minute}, wantCode: "provider_rate_limited"},
		{name: "unavailable", cause: errors.New("provider unavailable"), wantCode: "provider_unavailable", wantTerminal: true},
		{name: "insufficient permission", cause: composio.RemoteStatusError("list Gmail threads", http.StatusForbidden), wantCode: "provider_auth_failed", wantTerminal: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if code, terminal := importRetryPolicy(test.cause); code != test.wantCode || terminal != test.wantTerminal {
				t.Fatalf("policy code=%q terminal=%t want code=%q terminal=%t", code, terminal, test.wantCode, test.wantTerminal)
			}
		})
	}
}

func TestAllSelectedGitHubRepositoriesAvailable(t *testing.T) {
	available := map[string]composio.GitHubRepository{"repo-1": {RepositoryID: "repo-1"}, "unselected": {RepositoryID: "unselected"}}
	if !allSelectedGitHubRepositoriesAvailable(available, []GitHubRepositorySelection{{RepositoryID: "repo-1"}}) {
		t.Fatal("selected repository should stop pagination")
	}
	if allSelectedGitHubRepositoriesAvailable(available, []GitHubRepositorySelection{{RepositoryID: "repo-1"}, {RepositoryID: "repo-2"}}) {
		t.Fatal("missing selected repository should continue pagination")
	}
	if !allSelectedGitHubRepositoriesAvailable(available, nil) {
		t.Fatal("profile-only import should not paginate repositories")
	}
}

func TestAppProviderContextErrorsRemainRecoverable(t *testing.T) {
	service := &Service{}
	for _, cause := range []error{context.Canceled, context.DeadlineExceeded} {
		t.Run(cause.Error(), func(t *testing.T) {
			for _, err := range []error{cause, errors.Join(errors.New("provider request ended"), cause)} {
				if got := service.handleAppProviderError(t.Context(), &importRun{Provider: "google_calendar"}, err); !errors.Is(got, err) {
					t.Fatalf("Provider context error changed: got=%v want=%v", got, err)
				}
			}
		})
	}
}

func TestGmailProviderErrorClass(t *testing.T) {
	tests := []struct {
		name   string
		cause  error
		status int
		want   string
	}{
		{name: "budget", cause: composio.ErrProviderCallBudgetExhausted, want: "provider_call_budget_exhausted"},
		{name: "timeout", cause: context.DeadlineExceeded, want: "provider_timeout"},
		{name: "rate limited", cause: &composio.RateLimitError{RetryAfter: time.Second}, want: "provider_rate_limited"},
		{name: "auth", cause: composio.RemoteStatusError("get Gmail thread", http.StatusForbidden), status: http.StatusForbidden, want: "provider_auth_failed"},
		{name: "provider 5xx", cause: composio.RemoteStatusError("get Gmail thread", http.StatusBadGateway), status: http.StatusBadGateway, want: "provider_5xx"},
		{name: "transport", cause: errors.New("connection reset"), want: "provider_unavailable"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := gmailProviderErrorClass(test.cause, test.status); got != test.want {
				t.Fatalf("class=%q want=%q", got, test.want)
			}
		})
	}
}
