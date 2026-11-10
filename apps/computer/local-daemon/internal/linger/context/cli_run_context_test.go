package lingercontext

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/clicredential"
)

const cliTestTokenA = "th_agent_" + "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
const cliTestTokenB = "th_agent_" + "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

func cliTestStore(t *testing.T) *clicredential.Store {
	t.Helper()
	store, err := clicredential.Open(filepath.Join(t.TempDir(), "agent-cli-credentials"))
	if err != nil {
		t.Fatal(err)
	}
	return store
}

func putCLICredential(t *testing.T, store *clicredential.Store, token string, assignmentRevision uint64) {
	t.Helper()
	profile := clicredential.Profile{URL: "https://teamhub.example", TenantID: "tenant-one", AgentID: "agent-one"}
	if _, err := store.Put("tenant-one", "agent-one", profile, token, assignmentRevision); err != nil {
		t.Fatal(err)
	}
}

func readConfigDocument(t *testing.T, workspace string) cliConfigDocument {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(workspace, cliConfigFile))
	if err != nil {
		t.Fatal(err)
	}
	var document cliConfigDocument
	if err := json.Unmarshal(data, &document); err != nil {
		t.Fatal(err)
	}
	return document
}

func TestParseCLIRunContext(t *testing.T) {
	content, scope, err := ParseCLIRunContext(json.RawMessage(`{"kind":"run.start"}`))
	if err != nil || string(content) != `{}` || scope != nil {
		t.Fatalf("absent field = %s, %+v, %v", content, scope, err)
	}
	content, scope, err = ParseCLIRunContext(json.RawMessage(`{"cli_run_context":{"run_id":"run_one","scope":{"kind":"room","id":"room-1"}}}`))
	if err != nil || string(content) != `{"run_id":"run_one"}` || scope == nil || scope.Kind != "room" || scope.ID != "room-1" {
		t.Fatalf("scoped object = %s, %+v, %v", content, scope, err)
	}
	for name, payload := range map[string]string{
		"null":           `{"cli_run_context":null}`,
		"array":          `{"cli_run_context":[]}`,
		"string":         `{"cli_run_context":"x"}`,
		"oversized":      `{"cli_run_context":{"pad":"` + strings.Repeat("x", 16*1024) + `"}}`,
		"scope kind":     `{"cli_run_context":{"scope":{"kind":"thread","id":"x"}}}`,
		"agent scope":    `{"cli_run_context":{"scope":{"kind":"agent","id":"x"}}}`,
		"scope id":       `{"cli_run_context":{"scope":{"kind":"room","id":"../x"}}}`,
		"scope null":     `{"cli_run_context":{"scope":null}}`,
		"scope not json": `{"cli_run_context":{"scope":"room"}}`,
	} {
		if _, _, err := ParseCLIRunContext(json.RawMessage(payload)); err == nil {
			t.Fatalf("%s was accepted", name)
		}
	}
}

func TestPrepareRunCLIWritesConfigPointingAtAgentCredential(t *testing.T) {
	store := cliTestStore(t)
	putCLICredential(t, store, cliTestTokenA, 1)
	installation, err := store.Lookup("tenant-one", "agent-one")
	if err != nil {
		t.Fatal(err)
	}
	workspace := t.TempDir()
	payload := json.RawMessage(`{"cli_run_context":{"run_id":"run_one","scope":{"kind":"task","id":"task-1"}}}`)
	if err := PrepareRunCLI(workspace, "tenant-one", "agent-one", store, payload); err != nil {
		t.Fatal(err)
	}
	document := readConfigDocument(t, workspace)
	profile := document.Profiles["runtime"]
	if document.Version != 1 || document.DefaultProfile != "runtime" || profile.TokenFile != installation.CredentialPath ||
		profile.URL != "https://teamhub.example" || profile.TenantID != "tenant-one" || profile.AgentID != "agent-one" ||
		profile.Scope != (CLIScope{Kind: "task", ID: "task-1"}) {
		t.Fatalf("config = %+v", document)
	}
	if !filepath.IsAbs(profile.TokenFile) {
		t.Fatalf("token_file is not absolute: %s", profile.TokenFile)
	}
	runData, err := os.ReadFile(filepath.Join(workspace, cliRunFile))
	if err != nil || strings.TrimSpace(string(runData)) != `{"run_id":"run_one"}` {
		t.Fatalf("run.json = %q, %v", runData, err)
	}
	if runtime.GOOS != "windows" {
		info, err := os.Stat(filepath.Join(workspace, cliConfigFile))
		if err != nil || info.Mode().Perm() != 0o600 {
			t.Fatalf("config mode = %v, %v", info, err)
		}
	}
}

