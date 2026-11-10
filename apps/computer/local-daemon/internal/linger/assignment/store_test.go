package assignment

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
)

func TestEmptyStoreSerializesRunnerListAsArray(t *testing.T) {
	records, err := NewMemoryStore().List(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(records)
	if err != nil || string(encoded) != "[]" {
		t.Fatalf("empty runner list=%s err=%v; want []", encoded, err)
	}
}

func TestStoreReplaysCommandWithItsFirstRecord(t *testing.T) {
	store := NewMemoryStore()
	command := Command{
		Type: "agent_runner.ensure", CommandID: "ensure-1", RunnerID: "computer-1",
		TenantID: "tenant-1", AgentID: "agent-1", RegistrationID: "registration-1",
		AssignmentRevision: 2, RunnerRevision: 1, Runtime: json.RawMessage(`{"type":"codex"}`),
		WorkspaceGrantID: "grant-1",
	}
	first, err := store.Apply(context.Background(), command, 123)
	if err != nil || first.State != "ready" || first.RunnerPID != 123 {
		t.Fatalf("first=%+v err=%v", first, err)
	}
	replayed, err := store.Apply(context.Background(), command, 999)
	if err != nil || replayed.RunnerPID != 123 {
		t.Fatalf("replay=%+v err=%v", replayed, err)
	}
	items, err := store.List(context.Background())
	if err != nil || len(items) != 1 || items[0].RegistrationID != "registration-1" {
		t.Fatalf("items=%+v err=%v", items, err)
	}
}

func TestStoreRejectsRevisionReuseAndStaleCommand(t *testing.T) {
	store := NewMemoryStore()
	base := Command{Type: "agent_runner.ensure", CommandID: "ensure-1", RunnerID: "computer-1", TenantID: "tenant-1", AgentID: "agent-1", RegistrationID: "registration-1", AssignmentRevision: 1, RunnerRevision: 2, Runtime: json.RawMessage(`{"type":"codex"}`), WorkspaceGrantID: "grant-1"}
	if _, err := store.Apply(context.Background(), base, 1); err != nil {
		t.Fatal(err)
	}
	conflict := base
	conflict.CommandID = "ensure-2"
	if replayed, err := store.Apply(context.Background(), conflict, 2); err != nil || replayed.RunnerPID != 1 {
		t.Fatalf("same revision snapshot replay=%+v err=%v", replayed, err)
	}
	conflict.WorkspaceGrantID = "grant-other"
	if _, err := store.Apply(context.Background(), conflict, 1); !errors.Is(err, ErrConflict) {
		t.Fatalf("conflict err=%v", err)
	}
	stale := base
	stale.RunnerRevision = 1
	stale.CommandID = "ensure-stale"
	if _, err := store.Apply(context.Background(), stale, 1); !errors.Is(err, ErrStale) {
		t.Fatalf("stale err=%v", err)
	}
}

func TestStoreReconcilesFullSnapshotAfterMissingOfflineRevisions(t *testing.T) {
	store := NewMemoryStore()
	command := Command{Type: "agent_runner.ensure", CommandID: "initial", RunnerID: "computer", TenantID: "tenant", AgentID: "agent", RegistrationID: "registration", AssignmentRevision: 1, RunnerRevision: 1, Runtime: json.RawMessage(`{"type":"codex"}`), WorkspaceGrantID: "grant"}
	if _, err := store.Apply(context.Background(), command, 1); err != nil {
		t.Fatal(err)
	}
	command.CommandID = "latest-snapshot"
	command.RunnerRevision = 5
	if latest, err := store.Apply(context.Background(), command, 2); err != nil || latest.RunnerRevision != 5 {
		t.Fatalf("offline reconciliation failed: %v", err)
	}
}

func TestStoreReplaysReorderedRuntime(t *testing.T) {
	store := NewMemoryStore()
	command := Command{Type: "agent_runner.ensure", CommandID: "first", RunnerID: "computer", TenantID: "tenant", AgentID: "agent", RegistrationID: "registration", AssignmentRevision: 1, RunnerRevision: 1, Runtime: json.RawMessage(`{"type":"codex","model":"gpt-5.6-sol","reasoning_effort":"low"}`), WorkspaceGrantID: "grant"}
	if _, err := store.Apply(context.Background(), command, 1); err != nil {
		t.Fatal(err)
	}
	command.CommandID = "replayed"
	command.Runtime = json.RawMessage(`{"model":"gpt-5.6-sol","reasoning_effort":"low","type":"codex"}`)
	if result, err := store.Apply(context.Background(), command, 2); err != nil || result.State != "ready" {
		t.Fatalf("reordered replay rejected: %+v, %v", result, err)
	}
	command.Runtime = json.RawMessage(`{"model":"gpt-5.6-sol","reasoning_effort":"high","type":"codex"}`)
	if _, err := store.Apply(context.Background(), command, 2); !errors.Is(err, ErrConflict) {
		t.Fatalf("changed reasoning accepted: %v", err)
	}
}

func TestReadyAssignmentRequiresFenceButUnseenRemovalDoesNot(t *testing.T) {
	store := NewMemoryStore()
	command := Command{Type: "agent_runner.ensure", CommandID: "ensure-unregistered", RunnerID: "computer", TenantID: "tenant", AgentID: "agent", RunnerRevision: 1, Runtime: json.RawMessage(`{"type":"codex"}`), WorkspaceGrantID: "grant"}
	if _, err := store.Apply(t.Context(), command, 1); !errors.Is(err, ErrConflict) {
		t.Fatalf("unregistered ensure=%v", err)
	}
	command.Type = "agent_runner.remove"
	command.CommandID = "remove-unseen"
	if record, err := store.Apply(t.Context(), command, 0); err != nil || record.State != "removed" {
		t.Fatalf("unseen remove=%+v err=%v", record, err)
	}
}
