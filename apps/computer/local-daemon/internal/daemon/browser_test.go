package daemon

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/localtools"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/protocol"
)

type browserEventStream struct{ events []protocol.Event }

func (s *browserEventStream) Receive(context.Context) (protocol.Command, error) {
	return protocol.Command{}, context.Canceled
}
func (s *browserEventStream) Send(_ context.Context, event protocol.Event) error {
	s.events = append(s.events, event)
	return nil
}
func (s *browserEventStream) Close() error { return nil }

type deadlineBrowserConnections struct{ deadline time.Time }

func (b *deadlineBrowserConnections) BrowserConnection(ctx context.Context, _, _, _, _, _ string) (localtools.BrowserStatus, error) {
	b.deadline, _ = ctx.Deadline()
	return localtools.BrowserStatus{Mode: "isolated", State: "isolated", Platform: "darwin"}, nil
}

func TestBrowserCommandStopsAtItsExpiry(t *testing.T) {
	connections := &deadlineBrowserConnections{}
	d := &Daemon{computerID: "computer", browserConnections: connections, owners: []ComputerOwner{{TenantID: "tenant", OwnerActorID: "owner"}}}
	expires := time.Now().Add(time.Minute).UTC().Truncate(time.Second)
	payload, _ := json.Marshal(map[string]any{"runner_id": "computer", "tenant_id": "tenant", "owner_actor_id": "owner", "expires_at": expires, "action": "status"})
	stream := &browserEventStream{}
	if err := d.handleBrowserCommand(t.Context(), stream, protocol.Command{Type: protocol.CommandCapabilityBrowserConnect, RunnerID: "computer", Payload: payload}); err != nil {
		t.Fatal(err)
	}
	if !connections.deadline.Equal(expires) {
		t.Fatalf("browser work may outlive the Gateway wait: deadline=%v", connections.deadline)
	}
	if len(stream.events) != 1 || stream.events[0].Type != protocol.EventCapabilityBrowserConnected {
		t.Fatalf("events=%+v", stream.events)
	}

	payload, _ = json.Marshal(map[string]any{"runner_id": "computer", "tenant_id": "tenant", "owner_actor_id": "intruder", "expires_at": expires, "action": "status"})
	if err := d.handleBrowserCommand(t.Context(), stream, protocol.Command{Type: protocol.CommandCapabilityBrowserConnect, RunnerID: "computer", Payload: payload}); err != nil {
		t.Fatal(err)
	}
	if len(stream.events) != 2 || stream.events[1].Type != protocol.EventCapabilityBrowserFailed {
		t.Fatalf("another owner reached the browser records: %+v", stream.events)
	}
}
