package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"reflect"
	"strings"
	"testing"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/registration"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/transport"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/protocol"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider/native"
)

type enabledScopeResolver struct{ root, runtime string }

func (r enabledScopeResolver) Resolve(ctx context.Context, command protocol.Command, payload json.RawMessage) (provider.OperationSpec, error) {
	spec, err := (prepareOperationResolver{workingDirectory: r.root}).Resolve(ctx, command, payload)
	spec.Provider = r.runtime
	return spec, err
}

func enabledScopeDaemon(t *testing.T, runtime string) (*Daemon, *fakeStream, *providerPrepareBackend) {
	t.Helper()
	backend := &providerPrepareBackend{}
	stream := &fakeStream{}
	options := Options{ComputerID: "computer-1", ControlPlane: fakeControlPlane{stream: stream}, IdentityStore: fakeStore{},
		OperationResolver: enabledScopeResolver{root: t.TempDir(), runtime: runtime},
		Executor:          provider.Executor{NewBackend: func(string, native.Profile) (native.Runtime, error) { return backend, nil }},
	}
	field := reflect.ValueOf(&options).Elem().FieldByName("EnabledRuntimes")
	if !field.IsValid() {
		t.Fatal("Daemon has no independent configured Runtime scope")
	}
	field.Set(reflect.ValueOf([]string{"codex"}))
	d, err := newTestDaemon(t, options)
	if err != nil {
		t.Fatal(err)
	}
	d.daemonID = "daemon-scope"
	return d, stream, backend
}

func TestEnabledScopeRejectsWholeRegistrationSnapshotBeforeMutation(t *testing.T) {
	d, stream, _ := enabledScopeDaemon(t, "codex")
	snapshot := []transport.RuntimeRegistration{}
	for _, runtime := range []string{"codex", "claude"} {
		snapshot = append(snapshot, transport.RuntimeRegistration{RegistrationID: "registration-" + runtime,
			Observation: transport.RegistrationObservation{TenantID: "tenant-1", OwnerActorID: "owner-1", ProviderType: runtime, Status: "online", Revision: 1, Capabilities: []string{}},
		})
	}
	before := d.authorityRevision
	_ = d.applyRegistrationSnapshot(context.Background(), stream, protocol.Command{CommandID: "scope-snapshot", Payload: mustJSON(snapshot)})
	rows, err := d.registrations.List(context.Background())
	if err != nil || len(rows) != 0 || d.authorityRevision != before {
		t.Fatalf("disabled row partially mutated snapshot: rows=%+v revision=%d err=%v", rows, d.authorityRevision, err)
	}
}

func TestEnabledScopeRejectsUnselectedPrepareBeforeResidentReuse(t *testing.T) {
	d, stream, backend := enabledScopeDaemon(t, "claude")
	command := providerPrepareCommand("disabled-scope")
	command.RuntimeType = "claude"
	var payload map[string]any
	if err := json.Unmarshal(command.Payload, &payload); err != nil {
		t.Fatal(err)
	}
	payload["runtime"] = map[string]any{"type": "claude"}
	command.Payload = mustJSON(payload)
	if err := d.handleProviderPrepare(context.Background(), stream, command); err != nil {
		t.Fatal(err)
	}
	event := waitForProviderPrepared(t, stream, "disabled-scope")
	if event["outcome"] != "not_eligible" || !strings.Contains(event["reason"].(string), "not enabled") || len(backend.executions()) != 0 {
		t.Fatalf("unselected prepare was admitted: %+v", event)
	}
}

func TestEnabledScopeRejectsResolvedUnselectedOperationWithoutExecutor(t *testing.T) {
	d, stream, backend := enabledScopeDaemon(t, "claude")
	command := prepareCommand("disabled-scope-start")
	if err := d.handleOperationStart(context.Background(), stream, command); err != nil {
		t.Fatal(err)
	}
	encoded := string(mustJSON(stream.snapshotEvents()))
	if !strings.Contains(encoded, "not enabled") || len(backend.executions()) != 0 {
		t.Fatalf("unselected operation reached execution: %s", encoded)
	}
}

func TestEnabledScopeDoesNotAdvertiseRetainedUnselectedRegistration(t *testing.T) {
	d, _, _ := enabledScopeDaemon(t, "codex")
	_, err := d.registrations.Apply(context.Background(), registration.Observation{
		RegistrationID: "registration-claude", Key: registration.Key{DaemonID: d.daemonID, TenantID: "tenant-1", OwnerActorID: "owner-1", ProviderType: "claude"},
		Status: registration.StatusOnline, Revision: 1, Capabilities: []string{},
	})
	if err != nil {
		t.Fatal(err)
	}
	plane := &sequenceControlPlane{}
	d.controlPlane = plane
	device, err := transport.GenerateIdentity()
	if err != nil {
		t.Fatal(err)
	}
	if err := d.runConnection(context.Background(), device); !errors.Is(err, io.EOF) {
		t.Fatal(err)
	}
	if len(plane.hellos) != 1 || len(plane.hellos[0].Registrations) != 0 {
		t.Fatalf("retained unselected inventory advertised: %+v", plane.hellos)
	}
}

func TestEnabledScopeRejectsMonitorInventoryBeforeMutation(t *testing.T) {
	for _, part := range []string{"runtimes", "diagnostics", "observations"} {
		t.Run(part, func(t *testing.T) {
			d, _, _ := enabledScopeDaemon(t, "codex")
			runtimes := []string{"codex"}
			diagnostics := json.RawMessage(`[{"type":"codex"}]`)
			observations := []transport.RegistrationObservation{{ProviderType: "codex"}}
			switch part {
			case "runtimes":
				runtimes = []string{"claude"}
			case "diagnostics":
				diagnostics = json.RawMessage(`[{"type":"claude"}]`)
			case "observations":
				observations[0].ProviderType = "claude"
			}
			before := d.diagnosticsRevision
			if err := d.UpdateRuntimeInventory(context.Background(), runtimes, diagnostics, observations); err == nil {
				t.Fatal("unselected monitor inventory accepted")
			}
			if d.diagnosticsRevision != before {
				t.Fatal("rejected inventory changed revision")
			}
		})
	}
}

func TestEnabledScopeBlocksUnselectedCompaction(t *testing.T) {
	d, _, _ := enabledScopeDaemon(t, "codex")
	if reason := d.sessionCompactBlocked(protocol.Command{RuntimeType: "claude"}); !strings.Contains(reason, "not enabled") {
		t.Fatalf("unselected compaction admitted: %q", reason)
	}
}
