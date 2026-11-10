package workspace

import (
	"context"

	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/pelletier/go-toml/v2"
)

func TestCodexRuntimeHomeIsStableIsolatedAndExclusivelyClaimed(t *testing.T) {
	root := filepath.Join(t.TempDir(), "runtime-homes")
	shared := filepath.Join(t.TempDir(), "shared-codex")
	if err := os.MkdirAll(shared, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(shared, "auth.json"), []byte(`{"token":"secret"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(shared, "config.toml"), []byte("model = \"o3\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	identity := RuntimeHomeIdentity{
		TenantID: "tenant-1", OwnerActorID: "owner-1", AgentID: "agent-1",
		ScopeID: "room-1", ProviderType: "codex",
	}
	home, err := PrepareCodexRuntimeHome(context.Background(), root, shared, identity, "0.100.0", slog.Default(), "")
	if err != nil {
		t.Fatal(err)
	}
	defer home.Close()
	if !strings.HasPrefix(home.Path, filepath.Join(root, "codex")+string(os.PathSeparator)) {
		t.Fatalf("Runtime home path = %q", home.Path)
	}
	auth, err := os.Lstat(filepath.Join(home.Path, "auth.json"))
	if err != nil || (runtime.GOOS != "windows" && auth.Mode()&os.ModeSymlink == 0) {
		t.Fatalf("Runtime auth link = %+v err=%v", auth, err)
	}
	if runtime.GOOS == "windows" {
		data, err := os.ReadFile(filepath.Join(home.Path, "auth.json"))
		if err != nil || string(data) != `{"token":"secret"}` {
			t.Fatalf("Runtime auth copy = %q err=%v", data, err)
		}
	}
	config, err := os.ReadFile(filepath.Join(home.Path, "config.toml"))
	var settings struct {
		Model    string         `toml:"model"`
		Features map[string]any `toml:"features"`
	}
	if err != nil || toml.Unmarshal(config, &settings) != nil || settings.Model != "o3" || settings.Features != nil {
		t.Fatalf("Runtime config = %q err=%v", config, err)
	}
	if _, err := PrepareCodexRuntimeHome(context.Background(), root, shared, identity, "0.100.0", slog.Default(), ""); err == nil {
		t.Fatal("concurrent Runtime home claim succeeded")
	}
	path := home.Path
	if err := home.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := PrepareCodexRuntimeHome(context.Background(), root, shared, identity, "0.100.0", slog.Default(), "")
	if err != nil {
		t.Fatal(err)
	}
	if reopened.Path != path {
		t.Fatalf("Runtime home changed across reuse: %q != %q", reopened.Path, path)
	}
	if err := reopened.Close(); err != nil {
		t.Fatal(err)
	}
	otherOwner := identity
	otherOwner.OwnerActorID = "owner-2"
	isolated, err := PrepareCodexRuntimeHome(context.Background(), root, shared, otherOwner, "0.100.0", slog.Default(), "")
	if err != nil {
		t.Fatal(err)
	}
	defer isolated.Close()
	if isolated.Path == path {
		t.Fatal("cross-owner Runtime home identity collided")
	}
}

func TestClaudeRuntimeHomePersistsSessionMarkersAcrossReuse(t *testing.T) {
	root := filepath.Join(t.TempDir(), "runtime-homes")
	identity := RuntimeHomeIdentity{
		TenantID: "tenant-1", OwnerActorID: "owner-1", AgentID: "agent-1",
		ScopeID: "room-1", ProviderType: "claude",
	}
	home, err := PrepareClaudeRuntimeHome(context.Background(), root, identity)
	if err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(home.Path, "sessions", "session.json")
	if err := os.WriteFile(marker, []byte(`{"session_id":"session"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	path := home.Path
	if err := home.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := PrepareClaudeRuntimeHome(context.Background(), root, identity)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	if reopened.Path != path {
		t.Fatalf("Claude Runtime home changed across reuse: %q != %q", reopened.Path, path)
	}
	if data, err := os.ReadFile(marker); err != nil || string(data) != `{"session_id":"session"}` {
		t.Fatalf("Claude session marker=%q err=%v", data, err)
	}
}

func TestRuntimeHomeInspectionAndReuseIgnoreRetiredBindingMarker(t *testing.T) {
	root := filepath.Join(t.TempDir(), "runtime-homes")
	identity := RuntimeHomeIdentity{TenantID: "tenant", OwnerActorID: "owner", AgentID: "agent", ScopeID: "context", ProviderType: "claude"}
	home, err := PrepareClaudeRuntimeHome(context.Background(), root, identity)
	if err != nil {
		t.Fatal(err)
	}
	expected := home.Path
	if err := os.WriteFile(filepath.Join(expected, "sessions", "retained"), []byte("current session"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := home.Close(); err != nil {
		t.Fatal(err)
	}
	// The old marker must not redirect either execution or read-only inspection.
	if err := os.WriteFile(expected+".legacy-binding", []byte("retired"), 0o600); err != nil {
		t.Fatal(err)
	}
	inspected, err := RuntimeHomePath(root, identity)
	if err != nil || inspected != expected {
		t.Fatalf("inspected = %q, %v", inspected, err)
	}
	reopened, err := PrepareClaudeRuntimeHome(context.Background(), root, identity)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	if reopened.Path != expected {
		t.Fatalf("home = %q, want %q", reopened.Path, expected)
	}
	if content, err := os.ReadFile(filepath.Join(reopened.Path, "sessions", "retained")); err != nil || string(content) != "current session" {
		t.Fatalf("retained session = %q, %v", content, err)
	}
}
