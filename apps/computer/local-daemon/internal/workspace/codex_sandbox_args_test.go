package workspace

import (
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/pelletier/go-toml/v2"
)

// #249: the daemon must never rewrite the task home's config.toml for the
// sandbox policy, whatever the shared config holds, so repeated preparation
// cannot produce duplicate keys.
func TestPrepareCodexHomeReturnsSandboxArgsAndLeavesConfigAlone(t *testing.T) {
	cases := []struct {
		name    string
		config  string // empty means no shared config.toml
		wantErr bool   // the copied config is unparseable; preparation fails before any sandbox decision
	}{
		{"no shared config", "", false},
		{"no sandbox key", "model = \"o3\"\n", false},
		{"top-level sandbox_mode", "sandbox_mode = \"read-only\"\nmodel = \"o3\"\n", false},
		{"same key inside a table", "[permissions.linger]\nsandbox_mode = \"read-only\"\n", false},
		{"windows native sandbox", "[windows]\nsandbox = \"elevated\"\n", false},
		{"invalid TOML", "sandbox_mode = \n[[[broken", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			shared, home := filepath.Join(root, ".codex"), filepath.Join(root, "runtime")
			if err := os.MkdirAll(shared, 0o700); err != nil {
				t.Fatal(err)
			}
			if tc.config != "" {
				if err := os.WriteFile(filepath.Join(shared, "config.toml"), []byte(tc.config), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			opts := CodexHomeOptions{SharedHome: shared, UserHome: root, CodexVersion: "0.153.4"}
			var first []byte
			for run := 0; run < 3; run++ {
				projection, err := PrepareCodexHome(home, opts, slog.Default())
				args := projection.Args
				if tc.wantErr {
					if err == nil || args != nil {
						t.Fatalf("expected an error for invalid TOML, got args=%q err=%v", args, err)
					}
					data, _ := os.ReadFile(filepath.Join(home, "config.toml"))
					if strings.Contains(string(data), "sandbox_mode = \"danger") {
						t.Fatalf("daemon must not write sandbox settings into an invalid config:\n%s", data)
					}
					return
				}
				if err != nil {
					t.Fatal(err)
				}
				if want := []string{"-c", `sandbox_mode="danger-full-access"`}; !slices.Equal(args, want) {
					t.Fatalf("args = %q, want %q", args, want)
				}
				data, _ := os.ReadFile(filepath.Join(home, "config.toml"))
				if run == 0 {
					first = data
				} else if string(data) != string(first) {
					t.Fatalf("config.toml changed between runs:\n%s\n---\n%s", first, data)
				}
			}
			{
				var parsed map[string]any
				if err := toml.Unmarshal(first, &parsed); err != nil {
					t.Fatalf("config.toml must stay parseable (no duplicate keys): %v\n%s", err, first)
				}
				if tc.config != "" {
					if _, managed := parsed["sandbox_workspace_write"]; managed {
						t.Fatalf("daemon wrote sandbox settings into config.toml:\n%s", first)
					}
				}
			}
			if tc.config == "sandbox_mode = \"read-only\"\nmodel = \"o3\"\n" {
				// Only the user's own value remains in the file; the -c override wins at launch.
				var parsed map[string]any
				_ = toml.Unmarshal(first, &parsed)
				if parsed["sandbox_mode"] != "read-only" {
					t.Fatalf("user config was altered: %s", first)
				}
			}
		})
	}
}
