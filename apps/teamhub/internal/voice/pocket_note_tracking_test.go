package voice

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/riverqueue/river"
	"github.com/riverqueue/river/rivertype"
)

type fakeRefresher struct {
	calls  int
	err    error
	during func()
}

func (f *fakeRefresher) RefreshPocketNoteTracking(context.Context, string, string, string) error {
	f.calls++
	if f.during != nil {
		f.during()
	}
	return f.err
}

func TestPocketNoteTrackingRefreshesTodayAndRunsAgainAfterAChange(t *testing.T) {
	now := time.Date(2026, 11, 6, 15, 0, 0, 0, time.Local)
	today := PocketNoteDay(now).Format(PocketNoteDateLayout)
	changed := time.Date(2026, 11, 6, 14, 50, 0, 0, time.UTC)
	refresher := &fakeRefresher{}
	worker := &pocketNoteTrackingWorker{
		refresher: refresher,
		changedAt: func(context.Context, PocketNoteTrackingArgs) (time.Time, error) { return changed, nil },
		now:       func() time.Time { return now },
	}
	job := &river.Job[PocketNoteTrackingArgs]{Args: PocketNoteTrackingArgs{TenantID: "tenant_a", OwnerActorID: "actor_a", Date: today}}

	if err := worker.Work(t.Context(), job); err != nil || refresher.calls != 1 {
		t.Fatalf("unchanged page: err=%v calls=%d", err, refresher.calls)
	}

	// An edit while Memory worked is followed by another refresh.
	refresher.during = func() { changed = changed.Add(time.Minute) }
	var snooze *rivertype.JobSnoozeError
	if err := worker.Work(t.Context(), job); !errors.As(err, &snooze) || snooze.Duration != PocketNoteTrackingDelay {
		t.Fatalf("changed page: err=%v", err)
	}

	// A failure is retried by River.
	refresher.during, refresher.err = nil, errors.New("memory unavailable")
	if err := worker.Work(t.Context(), job); err == nil || errors.As(err, &snooze) {
		t.Fatalf("failed refresh: err=%v", err)
	}
}

func TestPocketNoteTrackingLeavesClosedDaysToTheDaily(t *testing.T) {
	refresher := &fakeRefresher{}
	worker := &pocketNoteTrackingWorker{
		refresher: refresher,
		changedAt: func(context.Context, PocketNoteTrackingArgs) (time.Time, error) {
			t.Fatal("a closed day is not read")
			return time.Time{}, nil
		},
		now: func() time.Time { return time.Date(2026, 11, 7, 0, 5, 0, 0, time.Local) },
	}
	job := &river.Job[PocketNoteTrackingArgs]{Args: PocketNoteTrackingArgs{Date: "2026-11-06"}}
	if err := worker.Work(t.Context(), job); err != nil || refresher.calls != 0 {
		t.Fatalf("closed day: err=%v calls=%d", err, refresher.calls)
	}
}

func TestPocketNoteTrackingCancelsWithoutMemory(t *testing.T) {
	worker := &pocketNoteTrackingWorker{now: time.Now}
	var cancel *rivertype.JobCancelError
	if err := worker.Work(t.Context(), &river.Job[PocketNoteTrackingArgs]{}); !errors.As(err, &cancel) {
		t.Fatalf("err=%v", err)
	}
}
