package provider

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/platform/privatefs"
)

func TestLocalDiagnosticsPreserveTurnIngressCorrelationFields(t *testing.T) {
	directory := t.TempDir()
	logger := localDiagnosticLogger(directory, OperationSpec{TaskID: "operation-test", Provider: "codex", ExecutionRunRef: "run-test"}, nil)
	logger.Info("codex turn/started received",
		"sent_at_unix_ms", int64(101),
		"acknowledged_at_unix_ms", int64(102),
		"emitted_at_unix_ms", int64(103),
		"received_at_unix_ms", int64(104),
		"outcome", "ready",
		"attempts", 3,
		"latency_ms", int64(321),
		"type", "tool_output",
		"tool", "exec_command",
		"call_id", "call-test",
		"content_len", 0,
		"output_len", 24,
		"external_exit", true,
		"cause", "signal",
		"spawns", 1,
		"session_starts", 0,
		"session_resumes", 1,
		"rebounds", 0,
		"recycles", "incompatible:skills=1",
	)

	content, err := os.ReadFile(filepath.Join(directory, "runner-diagnostics.log"))
	if err != nil {
		t.Fatal(err)
	}
	var entry map[string]any
	if err := json.Unmarshal(content, &entry); err != nil {
		t.Fatal(err)
	}
	for key, want := range map[string]any{
		"execution_run_ref":       "run-test",
		"sent_at_unix_ms":         "101",
		"acknowledged_at_unix_ms": "102",
		"emitted_at_unix_ms":      "103",
		"received_at_unix_ms":     "104",
		"outcome":                 "ready",
		"attempts":                "3",
		"latency_ms":              "321",
		"type":                    "tool_output",
		"tool":                    "exec_command",
		"call_id":                 "call-test",
		"content_len":             "0",
		"output_len":              "24",
		"external_exit":           "true",
		"cause":                   "signal",
		"spawns":                  "1",
		"session_starts":          "0",
		"session_resumes":         "1",
		"rebounds":                "0",
		"recycles":                "incompatible:skills=1",
	} {
		if got := entry[key]; got != want {
			t.Fatalf("%s=%v, want %v; entry=%v", key, got, want, entry)
		}
	}
}

func TestLocalDiagnosticsKeepResidentRecycleReasonAndMismatch(t *testing.T) {
	directory := t.TempDir()
	logger := localDiagnosticLogger(directory, OperationSpec{TaskID: "operation-test", Provider: "claude"}, nil)
	logger.Info("claude resident recycled", "reason", "incompatible", "mismatch", "model,permission_mode")

	content, err := os.ReadFile(filepath.Join(directory, "runner-diagnostics.log"))
	if err != nil {
		t.Fatal(err)
	}
	var entry map[string]any
	if err := json.Unmarshal(content, &entry); err != nil {
		t.Fatal(err)
	}
	if entry["reason"] != "incompatible" || entry["mismatch"] != "model,permission_mode" {
		t.Fatalf("reason or mismatch dropped; entry=%v", entry)
	}
}

func TestLocalDiagnosticsRedactSecretsAndBoundStorage(t *testing.T) {
	directory := t.TempDir()
	file := filepath.Join(directory, "runner-diagnostics.log")
	if err := os.WriteFile(file, []byte(strings.Repeat("x", 2*1024*1024)), 0o600); err != nil {
		t.Fatal(err)
	}
	logger := localDiagnosticLogger(directory, OperationSpec{TaskID: "operation-test", Provider: "codex"}, map[string]string{"API_KEY": "private-config-value"})
	logger.Error("runtime.failed", "error", "private-config-value Bearer another-value https://user:password@example.test/path?token=query-secret", "prompt", "private-prompt")
	content, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{"private-config-value", "another-value", "query-secret", "user:password", "private-prompt"} {
		if strings.Contains(string(content), secret) {
			t.Fatalf("diagnostic leaked %s", secret)
		}
	}
	info, _ := os.Stat(file)
	if len(content) > 8192 || (runtime.GOOS != "windows" && info.Mode().Perm() != 0o600) || !strings.Contains(string(content), "operation-test") {
		t.Fatalf("diagnostic size=%d mode=%v correlation=%v", len(content), info.Mode(), strings.Contains(string(content), "operation-test"))
	}
	if runtime.GOOS == "windows" {
		if err := privatefs.CheckPath(file, "file", true); err != nil {
			t.Fatalf("diagnostic file ACL: %v", err)
		}
	}
}

func TestLocalDiagnosticsDoNotWriteLinkedFiles(t *testing.T) {
	for _, hard := range []bool{false, true} {
		directory := t.TempDir()
		target := filepath.Join(directory, "retained")
		fixture := os.Getenv("LINGER_TEST_PROVIDER_LINK_ROOT")
		if runtime.GOOS == "windows" && !hard && fixture != "" {
			target = filepath.Join(fixture, "diagnostic", "retained")
			prepared := filepath.Join(fixture, "diagnostic", "runner-diagnostics.log")
			assertProviderFixtureLink(t, prepared, target)
			if err := os.Rename(prepared, filepath.Join(directory, "runner-diagnostics.log")); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() {
				if err := os.Rename(filepath.Join(directory, "runner-diagnostics.log"), prepared); err != nil {
					t.Errorf("restore link: %v", err)
				}
			})
		} else {
			if err := os.WriteFile(target, []byte("unchanged"), 0o600); err != nil {
				t.Fatal(err)
			}
			link := os.Symlink
			if hard {
				link = os.Link
			}
			if err := link(target, filepath.Join(directory, "runner-diagnostics.log")); err != nil {
				t.Fatal(err)
			}
		}
		localDiagnosticLogger(directory, OperationSpec{}, nil).Info("must not write")
		content, err := os.ReadFile(target)
		if err != nil || string(content) != "unchanged" {
			t.Fatal("diagnostic modified a linked target")
		}
	}
}
