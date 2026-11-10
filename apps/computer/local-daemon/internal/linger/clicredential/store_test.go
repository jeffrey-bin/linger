package clicredential

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"testing"
)

const testToken = "th_agent_0123456789abcdefghijklmnopqrstuvwxyzABCDEFG"
const rotatedToken = "th_agent_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefg"

func testProfile(tenant, agent string) Profile {
	return Profile{URL: "https://teamhub.example", TenantID: tenant, AgentID: agent}
}

func mustOpen(t *testing.T, root string) *Store {
	t.Helper()
	store, err := Open(root)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	return store
}

func TestPutThenLookupReturnsCredentialPath(t *testing.T) {
	store := mustOpen(t, filepath.Join(t.TempDir(), "agent-cli-credentials"))
	const assignment uint64 = 1
	result, err := store.Put("tenant-one", "agent-one", testProfile("tenant-one", "agent-one"), testToken, assignment)
	if err != nil {
		t.Fatalf("Put: %v", err)
	}
	if result.SHA256 == "" {
		t.Fatalf("Put result = %+v", result)
	}
	installation, err := store.Lookup("tenant-one", "agent-one")
	if err != nil {
		t.Fatalf("Lookup: %v", err)
	}
	content, err := os.ReadFile(installation.CredentialPath)
	if err != nil {
		t.Fatalf("read credential: %v", err)
	}
	if string(content) != testToken+"\n" {
		t.Fatalf("credential content = %q", content)
	}
	if installation.Profile != testProfile("tenant-one", "agent-one") {
		t.Fatalf("profile = %+v", installation.Profile)
	}
	if !filepath.IsAbs(installation.CredentialPath) {
		t.Fatalf("credential path is not absolute: %s", installation.CredentialPath)
	}
}

func TestPrivateModesAndDirectories(t *testing.T) {
	root := filepath.Join(t.TempDir(), "agent-cli-credentials")
	store := mustOpen(t, root)
	const assignment uint64 = 1
	if _, err := store.Put("tenant-one", "agent-one", testProfile("tenant-one", "agent-one"), testToken, assignment); err != nil {
		t.Fatalf("Put: %v", err)
	}
	installation, err := store.Lookup("tenant-one", "agent-one")
	if err != nil {
		t.Fatalf("Lookup: %v", err)
	}
	if runtimeSkipsPOSIXModes() {
		return
	}
	agentDirectory := filepath.Dir(installation.CredentialPath)
	for _, directory := range []string{root, agentDirectory} {
		info, err := os.Stat(directory)
		if err != nil {
			t.Fatalf("stat %s: %v", directory, err)
		}
		if info.Mode().Perm() != 0o700 {
			t.Fatalf("%s mode = %o, want 0700", directory, info.Mode().Perm())
		}
	}
	for _, file := range []string{installation.CredentialPath, filepath.Join(agentDirectory, "state.json"), filepath.Join(agentDirectory, "profile.json")} {
		info, err := os.Stat(file)
		if err != nil {
			t.Fatalf("stat %s: %v", file, err)
		}
		if info.Mode().Perm() != 0o600 {
			t.Fatalf("%s mode = %o, want 0600", file, info.Mode().Perm())
		}
	}
}

func TestRotationReplacesContentAtSamePath(t *testing.T) {
	store := mustOpen(t, filepath.Join(t.TempDir(), "agent-cli-credentials"))
	profile := testProfile("tenant-one", "agent-one")
	const first, second uint64 = 1, 2
	if _, err := store.Put("tenant-one", "agent-one", profile, testToken, first); err != nil {
		t.Fatalf("Put first: %v", err)
	}
	before, err := store.Lookup("tenant-one", "agent-one")
	if err != nil {
		t.Fatalf("Lookup before: %v", err)
	}
	result, err := store.Put("tenant-one", "agent-one", profile, rotatedToken, second)
	if err != nil || result.SHA256 == "" {
		t.Fatalf("Put rotation = %+v, %v", result, err)
	}
	after, err := store.Lookup("tenant-one", "agent-one")
	if err != nil {
		t.Fatalf("Lookup after: %v", err)
	}
	if before.CredentialPath != after.CredentialPath {
		t.Fatalf("rotation changed path: %s -> %s", before.CredentialPath, after.CredentialPath)
	}
	content, err := os.ReadFile(after.CredentialPath)
	if err != nil {
		t.Fatalf("read rotated credential: %v", err)
	}
	if string(content) != rotatedToken+"\n" {
		t.Fatalf("rotated content = %q", content)
	}
}

