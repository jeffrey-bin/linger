package provider

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

func writeUpgradeClaude(t *testing.T, path, version, authentication, protocol string) {
	t.Helper()
	script := fmt.Sprintf(`#!/bin/sh
if [ "$1" = "--version" ]; then echo 'claude %s'; exit 0; fi
if [ "$1" = "--execute" ]; then echo '%s'; exit 0; fi
if [ "$1 $2 $3" = "auth status --json" ]; then echo '{"loggedIn":%s}'; [ '%s' = 'true' ]; exit $?; fi
IFS= read -r request
%s
`, version, version, authentication, authentication, protocol)
	if err := os.WriteFile(path, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
}

const upgradeClaudeProtocol = `case "$request" in
  *linger-catalog*) echo '{"type":"control_response","response":{"subtype":"success","request_id":"linger-catalog","response":{"models":[{"value":"fixture-model","displayName":"Fixture model"}]}}}' ;;
  *) echo '{"type":"control_response","response":{"subtype":"success","request_id":"linger-computer-doctor"}}' ;;
esac
while IFS= read -r line; do :; done`

func TestRuntimeMonitorFollowsClaudeEntryAfterUpgradeAndWaitsForIdle(t *testing.T) {
	isolateClaudeKeychain(t)
	if runtime.GOOS == "windows" {
		t.Skip("POSIX executable fixture")
	}
	root := t.TempDir()
	entry, oldVersion, newVersion := filepath.Join(root, "claude"), filepath.Join(root, "2.1.290"), filepath.Join(root, "2.1.295")
	writeUpgradeClaude(t, oldVersion, "2.1.290", "true", upgradeClaudeProtocol)
	writeUpgradeClaude(t, newVersion, "2.1.295", "true", upgradeClaudeProtocol)
	if err := os.Symlink(oldVersion, entry); err != nil {
		t.Fatal(err)
	}
	options := DiscoveryOptions{ConfiguredPaths: map[string]string{"claude": entry}, Environment: map[string]string{"PATH": root, "HOME": root}, Timeout: 10 * time.Second}
	initial, err := Discover(context.Background(), options)
	if err != nil || initial.Diagnostics[1].Status != "ready" {
		t.Fatalf("initial discovery: %+v %v", initial, err)
	}
	for _, path := range []string{entry, oldVersion} {
		if err := os.Remove(path); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Symlink(newVersion, entry); err != nil {
		t.Fatal(err)
	}
	// Authentication alone must not bless the replacement or spawn the deleted path.
	authOnly, err := RefreshRuntimeAuthentication(context.Background(), initial, options)
	if err != nil || !sameRuntimeDiagnostics(authOnly.Diagnostics, initial.Diagnostics) {
		t.Fatalf("auth-only refresh changed executable: %+v %v", authOnly, err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	idleChecks, changes := 0, 0
	err = MonitorRuntimeDiagnostics(ctx, RuntimeMonitorOptions{
		Initial: initial, Discovery: options, RefreshInterval: 5 * time.Millisecond, FullRefreshEveryTicks: 1000,
		FullRefreshAllowed: func() bool { idleChecks++; return idleChecks >= 3 },
		OnChanged: func(next DiscoveryResult) error {
			changes++
			got := next.Installations["claude"]
			expected, err := filepath.EvalSymlinks(newVersion)
			if err != nil || got.EntryPath != entry || got.ExecutablePath != expected || got.Status != "ready" || got.Version != "claude 2.1.295" || idleChecks < 3 {
				t.Fatalf("upgrade was not fully validated after idle: %+v %v", got, err)
			}
			output, err := exec.CommandContext(ctx, got.ExecutablePath, "--execute").Output()
			if err != nil || string(output) != "2.1.295\n" {
				t.Fatalf("new task did not execute new binary: %q %v", output, err)
			}
			cancel()
			return nil
		},
	})
	if !errors.Is(err, context.Canceled) || changes != 1 {
		t.Fatalf("upgrade not published exactly once: changes=%d err=%v", changes, err)
	}
	options.ConfiguredPaths["claude"] = oldVersion
	pinned, err := Discover(context.Background(), options)
	if err != nil || pinned.Diagnostics[1].Status != "not_installed" || pinned.Diagnostics[1].Error.Code != "RUNTIME_NOT_INSTALLED" {
		t.Fatalf("deleted explicit version fell back to PATH: %+v %v", pinned, err)
	}
}

func TestClaudeUpgradeKeepsVersionProtocolAndAuthenticationFailuresDistinct(t *testing.T) {
	isolateClaudeKeychain(t)
	if runtime.GOOS == "windows" {
		t.Skip("POSIX executable fixture")
	}
	for _, test := range []struct{ name, version, authentication, protocol, status, code string }{
		{"version", "0.0.1", "true", upgradeClaudeProtocol, "incompatible", "RUNTIME_INCOMPATIBLE"},
		{"protocol", "2.1.295", "true", "exit 2", "incompatible", "RUNTIME_INCOMPATIBLE"},
		{"authentication", "2.1.295", "false", upgradeClaudeProtocol, "authentication_required", "RUNTIME_AUTHENTICATION_REQUIRED"},
	} {
		t.Run(test.name, func(t *testing.T) {
			root := t.TempDir()
			path := filepath.Join(root, "claude")
			writeUpgradeClaude(t, path, test.version, test.authentication, test.protocol)
			got, err := Discover(context.Background(), DiscoveryOptions{ConfiguredPaths: map[string]string{"claude": path}, Environment: map[string]string{"PATH": root, "HOME": root}, Timeout: 10 * time.Second})
			diagnostic := got.Diagnostics[1]
			if err != nil || diagnostic.Status != test.status || diagnostic.Error == nil || diagnostic.Error.Code != test.code {
				t.Fatalf("incorrect diagnostic: %+v %v", diagnostic, err)
			}
		})
	}
}
