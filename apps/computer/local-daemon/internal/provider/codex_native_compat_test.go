package provider

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/protocol"
)

func TestNativeCodexFirstRunResume(t *testing.T) {
	executable, endpoint := os.Getenv("LINGER_CODEX_COMPAT_EXECUTABLE"), os.Getenv("LINGER_CODEX_COMPAT_BASE_URL")
	if executable == "" || endpoint == "" {
		t.Skip("requires native Codex and an isolated loopback model")
	}
	home := t.TempDir()
	config := "model = \"gpt-5.4\"\nmodel_provider = \"compat\"\n[model_providers.compat]\nname = \"compat\"\nbase_url = " + strconv.Quote(endpoint) + "\nwire_api = \"responses\"\nrequires_openai_auth = false\n"
	if err := os.WriteFile(filepath.Join(home, "config.toml"), []byte(config), 0o600); err != nil {
		t.Fatal(err)
	}
	run := func(sessionID string) (Result, []map[string]any) {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		var events []map[string]any
		execution, err := (Executor{}).Start(ctx, OperationSpec{
			OperationKind: "run.start", Provider: "codex", ExecutablePath: executable,
			WorkingDirectory: home, Model: "gpt-5.4", Prompt: "Perform the local compatibility check.",
			ResumeSessionID: sessionID, Environment: map[string]string{"HOME": home, "CODEX_HOME": home, "PATH": os.Getenv("PATH")},
		}, func(_ context.Context, event protocol.Event) error {
			var payload map[string]any
			if err := json.Unmarshal(event.Payload, &payload); err != nil {
				return err
			}
			events = append(events, payload)
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
		return <-execution.Result, events
	}
	first, events := run("")
	if first.Status != "completed" || first.SessionID == "" {
		t.Fatalf("first native Turn failed: %+v", first)
	}
	if len(events) == 0 || events[0]["type"] != "run.started" {
		t.Fatal("first Turn did not publish its start")
	}
	checkpoint, ok := events[0]["session"].(map[string]any)
	if !ok || checkpoint["threadId"] != first.SessionID {
		t.Fatal("first Turn Session checkpoint does not match its result")
	}
	second, _ := run(first.SessionID)
	if second.Status != "completed" || second.SessionID != first.SessionID {
		t.Fatalf("native Session did not resume: %+v", second)
	}
	missing, _ := run("00000000-0000-4000-8000-000000000000")
	if missing.Status != "completed" || missing.SessionID == "" || missing.SessionID == first.SessionID {
		t.Fatalf("missing Session did not continue in a fresh Session: %+v", missing)
	}
}
