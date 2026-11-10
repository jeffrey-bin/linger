package agentregistry

import (
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

func storedLocalComputer(status string, lastSeen time.Time) store.LocalComputer {
	return store.LocalComputer{
		ComputerID: "computer_1", DisplayName: "Mac", Status: status, ActiveOperations: 1,
		Capacity:           pgtype.Int4{Int32: 2, Valid: true},
		LastSeenAt:         pgtype.Timestamptz{Time: lastSeen, Valid: true},
		DaemonVersion:      pgtype.Text{String: "0.40.0", Valid: true},
		RecommendedVersion: pgtype.Text{String: "0.41.0", Valid: true},
		WorkspaceGrants: []byte(`[
			{"grant_id":"grant_b","tenant_id":"tenant_1","scope":"owner","label":"Files","mode":"workspace-write"},
			{"grant_id":"grant_a","tenant_id":"tenant_2","scope":"owner","mode":"workspace-write"},
			{"grant_id":"grant_c","tenant_id":"tenant_1","scope":"shared","mode":"read-only"}]`),
		RuntimeDiagnostics: []byte(`[
			{"type":"codex","status":"ready","protocol":"app-server","checked_at":"2026-11-03T00:00:00Z","version":"1.2",
			 "models":[{"id":"gpt","label":"GPT","allowed_reasoning_effort":["medium","high"],"default_reasoning_effort":"high","is_default":true}]},
			{"type":"claude","status":"authentication_required","protocol":"stream-json","checked_at":"2026-11-03T00:00:00Z",
			 "error":{"code":"RUNTIME_AUTHENTICATION_REQUIRED","message":"Sign in"}},
			{"type":"pi","status":"ready","protocol":"rpc","checked_at":"2026-11-03T00:00:00Z","models":[],"model_catalog_error":{"code":"x"}}]`),
	}
}

func TestProjectStoredLocalComputerReadsTheRecordedInventory(t *testing.T) {
	now := time.Date(2026, 11, 3, 12, 0, 0, 0, time.UTC)
	item, listed, err := projectStoredLocalComputer(storedLocalComputer("online", now.Add(-20*time.Second)), "tenant_1", now)
	if err != nil || !listed {
		t.Fatalf("listed=%v err=%v", listed, err)
	}
	if item.Status != httpapi.LocalComputerStatusOnline || item.ActiveOperations != 1 || *item.AvailableCapacity != 1 ||
		*item.DaemonVersion != "0.40.0" || *item.RecommendedVersion != "0.41.0" {
		t.Fatalf("computer=%+v", item)
	}
	if len(item.WorkspaceGrants) != 1 || item.WorkspaceGrants[0].GrantId != "grant_b" || item.WorkspaceGrants[0].Label != "Files" {
		t.Fatalf("grants=%+v", item.WorkspaceGrants)
	}
	if len(item.Runtimes) != 3 || item.Runtimes[0].Type != "claude" || item.Runtimes[1].Type != "codex" || item.Runtimes[2].Type != "pi" {
		t.Fatalf("runtimes=%+v", item.Runtimes)
	}
	claude, codex, pi := item.Runtimes[0], item.Runtimes[1], item.Runtimes[2]
	if claude.Status != "authentication_required" || *claude.ErrorCode != "RUNTIME_AUTHENTICATION_REQUIRED" ||
		len(claude.Models) != 1 || claude.Models[0].Id != "claude-default" {
		t.Fatalf("claude=%+v", claude)
	}
	if len(codex.Models) != 1 || *codex.Models[0].DefaultReasoningEffort != "high" || len(*codex.Models[0].AllowedReasoningEffort) != 2 ||
		codex.Models[0].IsDefault == nil || !*codex.Models[0].IsDefault || claude.Models[0].IsDefault != nil {
		t.Fatalf("codex=%+v", codex)
	}
	if len(pi.Models) != 0 {
		t.Fatalf("pi=%+v", pi)
	}
}

func TestProjectStoredLocalComputerKeepsRuntimesOfAnOfflineComputer(t *testing.T) {
	now := time.Date(2026, 11, 3, 12, 0, 0, 0, time.UTC)
	for name, row := range map[string]store.LocalComputer{
		"disconnected":     storedLocalComputer("offline", now.Add(-time.Hour)),
		"stale heartbeat":  storedLocalComputer("online", now.Add(-2*time.Minute)),
		"upgrade required": storedLocalComputer("upgrade_required", now),
	} {
		t.Run(name, func(t *testing.T) {
			item, listed, err := projectStoredLocalComputer(row, "tenant_1", now)
			if err != nil || !listed || item.Status != httpapi.LocalComputerStatusOffline ||
				item.ActiveOperations != 0 || *item.AvailableCapacity != 0 {
				t.Fatalf("computer=%+v listed=%v err=%v", item, listed, err)
			}
			if item.UpgradeRequired != (row.Status == "upgrade_required") {
				t.Fatalf("upgrade_required=%v", item.UpgradeRequired)
			}
			if item.Runtimes[1].Status != "ready" || item.Runtimes[1].Models[0].Id != "gpt" {
				t.Fatalf("codex=%+v", item.Runtimes[1])
			}
		})
	}
}

func TestProjectStoredLocalComputerSkipsAComputerWithoutAnOwnerGrant(t *testing.T) {
	now := time.Now()
	_, listed, err := projectStoredLocalComputer(storedLocalComputer("online", now), "tenant_3", now)
	if err != nil || listed {
		t.Fatalf("listed=%v err=%v", listed, err)
	}
}
