package runtimehistory

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestClaudeHistoryIsContextOwnedFrozenAndRedacted(t *testing.T) {
	home := t.TempDir()
	session := "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	project := filepath.Join(home, ".claude", "projects", "workspace")
	if err := os.MkdirAll(project, 0700); err != nil {
		t.Fatal(err)
	}
	native := filepath.Join(project, session+".jsonl")
	content := `{"type":"user","sessionId":"` + session + `","uuid":"turn-1","message":{"role":"user","content":"hello"}}
{"type":"assistant","sessionId":"` + session + `","message":{"role":"assistant","content":[{"type":"thinking","thinking":"private-reasoning","signature":"private-signature"},{"type":"redacted_thinking","data":"private-encrypted-reasoning"},{"type":"text","text":"done"}]}}
`
	if err := os.WriteFile(native, []byte(content), 0600); err != nil {
		t.Fatal(err)
	}
	request := Request{CodexHome: home, ThreadID: session, Limit: 1}
	page := InspectClaude(context.Background(), request)
	encoded, _ := json.Marshal(page)
	if page.Status != "available" || page.PreviousCursor == "" || len(page.Records) != 1 || page.Records[0].Role != "assistant" || strings.Contains(string(encoded), "private-") {
		t.Fatalf("unexpected History: %s", encoded)
	}
	if err := os.WriteFile(native, []byte(content+`{"type":"system","sessionId":"`+session+`"}`+"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	request.Cursor = page.PreviousCursor
	previous := InspectClaude(context.Background(), request)
	if previous.Status != "available" || previous.Snapshot.RecordCount != 2 || previous.Records[0].Ordinal != 0 {
		t.Fatalf("snapshot shifted: %+v", previous)
	}
	other := Request{CodexHome: t.TempDir(), ThreadID: session}
	if got := InspectClaude(context.Background(), other); got.Status != "unavailable" {
		t.Fatalf("cross Context history: %+v", got)
	}
	if err := os.WriteFile(native, []byte(strings.ReplaceAll(content, session, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")), 0600); err != nil {
		t.Fatal(err)
	}
	request.Cursor = ""
	if got := InspectClaude(context.Background(), request); got.Reason != "transcript_session_mismatch" {
		t.Fatalf("foreign Session: %+v", got)
	}
}

func TestClaudeHistoryCategorizesCompactionRecords(t *testing.T) {
	home := t.TempDir()
	session := "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	project := filepath.Join(home, ".claude", "projects", "workspace")
	if err := os.MkdirAll(project, 0700); err != nil {
		t.Fatal(err)
	}
	line := func(record string) string { return strings.ReplaceAll(record, "SESSION", session) + "\n" }
	content := line(`{"type":"user","sessionId":"SESSION","message":{"role":"user","content":"hello"}}`) +
		line(`{"type":"system","subtype":"compact_boundary","sessionId":"SESSION","compactMetadata":{"trigger":"manual","preTokens":100}}`) +
		line(`{"type":"user","sessionId":"SESSION","isCompactSummary":true,"message":{"role":"user","content":"This session is being continued"}}`) +
		line(`{"type":"user","sessionId":"SESSION","message":{"role":"user","content":"<command-name>/compact</command-name>\n<command-message>compact</command-message>"}}`) +
		line(`{"type":"user","sessionId":"SESSION","message":{"role":"user","content":[{"type":"text","text":"<local-command-stdout>Compacted</local-command-stdout>"}]}}`) +
		line(`{"type":"system","subtype":"init","sessionId":"SESSION"}`) +
		line(`{"type":"user","sessionId":"SESSION","message":{"role":"user","content":[{"type":"text","text":"/compact is a word"}]}}`)
	if err := os.WriteFile(filepath.Join(project, session+".jsonl"), []byte(content), 0600); err != nil {
		t.Fatal(err)
	}
	page := InspectClaude(context.Background(), Request{CodexHome: home, ThreadID: session})
	var got []string
	for _, item := range page.Records {
		got = append(got, item.Category)
	}
	want := []string{"message", "compaction", "compaction", "compaction", "compaction", "lifecycle", "message"}
	if page.Status != "available" || strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("categories = %v, want %v (page %+v)", got, want, page)
	}
}
