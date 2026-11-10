package computerconfig

import (
	"encoding/base64"
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

func TestLoadReadsOwnerScopedExistingComputerConfig(t *testing.T) {
	root := t.TempDir()
	token := testToken("computer-1", "tenant-1", "owner-1")
	tokenPath := filepath.Join(root, "token")
	authPath := filepath.Join(root, "auth.json")
	configPath := filepath.Join(root, "computer.json")
	if err := os.WriteFile(tokenPath, []byte(token), 0o600); err != nil {
		t.Fatal(err)
	}
	encoded := fmt.Sprintf(`{"runner_id":"computer-1","display_name":"Computer","gateway":{"url":"wss://agent.example.test/v1/runner-gateway","token_file":%q},"state_directory":%q,"codex":{"auth_file":%q},"runtime_paths":{"codex":%q},"workspace_grants":[{"grant_id":"grant-1","tenant_id":"tenant-1","root_path":%q,"mode":"workspace-write","scope":"owner"}]}`, tokenPath, root, authPath, filepath.Join(root, "codex"), filepath.Join(root, "workspace"))
	if err := os.WriteFile(configPath, []byte(encoded), 0o600); err != nil {
		t.Fatal(err)
	}
	config, err := Load(configPath, nil)
	if err != nil {
		t.Fatal(err)
	}
	if config.ComputerID != "computer-1" || config.CodexAuthFile != authPath || len(config.Owners) != 1 || config.Owners[0].OwnerActorID != "owner-1" {
		t.Fatalf("config=%+v", config)
	}
}

func TestLoadRejectsCredentialForAnotherComputer(t *testing.T) {
	root := t.TempDir()
	tokenPath := filepath.Join(root, "token")
	configPath := filepath.Join(root, "computer.json")
	_ = os.WriteFile(tokenPath, []byte(testToken("computer-other", "tenant-1", "owner-1")), 0o600)
	encoded := fmt.Sprintf(`{"runner_id":"computer-1","display_name":"Computer","gateway":{"url":"wss://agent.example.test/v1/runner-gateway","token_file":%q},"state_directory":%q,"workspace_grants":[]}`, tokenPath, root)
	_ = os.WriteFile(configPath, []byte(encoded), 0o600)
	if _, err := Load(configPath, nil); err == nil {
		t.Fatal("cross-Computer credential was accepted")
	}
}

func testToken(computerID, tenantID, ownerID string) string {
	payload := fmt.Sprintf(`{"v":1,"runner_id":%q,"tenant_owners":[{"tenant_id":%q,"owner_actor_id":%q}]}`, computerID, tenantID, ownerID)
	return "sr1." + base64.RawURLEncoding.EncodeToString([]byte(payload)) + ".signature"
}
