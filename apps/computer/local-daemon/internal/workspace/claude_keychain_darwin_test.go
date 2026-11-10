//go:build darwin

package workspace

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestClaudeKeychainUsesExactAccountAndScopedService(t *testing.T) {
	root := t.TempDir()
	trace := filepath.Join(root, "calls")
	script := `#!/bin/sh
printf '%s\n' "$*" >> "$TRACE"
case "$1" in
 find-generic-password) printf '%s\n' '{"claudeAiOauth":{"accessToken":"fixture"}}' ;;
 delete-generic-password) exit 44 ;;
esac
`
	if err := os.WriteFile(filepath.Join(root, "security"), []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", root)
	t.Setenv("TRACE", trace)
	if claudeKeychainService("") != "Claude Code-credentials" {
		t.Fatal("default login namespace changed")
	}
	if claudeKeychainService("/tmp/test") != "Claude Code-credentials-0872effe" {
		t.Fatal("incorrect scoped Keychain hash")
	}
	content, err := readClaudeKeychain("/tmp/test")
	if err != nil || !strings.Contains(string(content), "fixture") {
		t.Fatalf("read failed: %v", err)
	}
	if err := removeClaudeKeychain("/tmp/test"); err != nil {
		t.Fatal(err)
	}
	if err := removeClaudeKeychain(""); err == nil {
		t.Fatal("default login deletion allowed")
	}
	calls, _ := os.ReadFile(trace)
	if strings.Count(string(calls), "\n") != 2 || !strings.Contains(string(calls), "-a ") || !strings.Contains(string(calls), "-s Claude Code-credentials-0872effe") {
		t.Fatalf("wrong calls: %s", calls)
	}
	if strings.Contains(string(calls), "fixture") {
		t.Fatal("credential leaked into command arguments")
	}
}

func TestClaudeKeychainFailureDoesNotExposeSecretOutput(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "security"), []byte("#!/bin/sh\necho secret-fixture >&2\nexit 1\n"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", root)
	if _, err := readClaudeKeychain(""); err == nil || strings.Contains(err.Error(), "secret-fixture") {
		t.Fatal("Keychain failure was hidden or leaked output")
	}
}
