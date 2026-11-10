package daemon

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/assignment"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/clicredential"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/registration"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/transport"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/protocol"
)

const credentialTestToken = "th_agent_" + "0123456789abcdefghijklmnopqrstuvwxyzABCDEFG"

type credentialFixture struct {
	daemon        *Daemon
	stream        *fakeStream
	store         *clicredential.Store
	assignments   assignment.Store
	registrations registration.Store
}

func newCredentialFixture(t *testing.T) credentialFixture {
	t.Helper()
	ctx := context.Background()
	device, err := transport.GenerateIdentity()
	if err != nil {
		t.Fatal(err)
	}
	registrations := newTestRegistrations(t)
	if _, err := registrations.Apply(ctx, registration.Observation{RegistrationID: "registration-one", Key: registration.Key{DaemonID: device.DaemonID, TenantID: "tenant-one", OwnerActorID: "owner-one", ProviderType: "codex"}, Status: registration.StatusOnline, Revision: 1}); err != nil {
		t.Fatal(err)
	}
	assignments := newTestAssignments(t)
	if _, err := assignments.Apply(ctx, assignment.Command{Type: protocol.CommandAgentRunnerEnsure, CommandID: "assign-one", RunnerID: "computer-one", TenantID: "tenant-one", AgentID: "agent-one", RegistrationID: "registration-one", AssignmentRevision: 2, RunnerRevision: 1, WorkspaceGrantID: "grant-one", Runtime: mustJSON(map[string]any{"type": "codex"})}, 0); err != nil {
		t.Fatal(err)
	}
	store, err := clicredential.Open(filepath.Join(t.TempDir(), "agent-cli-credentials"))
	if err != nil {
		t.Fatal(err)
	}
	stream := &fakeStream{}
	daemon, err := newTestDaemon(t, Options{ComputerID: "computer-one", ControlPlane: fakeControlPlane{stream: stream}, IdentityStore: fakeStore{value: device}, OperationResolver: fakeOperationResolver{}, Registrations: registrations, Assignments: assignments, CLICredentials: store})
	if err != nil {
		t.Fatal(err)
	}
	daemon.daemonID = device.DaemonID
	return credentialFixture{daemon: daemon, stream: stream, store: store, assignments: assignments, registrations: registrations}
}

func credentialPutCommand(tenant, agent string) protocol.Command {
	return protocol.Command{
		Type: protocol.CommandAgentCLICredentialPut, ProtocolVersion: "1.2", CommandID: "put-one",
		RunnerID: "computer-one", TenantID: "tenant-one", AgentID: "agent-one", RegistrationID: "registration-one",
		AssignmentRevision: 2, ConnectionEpoch: 7, RunnerRevision: 1,
		Payload: mustJSON(map[string]any{
			"profile":      map[string]any{"url": "https://teamhub.example", "tenant_id": tenant, "agent_id": agent},
			"access_token": credentialTestToken,
		}),
	}
}

// captureLogs records every slog line so tests can prove a token is never logged.
func captureLogs(t *testing.T) *bytes.Buffer {
	t.Helper()
	buffer := &bytes.Buffer{}
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(buffer, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() { slog.SetDefault(previous) })
	return buffer
}

func TestAgentCLICredentialPutStoresAndReportsOutcomeWithoutLoggingToken(t *testing.T) {
	logs := captureLogs(t)
	fixture := newCredentialFixture(t)
	if err := fixture.daemon.handleAgentCLICredentialPut(context.Background(), fixture.stream, credentialPutCommand("tenant-one", "agent-one")); err != nil {
		t.Fatal(err)
	}
	events := fixture.stream.snapshotEvents()
	if len(events) != 1 || events[0].Type != protocol.EventAgentCLICredentialStored || events[0].CommandID != "put-one" {
		t.Fatalf("events = %+v", events)
	}
	var outcome struct {
		SHA256 string `json:"sha256"`
	}
	if err := json.Unmarshal(events[0].Payload, &outcome); err != nil {
		t.Fatal(err)
	}
	if len(outcome.SHA256) != 64 {
		t.Fatalf("stored outcome = %+v", outcome)
	}
	// The credential is kept with the Runtime Assignment it was pushed for.
	if stored, ok, err := fixture.store.Current("tenant-one", "agent-one"); err != nil || !ok || stored.AssignmentRevision != 2 {
		t.Fatalf("credential was not stored for its assignment: %+v %v %v", stored, ok, err)
	}
	if strings.Contains(string(events[0].Payload), credentialTestToken) {
		t.Fatal("stored outcome exposes the token")
	}
	if strings.Contains(logs.String(), credentialTestToken) {
		t.Fatalf("token reached logs: %s", logs.String())
	}
}

