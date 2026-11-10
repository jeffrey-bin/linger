package workspace

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const hostClaudeFixture = `{"claudeAiOauth":{"accessToken":"host","refreshToken":"host-refresh","expiresAt":4102444800000}}`
const refreshedClaudeFixture = `{"claudeAiOauth":{"accessToken":"refreshed","refreshToken":"new-refresh","expiresAt":4102448400000}}`

func TestClaudeReconcilesNativeKeychainAndHostRelogin(t *testing.T) {
	for _, scenario := range []struct {
		name, scoped, want string
		remove             bool
	}{
		{"empty OAuth shadows file", `{"claudeAiOauth":{"accessToken":"","refreshToken":"","expiresAt":0}}`, hostClaudeFixture, true},
		{"expired OAuth shadows file", `{"claudeAiOauth":{"accessToken":"expired","expiresAt":1}}`, hostClaudeFixture, true},
		{"newer native refresh", refreshedClaudeFixture, refreshedClaudeFixture, false},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			root := t.TempDir()
			entries := map[string][]byte{"": []byte(hostClaudeFixture), root: []byte(scenario.scoped)}
			stubClaudeKeychainEntries(t, entries)
			configure := func() {
				t.Helper()
				if err := configureClaudeCredentials(root, map[string]string{"HOME": t.TempDir()}, nil); err != nil {
					t.Fatal(err)
				}
			}
			configure()
			body, err := os.ReadFile(filepath.Join(root, ".credentials.json"))
			if err != nil || string(body) != scenario.want {
				t.Fatalf("wrong projected credential: %v", err)
			}
			if _, exists := entries[root]; exists == scenario.remove {
				t.Fatal("incorrect scoped Keychain reconciliation")
			}
			// The next Host login has an earlier expiry than the retained native refresh.
			// Its identity still must become authoritative for the existing Context.
			entries[""] = []byte(strings.Replace(hostClaudeFixture, "host", "relogin", -1))
			entries[root] = []byte(refreshedClaudeFixture)
			configure()
			body, err = os.ReadFile(filepath.Join(root, ".credentials.json"))
			if err != nil || string(body) != string(entries[""]) {
				t.Fatal("relogin did not replace existing Context credentials")
			}
			if _, exists := entries[root]; exists {
				t.Fatal("relogin left a stale Keychain shadow")
			}
		})
	}
}

func TestClaudeOperationWaitsForAnInFlightAuthCheck(t *testing.T) {
	root := t.TempDir()
	stubClaudeKeychain(t, hostClaudeFixture)
	identity := RuntimeHomeIdentity{TenantID: "t", OwnerActorID: "u", AgentID: "a", ScopeID: "s", ProviderType: "claude"}
	home, err := PrepareClaudeRuntimeHome(t.Context(), root, identity)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(home.Path, ".claude"), 0700); err != nil {
		t.Fatal(err)
	}
	_ = home.Close()
	entered, release := make(chan struct{}), make(chan struct{})
	checked := make(chan error, 1)
	environment := map[string]string{"HOME": t.TempDir()}
	go func() {
		checked <- VisitClaudeAuthEnvironments(t.Context(), root, environment, func(string) error { return nil }, func(map[string]string) error {
			close(entered)
			<-release
			return nil
		})
	}()
	<-entered
	admitted := make(chan error, 1)
	go func() {
		next, err := PrepareClaudeRuntimeHome(t.Context(), root, identity)
		if next != nil {
			_ = next.Close()
		}
		admitted <- err
	}()
	select {
	case err := <-admitted:
		close(release)
		<-checked
		t.Fatalf("auth check caused premature Operation admission: %v", err)
	case <-time.After(50 * time.Millisecond):
	}
	close(release)
	if err := <-checked; err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-admitted:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("Operation did not resume after authentication check")
	}
}

func TestClaudeScopedKeychainDeletionFailureDoesNotRecordRecovery(t *testing.T) {
	root := t.TempDir()
	entries := map[string][]byte{"": []byte(hostClaudeFixture), root: []byte(`{"claudeAiOauth":{"expiresAt":0}}`)}
	stubClaudeKeychainEntries(t, entries)
	claudeKeychainRemove = func(string) error { return errors.New("fixture access denied") }
	err := configureClaudeCredentials(root, map[string]string{"HOME": t.TempDir()}, nil)
	if err == nil {
		t.Fatal("failed cleanup was silently accepted")
	}
	if _, err := os.Stat(filepath.Join(root, ".linger-auth-source.sha256")); !os.IsNotExist(err) {
		t.Fatal("failed recovery committed source generation")
	}
}

