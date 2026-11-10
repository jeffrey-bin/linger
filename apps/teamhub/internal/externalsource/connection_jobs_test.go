package externalsource

import (
	"errors"
	"slices"
	"testing"
	"time"

	"github.com/riverqueue/river"
	"github.com/riverqueue/river/rivertype"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/composio"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/jobs"
)

func TestConnectionReconcileRetryDelayMatchesPersistedBackoff(t *testing.T) {
	connectionID := "connection_jitter_a"
	upstreamID := "upstream_jitter_b"
	if connectionReconcileRetryDelay(connectionID, 3, time.Minute) == connectionReconcileRetryDelay(upstreamID, 3, time.Minute) {
		t.Fatal("test IDs must produce different jitter below the hourly floor")
	}
	if connectionReconcileRetryDelay(connectionID, 8, time.Minute) == connectionReconcileRetryDelay(upstreamID, 8, time.Minute) {
		t.Fatal("test IDs must produce different jitter above the hourly floor")
	}
	worker := &connectionReconcileWorker{}
	cause := errors.New("temporary")
	for _, attempt := range []int{1, 4, connectionCheckHourlyRetryAttempt, 8} {
		check := &connectionCheck{
			connection:       Connection{ID: connectionID, UpstreamConnectionID: upstreamID, Provider: "gmail"},
			attempt:          attempt,
			hourlyRetryFloor: true,
		}
		persisted := check.failed("identity_refresh", cause)
		riverDelay := connectionReconcileRetryDelay(connectionID, attempt, time.Minute)
		if persisted != riverDelay {
			t.Fatalf("attempt=%d persisted=%s river=%s", attempt, persisted, riverDelay)
		}
		if persisted == connectionReconcileRetryDelay(upstreamID, attempt, time.Minute) && persisted != connectionCheckHourlyRetryDelay {
			t.Fatalf("attempt=%d delay used upstream id jitter", attempt)
		}
		job := &river.Job[ConnectionReconcileArgs]{
			JobRow: &rivertype.JobRow{Attempt: attempt},
			Args:   ConnectionReconcileArgs{ConnectionID: connectionID},
		}
		until := time.Until(worker.NextRetry(job))
		if until < riverDelay-20*time.Millisecond {
			t.Fatalf("attempt=%d River retried earlier than persisted delay: until=%s delay=%s", attempt, until, riverDelay)
		}
	}
}

func TestConnectionReconcileRateLimitSnoozeHonorsPersistedDelay(t *testing.T) {
	limited := &composio.RateLimitError{RetryAfter: 30 * time.Second}
	check := &connectionCheck{
		connection:       Connection{ID: "connection_rate_limit", Provider: "gmail"},
		attempt:          connectionCheckHourlyRetryAttempt,
		hourlyRetryFloor: true,
	}
	persisted := check.failed("identity_refresh", limited)
	if persisted < time.Hour {
		t.Fatalf("persisted delay=%s want hourly floor", persisted)
	}
	err := connectionCheckResult(limited, &connectionCheckFailure{
		connectionID: check.connection.ID, phase: "identity_refresh", code: "provider_rate_limited",
		retryDelay: persisted, cause: limited,
	})
	got := connectionReconcileWorkResult(err)
	var snooze *rivertype.JobSnoozeError
	if !errors.As(got, &snooze) {
		t.Fatalf("result=%v want JobSnooze", got)
	}
	if snooze.Duration != persisted {
		t.Fatalf("River snoozed %s, want persisted delay %s", snooze.Duration, persisted)
	}
	if snooze.Duration < 30*time.Second {
		t.Fatalf("River dropped Retry-After: %s", snooze.Duration)
	}
}

func TestConnectionReconcileDiscordSnoozeMatchesPolicyFloor(t *testing.T) {
	check := &connectionCheck{
		connection:       Connection{ID: "connection_discord", Provider: "discord"},
		attempt:          1,
		hourlyRetryFloor: true,
	}
	persisted := check.failed("identity_refresh", composio.ErrDiscordGuildRequired)
	if persisted < 6*time.Hour {
		t.Fatalf("persisted delay=%s want 6h policy floor", persisted)
	}
	worker := &connectionReconcileWorker{}
	nextRetry := time.Until(worker.NextRetry(&river.Job[ConnectionReconcileArgs]{
		JobRow: &rivertype.JobRow{Attempt: 1},
		Args:   ConnectionReconcileArgs{ConnectionID: check.connection.ID},
	}))
	if nextRetry >= 6*time.Hour {
		t.Fatalf("NextRetry already used the 6h policy floor: %s", nextRetry)
	}
	err := connectionCheckResult(composio.ErrDiscordGuildRequired, &connectionCheckFailure{
		connectionID: check.connection.ID, phase: "identity_refresh", code: "discord_guild_required",
		retryDelay: persisted, cause: composio.ErrDiscordGuildRequired,
	})
	got := connectionReconcileWorkResult(err)
	var snooze *rivertype.JobSnoozeError
	if !errors.As(got, &snooze) {
		t.Fatalf("result=%v want JobSnooze", got)
	}
	if snooze.Duration != persisted {
		t.Fatalf("River snoozed %s, want persisted delay %s", snooze.Duration, persisted)
	}
}

