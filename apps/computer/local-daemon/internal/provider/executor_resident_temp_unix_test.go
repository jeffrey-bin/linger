//go:build !windows

package provider

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/protocol"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider/native"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/workspace"
)

func TestExecutorCodexResidentOwnsTempAcrossOperations(t *testing.T) {
	root := t.TempDir()
	script := filepath.Join(root, "codex-fixture")
	if err := os.WriteFile(script, []byte(`#!/bin/sh
printf '%s\t%s\t%s\t%s\n' "$$" "$TMPDIR" "$TMP" "$TEMP" >> "$CODEX_HOME/launches"
while read -r line; do
 id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
 method=$(printf '%s' "$line" | sed -n 's/.*"method":"\([^"]*\)".*/\1/p')
 [ -n "$id" ] || continue
 result='{}'
 case "$method" in
 config/read) result='{"config":{"features":{"memories":false,"memory_tool":false}}}' ;;
 thread/start|thread/resume) result='{"thread":{"id":"thread-temp"}}' ;;
 turn/start)
   if ! printf 'written by resident\n' > "$TMPDIR/turn-output"; then
     printf '{"jsonrpc":"2.0","id":%s,"error":{"code":-32000,"message":"resident TMPDIR was deleted"}}\n' "$id"
     continue
   fi
   printf '%s\t%s\n' "$$" "$TMPDIR" >> "$CODEX_HOME/turns"
   printf '{"jsonrpc":"2.0","id":%s,"result":{}}\n' "$id"
   printf '{"method":"turn/started","params":{"threadId":"thread-temp","turn":{"id":"turn-temp"}}}\n'
   printf '{"jsonrpc":"2.0","method":"turn/completed","params":{"threadId":"thread-temp","turn":{"id":"turn-temp","status":"completed"}}}\n'
   continue ;;
 esac
 printf '{"jsonrpc":"2.0","id":%s,"result":%s}\n' "$id" "$result"
done
`), 0o700); err != nil {
		t.Fatal(err)
	}
	executor := Executor{TempBase: filepath.Join(root, "operation-tmp")}
	homes := []string{filepath.Join(root, "context-a"), filepath.Join(root, "context-b")}
	for _, home := range homes {
		if err := os.MkdirAll(filepath.Join(home, "sessions"), 0o700); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() {
			if _, err := native.StopCodexHomeForMaintenance(home); err != nil {
				t.Errorf("stop fixture resident: %v", err)
			}
		})
	}
	run := func(home, kind string) Result {
		t.Helper()
		spec := OperationSpec{
			Provider: "codex", ExecutablePath: script, WorkingDirectory: home,
			Environment:   map[string]string{"HOME": root, "CODEX_HOME": home},
			OperationKind: kind, CodexVersion: "0.155.1", Timeout: 10 * time.Second,
		}
		if kind == "run.start" {
			spec.ResumeSessionID = "thread-temp"
		}
		execution, err := executor.Start(t.Context(), spec, func(context.Context, protocol.Event) error { return nil })
		if err != nil {
			t.Fatal(err)
		}
		select {
		case result := <-execution.Result:
			if result.Status != "completed" {
				t.Fatalf("%s failed: %+v", kind, result)
			}
			return result
		case <-time.After(15 * time.Second):
			t.Fatal("fixture operation did not finish")
			return Result{}
		}
	}
	var temps []string
	for _, home := range homes {
		run(home, "run.start")
		run(home, "run.start")
		launches, err := os.ReadFile(filepath.Join(home, "launches"))
		if err != nil {
			t.Fatal(err)
		}
		fields := strings.Split(strings.TrimSpace(string(launches)), "\t")
		if strings.Count(string(launches), "\n") != 1 || len(fields) != 4 || fields[1] != fields[2] || fields[1] != fields[3] {
			t.Fatalf("expected one process with consistent temp environment: %s", launches)
		}
		turns, err := os.ReadFile(filepath.Join(home, "turns"))
		if err != nil || string(turns) != strings.Repeat(fields[0]+"\t"+fields[1]+"\n", 2) {
			t.Fatalf("turns did not reuse the original process and temp: %s, %v", turns, err)
		}
		if info, err := os.Stat(fields[1]); err != nil || info.Mode().Perm() != 0o700 {
			t.Fatalf("resident temp permissions: %v, %v", info, err)
		}
		temps = append(temps, fields[1])
	}
	if temps[0] == temps[1] {
		t.Fatal("different Contexts shared a resident temp directory")
	}
	if count, _, err := workspace.PruneOperationTemps(executor.TempBase, nil); err != nil || count != 0 {
		t.Fatalf("sweep removed live resident temps: count=%d, %v", count, err)
	}
	for i, home := range homes {
		if stopped, err := native.StopCodexHomeForMaintenance(home); err != nil || !stopped {
			t.Fatalf("resident cleanup was not confirmed: %t, %v", stopped, err)
		}
		if _, err := os.Stat(temps[i]); !os.IsNotExist(err) {
			t.Fatalf("resident temp survived confirmed process exit: %v", err)
		}
		if i == 0 {
			if _, err := os.Stat(temps[1]); err != nil {
				t.Fatalf("stopping one Context removed another's temp: %v", err)
			}
		}
	}
	if entries, err := os.ReadDir(executor.TempBase); err != nil || len(entries) != 0 {
		t.Fatalf("completed Operations left temp directories: %v, %v", entries, err)
	}
}
