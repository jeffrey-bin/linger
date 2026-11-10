package app

import (
	"github.com/riverqueue/river"
)

type proactiveListenerSweepArgs struct{}

func (proactiveListenerSweepArgs) Kind() string { return "maintenance.proactive_listener_sweep" }

func (proactiveListenerSweepArgs) InsertOpts() river.InsertOpts { return maintenanceInsertOpts }
