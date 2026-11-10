//go:build windows

package provider

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/workspace"
)

func TestMain(m *testing.M) {
	if os.Getenv("LINGER_DISCOVERY_FIXTURE") == "1" {
		runWindowsDiscoveryFixture()
		os.Exit(0)
	}
	os.Exit(m.Run())
}
func runWindowsDiscoveryFixture() {
	if os.Getenv("LINGER_DIAGNOSTIC_SECRET") != "" || os.Getenv("FIXTURE_ENV") != "isolated" {
		os.Exit(11)
	}
	kind := strings.ToLower(strings.TrimSuffix(filepath.Base(os.Args[0]), ".exe"))
	if len(os.Args) > 1 && os.Args[1] == "--version" {
		if os.Getenv("FIXTURE_VERSION_SLOW") == "1" {
			time.Sleep(6 * time.Second)
		}
		fmt.Println(map[string]string{"codex": "codex-cli 0.144.1", "claude": "claude 2.1.282"}[kind])
		return
	}
	if len(os.Args) > 1 && os.Args[1] == "--help" {
		fmt.Println("--effort <level> (low, medium, high)")
		return
	}
	if kind == "claude" && len(os.Args) > 2 && os.Args[1] == "auth" {
		if os.Getenv("FIXTURE_AUTH_SLOW") == "1" {
			time.Sleep(6 * time.Second)
		}
		if os.Getenv("FIXTURE_AUTH") == "missing" {
			fmt.Println(`{"loggedIn":false}`)
			os.Exit(1)
		}
		fmt.Println(`{"loggedIn":true}`)
		return
	}

	scanner := bufio.NewScanner(os.Stdin)
	for scanner.Scan() {
		var request map[string]any
		if json.Unmarshal(scanner.Bytes(), &request) != nil {
			os.Exit(2)
		}
		if os.Getenv("FIXTURE_PROTOCOL") == "broken" {
			fmt.Println(`{"error":"bad protocol"}`)
			return
		}
		if kind == "claude" {
			if request["request_id"] == "linger-catalog" {
				fmt.Println(`{"type":"control_response","response":{"subtype":"success","request_id":"linger-catalog","response":{"models":[{"value":"fixture-model","displayName":"Fixture"}]}}}`)
				return
			}
			if delay := os.Getenv("FIXTURE_PROTOCOL_DELAY"); delay != "" {
				_ = os.WriteFile(filepath.Join(os.Getenv("HOME"), "protocol-started"), nil, 0o600)
				duration, err := time.ParseDuration(delay)
				if err != nil {
					os.Exit(2)
				}
				time.Sleep(duration)
			}
			fmt.Println(`{"type":"control_response","response":{"subtype":"success","request_id":"linger-computer-doctor"}}`)
			return
		}
		if request["method"] == "initialize" {

			fmt.Println(`{"id":1,"result":{"userAgent":"fixture"}}`)
		}
		if request["method"] == "model/list" {
			fmt.Println(`{"id":2,"result":{"data":[{"id":"fixture-model","displayName":"Fixture"}],"nextCursor":null}}`)
			return
		}
		if request["method"] == "account/read" {
			if os.Getenv("FIXTURE_AUTH") == "missing" {
				fmt.Println(`{"id":2,"result":{"account":null,"requiresOpenaiAuth":true}}`)
			} else {
				fmt.Println(`{"id":2,"result":{"account":{"type":"chatgpt"},"requiresOpenaiAuth":true}}`)
			}
			return
		}
	}
}

func TestWindowsRefreshAuthenticationAllowsColdCLIAndKeepsCallerDeadline(t *testing.T) {
	root := t.TempDir()
	executable := filepath.Join(root, "claude.exe")
	fixture, err := os.ReadFile(os.Args[0])
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(executable, fixture, 0o700); err != nil {
		t.Fatal(err)
	}
	environment := map[string]string{
		"HOME": root, "USERPROFILE": root, "SystemRoot": os.Getenv("SystemRoot"),
		"LINGER_DISCOVERY_FIXTURE": "1", "FIXTURE_ENV": "isolated",
		"FIXTURE_AUTH_SLOW": "1", "ANTHROPIC_API_KEY": "fixture-only",
	}
	current := DiscoveryResult{Diagnostics: []RuntimeDiagnostic{{
		Type: "claude", Status: "ready", Version: "2.1.0", ExecutablePath: executable,
	}}}
	for _, test := range []struct {
		name          string
		timeout       time.Duration
		parentTimeout time.Duration
		status        string
	}{
		{name: "cold CLI remains ready", status: "ready"},
		{name: "caller deadline remains bounded", timeout: 100 * time.Millisecond, status: "error"},
		{name: "parent deadline remains bounded", parentTimeout: 100 * time.Millisecond, status: "error"},
	} {
		t.Run(test.name, func(t *testing.T) {
			parentTimeout := test.parentTimeout
			if parentTimeout == 0 {
				parentTimeout = time.Minute
			}
			ctx, cancel := context.WithTimeout(t.Context(), parentTimeout)
			defer cancel()
			started := time.Now()
			result, err := RefreshRuntimeAuthentication(ctx, current, DiscoveryOptions{
				Environment: environment, Timeout: test.timeout,
			})
			if err != nil {
				t.Fatal(err)
			}
			if got := result.Diagnostics[0]; got.Status != test.status {
				t.Fatalf("status=%s, want %s; error=%+v", got.Status, test.status, got.Error)
			}
			if test.status == "error" && time.Since(started) > 3*time.Second {
				t.Fatal("authentication probe exceeded cancellation cleanup budget")
			}
		})
	}
}

