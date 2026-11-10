package externalsource

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"net"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/composio"
)

// The pinned session lock covers status, identity, and the resulting product
// mutation. Provider calls share one 30s deadline; Gmail attempts do not retry.
// A failed attempt is retried by its River job, so the attempt count alone sets
// the backoff.
type connectionCheck struct {
	service    *Service
	connection Connection
	session    *pgxpool.Conn
	lockKey    string
	cancel     context.CancelFunc
	attempt    int
	failure    error
	retryDelay time.Duration
	phase      string
	retryAt    time.Time
	// hourlyRetryFloor applies the Connection status-check hourly wait. Reauthorization
	// checks leave it off so a connect link can still complete.
	hourlyRetryFloor bool
}

type connectionCheckDeferred struct{ until time.Time }

func (e *connectionCheckDeferred) Error() string        { return "external connection check deferred" }
func (e *connectionCheckDeferred) Is(target error) bool { return target == pgx.ErrNoRows }

// beginConnectionCheck takes the per-upstream lock. A busy upstream defers the
// check by a minute; attempt is the River attempt that owns this check.
func (s *Service) beginConnectionCheck(ctx context.Context, connection Connection, attempt int) (context.Context, *connectionCheck, error) {
	session, err := s.pool.Acquire(ctx)
	if err != nil {
		return ctx, nil, err
	}
	check := &connectionCheck{service: s, connection: connection, session: session, lockKey: "external-connection-check:" + connection.UpstreamConnectionID, attempt: attempt}
	var locked bool
	if err = session.QueryRow(ctx, `SELECT pg_try_advisory_lock(hashtextextended($1,0))`, check.lockKey).Scan(&locked); err != nil {
		// Cancellation can hide a successful lock acquisition. Do not return
		// that session to the pool with unknown advisory-lock ownership.
		closeCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = session.Hijack().Close(closeCtx)
		return ctx, nil, err
	}
	if !locked {
		session.Release()
		return ctx, nil, &connectionCheckDeferred{until: time.Now().Add(time.Minute)}
	}
	ctx, check.cancel = context.WithTimeout(ctx, 30*time.Second)
	if connection.Provider == "gmail" {
		ctx, _ = composio.WithProviderAttemptBudget(ctx, 2)
	}
	return ctx, check, nil
}

const (
	// connectionCheckHourlyRetryAttempt is the first failed attempt that waits at
	// least an hour. Earlier retries stay on the exponential minute schedule.
	connectionCheckHourlyRetryAttempt = 5
	connectionCheckHourlyRetryDelay   = time.Hour
)

// connectionCheckRetryDelay spaces retries of one Connection check. The jitter is
// keyed to the entity so retries for different entities do not align.
func connectionCheckRetryDelay(key string, failures int, retryAfter time.Duration) time.Duration {
	base := min(time.Minute*time.Duration(1<<min(max(failures-1, 0), 9)), 6*time.Hour)
	sum := sha256.Sum256([]byte(key))
	// Stable positive jitter keeps the server's Retry-After a lower bound.
	delay := min(base+time.Duration(sum[0])*base/1024, 6*time.Hour)
	return max(delay, retryAfter)
}

// connectionReconcileRetryDelay is the Connection status-check schedule: the
// shared jittered delay plus an hourly floor after repeated failures.
func connectionReconcileRetryDelay(key string, failures int, retryAfter time.Duration) time.Duration {
	delay := connectionCheckRetryDelay(key, failures, retryAfter)
	if failures >= connectionCheckHourlyRetryAttempt {
		delay = max(delay, connectionCheckHourlyRetryDelay)
	}
	return delay
}

