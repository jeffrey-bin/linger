package runtimehistory

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPiHistoryCurrentBranchFrozenPaginationAndRedaction(t *testing.T) {
	home := t.TempDir()
	id := "pi-session"
	directory := filepath.Join(home, "sessions", id)
	if err := os.MkdirAll(directory, 0700); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(directory, "2026-10-27_"+id+".jsonl")
	content := `{"type":"session","version":3,"id":"pi-session","cwd":"/workspace"}
{"type":"message","id":"system","parentId":null,"message":{"role":"system","sections":{"preamble":"Be helpful"}}}
{"type":"message","id":"question","parentId":"system","message":{"role":"user","content":"Delivery Thursday"}}
{"type":"message","id":"abandoned","parentId":"question","message":{"role":"assistant","content":"wrong-branch"}}
{"type":"message","id":"answer","parentId":"question","message":{"role":"assistant","content":[{"type":"thinking","thinking":"private-reasoning","thinkingSignature":"private-signature"},{"type":"text","text":"Bearer private-credential"}]}}
{"type":"message","id":"tool","parentId":"answer","message":{"role":"toolResult","toolName":"read","toolCallId":"call-1","content":[{"type":"text","text":"ok"}]}}
`
	if err := os.WriteFile(file, []byte(content), 0600); err != nil {
		t.Fatal(err)
	}
	request := Request{CodexHome: home, ThreadID: id, Limit: 2}
	page := InspectPi(context.Background(), request)
	encoded, _ := json.Marshal(page)
	if page.Status != "available" || page.Source != "pi_session" || len(page.Records) != 2 || page.Records[1].Category != "tool_result" || page.Records[1].Ordinal != 5 || page.Instructions.Status != "available" || strings.Contains(string(encoded), "private-") {
		t.Fatalf("history: %s", encoded)
	}
	if err := os.WriteFile(file, []byte(content+`{"type":"message","id":"later","parentId":"tool","message":{"role":"user","content":"new"}}`+"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	request.Cursor = page.PreviousCursor
	older := InspectPi(context.Background(), request)
	if older.Status != "available" || older.Snapshot.ID != page.Snapshot.ID || older.Records[1].TurnID != "question" {
		t.Fatalf("frozen page: %+v", older)
	}
	all := InspectPi(context.Background(), Request{CodexHome: home, ThreadID: id})
	for _, item := range all.Records {
		if item.TurnID == "abandoned" {
			t.Fatal("abandoned branch leaked")
		}
	}
	if got := InspectPi(context.Background(), Request{CodexHome: t.TempDir(), ThreadID: id}); got.Status != "unavailable" {
		t.Fatal("cross Context history")
	}
	for name, broken := range map[string]string{
		"foreign session": strings.Replace(content, `"id":"pi-session"`, `"id":"foreign"`, 1),
		"cycle":           strings.Replace(content, `"parentId":"answer"`, `"parentId":"tool"`, 1),
	} {
		t.Run(name, func(t *testing.T) {
			if err := os.WriteFile(file, []byte(broken), 0600); err != nil {
				t.Fatal(err)
			}
			if got := InspectPi(context.Background(), Request{CodexHome: home, ThreadID: id}); got.Status != "unavailable" {
				t.Fatalf("invalid history: %+v", got)
			}
		})
	}
	if err := os.Remove(file); err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(t.TempDir(), "private.jsonl")
	if err := os.WriteFile(outside, []byte(content), 0600); err != nil {
		t.Fatal(err)
	}
	if err := createTestFileLink(t, outside, file); err != nil {
		t.Fatal(err)
	}
	if got := InspectPi(context.Background(), Request{CodexHome: home, ThreadID: id}); got.Status != "unavailable" {
		t.Fatal("symlink accepted")
	}
}
