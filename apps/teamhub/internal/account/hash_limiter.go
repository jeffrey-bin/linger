package account

import (
	"context"
	"errors"
	"time"
)

// ErrHashBusy means no hash permit became free within the wait limit.
var ErrHashBusy = errors.New("password hashing is busy")

// HashLimiter limits concurrent Argon2id computations. Each computation uses 64 MiB, so the process admits only
// a few at a time; other requests wait at most a fixed duration and cannot exhaust memory.
type HashLimiter struct {
	permits chan struct{}
	wait    time.Duration
}

func NewHashLimiter(permits int, wait time.Duration) *HashLimiter {
	return &HashLimiter{permits: make(chan struct{}, permits), wait: wait}
}

// Acquire waits for a permit until the wait limit is exceeded or ctx ends. Callers call release after computing the hash.
func (l *HashLimiter) Acquire(ctx context.Context) (release func(), err error) {
	timer := time.NewTimer(l.wait)
	defer timer.Stop()
	select {
	case l.permits <- struct{}{}:
		return func() { <-l.permits }, nil
	case <-timer.C:
		return nil, ErrHashBusy
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}
