package app

import (
	"reflect"
	"slices"
	"testing"
	"time"

	"github.com/riverqueue/river"
	"github.com/riverqueue/river/rivertype"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/config"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
)

// A finished sweep must not block the next period. River keeps completed jobs
// for 24 hours, so counting them as duplicates would run each sweep once a day.
func TestMaintenanceSweepUniquenessIgnoresFinishedJobs(t *testing.T) {
	states := maintenanceInsertOpts.UniqueOpts.ByState
	for _, finished := range []rivertype.JobState{
		rivertype.JobStateCompleted, rivertype.JobStateCancelled, rivertype.JobStateDiscarded, rivertype.JobStateRetryable,
	} {
		if slices.Contains(states, finished) {
			t.Fatalf("sweep uniqueness includes %s; a finished sweep would block the next period", finished)
		}
	}
	if !slices.Contains(states, rivertype.JobStateRunning) {
		t.Fatal("sweep uniqueness must include running so a slow sweep is not queued twice")
	}
}

// sweepSchedule must refuse a non-positive interval at construction time.
func TestSweepScheduleRejectsNonPositiveInterval(t *testing.T) {
	for _, interval := range []time.Duration{0, -time.Second} {
		func() {
			defer func() {
				if recover() == nil {
					t.Fatalf("sweepSchedule(%s) did not panic", interval)
				}
			}()
			sweepSchedule[agentCredentialGCArgs](interval)
		}()
	}
}

// periodicIntervalOf reads the interval of a River periodic job. River keeps its
// schedule unexported, so the test reads the field directly.
func periodicIntervalOf(t *testing.T, job *river.PeriodicJob) time.Duration {
	t.Helper()
	schedule := reflect.ValueOf(job).Elem().FieldByName("scheduleFunc").Elem().Elem()
	return time.Duration(schedule.Field(0).Int())
}

// A Composio API key can be saved after start, so the sweeps are always scheduled.
func TestConnectedAppSweepsSchedule(t *testing.T) {
	jobs := (&App{}).connectedAppSweeps(river.NewWorkers())
	want := []time.Duration{connectionAuthReconcileInterval, connectionReconcileSweepInterval, mailSyncSweepInterval}
	if len(jobs) != len(want) {
		t.Fatalf("scheduled %d connected app sweeps with Composio, want %d", len(jobs), len(want))
	}
	for i, job := range jobs {
		if got := periodicIntervalOf(t, job); got != want[i] {
			t.Fatalf("sweep %d interval=%s want %s", i, got, want[i])
		}
	}
}

// Every periodic job runs at most once a minute at its production interval:
// commits enqueue their work and timed work is scheduled for its
// time, so a sweep is only a safety net.
func TestPeriodicJobsRunAtMostOnceAMinute(t *testing.T) {
	a := &App{cfg: config.Default()}
	workers := river.NewWorkers()
	features := newFeatureSet()
	a.addExternalAppJobs(features, true)
	periodic := slices.Concat(
		a.maintenanceJobs(workers, true),
		a.roomDocumentSweepJobs(workers, document.NewRetentionCollector(nil), true, true),
		features.periodic,
	)
	if len(periodic) < 10 {
		t.Fatalf("collected %d periodic jobs; a schedule is missing from the guard", len(periodic))
	}
	for i, job := range periodic {
		if got := periodicIntervalOf(t, job); got < time.Minute {
			t.Fatalf("periodic job %d runs every %s, want at least a minute", i, got)
		}
	}
}