func TestAgentCLICredentialPutRejectsIdentityMismatchAndUnknownAssignment(t *testing.T) {
	t.Run("profile tenant mismatch", func(t *testing.T) {
		fixture := newCredentialFixture(t)
		if err := fixture.daemon.handleAgentCLICredentialPut(context.Background(), fixture.stream, credentialPutCommand("tenant-two", "agent-one")); err != nil {
			t.Fatal(err)
		}
		assertCredentialFailed(t, fixture)
	})
	t.Run("unknown agent assignment", func(t *testing.T) {
		fixture := newCredentialFixture(t)
		command := credentialPutCommand("tenant-one", "agent-two")
		if err := fixture.daemon.handleAgentCLICredentialPut(context.Background(), fixture.stream, command); err != nil {
			t.Fatal(err)
		}
		assertCredentialFailed(t, fixture)
	})
	t.Run("removed assignment", func(t *testing.T) {
		fixture := newCredentialFixture(t)
		if _, err := fixture.assignments.Apply(context.Background(), assignment.Command{Type: protocol.CommandAgentRunnerRemove, CommandID: "remove-one", RunnerID: "computer-one", TenantID: "tenant-one", AgentID: "agent-one", RegistrationID: "registration-one", AssignmentRevision: 2, RunnerRevision: 2}, 0); err != nil {
			t.Fatal(err)
		}
		if err := fixture.daemon.handleAgentCLICredentialPut(context.Background(), fixture.stream, credentialPutCommand("tenant-one", "agent-one")); err != nil {
			t.Fatal(err)
		}
		assertCredentialFailed(t, fixture)
		if _, err := fixture.store.Lookup("tenant-one", "agent-one"); !errors.Is(err, clicredential.ErrNotInstalled) {
			t.Fatalf("removed assignment stored a credential: %v", err)
		}
	})
}

func assertCredentialFailed(t *testing.T, fixture credentialFixture) {
	t.Helper()
	events := fixture.stream.snapshotEvents()
	if len(events) != 1 || events[0].Type != protocol.EventAgentCLICredentialFailed {
		t.Fatalf("events = %+v, want one failure", events)
	}
	if strings.Contains(string(events[0].Payload), credentialTestToken) {
		t.Fatal("failure exposes the token")
	}
	// A wrong identity or a missing assignment never clears on retry.
	var outcome struct {
		Error struct {
			Retryable bool `json:"retryable"`
		} `json:"error"`
	}
	if err := json.Unmarshal(events[0].Payload, &outcome); err != nil {
		t.Fatal(err)
	}
	if outcome.Error.Retryable {
		t.Fatal("definitive refusal is reported as retryable")
	}
}

