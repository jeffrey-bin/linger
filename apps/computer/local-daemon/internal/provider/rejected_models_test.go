package provider

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestRejectedModelsHideRefusedModelsForTheCurrentLogin(t *testing.T) {
	auth := filepath.Join(t.TempDir(), "auth.json")
	if err := os.WriteFile(auth, []byte("login-a"), 0o600); err != nil {
		t.Fatal(err)
	}
	now := time.Unix(1000, 0)
	rejected := NewRejectedModels(map[string]string{"codex": auth})
	rejected.now = func() time.Time { return now }
	diagnostics := []RuntimeDiagnostic{
		{Type: "codex", Models: []RuntimeModel{{ID: "gpt-a"}, {ID: "gpt-b"}}},
		{Type: "claude", Models: []RuntimeModel{{ID: "gpt-a"}}},
	}
	ids := func(diagnostics []RuntimeDiagnostic) [][]string {
		var result [][]string
		for _, diagnostic := range diagnostics {
			var models []string
			for _, model := range diagnostic.Models {
				models = append(models, model.ID)
			}
			result = append(result, models)
		}
		return result
	}

	rejected.Reject("codex", "gpt-a")
	if got := ids(rejected.Filter(diagnostics)); len(got[0]) != 1 || got[0][0] != "gpt-b" || len(got[1]) != 1 {
		t.Fatalf("filtered = %v, want only codex gpt-a hidden", got)
	}
	if len(diagnostics[0].Models) != 2 {
		t.Fatal("Filter changed its input")
	}
	// Rejecting the final candidate must publish an empty catalog.
	rejected.Reject("codex", "gpt-b")
	if got := ids(rejected.Filter(diagnostics)); len(got[0]) != 0 {
		t.Fatalf("filtered = %v, want an empty catalog", got)
	}

	// A new login makes every model selectable again.
	if err := os.WriteFile(auth, []byte("login-b-longer"), 0o600); err != nil {
		t.Fatal(err)
	}
	if !rejected.Expire() || rejected.Expire() {
		t.Fatal("a changed login must expire the refusals once")
	}
	rejected.Reject("codex", "gpt-a")
	now = now.Add(rejectedModelTTL)
	if !rejected.Expire() {
		t.Fatal("a refusal must expire after its time limit")
	}
	if got := ids(rejected.Filter(diagnostics)); len(got[0]) != 2 {
		t.Fatalf("filtered = %v after expiry", got)
	}
}
