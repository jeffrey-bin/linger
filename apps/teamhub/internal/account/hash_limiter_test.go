package account

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestHashLimiterBoundsConcurrentHashes(t *testing.T) {
	limiter := NewHashLimiter(2, 20*time.Millisecond)
	first, err := limiter.Acquire(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	second, err := limiter.Acquire(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := limiter.Acquire(context.Background()); !errors.Is(err, ErrHashBusy) {
		t.Fatalf("a third hash must wait out the bound and fail, got %v", err)
	}
	first()
	third, err := limiter.Acquire(context.Background())
	if err != nil {
		t.Fatalf("a released permit must be reusable: %v", err)
	}
	third()
	second()

	canceled, cancel := context.WithCancel(context.Background())
	cancel()
	busy := NewHashLimiter(1, time.Hour)
	release, err := busy.Acquire(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	if _, err := busy.Acquire(canceled); !errors.Is(err, context.Canceled) {
		t.Fatalf("a canceled request must stop waiting, got %v", err)
	}
}
