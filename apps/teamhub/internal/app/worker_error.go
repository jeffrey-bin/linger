package app

import (
	"context"
	"errors"
)

// reportWorkerError suppresses only cancellation caused by stopping this worker.
// Joined errors must contain no independent failure, even during shutdown.
func (a *App) reportWorkerError(ctx context.Context, message string, err error) {
	if ctx.Err() == context.Canceled && onlyWorkerCancellation(err) {
		return
	}
	a.logger.Error(message, "error", err)
}

func onlyWorkerCancellation(err error) bool {
	switch value := err.(type) { //nolint:errorlint // walks the Unwrap tree by hand to inspect joined errors
	case interface{ Unwrap() []error }:
		children := value.Unwrap()
		if len(children) == 0 {
			return false
		}
		for _, child := range children {
			if !onlyWorkerCancellation(child) {
				return false
			}
		}
		return true
	case interface{ Unwrap() error }:
		return onlyWorkerCancellation(value.Unwrap())
	default:
		return errors.Is(err, context.Canceled)
	}
}
