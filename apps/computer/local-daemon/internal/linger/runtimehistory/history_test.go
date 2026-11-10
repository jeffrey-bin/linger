package runtimehistory

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/klauspost/compress/zstd"
)

func TestInspectPagesFrozenSnapshotAndRedactsSensitiveData(t *testing.T) {
	home, rollout := writeRollout(t, "thread-page", []map[string]any{
		sessionMeta("thread-page", "Bearer instruction-token from /Users/me/.codex/config.toml"),
		record("response_item", "reasoning", map[string]any{
			"turn_id": "turn-1", "summary": []any{map[string]any{"text": "safe summary"}},
			"content": "hidden thought", "authorization": "Bearer secret-token",
			"note": "host file /Users/me/private/token.txt but /workspace/visible.txt is logical",
		}),
		record("event_msg", "agent_message", map[string]any{"message": "two"}),
		record("event_msg", "agent_message", map[string]any{"message": "three"}),
	}, false, "")

	latest := Inspect(context.Background(), Request{
		CodexHome: home, ThreadID: "thread-page", Limit: 2,
		Now: func() time.Time { return time.Date(2026, 8, 24, 12, 0, 0, 0, time.UTC) },
	})
	if latest.Status != "available" || latest.PreviousCursor == "" {
		t.Fatalf("latest page = %#v", latest)
	}
	if got := []int{latest.Records[0].Ordinal, latest.Records[1].Ordinal}; got[0] != 2 || got[1] != 3 {
		t.Fatalf("latest ordinals = %v", got)
	}

	appendRollout(t, rollout, record("event_msg", "agent_message", map[string]any{"message": "four"}))
	earlier := Inspect(context.Background(), Request{CodexHome: home, ThreadID: "thread-page", Cursor: latest.PreviousCursor, Limit: 2})
	if earlier.Status != "available" || earlier.Snapshot.RecordCount != 4 || earlier.Snapshot.CapturedAt != "2026-08-24T12:00:00Z" {
		t.Fatalf("earlier page = %#v", earlier)
	}
	if got := []int{earlier.Records[0].Ordinal, earlier.Records[1].Ordinal}; got[0] != 0 || got[1] != 1 {
		t.Fatalf("earlier ordinals = %v", got)
	}
	encoded, _ := json.Marshal(earlier.Records[1])
	text := string(encoded)
	for _, forbidden := range []string{"hidden thought", "secret-token", "/Users/me"} {
		if strings.Contains(text, forbidden) {
			t.Fatalf("history leaked %q: %s", forbidden, text)
		}
	}
	for _, required := range []string{"safe summary", "[REDACTED_PATH]", "/workspace/visible.txt", "reasoning_content"} {
		if !strings.Contains(text, required) {
			t.Fatalf("history omitted %q: %s", required, text)
		}
	}
	if got := earlier.Instructions.Blocks[0].Text; got != "Bearer [REDACTED] from [REDACTED_PATH]" {
		t.Fatalf("instructions = %q", got)
	}
	refreshed := Inspect(context.Background(), Request{CodexHome: home, ThreadID: "thread-page"})
	if refreshed.Status != "available" || refreshed.Snapshot.RecordCount != 5 {
		t.Fatalf("refresh = %#v", refreshed)
	}
}