func TestWindowsDiscoverDeadlineRequiresFullProtocolRecovery(t *testing.T) {
	root := t.TempDir()
	executable := filepath.Join(root, "claude.exe")
	fixture, err := os.ReadFile(os.Args[0])
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(executable, fixture, 0o700); err != nil {
		t.Fatal(err)
	}
	environment := map[string]string{
		"HOME": root, "USERPROFILE": root, "SystemRoot": os.Getenv("SystemRoot"), "PATH": root,
		"LINGER_DISCOVERY_FIXTURE": "1", "FIXTURE_ENV": "isolated",
		"FIXTURE_AUTH_SLOW": "1", "FIXTURE_PROTOCOL_DELAY": "6s", "ANTHROPIC_API_KEY": "fixture-only",
	}
	options := DiscoveryOptions{ConfiguredPaths: map[string]string{"claude": executable}, Environment: environment}
	// Finish first-execution scanning of the copied test binary before measuring
	// the version/authentication/protocol budget. The slow auth remains in place.
	prepareCtx, prepareCancel := context.WithTimeout(t.Context(), time.Minute)
	prepare := exec.CommandContext(prepareCtx, executable, "--version")
	prepare.Env = environmentList(environment)
	output, prepareErr := prepare.CombinedOutput()
	prepareCancel()
	if prepareErr != nil || !strings.Contains(string(output), "claude") {
		t.Fatalf("prepare fixture: %v output=%q", prepareErr, output)
	}
	ctx, cancel := context.WithTimeout(t.Context(), time.Minute)
	defer cancel()
	// A valid cold CLI needs three consecutive process starts. Each phase is
	// within its own bound, but together they exceed the old 15-second default.
	environment["FIXTURE_VERSION_SLOW"] = "1"
	cold, err := Discover(ctx, options)
	if err != nil || findRuntimeDiagnostic(cold.Diagnostics, "claude").Status != "ready" {
		t.Fatalf("default discovery rejected valid cold CLI stages: %+v error=%v", cold, err)
	}
	delete(environment, "FIXTURE_VERSION_SLOW")
	environment["FIXTURE_PROTOCOL_DELAY"] = "20s"
	if err := os.Remove(filepath.Join(root, "protocol-started")); err != nil {
		t.Fatal(err)
	}
	options.Timeout = 15 * time.Second
	started := time.Now()
	result, err := Discover(ctx, options)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(root, "protocol-started")); err != nil {
		t.Fatalf("discovery did not reach protocol after version and slow authentication: %v", err)
	}
	diagnostic := findRuntimeDiagnostic(result.Diagnostics, "claude")
	if diagnostic.Status != "error" || diagnostic.Error == nil || diagnostic.Error.Code != "RUNTIME_DIAGNOSTIC_FAILED" {
		t.Fatalf("deadline reported as incompatibility: %+v error=%+v", diagnostic, diagnostic.Error)
	}
	if time.Since(started) > 18*time.Second {
		t.Fatal("discovery extended its overall deadline")
	}
	delete(environment, "FIXTURE_AUTH_SLOW")
	delete(environment, "FIXTURE_PROTOCOL_DELAY")
	refreshed, err := refreshRuntimeAuthentication(ctx, result, options, true)
	if err != nil || findRuntimeDiagnostic(refreshed.Diagnostics, "claude").Status != "error" {
		t.Fatalf("authentication-only refresh recovered an unverified protocol: %+v error=%v", refreshed, err)
	}
	recovered, err := Discover(ctx, options)
	if err != nil || findRuntimeDiagnostic(recovered.Diagnostics, "claude").Status != "ready" {
		t.Fatalf("full discovery did not recover: %+v error=%v", recovered, err)
	}
}

