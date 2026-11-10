package workspace

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestClaudeCredentialChangeRetiresTheResidentFirst(t *testing.T) {
	root := t.TempDir()
	entries := map[string][]byte{"": []byte(hostClaudeFixture)}
	stubClaudeKeychainEntries(t, entries)
	environment := func() map[string]string { return map[string]string{"HOME": t.TempDir()} }
	var retired []string
	retire := func() error {
		body, _ := os.ReadFile(filepath.Join(root, ".credentials.json"))
		retired = append(retired, string(body))
		return nil
	}
	if err := configureClaudeCredentials(root, environment(), retire); err != nil {
		t.Fatal(err)
	}
	retired = nil
	// Unchanged source: nothing changes, the resident stays.
	if err := configureClaudeCredentials(root, environment(), retire); err != nil || len(retired) != 0 {
		t.Fatalf("unchanged login retired resident: %v %v", retired, err)
	}
	// Relogin: the resident is stopped while the old login is still on disk.
	entries[""] = []byte(strings.ReplaceAll(hostClaudeFixture, "host", "relogin"))
	if err := configureClaudeCredentials(root, environment(), retire); err != nil {
		t.Fatal(err)
	}
	if len(retired) != 1 || retired[0] != hostClaudeFixture {
		t.Fatalf("resident not retired before relogin was written: %q", retired)
	}
}

func TestClaudeCredentialChangeKeepsOldLoginWhenResidentSurvives(t *testing.T) {
	root := t.TempDir()
	entries := map[string][]byte{"": []byte(hostClaudeFixture)}
	stubClaudeKeychainEntries(t, entries)
	if err := configureClaudeCredentials(root, map[string]string{"HOME": t.TempDir()}, nil); err != nil {
		t.Fatal(err)
	}
	entries[""] = []byte(strings.ReplaceAll(hostClaudeFixture, "host", "relogin"))
	entries[root] = []byte(refreshedClaudeFixture)
	stuck := errors.New("unconfirmed")
	if err := configureClaudeCredentials(root, map[string]string{"HOME": t.TempDir()}, func() error { return stuck }); !errors.Is(err, stuck) {
		t.Fatalf("err = %v", err)
	}
	body, _ := os.ReadFile(filepath.Join(root, ".credentials.json"))
	if string(body) != hostClaudeFixture || entries[root] == nil {
		t.Fatal("credentials changed under a live resident")
	}
}

func TestClaudeAuthCheckSkipsHomeWhoseResidentCannotStop(t *testing.T) {
	root := t.TempDir()
	entries := map[string][]byte{"": []byte(hostClaudeFixture)}
	stubClaudeKeychainEntries(t, entries)
	home, err := PrepareClaudeRuntimeHome(t.Context(), root, RuntimeHomeIdentity{TenantID: "t", OwnerActorID: "o", AgentID: "a", ScopeID: "s", ProviderType: "claude"})
	if err != nil {
		t.Fatal(err)
	}
	config := filepath.Join(home.Path, ".claude")
	if err := os.MkdirAll(config, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := configureClaudeCredentials(config, map[string]string{"HOME": t.TempDir()}, nil); err != nil {
		t.Fatal(err)
	}
	_ = home.Close()
	entries[""] = []byte(strings.ReplaceAll(hostClaudeFixture, "host", "relogin"))
	entries[config] = []byte(refreshedClaudeFixture)
	visited, asked := 0, ""
	err = VisitClaudeAuthEnvironments(t.Context(), root, map[string]string{"HOME": t.TempDir()}, func(path string) error {
		asked = path
		return errors.New("unconfirmed")
	}, func(map[string]string) error { visited++; return nil })
	if err != nil || visited != 0 || asked != home.Path {
		t.Fatalf("err=%v visited=%d asked=%q", err, visited, asked)
	}
	body, _ := os.ReadFile(filepath.Join(config, ".credentials.json"))
	if string(body) != hostClaudeFixture || string(entries[config]) != refreshedClaudeFixture {
		t.Fatal("auth check changed credentials under a live resident")
	}
}

func TestClaudeCredentialMirrorOfNativeRefreshKeepsTheResident(t *testing.T) {
	root := t.TempDir()
	entries := map[string][]byte{"": []byte(hostClaudeFixture)}
	stubClaudeKeychainEntries(t, entries)
	if err := configureClaudeCredentials(root, map[string]string{"HOME": t.TempDir()}, nil); err != nil {
		t.Fatal(err)
	}
	// The parked CLI refreshed natively; the new login lives only in the
	// scoped Keychain entry, which shadows the file Claude would read.
	entries[root] = []byte(refreshedClaudeFixture)
	retired := 0
	if err := configureClaudeCredentials(root, map[string]string{"HOME": t.TempDir()}, func() error { retired++; return nil }); err != nil {
		t.Fatal(err)
	}
	body, _ := os.ReadFile(filepath.Join(root, ".credentials.json"))
	if retired != 0 || string(body) != refreshedClaudeFixture || string(entries[root]) != refreshedClaudeFixture {
		t.Fatalf("mirror retired=%d file=%t", retired, string(body) == refreshedClaudeFixture)
	}
}
