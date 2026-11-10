package lingercontext

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/clicredential"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/registration"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/protocol"
)

// cliTestResolver binds the trusted CLI path and a Registration for tenant/agent.
// The credential lookup is set only when the test supplies a store, so a nil
// store never reaches the resolver as a non-nil interface.
func cliTestResolver(root string, store *clicredential.Store) ExecutionResolver {
	resolver := ExecutionResolver{TeamHubCLIBin: "/trusted/release/cli", Providers: map[string]ProviderInstallation{"codex": {Type: "codex", ExecutablePath: "/trusted/codex", Environment: map[string]string{"PATH": "/bin"}}}, WorkspaceGrants: map[string]WorkspaceGrant{"grant": {GrantID: "grant", TenantID: "tenant", Path: root}}, Registrations: map[string]RegistrationBinding{"registration": {RegistrationID: "registration", TenantID: "tenant", ProviderType: "codex", Status: registration.StatusOnline}}, Views: testContextViews{root: root}}
	if store != nil {
		resolver.CLICredentials = store
	}
	return resolver
}

func cliTestCommand(contextKey string) protocol.Command {
	return protocol.Command{TenantID: "tenant", AgentID: "agent", RegistrationID: "registration", AssignmentRevision: 1, WorkspaceGrantID: "grant", ExecutionContextKey: contextKey, RuntimeType: "codex",
		ContextViewRef: json.RawMessage(`{"receipt_ref":"receipt-1"}`)}
}

func cliTestCredentialStore(t *testing.T, install bool) *clicredential.Store {
	t.Helper()
	store, err := clicredential.Open(filepath.Join(t.TempDir(), "agent-cli-credentials"))
	if err != nil {
		t.Fatal(err)
	}
	if install {
		profile := clicredential.Profile{URL: "https://teamhub.example", TenantID: "tenant", AgentID: "agent"}
		if _, err := store.Put("tenant", "agent", profile, "th_agent_"+strings.Repeat("a", 43), 1); err != nil {
			t.Fatal(err)
		}
	}
	return store
}

func TestResolverExposesInstalledCLIProfileWithoutWireEnvironment(t *testing.T) {
	root := t.TempDir()
	store := cliTestCredentialStore(t, true)
	resolver := cliTestResolver(root, store)
	// The first run has no config.json yet; the profile comes from the credential.
	spec, err := resolver.Resolve(context.Background(), cliTestCommand(""), json.RawMessage(`{"kind":"run.start","runtime":{"type":"codex"},"session":{"threadId":""},"input":{"type":"text","text":"hi"},"environment":{"TEAMHUB_CONFIG":"/evil/config","TEAMHUB_TOKEN":"secret"}}`))
	if err != nil {
		t.Fatal(err)
	}
	config := filepath.Join(root, ".teamhub", "cli", "config.json")
	if _, err := os.Stat(config); !os.IsNotExist(err) {
		t.Fatalf("resolver must not create config.json: %v", err)
	}
	if spec.Environment["TEAMHUB_CONFIG"] != config || spec.Environment["TEAMHUB_PROFILE"] != "runtime" || spec.Environment["TEAMHUB_TOKEN"] != "" || spec.Environment["PATH"] != "/trusted/release/cli"+string(os.PathListSeparator)+"/bin" {
		t.Fatalf("CLI configuration or installed path was not derived locally: %+v", spec.Environment)
	}
}

func TestResolverSetsNoCLIEnvironmentWithoutCredential(t *testing.T) {
	root := t.TempDir()
	for name, store := range map[string]*clicredential.Store{
		"no store":    nil,
		"empty store": cliTestCredentialStore(t, false),
	} {
		t.Run(name, func(t *testing.T) {
			spec, err := cliTestResolver(root, store).Resolve(context.Background(), cliTestCommand(""), json.RawMessage(`{"kind":"run.start","runtime":{"type":"codex"},"session":{"threadId":""},"input":{"type":"text","text":"hi"}}`))
			if err != nil {
				t.Fatal(err)
			}
			if _, ok := spec.Environment["TEAMHUB_CONFIG"]; ok {
				t.Fatalf("CLI environment set without a business credential: %+v", spec.Environment)
			}
		})
	}
}

func TestResolverPrepareAndStartShareCLIEnvironment(t *testing.T) {
	root := t.TempDir()
	store := cliTestCredentialStore(t, true)
	resolver := cliTestResolver(root, store)
	prepare, err := resolver.Resolve(context.Background(), cliTestCommand("context-one"), json.RawMessage(`{"kind":"run.start","runtime":{"type":"codex"},"session":{"threadId":""},"input":{"type":"text","text":"hi"}}`))
	if err != nil {
		t.Fatal(err)
	}
	start, err := resolver.Resolve(context.Background(), cliTestCommand("context-one"), json.RawMessage(`{"kind":"run.start","runtime":{"type":"codex"},"session":{"threadId":""},"input":{"type":"text","text":"hi"},"cli_run_context":{"scope":{"kind":"room","id":"room-1"}}}`))
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"TEAMHUB_CONFIG", "TEAMHUB_PROFILE", "PATH"} {
		if prepare.Environment[name] == "" || prepare.Environment[name] != start.Environment[name] {
			t.Fatalf("%s differs between prepare and start: %q vs %q", name, prepare.Environment[name], start.Environment[name])
		}
	}
}

func TestResolverRejectsCLIConfigurationThroughSymbolicParent(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	if err := os.MkdirAll(filepath.Join(outside, "cli"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(outside, "cli", "config.json"), []byte(`{}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := createTestDirectoryLink(outside, filepath.Join(root, ".teamhub")); err != nil {
		t.Fatal(err)
	}
	resolver := ExecutionResolver{TeamHubCLIBin: "/trusted/cli", Providers: map[string]ProviderInstallation{"codex": {Type: "codex", ExecutablePath: "/trusted/codex"}}, WorkspaceGrants: map[string]WorkspaceGrant{"grant": {GrantID: "grant", TenantID: "tenant", Path: root}}, Registrations: map[string]RegistrationBinding{"registration": {RegistrationID: "registration", TenantID: "tenant", ProviderType: "codex", Status: registration.StatusOnline}}}
	_, err := resolver.Resolve(context.Background(), protocol.Command{TenantID: "tenant", AgentID: "agent", RegistrationID: "registration", AssignmentRevision: 1, WorkspaceGrantID: "grant", RuntimeType: "codex"}, json.RawMessage(`{"kind":"run.start","runtime":{"type":"codex"},"session":{"threadId":""},"input":{"type":"text","text":"hi"}}`))
	if err == nil {
		t.Fatal("symbolic parent configuration must not be passed to the Runtime")
	}
}