func (check *connectionCheck) failed(phase string, cause error) time.Duration {
	check.failure, check.phase = cause, phase
	_, minimum, _ := connectionIdentityFailurePolicy(check.connection.Provider, cause)
	var delay time.Duration
	if check.hourlyRetryFloor {
		delay = connectionReconcileRetryDelay(check.connection.ID, check.attempt, minimum)
	} else {
		delay = connectionCheckRetryDelay(check.connection.ID, check.attempt, minimum)
	}
	check.retryDelay = delay
	check.retryAt = time.Now().UTC().Add(delay)
	return delay
}

// finish releases the lock. A failed check reports a connectionCheckFailure with
// only controlled phase/code and local IDs, so errors.As can classify it without
// interpolating provider payloads.
func (check *connectionCheck) finish(result *error) {
	defer check.release()
	check.cancel()
	if check.failure == nil {
		return
	}
	code, _, _ := connectionIdentityFailurePolicy(check.connection.Provider, check.failure)
	check.service.logger.Warn("external connection check failed",
		"connection_id", check.connection.ID, "provider", check.connection.Provider, "phase", check.phase,
		"error_code", code, "error_class", connectionCheckErrorClass(check.failure),
		"attempt", check.attempt, "next_attempt_at", check.retryAt)
	*result = connectionCheckResult(*result, &connectionCheckFailure{
		connectionID: check.connection.ID, phase: check.phase, code: code, retryDelay: check.retryDelay, cause: check.failure,
	})
}

// connectionCheckResult keeps a write/lock error as the job error so HandleError
// logs it at ERROR. The check WARN already recorded the provider failure.
func connectionCheckResult(previous error, failure *connectionCheckFailure) error {
	if failure == nil {
		return previous
	}
	if errors.Is(previous, failure.cause) {
		previous = nil
	}
	if previous != nil {
		return previous
	}
	return failure
}

func (check *connectionCheck) release() {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var unlocked bool
	if err := check.session.QueryRow(ctx, `SELECT pg_advisory_unlock(hashtextextended($1,0))`, check.lockKey).Scan(&unlocked); err != nil || !unlocked {
		_ = check.session.Hijack().Close(ctx)
		return
	}
	check.session.Release()
}

type connectionCheckFailure struct {
	connectionID, phase, code string
	retryDelay                time.Duration
	cause                     error
}

func (e *connectionCheckFailure) Error() string {
	return fmt.Sprintf("external connection check failed: connection_id=%s phase=%s code=%s next_attempt_in=%s", e.connectionID, e.phase, e.code, e.retryDelay)
}
func (e *connectionCheckFailure) Unwrap() error { return e.cause }

// RetryableJobFailure reports identity/status checks that River should retry.
// Auth failures stay terminal for job error logging.
func (e *connectionCheckFailure) RetryableJobFailure() bool {
	switch e.code {
	case "provider_identity_unavailable", "provider_status_unavailable", "provider_rate_limited", "discord_guild_required":
		return true
	default:
		return false
	}
}

// connectionCheckErrorClass is a closed set of labels for the check WARN log.
// It never interpolates provider payloads or Error() text.
func connectionCheckErrorClass(err error) string {
	if err == nil {
		return "unknown"
	}
	if errors.Is(err, context.Canceled) {
		return "canceled"
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return "timeout"
	}
	var limited *composio.RateLimitError
	if errors.As(err, &limited) {
		return "http_429"
	}
	if status, ok := composio.ErrorStatus(err); ok {
		return "http_" + strconv.Itoa(status)
	}
	var netErr net.Error
	if errors.As(err, &netErr) {
		if netErr.Timeout() {
			return "timeout"
		}
		return "network"
	}
	return connectionCheckErrorTypeName(err)
}

func connectionCheckErrorTypeName(err error) string {
	for {
		wrapper, ok := err.(interface{ Unwrap() error })
		if !ok {
			break
		}
		inner := wrapper.Unwrap()
		if inner == nil {
			break
		}
		err = inner
	}
	name := fmt.Sprintf("%T", err)
	if name == "" || name == "<nil>" {
		return "unknown"
	}
	return name
}
