//go:build windows

package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/platform/privatefs"
)

func TestPlatformEntryUsesStdinAndReturnsJSONWithoutStartingDaemon(t *testing.T) {
	path := filepath.Join(t.TempDir(), "private config", "configuración.json")
	call := func(request any) map[string]any {
		t.Helper()
		input, _ := json.Marshal(request)
		var output bytes.Buffer
		if err := runPlatform(bytes.NewReader(input), &output); err != nil {
			t.Fatal(err)
		}
		var result map[string]any
		if err := json.Unmarshal(output.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
		return result
	}
	call(map[string]any{"action": "write-private-file", "path": path, "data": "secret\nCafé", "exclusive": true})
	result := call(map[string]any{"action": "read-private-file", "path": path})
	if result["data"] != "secret\nCafé" {
		t.Fatalf("read=%v", result)
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(path), "daemon.lock")); !os.IsNotExist(err) {
		t.Fatalf("helper started daemon: %v", err)
	}
	other := filepath.Join(filepath.Dir(path), "other.json")
	call(map[string]any{"action": "write-private-file", "path": other, "data": "x"})
	call(map[string]any{"action": "check-private-paths", "paths": []string{path, other}, "kind": "file"})
	missing, _ := json.Marshal(map[string]any{"action": "check-private-paths", "paths": []string{path, filepath.Join(filepath.Dir(path), "missing")}, "kind": "file"})
	if err := runPlatform(bytes.NewReader(missing), &bytes.Buffer{}); err == nil {
		t.Fatal("batch check accepted a missing path")
	}
	var output bytes.Buffer
	if err := runPlatform(strings.NewReader(`{"action":"unknown","secret":"do-not-print"}`), &output); err == nil || strings.Contains(err.Error(), "do-not-print") {
		t.Fatalf("unsafe error=%v", err)
	}
	if err := runPlatform(strings.NewReader(`{"action":"read-private-file"} {}`), &output); err == nil {
		t.Fatal("multiple requests accepted")
	}
}

func TestWindowsPlatformCleanupMissingStateAndRejectsCorruptOwner(t *testing.T) {
	state := filepath.Join(t.TempDir(), "not-configured", "state")
	for _, action := range []string{"cleanup-owned-processes", "owned-processes-stopped", "stop-managed-services"} {
		input, _ := json.Marshal(map[string]any{"action": action, "stateDirectory": state})
		var output bytes.Buffer
		if err := runPlatform(bytes.NewReader(input), &output); err != nil {
			t.Fatalf("%s: %v", action, err)
		}
		var result map[string]any
		if err := json.Unmarshal(output.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
		if action == "cleanup-owned-processes" && result["found"] != false {
			t.Fatalf("cleanup=%v", result)
		}
		if (action == "owned-processes-stopped" || action == "stop-managed-services") && result["stopped"] != true {
			t.Fatalf("%s=%v", action, result)
		}
	}
	if _, err := os.Stat(state); !os.IsNotExist(err) {
		t.Fatalf("cleanup created missing state: %v", err)
	}
	if err := privatefs.WriteFile(filepath.Join(state, "daemon.lock", "owner.json"), []byte("{}"), true); err != nil {
		t.Fatal(err)
	}
	input, _ := json.Marshal(map[string]any{"action": "cleanup-owned-processes", "stateDirectory": state})
	var output bytes.Buffer
	if err := runPlatform(bytes.NewReader(input), &output); err == nil {
		t.Fatal("corrupt owner record ignored")
	}
}