func TestReauthorizationNextRetryHasNoHourlyFloor(t *testing.T) {
	worker := &reauthorizationWorker{}
	job := &river.Job[ReauthorizationArgs]{
		JobRow: &rivertype.JobRow{Attempt: connectionCheckHourlyRetryAttempt},
		Args:   ReauthorizationArgs{ConnectionID: "connection_1"},
	}
	delay := time.Until(worker.NextRetry(job))
	if delay >= time.Hour {
		t.Fatalf("reauthorization NextRetry=%s includes hourly floor", delay)
	}
}

func TestConnectionReconcileUniquenessIncludesRetryable(t *testing.T) {
	opts := ConnectionReconcileArgs{}.InsertOpts()
	if !opts.UniqueOpts.ByArgs {
		t.Fatal("reconcile jobs must be unique by connection id")
	}
	for _, state := range []rivertype.JobState{
		rivertype.JobStateAvailable,
		rivertype.JobStatePending,
		rivertype.JobStateRunning,
		rivertype.JobStateScheduled,
		rivertype.JobStateRetryable,
	} {
		if !slices.Contains(opts.UniqueOpts.ByState, state) {
			t.Fatalf("reconcile uniqueness missing %s", state)
		}
	}
	for _, state := range []rivertype.JobState{
		rivertype.JobStateCompleted, rivertype.JobStateCancelled, rivertype.JobStateDiscarded,
	} {
		if slices.Contains(opts.UniqueOpts.ByState, state) {
			t.Fatalf("reconcile uniqueness includes %s; a later due check could not enqueue", state)
		}
	}
	if slices.Contains(jobs.UniqueUnfinished.ByState, rivertype.JobStateRetryable) {
		t.Fatal("UniqueUnfinished must keep omitting retryable")
	}
}

func TestReauthorizationOutcome(t *testing.T) {
	gone := errors.New("upstream gone")
	for _, test := range []struct {
		name                           string
		status                         composio.ConnectionStatus
		statusErr                      error
		expired, compatible, duplicate bool
		state, code                    string
	}{
		{"still connecting", composio.ConnectionPending, nil, false, true, false, "pending", ""},
		{"link expired while connecting", composio.ConnectionPending, nil, true, true, false, "failed", "connect_link_expired"},
		{"candidate gone after expiry", "", gone, true, true, false, "failed", "connect_link_expired"},
		{"candidate failed", composio.ConnectionFailed, nil, false, true, false, "failed", "candidate_not_active"},
		{"another account", composio.ConnectionActive, nil, false, false, false, "failed", "identity_mismatch"},
		{"account already connected", composio.ConnectionActive, nil, false, true, true, "failed", "duplicate_remote_principal"},
		{"same account", composio.ConnectionActive, nil, true, true, false, "active", ""},
	} {
		state, code := reauthorizationOutcome(test.status, test.statusErr, test.expired, test.compatible, test.duplicate)
		if state != test.state || code != test.code {
			t.Errorf("%s: state=%q code=%q want %q %q", test.name, state, code, test.state, test.code)
		}
	}
}

func TestPendingConnectionPollIsFastWhileTheUserAuthorizes(t *testing.T) {
	created := time.Date(2026, 11, 3, 10, 0, 0, 0, time.UTC)
	if got := pendingConnectionPoll(created, created.Add(30*time.Second)); got != connectingPoll {
		t.Fatalf("poll right after Connect=%s want %s", got, connectingPoll)
	}
	if got := pendingConnectionPoll(created, created.Add(connectingWindow)); got != pendingAuthorizationPoll {
		t.Fatalf("poll after the window=%s want %s", got, pendingAuthorizationPoll)
	}
}

func TestConnectionReconcileSnoozesAPendingConnectionForItsPoll(t *testing.T) {
	got := connectionReconcileWorkResult(&connectionPending{poll: connectingPoll})
	var snooze *rivertype.JobSnoozeError
	if !errors.As(got, &snooze) || snooze.Duration != connectingPoll {
		t.Fatalf("result=%v want JobSnooze(%s)", got, connectingPoll)
	}
}
