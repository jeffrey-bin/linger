package workspace

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestPiSourceRetainsNativeAuthenticationAndManagedCLI(t *testing.T) {
	user := t.TempDir()
	source := map[string]string{"HOME": user, "ANTHROPIC_API_KEY": "fixture-only", "TEAMHUB_CONFIG": "managed-config", "TEAMHUB_PROFILE": "runtime", "TEAMHUB_TOKEN": "ambient-override", "TEAMHUB_HOST_URL": "ambient-url"}
	env, err := PiSourceEnvironment(source)
	if err != nil {
		t.Fatal(err)
	}
	if env["PI_CODING_AGENT_DIR"] != filepath.Join(user, ".pi", "agent") || env["ANTHROPIC_API_KEY"] != "fixture-only" || env["TEAMHUB_CONFIG"] != "managed-config" || env["TEAMHUB_PROFILE"] != "runtime" {
		t.Fatalf("Pi environment policy was not preserved: keys=%v", len(env))
	}
	if env["TEAMHUB_TOKEN"] != "" || env["TEAMHUB_HOST_URL"] != "" || source["TEAMHUB_TOKEN"] != "ambient-override" {
		t.Fatal("credential overrides leaked or the source was mutated")
	}
	if _, err := os.Stat(filepath.Join(user, ".pi")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("preparation unexpectedly copied or created native credentials")
	}
}

func TestPiHomesIsolateContextsAndReleaseClaims(t *testing.T) {
	root := t.TempDir()
	identity := RuntimeHomeIdentity{TenantID: "tenant", OwnerActorID: "owner", AgentID: "agent", ScopeID: "room-a", ProviderType: "pi"}
	first, err := PreparePiRuntimeHome(t.Context(), root, identity)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	if _, err := PreparePiRuntimeHome(t.Context(), root, identity); !errors.Is(err, ErrRuntimeHomeInUse) {
		t.Fatalf("second writer accepted: %v", err)
	}
	other := identity
	other.ScopeID = "room-b"
	second, err := PreparePiRuntimeHome(t.Context(), root, other)
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	if first.Path == second.Path {
		t.Fatal("Context session roots were shared")
	}
	_ = first.Close()
	resumed, err := PreparePiRuntimeHome(t.Context(), root, identity)
	if err != nil {
		t.Fatal(err)
	}
	defer resumed.Close()
	if resumed.Path != first.Path {
		t.Fatal("Context home moved after release")
	}
}

func TestPiConfigDigestFollowsSettingsAndModelsOnly(t *testing.T) {
	dir := t.TempDir()
	environment := map[string]string{"PI_CODING_AGENT_DIR": dir}
	digest := func() string {
		t.Helper()
		value, err := PiConfigDigest(environment)
		if err != nil {
			t.Fatal(err)
		}
		return value
	}
	empty := digest()
	if err := os.WriteFile(filepath.Join(dir, "auth.json"), []byte(`{"token":"x"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if digest() != empty {
		t.Fatal("auth.json changed the config digest")
	}
	if err := os.WriteFile(filepath.Join(dir, "settings.json"), []byte(`{"a":1}`), 0o600); err != nil {
		t.Fatal(err)
	}
	settings := digest()
	if settings == empty {
		t.Fatal("settings.json did not change the config digest")
	}
	if err := os.WriteFile(filepath.Join(dir, "models.json"), []byte(`{}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if digest() == settings {
		t.Fatal("models.json did not change the config digest")
	}
	if entries, _ := os.ReadDir(dir); len(entries) != 3 {
		t.Fatalf("the digest created files: %v", entries)
	}
}
