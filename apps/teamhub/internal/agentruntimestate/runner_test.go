package agentruntimestate

import (
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

func TestLocalComputerReadSkipsRetiredRuntimeInventoryAndDiagnostics(t *testing.T) {
	row := store.LocalComputer{
		ComputerID: "mixed", RuntimeInventory: []byte(`["hermes","codex","opencode","pi"]`),
		RuntimeDiagnostics: []byte(`[{"type":"hermes","protocol":"acp"},{"type":"codex","status":"ready"},{"type":"opencode"},{"type":"pi","status":"not_installed"}]`),
		WorkspaceGrants:    []byte(`[]`),
	}
	got, err := localComputerFromRow(row)
	if err != nil {
		t.Fatal(err)
	}
	if string(got.Runtimes) != `["codex","pi"]` || string(got.RuntimeDiagnostics) != `[{"status":"ready","type":"codex"},{"status":"not_installed","type":"pi"}]` {
		t.Fatalf("unfiltered Computer: runtimes=%s diagnostics=%s", got.Runtimes, got.RuntimeDiagnostics)
	}
	if !strings.Contains(string(row.RuntimeInventory), "hermes") || !strings.Contains(string(row.RuntimeDiagnostics), "hermes") {
		t.Fatal("read changed the stored row")
	}
	row.RuntimeInventory = []byte(`["hermes"]`)
	row.RuntimeDiagnostics = []byte(`[{"type":"hermes"}]`)
	got, err = localComputerFromRow(row)
	if err != nil || string(got.Runtimes) != `[]` || string(got.RuntimeDiagnostics) != `[]` {
		t.Fatalf("retired-only Computer: %+v %v", got, err)
	}
}

func TestLocalComputerReadPreservesSupportedObservationFormats(t *testing.T) {
	for _, test := range []struct {
		name        string
		inventory   string
		diagnostics string
		wantRuntime string
		wantDiag    string
	}{
		{
			name: "dev Windows observation", inventory: `[{"type":"codex"}]`, diagnostics: `[]`,
			wantRuntime: `[{"type":"codex"}]`, wantDiag: `[]`,
		},
		{
			name:        "object inventory with retired runtimes",
			inventory:   `[{"type":"hermes","protocol":"acp"},{"type":"codex","version":"1"},{"type":"opencode"},{"type":"pi"}]`,
			diagnostics: `[{"type":"hermes","protocol":"acp","runtime":{"legacy":true}},{"type":"codex","status":"ready"}]`,
			wantRuntime: `[{"type":"codex","version":"1"},{"type":"pi"}]`,
			wantDiag:    `[{"type":"codex","status":"ready"}]`,
		},
		{
			name: "legacy diagnostic runtime field", inventory: `["codex","claude","pi","hermes"]`,
			diagnostics: `[{"runtime":"hermes","status":"ready"},{"runtime":"codex","status":"ready"},{"runtime":"opencode"},{"runtime":"claude","status":"not_installed"}]`,
			wantRuntime: `["codex","claude","pi"]`,
			wantDiag:    `[{"runtime":"codex","status":"ready"},{"runtime":"claude","status":"not_installed"}]`,
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			row := store.LocalComputer{
				ComputerID: "computer_runtime_freshness", Status: "online",
				Platform:         pgtype.Text{String: "win32", Valid: true},
				RuntimeInventory: []byte(test.inventory), RuntimeDiagnostics: []byte(test.diagnostics),
				WorkspaceGrants: []byte(`[]`),
			}
			got, err := localComputerFromRow(row)
			if err != nil {
				t.Fatalf("project Local Computer observation: %v", err)
			}
			if got.Platform != "win32" || got.Status != "online" ||
				!sameJSON(got.Runtimes, []byte(test.wantRuntime)) || !sameJSON(got.RuntimeDiagnostics, []byte(test.wantDiag)) {
				t.Fatalf("Local Computer projection: %+v", got)
			}
			if string(row.RuntimeInventory) != test.inventory || string(row.RuntimeDiagnostics) != test.diagnostics {
				t.Fatal("read changed the stored observation")
			}
		})
	}
}

func TestDaemonIdentityInUseMatchesOnlyTheDaemonIDIndex(t *testing.T) {
	held := fmt.Errorf("bind: %w", &pgconn.PgError{Code: "23505", ConstraintName: "local_computers_daemon_id_idx"})
	if !isDaemonIdentityInUse(held) {
		t.Fatal("a unique violation on the Daemon ID index was not recognized")
	}
	for _, err := range []error{
		&pgconn.PgError{Code: "23505", ConstraintName: "local_computers_pkey"},
		&pgconn.PgError{Code: "23514", ConstraintName: "local_computers_daemon_id_idx"},
		errors.New("unique violation"),
	} {
		if isDaemonIdentityInUse(err) {
			t.Fatalf("unrelated error matched: %v", err)
		}
	}
	if !errors.Is(ErrDaemonIdentityInUse, ErrConflict) {
		t.Fatal("a held Daemon Identity must surface as a conflict")
	}
}