// The Agent Service decides when to replace a credential; the store keeps
// whatever it pushed last, whatever the assignment or profile.
func TestPutReplacesStoredCredential(t *testing.T) {
	store := mustOpen(t, filepath.Join(t.TempDir(), "agent-cli-credentials"))
	profile := testProfile("tenant-one", "agent-one")
	if _, err := store.Put("tenant-one", "agent-one", profile, rotatedToken, 2); err != nil {
		t.Fatalf("Put original: %v", err)
	}
	profile.URL = "https://new-teamhub.example"
	result, err := store.Put("tenant-one", "agent-one", profile, testToken, 1)
	if err != nil {
		t.Fatalf("Put replacement: %v", err)
	}
	stored, ok, err := store.Current("tenant-one", "agent-one")
	if err != nil || !ok || stored.Profile != profile || stored.AssignmentRevision != 1 || stored.SHA256 != result.SHA256 {
		t.Fatalf("Current = %+v, ok %v, err %v", stored, ok, err)
	}
	installation, err := store.Lookup("tenant-one", "agent-one")
	if err != nil {
		t.Fatalf("Lookup: %v", err)
	}
	content, err := os.ReadFile(installation.CredentialPath)
	if err != nil || string(content) != testToken+"\n" {
		t.Fatalf("credential after replacement = %q, %v", content, err)
	}
}

func TestSymlinkComponentIsRefused(t *testing.T) {
	base := t.TempDir()
	root := filepath.Join(base, "agent-cli-credentials")
	store := mustOpen(t, root)
	const assignment uint64 = 1
	profile := testProfile("tenant-one", "agent-one")
	if _, err := store.Put("tenant-one", "agent-one", profile, testToken, assignment); err != nil {
		t.Fatalf("Put: %v", err)
	}
	agentDirectory := store.agentDirectory("tenant-one", "agent-one")
	redirect := filepath.Join(base, "elsewhere")
	if err := os.MkdirAll(redirect, 0o700); err != nil {
		t.Fatalf("mkdir redirect: %v", err)
	}
	if err := os.RemoveAll(agentDirectory); err != nil {
		t.Fatalf("remove agent dir: %v", err)
	}
	if err := createTestDirectoryLink(redirect, agentDirectory); err != nil {
		t.Fatalf("symlink agent dir: %v", err)
	}
	if _, err := store.Lookup("tenant-one", "agent-one"); err == nil {
		t.Fatal("Lookup followed a symlinked agent directory")
	}
	if _, err := store.Put("tenant-one", "agent-one", profile, rotatedToken, assignment+1); err == nil {
		t.Fatal("Put wrote through a symlinked agent directory")
	}
	if entries, _ := os.ReadDir(redirect); len(entries) != 0 {
		t.Fatalf("symlink target was written: %v", entries)
	}
}

func TestReopenKeepsCredential(t *testing.T) {
	root := filepath.Join(t.TempDir(), "agent-cli-credentials")
	const assignment uint64 = 1
	if _, err := mustOpen(t, root).Put("tenant-one", "agent-one", testProfile("tenant-one", "agent-one"), testToken, assignment); err != nil {
		t.Fatalf("Put: %v", err)
	}
	installation, err := mustOpen(t, root).Lookup("tenant-one", "agent-one")
	if err != nil {
		t.Fatalf("Lookup after reopen: %v", err)
	}
	content, err := os.ReadFile(installation.CredentialPath)
	if err != nil || string(content) != testToken+"\n" {
		t.Fatalf("credential after reopen = %q, %v", content, err)
	}
}

func TestTwoAgentsUseDifferentPaths(t *testing.T) {
	store := mustOpen(t, filepath.Join(t.TempDir(), "agent-cli-credentials"))
	const assignment uint64 = 1
	for _, agent := range []string{"agent-one", "agent-two"} {
		if _, err := store.Put("tenant-one", agent, testProfile("tenant-one", agent), testToken, assignment); err != nil {
			t.Fatalf("Put %s: %v", agent, err)
		}
	}
	one, err := store.Lookup("tenant-one", "agent-one")
	if err != nil {
		t.Fatalf("Lookup one: %v", err)
	}
	two, err := store.Lookup("tenant-one", "agent-two")
	if err != nil {
		t.Fatalf("Lookup two: %v", err)
	}
	if one.CredentialPath == two.CredentialPath {
		t.Fatalf("two Agents share credential path %s", one.CredentialPath)
	}
}

func TestRemoveAgentIsIdempotent(t *testing.T) {
	store := mustOpen(t, filepath.Join(t.TempDir(), "agent-cli-credentials"))
	const assignment uint64 = 1
	if _, err := store.Put("tenant-one", "agent-one", testProfile("tenant-one", "agent-one"), testToken, assignment); err != nil {
		t.Fatalf("Put: %v", err)
	}
	if err := store.RemoveAgent("tenant-one", "agent-one"); err != nil {
		t.Fatalf("RemoveAgent: %v", err)
	}
	if _, err := os.Stat(store.agentDirectory("tenant-one", "agent-one")); !os.IsNotExist(err) {
		t.Fatalf("agent directory still exists: %v", err)
	}
	if _, err := store.Lookup("tenant-one", "agent-one"); !errors.Is(err, ErrNotInstalled) {
		t.Fatalf("Lookup after remove = %v, want ErrNotInstalled", err)
	}
	if err := store.RemoveAgent("tenant-one", "agent-one"); err != nil {
		t.Fatalf("second RemoveAgent: %v", err)
	}
}

