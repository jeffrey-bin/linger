package provider

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/protocol"
)

func TestClaudeExecutorStreamMatchesFinalResultAfterProgress(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX executable fixture")
	}
	dir := t.TempDir()
	executable := filepath.Join(dir, "claude")
	script := `#!/bin/sh
IFS= read -r initialization
echo '{"type":"control_response","response":{"subtype":"success","request_id":"linger-session-restore"}}'
IFS= read -r input
cat <<'JSON'
{"type":"assistant","message":{"id":"progress","role":"assistant","content":[{"type":"text","text":"Let me check."}]}}
{"type":"assistant","message":{"id":"answer","role":"assistant","content":[{"type":"text","text":"The result "},{"type":"text","text":"is ready."}]}}
{"type":"assistant","message":{"id":"answer","role":"assistant","content":[{"type":"text","text":" Done."}]}}
{"type":"result","subtype":"success","is_error":false,"session_id":"session-1","result":"The result is ready. Done."}
JSON
`
	if err := os.WriteFile(executable, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	messages := make(map[string]string)
	var finalMessageID string
	execution, err := (Executor{}).Start(ctx, OperationSpec{
		OperationKind: "run.start", Provider: "claude", ExecutablePath: executable,
		WorkingDirectory: dir, TaskID: "claude-message-boundary", Prompt: "Check the result.",
	}, func(_ context.Context, event protocol.Event) error {
		var payload struct {
			Type      string `json:"type"`
			MessageID string `json:"message_id"`
			Delta     string `json:"delta"`
		}
		if err := json.Unmarshal(event.Payload, &payload); err != nil {
			return err
		}
		if payload.Type == "message.delta" {
			messages[payload.MessageID] += payload.Delta
			finalMessageID = payload.MessageID
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	result := <-execution.Result
	if result.Status != "completed" || result.Output != "The result is ready. Done." {
		t.Fatalf("unexpected provider result: %+v", result)
	}
	if messages[finalMessageID] != result.Output {
		t.Fatalf("stream %q disagrees with final result %q", messages[finalMessageID], result.Output)
	}
	if len(messages) != 2 || messages["progress"] != "Let me check." || finalMessageID != "answer" {
		t.Fatalf("message boundaries lost: last=%q messages=%v", finalMessageID, messages)
	}
}
