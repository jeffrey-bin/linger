package personalprofile

import (
	"context"
	"errors"
	"testing"

	"github.com/riverqueue/river"
	"github.com/riverqueue/river/rivertype"
)

type fakeProfileMemorySyncer struct {
	calls  int
	err    error
	during func()
}

func (f *fakeProfileMemorySyncer) SyncProfileMemory(context.Context, string, string) error {
	f.calls++
	if f.during != nil {
		f.during()
	}
	return f.err
}

func TestProfileMemorySyncRunsAgainAfterANewRevision(t *testing.T) {
	current := "personal_profile_revision_a"
	syncer := &fakeProfileMemorySyncer{}
	worker := &profileMemorySyncWorker{
		syncer:          syncer,
		currentRevision: func(context.Context, string, string) (string, error) { return current, nil },
	}
	job := &river.Job[ProfileMemorySyncArgs]{Args: ProfileMemorySyncArgs{TenantID: "tenant_a", OwnerActorID: "actor_a"}}

	if err := worker.Work(t.Context(), job); err != nil || syncer.calls != 1 {
		t.Fatalf("unchanged Profile: err=%v calls=%d", err, syncer.calls)
	}

	// A Revision published while Memory worked is synced again.
	syncer.during = func() { current = "personal_profile_revision_b" }
	var snooze *rivertype.JobSnoozeError
	if err := worker.Work(t.Context(), job); !errors.As(err, &snooze) || snooze.Duration != ProfileMemorySyncDelay {
		t.Fatalf("new Revision: err=%v", err)
	}

	// A failure is retried by River.
	syncer.during, syncer.err = nil, errors.New("memory unavailable")
	if err := worker.Work(t.Context(), job); err == nil || errors.As(err, &snooze) {
		t.Fatalf("failed sync: err=%v", err)
	}
}

func TestProfileMemorySyncCancelsWithoutMemory(t *testing.T) {
	var cancel *rivertype.JobCancelError
	if err := (&profileMemorySyncWorker{}).Work(t.Context(), &river.Job[ProfileMemorySyncArgs]{}); !errors.As(err, &cancel) {
		t.Fatalf("err=%v", err)
	}
}
