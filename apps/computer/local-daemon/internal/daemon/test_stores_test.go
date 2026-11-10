package daemon

import (
	"testing"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/assignment"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/registration"
)

// newTestDaemon fills the stores a test leaves unset with fresh ones.
func newTestDaemon(t testing.TB, options Options) (*Daemon, error) {
	t.Helper()
	if options.Ledger == nil {
		options.Ledger = newTestLedger(t)
	}
	if options.Registrations == nil {
		options.Registrations = newTestRegistrations(t)
	}
	if options.Assignments == nil {
		options.Assignments = newTestAssignments(t)
	}
	daemon, err := New(options)
	if err != nil {
		return nil, err
	}
	// Starts carry an execution Context, so they run on dispatch workers; hold
	// a fake stream's EOF until that queued work has finished.
	var streams []*fakeStream
	switch plane := options.ControlPlane.(type) {
	case fakeControlPlane:
		streams = []*fakeStream{plane.stream}
	case *sequenceControlPlane:
		streams = plane.streams
	}
	for _, stream := range streams {
		if stream != nil && stream.idle == nil {
			stream.idle = dispatchIdle(daemon)
		}
	}
	return daemon, err
}

func newTestLedger(testing.TB) *MemoryLedger {
	return NewMemoryLedger()
}

func newTestRegistrations(testing.TB) *registration.MemoryStore {
	return registration.NewMemoryStore()
}

func newTestAssignments(testing.TB) *assignment.MemoryStore {
	return assignment.NewMemoryStore()
}

// dispatchIdle reports whether no queued or running dispatch work remains.
func dispatchIdle(d *Daemon) func() bool {
	return func() bool { return d.dispatcher.Load().activeCount() == 0 }
}
