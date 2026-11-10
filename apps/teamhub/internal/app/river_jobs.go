package app

import (
	"context"
	"time"
)

// Shutdown budgets must fit inside the process watchdog (20s), with the soft
// stop (config.JobsConfig) first.
const riverHardStopTimeout = 5 * time.Second

// stopRiverJobs lets running background jobs finish, then cancels them if they
// overrun the soft stop budget.
func (a *App) stopRiverJobs() {
	if a.riverClient == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), a.cfg.Jobs.SoftStopTimeout)
	defer cancel()
	err := a.riverClient.Stop(ctx)
	if err == nil {
		return
	}
	a.logger.Error("stop background jobs", "error", err)
	hardCtx, hardCancel := context.WithTimeout(context.Background(), riverHardStopTimeout)
	defer hardCancel()
	if err := a.riverClient.StopAndCancel(hardCtx); err != nil {
		a.logger.Error("cancel background jobs", "error", err)
	}
}