func TestAgentRunnerRemoveDeletesCLICredentialAndFailureFailsCommand(t *testing.T) {
	ctx := context.Background()
	fixture := newCredentialFixture(t)
	if err := fixture.daemon.handleAgentCLICredentialPut(ctx, fixture.stream, credentialPutCommand("tenant-one", "agent-one")); err != nil {
		t.Fatal(err)
	}
	remove := protocol.Command{
		Type: protocol.CommandAgentRunnerRemove, ProtocolVersion: "1.2", CommandID: "remove-one",
		RunnerID: "computer-one", TenantID: "tenant-one", AgentID: "agent-one", RegistrationID: "registration-one",
		AssignmentRevision: 2, ConnectionEpoch: 7, RunnerRevision: 2,
	}
	if err := fixture.daemon.handleAgentRunnerCommand(ctx, fixture.stream, remove); err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.store.Lookup("tenant-one", "agent-one"); !errors.Is(err, clicredential.ErrNotInstalled) {
		t.Fatalf("credential survived removal: %v", err)
	}
	events := fixture.stream.snapshotEvents()
	if last := events[len(events)-1]; last.Type != protocol.EventAgentRunnerRemoved {
		t.Fatalf("last event = %s, want removed", last.Type)
	}

	if runtime.GOOS == "windows" || os.Getuid() == 0 {
		t.Skip("permission-based removal failure needs a non-root POSIX user")
	}
	if _, err := fixture.store.Put("tenant-one", "agent-one", clicredential.Profile{URL: "https://teamhub.example", TenantID: "tenant-one", AgentID: "agent-one"}, credentialTestToken, 2); err != nil {
		t.Fatal(err)
	}
	agentDirectory := filepath.Dir(filepath.Dir(mustLookupPath(t, fixture.store)))
	if err := os.Chmod(agentDirectory, 0o500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(agentDirectory, 0o700) })
	remove.CommandID = "remove-two"
	remove.RunnerRevision = 3
	before := len(fixture.stream.snapshotEvents())
	if err := fixture.daemon.handleAgentRunnerCommand(ctx, fixture.stream, remove); err == nil {
		t.Fatal("removal acknowledged while the credential directory could not be deleted")
	}
	for _, event := range fixture.stream.snapshotEvents()[before:] {
		if event.Type == protocol.EventAgentRunnerRemoved {
			t.Fatal("removed event sent after a credential deletion failure")
		}
	}
}

func mustLookupPath(t *testing.T, store *clicredential.Store) string {
	t.Helper()
	installation, err := store.Lookup("tenant-one", "agent-one")
	if err != nil {
		t.Fatal(err)
	}
	return installation.CredentialPath
}

func TestAgentRunnerReadyReportsTheStoredCLICredential(t *testing.T) {
	ctx := context.Background()
	fixture := newCredentialFixture(t)
	ensure := protocol.Command{
		Type: protocol.CommandAgentRunnerEnsure, ProtocolVersion: "1.2", CommandID: "ensure-one",
		RunnerID: "computer-one", TenantID: "tenant-one", AgentID: "agent-one", RegistrationID: "registration-one",
		AssignmentRevision: 2, ConnectionEpoch: 7, RunnerRevision: 2,
		Payload: mustJSON(map[string]any{"runtime": map[string]any{"type": "codex"}, "workspace_grant_id": "grant-one"}),
	}
	readyReport := func() map[string]any {
		t.Helper()
		events := fixture.stream.snapshotEvents()
		last := events[len(events)-1]
		if last.Type != protocol.EventAgentRunnerReady {
			t.Fatalf("last event = %s, want ready", last.Type)
		}
		if len(last.Payload) == 0 {
			return nil
		}
		var payload struct {
			CLICredential map[string]any `json:"cli_credential"`
		}
		if err := json.Unmarshal(last.Payload, &payload); err != nil {
			t.Fatal(err)
		}
		return payload.CLICredential
	}
	if err := fixture.daemon.handleAgentRunnerCommand(ctx, fixture.stream, ensure); err != nil {
		t.Fatal(err)
	}
	if report := readyReport(); report != nil {
		t.Fatalf("ready reported %+v before any credential was stored", report)
	}
	if err := fixture.daemon.handleAgentCLICredentialPut(ctx, fixture.stream, credentialPutCommand("tenant-one", "agent-one")); err != nil {
		t.Fatal(err)
	}
	ensure.CommandID, ensure.RunnerRevision = "ensure-two", 3
	if err := fixture.daemon.handleAgentRunnerCommand(ctx, fixture.stream, ensure); err != nil {
		t.Fatal(err)
	}
	stored, ok, err := fixture.store.Current("tenant-one", "agent-one")
	if err != nil || !ok {
		t.Fatalf("stored credential = ok %v, err %v", ok, err)
	}
	report := readyReport()
	profile, _ := report["profile"].(map[string]any)
	if report["sha256"] != stored.SHA256 || report["assignment_revision"] != float64(2) ||
		profile["url"] != "https://teamhub.example" || profile["agent_id"] != "agent-one" {
		t.Fatalf("ready report = %+v", report)
	}
	if strings.Contains(mustMarshal(t, report), credentialTestToken) {
		t.Fatal("ready report exposes the token")
	}
}

func mustMarshal(t *testing.T, value any) string {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(encoded)
}