func TestClaudeProbeReleasesNativeKeychain(t *testing.T) {
	entries := map[string][]byte{"": []byte(hostClaudeFixture)}
	stubClaudeKeychainEntries(t, entries)
	prepared, release, err := ClaudeProbeEnvironment(map[string]string{"HOME": t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	root := prepared["CLAUDE_CONFIG_DIR"]
	entries[root] = []byte(refreshedClaudeFixture)
	release()
	if _, exists := entries[root]; exists {
		t.Fatal("probe leaked a native Keychain login")
	}
}

func TestClaudeConfiguredSourceUsesItsOwnKeychain(t *testing.T) {
	source, root := t.TempDir(), t.TempDir()
	entries := map[string][]byte{"": []byte(refreshedClaudeFixture), source: []byte(hostClaudeFixture)}
	stubClaudeKeychainEntries(t, entries)
	if err := configureClaudeCredentials(root, map[string]string{"HOME": t.TempDir(), "CLAUDE_CONFIG_DIR": source}, nil); err != nil {
		t.Fatal(err)
	}
	body, _ := os.ReadFile(filepath.Join(root, ".credentials.json"))
	if string(body) != hostClaudeFixture {
		t.Fatal("configured source borrowed another login")
	}
}

func TestClaudeAuthMonitorRepairsIdleHomesAndLeavesActiveHomes(t *testing.T) {
	root := t.TempDir()
	entries := map[string][]byte{"": []byte(hostClaudeFixture)}
	stubClaudeKeychainEntries(t, entries)
	identity := RuntimeHomeIdentity{TenantID: "t", OwnerActorID: "u", AgentID: "a", ScopeID: "s", ProviderType: "claude"}
	home, err := PrepareClaudeRuntimeHome(t.Context(), root, identity)
	if err != nil {
		t.Fatal(err)
	}
	config := filepath.Join(home.Path, ".claude")
	if err := os.MkdirAll(config, 0700); err != nil {
		t.Fatal(err)
	}
	entries[config] = []byte(`{"claudeAiOauth":{"expiresAt":0}}`)
	count := 0
	visit := func(env map[string]string) error {
		count++
		if env["CLAUDE_CONFIG_DIR"] != config {
			t.Fatal("probed wrong Context")
		}
		return nil
	}
	if err := VisitClaudeAuthEnvironments(t.Context(), root, map[string]string{"HOME": t.TempDir()}, func(string) error { return nil }, visit); err != nil {
		t.Fatal(err)
	}
	if count != 0 || entries[config] == nil {
		t.Fatal("monitor touched active Context")
	}
	_ = home.Close()
	if err := VisitClaudeAuthEnvironments(t.Context(), root, map[string]string{"HOME": t.TempDir()}, func(string) error { return nil }, visit); err != nil {
		t.Fatal(err)
	}
	if count != 1 || entries[config] != nil {
		t.Fatal("idle Context was not repaired and probed")
	}
}

func TestClaudeAuthCheckCostDoesNotGrowWithIdleHomes(t *testing.T) {
	root := t.TempDir()
	stubClaudeKeychain(t, hostClaudeFixture)
	identity := RuntimeHomeIdentity{TenantID: "t", OwnerActorID: "u", AgentID: "a", ProviderType: "claude"}
	var newest string
	for index := range 150 {
		identity.ScopeID = fmt.Sprintf("scope-%d", index)
		home, err := PrepareClaudeRuntimeHome(t.Context(), root, identity)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.MkdirAll(filepath.Join(home.Path, ".claude"), 0700); err != nil {
			t.Fatal(err)
		}
		used := time.Now().Add(time.Duration(index-150) * time.Hour)
		if err := os.Chtimes(home.Path, used, used); err != nil {
			t.Fatal(err)
		}
		newest = home.Path
		_ = home.Close()
	}
	var visited []string
	visit := func(environment map[string]string) error {
		visited = append(visited, environment["CLAUDE_CONFIG_DIR"])
		return nil
	}
	if err := VisitClaudeAuthEnvironments(t.Context(), root, map[string]string{"HOME": t.TempDir()}, func(string) error { return nil }, visit); err != nil {
		t.Fatal(err)
	}
	// Every home holds the same projected login, so one probe covers them.
	if len(visited) != 1 || visited[0] != filepath.Join(newest, ".claude") {
		t.Fatalf("visited %v, want only the most recently used home", visited)
	}
	reconciled, err := filepath.Glob(filepath.Join(root, "claude", "*", ".claude", ".credentials.json"))
	if err != nil || len(reconciled) != claudeAuthCheckHomes {
		t.Fatalf("reconciled %d homes, want %d: %v", len(reconciled), claudeAuthCheckHomes, err)
	}
}
