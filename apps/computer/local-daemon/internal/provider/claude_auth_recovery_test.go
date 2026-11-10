package provider

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestClaudeAuthenticationChecksExistingContextsAndRecovers(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX fixture")
	}
	root := t.TempDir()
	executable := filepath.Join(root, "claude")
	source := filepath.Join(root, "source")
	homes := filepath.Join(root, "runtime-homes")
	config := filepath.Join(homes, "claude", strings.Repeat("a", 64), ".claude")
	for _, dir := range []string{source, config} {
		if err := os.MkdirAll(dir, 0700); err != nil {
			t.Fatal(err)
		}
	}
	// Keychain access stays inside this test even on macOS.
	if err := os.WriteFile(filepath.Join(root, "security"), []byte("#!/bin/sh\nexit 44\n"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", root+string(os.PathListSeparator)+os.Getenv("PATH"))
	script := `#!/bin/sh
echo "$CLAUDE_CONFIG_DIR" >> "$AUTH_TRACE"
if [ "$CLAUDE_CONFIG_DIR" = "$FAILED_CONFIG" ] && ! /usr/bin/grep -q relogin "$CLAUDE_CONFIG_DIR/.credentials.json"; then
 echo '{"loggedIn":false}'; exit 1
fi
echo '{"loggedIn":true}'
`
	if err := os.WriteFile(executable, []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	primeTestExecutable(t, filepath.Join(root, "security"))
	primeTestExecutable(t, executable, "AUTH_TRACE="+os.DevNull)
	credential := filepath.Join(source, ".credentials.json")
	if err := os.WriteFile(credential, []byte(`{"claudeAiOauth":{"accessToken":"initial","expiresAt":4102448400000}}`), 0600); err != nil {
		t.Fatal(err)
	}
	options := DiscoveryOptions{RuntimeHomeRoot: homes, Timeout: 10 * time.Second, Environment: map[string]string{
		"HOME": root, "CLAUDE_CONFIG_DIR": source, "PATH": root, "FAILED_CONFIG": config, "AUTH_TRACE": filepath.Join(root, "trace"),
	}}
	current := DiscoveryResult{Diagnostics: []RuntimeDiagnostic{{Type: "claude", Status: "ready", ExecutablePath: executable}}}
	failed, err := RefreshRuntimeAuthentication(t.Context(), current, options)
	if err != nil || failed.Diagnostics[0].Status != "authentication_required" {
		t.Fatalf("fresh probe hid existing Context failure: %+v %v", failed, err)
	}
	// Relogin changes the credential but has an earlier expiry.
	if err := os.WriteFile(credential, []byte(`{"claudeAiOauth":{"accessToken":"relogin","expiresAt":4102444800000}}`), 0600); err != nil {
		t.Fatal(err)
	}
	recovered, err := RefreshRuntimeAuthentication(t.Context(), failed, options)
	if err != nil || recovered.Diagnostics[0].Status != "ready" {
		t.Fatalf("existing Context did not recover: %+v %v", recovered, err)
	}
	trace, _ := os.ReadFile(filepath.Join(root, "trace"))
	if strings.Count(string(trace), config+"\n") != 2 {
		t.Fatal("authentication did not probe the existing Context on both refreshes")
	}
}

func TestClaudeAuthenticationStaysReadyWithManyIdleHomesAndASlowProbe(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX fixture")
	}
	root := t.TempDir()
	executable := filepath.Join(root, "claude")
	homes := filepath.Join(root, "runtime-homes")
	var slowest string
	for index := range 150 {
		home := filepath.Join(homes, "claude", fmt.Sprintf("%064x", index))
		if err := os.MkdirAll(filepath.Join(home, ".claude"), 0700); err != nil {
			t.Fatal(err)
		}
		used := time.Now().Add(time.Duration(index-150) * time.Hour)
		if err := os.Chtimes(home, used, used); err != nil {
			t.Fatal(err)
		}
		slowest = filepath.Join(home, ".claude")
	}
	// Keychain access stays inside this test even on macOS.
	if err := os.WriteFile(filepath.Join(root, "security"), []byte("#!/bin/sh\nexit 44\n"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", root+string(os.PathListSeparator)+os.Getenv("PATH"))
	script := `#!/bin/sh
echo "$CLAUDE_CONFIG_DIR" >> "$AUTH_TRACE"
if [ -n "$SLOW_CONFIG" ] && [ "$CLAUDE_CONFIG_DIR" = "$SLOW_CONFIG" ]; then exec /bin/sleep 30; fi
echo '{"loggedIn":true}'
`
	if err := os.WriteFile(executable, []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	primeTestExecutable(t, filepath.Join(root, "security"))
	primeTestExecutable(t, executable, "AUTH_TRACE="+os.DevNull)
	trace := filepath.Join(root, "trace")
	options := DiscoveryOptions{RuntimeHomeRoot: homes, Timeout: 2 * time.Second, Environment: map[string]string{
		"HOME": root, "PATH": root, "ANTHROPIC_API_KEY": "fixture-key", "SLOW_CONFIG": slowest, "AUTH_TRACE": trace,
	}}
	current := DiscoveryResult{Diagnostics: []RuntimeDiagnostic{{Type: "claude", Status: "ready", ExecutablePath: executable}}}
	refreshed, err := RefreshRuntimeAuthentication(t.Context(), current, options)
	if err != nil || refreshed.Diagnostics[0].Status != "ready" {
		t.Fatalf("idle Context homes made Claude unavailable: %+v %v", refreshed, err)
	}
	probes, _ := os.ReadFile(trace)
	// One host check plus one Context check: every home shares the API key.
	if lines := strings.Count(string(probes), "\n"); lines != 2 {
		t.Fatalf("ran %d authentication probes, want 2:\n%s", lines, probes)
	}
}
