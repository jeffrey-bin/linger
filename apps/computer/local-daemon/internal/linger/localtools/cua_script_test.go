package localtools

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/permission"
)

func TestScriptArgumentsBoundTheScript(t *testing.T) {
	arguments := map[string]any{"script": "return 1;"}
	if err := scriptArguments(context.Background(), arguments, "", 0); err != nil || arguments["timeout_ms"] != float64(scriptTimeoutMs) {
		t.Fatalf("default: %v %v", err, arguments)
	}
	arguments = map[string]any{"script": "return 1;", "timeout_ms": float64(500000)}
	if err := scriptArguments(context.Background(), arguments, "", 0); err != nil || arguments["timeout_ms"] != float64(scriptMaxTimeoutMs) {
		t.Fatalf("cap: %v %v", err, arguments)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	arguments = map[string]any{"script": "return 1;", "timeout_ms": float64(90000)}
	if err := scriptArguments(ctx, arguments, "", 0); err != nil || arguments["timeout_ms"].(float64) > 45000 {
		t.Fatalf("deadline: %v %v", err, arguments)
	}
	late, stop := context.WithTimeout(context.Background(), 10*time.Second)
	defer stop()
	if err := scriptArguments(late, map[string]any{"script": "return 1;"}, "", 0); !errors.Is(err, errNotSent) {
		t.Fatalf("late: %v", err)
	}
	for _, refused := range []map[string]any{
		{"script": " "},
		{"script": "return 1;", "session": "x"},
		{"script": `await cua.call("click", {pid: 1, x: 2, y: 3, delivery_mode: "foreground"})`},
		{"script": `await app.getState({screenshot_out_file: "/tmp/a.png"})`},
	} {
		if err := scriptArguments(context.Background(), refused, "", 0); !errors.Is(err, errNotSent) {
			t.Fatalf("%v: got %v", refused, err)
		}
	}
}

func TestScriptArgumentsReadASkillScriptWithArgs(t *testing.T) {
	skill := t.TempDir()
	if err := os.WriteFile(filepath.Join(skill, "SKILL.md"), []byte("---\nname: s\n---\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(skill, "read.js")
	if err := os.WriteFile(file, []byte("return args.pid;"), 0o600); err != nil {
		t.Fatal(err)
	}
	arguments := map[string]any{"script_file": file, "args": map[string]any{"pid": float64(7)}}
	if err := scriptArguments(context.Background(), arguments, "", 0); err != nil {
		t.Fatal(err)
	}
	script, _ := arguments["script"].(string)
	if !strings.Contains(script, `Object.freeze({"pid":7})`) || !strings.HasSuffix(script, `"use strict"; return args.pid;`+scriptEpilogue) || arguments["script_file"] != nil || arguments["args"] != nil {
		t.Fatalf("got %v", arguments)
	}
	for _, refused := range []map[string]any{
		{"script": "return 1;", "script_file": file},
		{"script_file": file, "args": "pid=7"},
		{"script_file": filepath.Join(t.TempDir(), "x.js")},
		{"script": `return cua.call("click", {delivery_mode: "foreground"});`},
		{"script_file": file, "args": map[string]any{"click": []any{map[string]any{"delivery_mode": "foreground"}}}},
	} {
		if err := scriptArguments(context.Background(), refused, "", 0); !errors.Is(err, errNotSent) {
			t.Fatalf("%v: got %v", refused, err)
		}
	}
	// args carry page and user text, which may name a forbidden option.
	if err := scriptArguments(context.Background(), map[string]any{"script_file": file, "args": map[string]any{"text": "in the foreground"}}, "", 0); err != nil {
		t.Fatalf("user text in args: %v", err)
	}
	// A reviewed Run runs a script file only as a review allowed it.
	if err := scriptArguments(context.Background(), map[string]any{"script_file": file, "args": map[string]any{"pid": float64(7)}}, permission.ScriptScope("agent-1", "context-1"), 0); !errors.Is(err, errNotSent) || !strings.Contains(err.Error(), "COMPUTER_SCRIPT_REFUSED") {
		t.Fatalf("unreviewed script file in a reviewed Run: %v", err)
	}
	if err := scriptArguments(context.Background(), map[string]any{"script": "return 1;"}, permission.ScriptScope("agent-1", "context-1"), 0); err != nil {
		t.Fatalf("inline script in a reviewed Run: %v", err)
	}
}

func TestCompactScriptResultKeepsTheReturnValueWithoutImages(t *testing.T) {
	var calls []string
	for i := 1; i <= 30; i++ {
		calls = append(calls, fmt.Sprintf("  %d. line %d click ok (5 ms)", i, i))
	}
	text := "run_script: ok in 900 ms, 30 driver call(s)\nreturn value: {\"n\":3}\ncalls:\n" + strings.Join(calls, "\n")
	raw, _ := json.Marshal(map[string]any{"content": []any{
		map[string]any{"type": "text", "text": text},
		map[string]any{"type": "image", "mimeType": "image/png", "data": "first"},
		map[string]any{"type": "image", "mimeType": "image/png", "data": "last"},
	}})
	var reply struct {
		Content []map[string]string `json:"content"`
	}
	if err := json.Unmarshal(compactScriptResult(raw), &reply); err != nil {
		t.Fatal(err)
	}
	if len(reply.Content) != 1 {
		t.Fatalf("images: %v", reply.Content)
	}
	got := reply.Content[0]["text"]
	for _, want := range []string{"return value: {\"n\":3}", "  1. line 1", "  4. line 4", "… 10 calls omitted …", "  15. line 15", "  30. line 30"} {
		if !strings.Contains(got, want) {
			t.Fatalf("missing %q in %q", want, got)
		}
	}
	if strings.Contains(got, "  5. line 5") || strings.Contains(got, "  14. line 14") {
		t.Fatalf("middle calls kept: %q", got)
	}
	long, _ := json.Marshal(map[string]any{"content": []any{map[string]any{"type": "text", "text": strings.Repeat("\u5b57", scriptResultCharacters+10)}}})
	if err := json.Unmarshal(compactScriptResult(long), &reply); err != nil || !strings.HasSuffix(reply.Content[0]["text"], "return less, such as only the fields you need.") {
		t.Fatalf("cut: %v", err)
	}
}

func TestWithoutStructuredKeepsTheText(t *testing.T) {
	raw := json.RawMessage(`{"content":[{"type":"text","text":"- [0] AXWindow"}],"structuredContent":{"tree_markdown":"- [0] AXWindow","capture_id":"c1"}}`)
	got := string(withoutStructured(raw))
	if strings.Contains(got, "structuredContent") || !strings.Contains(got, `"text":"- [0] AXWindow"`) {
		t.Fatalf("got %s", got)
	}
	if !textResultTools["get_window_state"] || textResultTools["list_windows"] {
		t.Fatal("list_windows tells its windows only in structuredContent")
	}
}