func TestInspectCompressedTailAndSecurityFailures(t *testing.T) {
	home, _ := writeRollout(t, "thread-zstd", []map[string]any{sessionMeta("thread-zstd", "")}, true, "")
	page := Inspect(context.Background(), Request{CodexHome: home, ThreadID: "thread-zstd"})
	if page.Status != "available" || page.Snapshot.TailState != "clean" {
		t.Fatalf("zstd page = %#v", page)
	}

	incompleteHome, _ := writeRollout(t, "thread-tail", []map[string]any{sessionMeta("thread-tail", "")}, false, `{"timestamp":`)
	incomplete := Inspect(context.Background(), Request{CodexHome: incompleteHome, ThreadID: "thread-tail"})
	if incomplete.Status != "available" || incomplete.Snapshot.TailState != "incomplete" {
		t.Fatalf("incomplete = %#v", incomplete)
	}

	corruptHome, _ := writeRollout(t, "thread-corrupt", []map[string]any{sessionMeta("thread-corrupt", "")}, false, "not-json\n{}\n")
	corrupt := Inspect(context.Background(), Request{CodexHome: corruptHome, ThreadID: "thread-corrupt"})
	if corrupt.Status != "available" || corrupt.Snapshot.TailState != "corrupt" || len(corrupt.Records) != 1 {
		t.Fatalf("corrupt = %#v", corrupt)
	}

	mismatch := Inspect(context.Background(), Request{CodexHome: home, ThreadID: "thread-other"})
	if mismatch.Status != "unavailable" || mismatch.Reason != "rollout_unavailable" {
		t.Fatalf("mismatch = %#v", mismatch)
	}

	linkedHome := t.TempDir()
	outside := t.TempDir()
	if err := createTestDirectoryLink(outside, filepath.Join(linkedHome, "sessions")); err != nil {
		t.Fatal(err)
	}
	linked := Inspect(context.Background(), Request{CodexHome: linkedHome, ThreadID: "thread-link"})
	if linked.Status != "unavailable" || linked.Reason != "rollout_root_invalid" {
		t.Fatalf("linked = %#v", linked)
	}

	invalidLimit := Inspect(context.Background(), Request{CodexHome: home, ThreadID: "thread-zstd", Limit: 501})
	if invalidLimit.Status != "unavailable" || invalidLimit.Reason != "history_limit_invalid" {
		t.Fatalf("limit = %#v", invalidLimit)
	}
}

func TestInspectCategorizesCompactionRecords(t *testing.T) {
	compacted := record("compacted", "", map[string]any{"message": "summary"})
	delete(compacted["payload"].(map[string]any), "type")
	home, _ := writeRollout(t, "thread-compact", []map[string]any{
		sessionMeta("thread-compact", ""),
		compacted,
		record("event_msg", "context_compacted", nil),
		record("event_msg", "agent_message", map[string]any{"message": "after"}),
	}, false, "")
	page := Inspect(context.Background(), Request{CodexHome: home, ThreadID: "thread-compact"})
	if page.Status != "available" || len(page.Records) != 4 {
		t.Fatalf("page = %#v", page)
	}
	var got []string
	for _, item := range page.Records {
		got = append(got, item.Category)
	}
	if want := []string{"lifecycle", "compaction", "compaction", "message"}; strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("categories = %v, want %v", got, want)
	}
}

func TestInspectRejectsMismatchedAndAmbiguousRollouts(t *testing.T) {
	home, rollout := writeRollout(t, "thread-target", []map[string]any{sessionMeta("thread-wrong", "")}, false, "")
	mismatch := Inspect(context.Background(), Request{CodexHome: home, ThreadID: "thread-target"})
	if mismatch.Status != "unavailable" || mismatch.Reason != "rollout_session_mismatch" {
		t.Fatalf("mismatch = %#v", mismatch)
	}
	otherDirectory := filepath.Join(home, "sessions", "other")
	if err := os.MkdirAll(otherDirectory, 0o700); err != nil {
		t.Fatal(err)
	}
	encoded, _ := os.ReadFile(rollout)
	if err := os.WriteFile(filepath.Join(otherDirectory, "second-thread-target.jsonl"), encoded, 0o600); err != nil {
		t.Fatal(err)
	}
	ambiguous := Inspect(context.Background(), Request{CodexHome: home, ThreadID: "thread-target"})
	if ambiguous.Status != "unavailable" || ambiguous.Reason != "rollout_session_ambiguous" {
		t.Fatalf("ambiguous = %#v", ambiguous)
	}
}

func TestInspectOmitsOversizedRecord(t *testing.T) {
	home, _ := writeRollout(t, "thread-large", []map[string]any{
		sessionMeta("thread-large", ""),
		record("response_item", "custom_tool_call_output", map[string]any{
			"turn_id": "turn-1", "call_id": "call-large", "output": strings.Repeat("x", maxNativeRecordBytes+1),
		}),
	}, false, "")
	page := Inspect(context.Background(), Request{CodexHome: home, ThreadID: "thread-large"})
	if page.Status != "available" || len(page.Records) != 2 {
		t.Fatalf("page = %#v", page)
	}
	encoded, _ := json.Marshal(page.Records[1])
	text := string(encoded)
	if !strings.Contains(text, `"omitted_too_large"`) || strings.Contains(text, strings.Repeat("x", 1024)) {
		t.Fatalf("oversized record = %s", text)
	}
}