func TestPrepareRunCLIRemovesFilesWithoutScope(t *testing.T) {
	store := cliTestStore(t)
	putCLICredential(t, store, cliTestTokenA, 1)
	workspace := t.TempDir()
	if err := os.MkdirAll(filepath.Join(workspace, ".teamhub", "cli"), 0o700); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{cliConfigFile, cliRunFile} {
		if err := os.WriteFile(filepath.Join(workspace, name), []byte("old"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := PrepareRunCLI(workspace, "tenant-one", "agent-one", store, json.RawMessage(`{"cli_run_context":{"run_id":"run_two"}}`)); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{cliConfigFile, cliRunFile} {
		if _, err := os.Lstat(filepath.Join(workspace, name)); !os.IsNotExist(err) {
			t.Fatalf("%s survived a Run without scope: %v", name, err)
		}
	}
}

func TestPrepareRunCLIRequiresInstalledCredentialForScopedRun(t *testing.T) {
	payload := json.RawMessage(`{"cli_run_context":{"scope":{"kind":"room","id":"room-1"}}}`)
	workspace := t.TempDir()
	err := PrepareRunCLI(workspace, "tenant-one", "agent-one", cliTestStore(t), payload)
	if !errors.Is(err, clicredential.ErrNotInstalled) {
		t.Fatalf("error = %v, want ErrNotInstalled", err)
	}
	if _, err := os.Stat(filepath.Join(workspace, cliConfigFile)); !os.IsNotExist(err) {
		t.Fatalf("config written without a credential: %v", err)
	}
	if err := PrepareRunCLI(workspace, "tenant-one", "agent-one", nil, payload); !errors.Is(err, clicredential.ErrNotInstalled) {
		t.Fatalf("nil lookup error = %v", err)
	}
}

func TestPrepareRunCLIRotationKeepsTokenFilePath(t *testing.T) {
	store := cliTestStore(t)
	putCLICredential(t, store, cliTestTokenA, 1)
	workspace := t.TempDir()
	payload := json.RawMessage(`{"cli_run_context":{"scope":{"kind":"room","id":"room-1"}}}`)
	if err := PrepareRunCLI(workspace, "tenant-one", "agent-one", store, payload); err != nil {
		t.Fatal(err)
	}
	before := readConfigDocument(t, workspace).Profiles["runtime"].TokenFile
	putCLICredential(t, store, cliTestTokenB, 2)
	if err := PrepareRunCLI(workspace, "tenant-one", "agent-one", store, payload); err != nil {
		t.Fatal(err)
	}
	after := readConfigDocument(t, workspace).Profiles["runtime"].TokenFile
	if before != after {
		t.Fatalf("rotation changed token_file: %s -> %s", before, after)
	}
	data, err := os.ReadFile(after)
	if err != nil || string(data) != cliTestTokenB+"\n" {
		t.Fatalf("token file after rotation = %q, %v", data, err)
	}
}

func TestPrepareRunCLIDoesNotFollowSymlinks(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symbolic links need privileges on Windows")
	}
	store := cliTestStore(t)
	putCLICredential(t, store, cliTestTokenA, 1)
	payload := json.RawMessage(`{"cli_run_context":{"run_id":"run_one","scope":{"kind":"room","id":"room-1"}}}`)

	outside := filepath.Join(t.TempDir(), "outside.json")
	if err := os.WriteFile(outside, []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	workspace := t.TempDir()
	if err := os.MkdirAll(filepath.Join(workspace, ".teamhub", "cli"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(workspace, cliRunFile)); err != nil {
		t.Fatal(err)
	}
	if err := PrepareRunCLI(workspace, "tenant-one", "agent-one", store, payload); err != nil {
		t.Fatal(err)
	}
	if data, _ := os.ReadFile(outside); string(data) != "keep" {
		t.Fatalf("symlink target was written: %q", data)
	}
	if info, err := os.Lstat(filepath.Join(workspace, cliRunFile)); err != nil || !info.Mode().IsRegular() {
		t.Fatalf("run.json was not replaced by a regular file: %v", err)
	}

	linked := t.TempDir()
	external := t.TempDir()
	if err := os.MkdirAll(filepath.Join(external, "cli"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(external, filepath.Join(linked, ".teamhub")); err != nil {
		t.Fatal(err)
	}
	if err := PrepareRunCLI(linked, "tenant-one", "agent-one", store, payload); err == nil {
		t.Fatal("symlinked .teamhub was followed")
	}
	if _, err := os.Stat(filepath.Join(external, "cli", "config.json")); !os.IsNotExist(err) {
		t.Fatalf("config escaped the workspace: %v", err)
	}
}