func TestPutRejectsInvalidInput(t *testing.T) {
	store := mustOpen(t, filepath.Join(t.TempDir(), "agent-cli-credentials"))
	const assignment uint64 = 1
	good := testProfile("tenant-one", "agent-one")
	cases := map[string]func() error{
		"token": func() error {
			_, err := store.Put("tenant-one", "agent-one", good, "th_agent_short", assignment)
			return err
		},
		"tenant mismatch": func() error {
			_, err := store.Put("tenant-two", "agent-one", good, testToken, assignment)
			return err
		},
		"agent mismatch": func() error {
			_, err := store.Put("tenant-one", "agent-two", good, testToken, assignment)
			return err
		},
		"assignment": func() error {
			_, err := store.Put("tenant-one", "agent-one", good, testToken, 0)
			return err
		},
		"scheme": func() error {
			bad := good
			bad.URL = "ftp://teamhub.example"
			_, err := store.Put("tenant-one", "agent-one", bad, testToken, assignment)
			return err
		},
	}
	for name, call := range cases {
		err := call()
		if err == nil {
			t.Fatalf("%s: Put accepted invalid input", name)
		}
		if strings.Contains(err.Error(), testToken) {
			t.Fatalf("%s: error echoes the token", name)
		}
	}
}

func TestCurrentReportsStoredCredentialWithoutToken(t *testing.T) {
	store := mustOpen(t, filepath.Join(t.TempDir(), "agent-cli-credentials"))
	if _, ok, err := store.Current("tenant-one", "agent-one"); err != nil || ok {
		t.Fatalf("Current before Put = ok %v, err %v", ok, err)
	}
	const assignment uint64 = 1
	put, err := store.Put("tenant-one", "agent-one", testProfile("tenant-one", "agent-one"), testToken, assignment)
	if err != nil {
		t.Fatal(err)
	}
	stored, ok, err := store.Current("tenant-one", "agent-one")
	if err != nil || !ok {
		t.Fatalf("Current after Put = ok %v, err %v", ok, err)
	}
	if digest := sha256.Sum256([]byte(testToken)); put.SHA256 != hex.EncodeToString(digest[:]) {
		t.Fatalf("Put digest = %s, want the token's own", put.SHA256)
	}
	if stored.SHA256 != put.SHA256 || stored.AssignmentRevision != assignment || stored.Profile != testProfile("tenant-one", "agent-one") {
		t.Fatalf("Current = %+v, want the stored credential", stored)
	}
	if strings.Contains(fmt.Sprintf("%+v", stored), testToken) {
		t.Fatal("Current exposes the token")
	}
	if err := store.RemoveAgent("tenant-one", "agent-one"); err != nil {
		t.Fatal(err)
	}
	if _, ok, err := store.Current("tenant-one", "agent-one"); err != nil || ok {
		t.Fatalf("Current after RemoveAgent = ok %v, err %v", ok, err)
	}
}

func TestCurrentTreatsStateWithoutAssignmentAsNotInstalled(t *testing.T) {
	store := mustOpen(t, filepath.Join(t.TempDir(), "agent-cli-credentials"))
	if _, err := store.Put("tenant-one", "agent-one", testProfile("tenant-one", "agent-one"), testToken, 1); err != nil {
		t.Fatal(err)
	}
	// A state that names no Runtime Assignment cannot be reported as held:
	// the Gateway must issue and push a credential that replaces it.
	directory := store.agentDirectory("tenant-one", "agent-one")
	if err := os.WriteFile(filepath.Join(directory, stateFile), []byte(`{"expires_at":"2026-11-05T00:00:00Z","sha256":"`+strings.Repeat("a", 64)+`"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, ok, err := store.Current("tenant-one", "agent-one"); err != nil || ok {
		t.Fatalf("Current = ok %v, err %v, want not installed", ok, err)
	}
	if _, err := store.Put("tenant-one", "agent-one", testProfile("tenant-one", "agent-one"), rotatedToken, 2); err != nil {
		t.Fatal(err)
	}
	if stored, ok, err := store.Current("tenant-one", "agent-one"); err != nil || !ok || stored.AssignmentRevision != 2 {
		t.Fatalf("Current after Put = %+v, ok %v, err %v", stored, ok, err)
	}
}

func TestRetryableSeparatesTransientStorageErrors(t *testing.T) {
	wrapped := func(errno syscall.Errno) error {
		return fmt.Errorf("write TeamHub CLI credential file: %w", &fs.PathError{Op: "write", Path: "credential", Err: errno})
	}
	for _, errno := range []syscall.Errno{syscall.EIO, syscall.EAGAIN, syscall.ENOSPC} {
		if !Retryable(wrapped(errno)) {
			t.Fatalf("%v is not retryable", errno)
		}
	}
	for _, err := range []error{
		wrapped(syscall.EACCES),
		wrapped(syscall.ENOTDIR),
		errors.New("TeamHub CLI credential directory is invalid"),
		ErrNotInstalled,
	} {
		if Retryable(err) {
			t.Fatalf("%v is retryable", err)
		}
	}
}

func runtimeSkipsPOSIXModes() bool {
	return runtime.GOOS == "windows"
}