func TestInspectKeepsNativeRecordsWithinRunnerFrameLimits(t *testing.T) {
	deep := any("leaf")
	for range 40 {
		deep = map[string]any{"next": deep}
	}
	wide := map[string]any{}
	for index := range 257 {
		wide[fmt.Sprintf("key-%d", index)] = index
	}
	home, _ := writeRollout(t, "thread-limits", []map[string]any{
		sessionMeta("thread-limits", ""),
		record("response_item", "function_call_output", map[string]any{
			"call_id": "call-limits",
			"output":  strings.Repeat("é", 262_145),
			"items":   make([]any, 1_025),
			"wide":    wide,
			"deep":    deep,
			"nanos":   float64(1_792_515_479_250_000_000),
		}),
	}, false, "")
	page := Inspect(context.Background(), Request{CodexHome: home, ThreadID: "thread-limits"})
	if page.Status != "available" || len(page.Records) != 2 {
		t.Fatalf("page = %#v", page)
	}
	encoded, _ := json.Marshal(page.Records[1].NativeRecord)
	var native any
	if err := json.Unmarshal(encoded, &native); err != nil {
		t.Fatal(err)
	}
	// native_record is four levels below the debug.inspected frame root.
	assertRunnerFrameValue(t, native, 4)
	if len(page.Records[1].RedactedFields) < 4 {
		t.Fatalf("redactions = %#v", page.Records[1].RedactedFields)
	}
}

// Mirrors the Runner Gateway JsonValue schema and frame limits.
func assertRunnerFrameValue(t *testing.T, value any, depth int) {
	t.Helper()
	if depth > 32 {
		t.Fatalf("value at depth %d exceeds the frame limit", depth)
	}
	switch typed := value.(type) {
	case string:
		if count := utf8.RuneCountInString(typed); count > 262_144 {
			t.Fatalf("string has %d characters", count)
		}
	case float64:
		if math.Abs(typed) > 1<<53-1 {
			t.Fatalf("number %v is outside the safe integer range", typed)
		}
	case []any:
		if len(typed) > 1_024 {
			t.Fatalf("array has %d items", len(typed))
		}
		for _, item := range typed {
			assertRunnerFrameValue(t, item, depth+1)
		}
	case map[string]any:
		if len(typed) > 256 {
			t.Fatalf("object has %d properties", len(typed))
		}
		for _, item := range typed {
			assertRunnerFrameValue(t, item, depth+1)
		}
	}
}

func writeRollout(t *testing.T, threadID string, records []map[string]any, compressed bool, suffix string) (string, string) {
	t.Helper()
	home := t.TempDir()
	sessions := filepath.Join(home, "sessions", "2026", "08", "24")
	if err := os.MkdirAll(sessions, 0o700); err != nil {
		t.Fatal(err)
	}
	var source strings.Builder
	for _, item := range records {
		encoded, _ := json.Marshal(item)
		source.Write(encoded)
		source.WriteByte('\n')
	}
	source.WriteString(suffix)
	path := filepath.Join(sessions, "rollout-"+threadID+".jsonl")
	data := []byte(source.String())
	if compressed {
		encoder, err := zstd.NewWriter(nil)
		if err != nil {
			t.Fatal(err)
		}
		data = encoder.EncodeAll(data, nil)
		_ = encoder.Close()
		path += ".zst"
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	return home, path
}

func appendRollout(t *testing.T, path string, value map[string]any) {
	t.Helper()
	file, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	encoded, _ := json.Marshal(value)
	if _, err := file.Write(append(encoded, '\n')); err != nil {
		t.Fatal(err)
	}
}

func sessionMeta(id, instructions string) map[string]any {
	payload := map[string]any{"id": id}
	if instructions != "" {
		payload["base_instructions"] = instructions
	}
	return map[string]any{"timestamp": "2026-08-24T12:00:00Z", "type": "session_meta", "payload": payload}
}

func record(recordType, payloadType string, fields map[string]any) map[string]any {
	payload := map[string]any{"type": payloadType}
	for key, value := range fields {
		payload[key] = value
	}
	return map[string]any{"timestamp": "2026-08-24T12:00:01Z", "type": recordType, "payload": payload}
}
