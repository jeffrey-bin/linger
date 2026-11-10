package app

import (
	"context"

	"github.com/riverqueue/river"
)

// featureSet collects the River work StartWorkers registers: workers, queues,
// periodic jobs, and the steps that prepare their jobs before River starts.
// Core work adds to it directly; each optional feature adds its own part,
// which a missing configuration leaves out.
type featureSet struct {
	workers  *river.Workers
	queues   map[string]river.QueueConfig
	periodic []*river.PeriodicJob
	resume   []func(context.Context) error
}

func newFeatureSet() *featureSet {
	return &featureSet{workers: river.NewWorkers(), queues: map[string]river.QueueConfig{}}
}

func (f *featureSet) schedule(jobs ...*river.PeriodicJob) {
	f.periodic = append(f.periodic, jobs...)
}
