package native

import (
	"context"
	"errors"
	"time"
)

// errRunBudgetExpired is the cancellation cause of an expired RunSpec.Budget.
var errRunBudgetExpired = errors.New("native run budget expired")

// budgetContext bounds a run by its budget. A zero or negative budget leaves
// only the parent in charge.
func budgetContext(parent context.Context, budget time.Duration) (context.Context, context.CancelFunc) {
	if budget <= 0 {
		return context.WithCancel(parent)
	}
	return context.WithTimeoutCause(parent, budget, errRunBudgetExpired)
}

// interruptedStatus names how a run context ended: "timeout" when its own
// budget expired, "aborted" for any other cancellation, "" while it is live.
func interruptedStatus(runCtx context.Context) string {
	if runCtx.Err() == nil {
		return ""
	}
	if errors.Is(context.Cause(runCtx), errRunBudgetExpired) {
		return statusTimeout
	}
	return statusAborted
}
