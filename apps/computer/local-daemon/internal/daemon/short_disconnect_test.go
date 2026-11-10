package daemon

import (
	"context"
	"errors"
	"io"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/transport"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/protocol"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider/native"
)

// A Gateway disconnect does not end an Operation: the next connection resumes
// it by operation_id from the in-memory ledger, a resent start replays instead
// of starting the Provider again, and a cancel reaches the same execution.
func TestShortDisconnectResumesTheOperationByIDWithoutRerunningTheProvider(t *testing.T) {
	device, err := transport.GenerateIdentity()
	if err != nil {
		t.Fatal(err)
	}
	release := make(chan struct{})
	var releaseOnce sync.Once
	finish := func() { releaseOnce.Do(func() { close(release) }) }
	defer finish()
	var starts atomic.Int32
	start := daemonOperationStart("operation-resume", "agent-1")
	first := &fakeStream{commands: []protocol.Command{{Type: protocol.CommandRunnerWelcome, ConnectionEpoch: 1}, start}}
	d, err := newTestDaemon(t, Options{
		ComputerID: "computer-1", ControlPlane: fakeControlPlane{stream: first}, IdentityStore: fakeStore{value: device},
		OperationResolver: fakeOperationResolver{},
		Executor: provider.Executor{NewBackend: func(string, native.Profile) (native.Runtime, error) {
			starts.Add(1)
			return heldBackend{release: release}, nil
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := d.runConnection(t.Context(), device); !errors.Is(err, io.EOF) {
		t.Fatalf("first connection: %v", err)
	}
	awaitOperationStarted(t, d)
	if events := first.snapshotEvents(); len(events) != 2 || events[1].Type != protocol.EventOperationAccepted || events[1].Sequence != 1 {
		t.Fatalf("first connection events=%+v", events)
	}

	cancel := start
	cancel.Type = protocol.CommandOperationCancel
	ack := start
	ack.Type, ack.ThroughSequence = protocol.CommandOperationAck, 1
	second := &fakeStream{commands: []protocol.Command{
		{Type: protocol.CommandRunnerWelcome, ConnectionEpoch: 2, ReconcileOperationIDs: []string{start.OperationID}},
		start, ack, cancel,
	}}
	second.idle = dispatchIdle(d)
	d.controlPlane = fakeControlPlane{stream: second}
	if err := d.runConnection(t.Context(), device); !errors.Is(err, io.EOF) {
		t.Fatalf("second connection: %v", err)
	}
	// The held Provider ignores cancellation until released; the recorded
	// cancel still makes its terminal a cancellation.
	finish()
	d.WaitForOperations()
	if starts.Load() != 1 {
		t.Fatalf("Provider started %d times", starts.Load())
	}
	var sequences []uint64
	for _, event := range second.snapshotEvents() {
		if event.OperationID == start.OperationID {
			sequences = append(sequences, event.Sequence)
		}
	}
	// The welcome replays the unacknowledged acceptance; the resent start
	// replays what is still unacknowledged when its worker runs; the
	// cancellation ends the same execution at the next sequence.
	if len(sequences) < 2 || sequences[0] != 1 || sequences[len(sequences)-1] != 2 {
		t.Fatalf("resumed sequences=%v events=%+v", sequences, second.snapshotEvents())
	}
	for _, sequence := range sequences[1 : len(sequences)-1] {
		if sequence != 1 {
			t.Fatalf("resumed sequences=%v", sequences)
		}
	}
	retained, err := d.ledger.Replay(context.Background(), []string{start.OperationID})
	if err != nil || len(retained) != 1 || retained[0].Type != protocol.EventOperationCancelled || retained[0].Sequence != 2 {
		t.Fatalf("retained events=%+v err=%v", retained, err)
	}
	// A self-update waits for the terminal's acknowledgement: it would lose
	// the only record of it.
	if active := d.DrainIfIdle(); active != 1 {
		t.Fatalf("DrainIfIdle with an unacknowledged terminal = %d", active)
	}
	if err := d.ledger.Acknowledge(context.Background(), operationIdentity(start), 2); err != nil {
		t.Fatal(err)
	}
	if active := d.DrainIfIdle(); active != 0 {
		t.Fatalf("DrainIfIdle after the acknowledgement = %d", active)
	}
	// An acknowledgement beyond the emitted sequence is a protocol violation.
	if err := d.ledger.Acknowledge(context.Background(), operationIdentity(start), 3); !errors.Is(err, ErrLedgerIdentityConflict) {
		t.Fatalf("acknowledgement past the last event: %v", err)
	}
}