func TestWindowsDiscoverNativeProtocolsAndAuthenticationWithSanitizedEnvironment(t *testing.T) {
	// This fixture tests protocol and authentication behavior, not probe latency.
	timeout := 3 * time.Second
	if value := os.Getenv("LINGER_TEST_WINDOWS_TIMEOUT_SCALE"); value != "" {
		multiplier, err := strconv.Atoi(value)
		if err != nil || multiplier < 1 || multiplier > 20 {
			t.Fatal("LINGER_TEST_WINDOWS_TIMEOUT_SCALE must be an integer from 1 to 20")
		}
		timeout *= time.Duration(multiplier)
	}
	root := filepath.Join(t.TempDir(), "Café runtime paths")
	if err := os.MkdirAll(root, 0o700); err != nil {
		t.Fatal(err)
	}
	input, err := os.Open(os.Args[0])
	if err != nil {
		t.Fatal(err)
	}
	defer input.Close()
	paths := map[string]string{}
	for _, kind := range []string{"codex", "claude"} {
		target := filepath.Join(root, kind+".exe")
		file, err := os.Create(target)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := input.Seek(0, 0); err != nil {
			t.Fatal(err)
		}
		if _, err := io.Copy(file, input); err != nil {
			t.Fatal(err)
		}
		file.Close()
		paths[kind] = target
	}
	environment := map[string]string{"Path": root, "SystemRoot": os.Getenv("SystemRoot"), "USERPROFILE": root, "LINGER_DISCOVERY_FIXTURE": "1", "FIXTURE_ENV": "isolated", "ANTHROPIC_API_KEY": "fixture-only"}
	t.Setenv("LINGER_DIAGNOSTIC_SECRET", "must-not-inherit")
	// Prepare freshly copied fixture executables before concurrent discovery.
	// First execution can include serialized antivirus scanning, especially
	// under CPU emulation. This is fixture setup, not a retry of discovery or
	// an override of the production version probe's ten-second deadline.
	for _, kind := range []string{"codex", "claude"} {
		ctx, cancel := context.WithTimeout(context.Background(), 10*timeout)
		cmd := exec.CommandContext(ctx, paths[kind], "--version")
		cmd.Env = make([]string, 0, len(environment))
		for key, value := range environment {
			cmd.Env = append(cmd.Env, key+"="+value)
		}
		output, err := cmd.CombinedOutput()
		cancel()
		if err != nil || !strings.Contains(string(output), kind) {
			t.Fatalf("prepare %s fixture: %v, output=%q", kind, err, output)
		}
	}
	result, err := Discover(context.Background(), DiscoveryOptions{Environment: environment, Timeout: timeout})
	if err != nil {
		t.Fatal(err)
	}
	for _, diagnostic := range result.Diagnostics[:2] {
		if diagnostic.Status != "ready" {
			t.Fatalf("%s=%+v error=%+v", diagnostic.Type, diagnostic, diagnostic.Error)
		}
	}
	environment["FIXTURE_AUTH"] = "missing"
	result, err = Discover(context.Background(), DiscoveryOptions{ConfiguredPaths: paths, Environment: environment, Timeout: timeout})
	if err != nil {
		t.Fatal(err)
	}
	for _, diagnostic := range result.Diagnostics[:2] {
		if diagnostic.Status != "authentication_required" {
			t.Fatalf("%s=%+v error=%+v", diagnostic.Type, diagnostic, diagnostic.Error)
		}
	}
	environment["FIXTURE_AUTH"] = "ready"
	environment["FIXTURE_PROTOCOL"] = "broken"
	result, err = Discover(context.Background(), DiscoveryOptions{ConfiguredPaths: paths, Environment: environment, Timeout: timeout})
	if err != nil {
		t.Fatal(err)
	}
	for _, diagnostic := range result.Diagnostics[:2] {
		if diagnostic.Status != "incompatible" {
			t.Fatalf("%s=%+v error=%+v", diagnostic.Type, diagnostic, diagnostic.Error)
		}
	}
}

func TestWindowsDiscoverFollowsStandaloneCodexJunctions(t *testing.T) {
	// Standalone Codex: Programs\OpenAI\Codex\bin -> current\bin, current -> releases\<version>.
	root := t.TempDir()
	release := filepath.Join(root, "releases", "0.166.0")
	if err := os.MkdirAll(filepath.Join(release, "bin"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(release, "bin", "codex.exe"), nil, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, "Programs"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := workspace.CreateDirectoryLink(release, filepath.Join(root, "current")); err != nil {
		t.Fatal(err)
	}
	bin := filepath.Join(root, "Programs", "bin")
	if err := workspace.CreateDirectoryLink(filepath.Join(root, "current", "bin"), bin); err != nil {
		t.Fatal(err)
	}
	entry, err := resolveExecutableEntry(t.Context(), "codex", "codex", DiscoveryOptions{Environment: map[string]string{"PATH": bin}})
	if err != nil {
		t.Fatalf("junctioned codex was not found: %v", err)
	}
	resolved, err := canonicalExecutable(entry)
	if err != nil {
		t.Fatal(err)
	}
	direct, err := canonicalExecutable(filepath.Join(release, "bin", "codex.exe"))
	if err != nil || resolved != direct {
		t.Fatalf("resolved=%q direct=%q error=%v", resolved, direct, err)
	}
}
