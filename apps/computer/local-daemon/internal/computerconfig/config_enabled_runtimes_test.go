package computerconfig

import (
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func enabledConfig(t *testing.T, selection string) (Config, error) {
	t.Helper()
	root := t.TempDir()
	token := filepath.Join(root, "token")
	if err := os.WriteFile(token, []byte(testToken("computer-1", "tenant-1", "owner-1")), 0o600); err != nil {
		t.Fatal(err)
	}
	field := ""
	if selection != "" {
		field = `,"enabled_runtimes":` + selection
	}
	encoded := fmt.Sprintf(`{"runner_id":"computer-1","display_name":"Fixture","gateway":{"url":"wss://agent.example.test/v1/runner-gateway","token_file":%q},"state_directory":%q,"workspace_grants":[]%s}`, token, root, field)
	file := filepath.Join(root, "computer.json")
	if err := os.WriteFile(file, []byte(encoded), 0o600); err != nil {
		t.Fatal(err)
	}
	return Load(file, nil)
}

func TestEnabledRuntimeConfigAcceptsSupportedSubsets(t *testing.T) {
	for _, encoded := range []string{`["codex"]`, `["pi"]`, `["pi","codex"]`} {
		t.Run(encoded, func(t *testing.T) {
			config, err := enabledConfig(t, encoded)
			if err != nil {
				t.Fatalf("valid enabled subset rejected: %v", err)
			}
			field := reflect.ValueOf(config).FieldByName("EnabledRuntimes")
			if !field.IsValid() || field.Len() == 0 {
				t.Fatal("configured scope was discarded")
			}
		})
	}
}

func TestEnabledRuntimeConfigOmissionPreservesStandalone(t *testing.T) {
	if _, err := enabledConfig(t, ""); err != nil {
		t.Fatal(err)
	}
}

func TestEnabledRuntimeConfigRejectsMalformedExplicitScope(t *testing.T) {
	for _, value := range []string{`[]`, `null`, `["codex","codex"]`, `["other"]`, `"codex"`, `[1]`} {
		t.Run(value, func(t *testing.T) {
			if _, err := enabledConfig(t, value); err == nil {
				t.Fatal("malformed explicit selection accepted")
			}
		})
	}
}
