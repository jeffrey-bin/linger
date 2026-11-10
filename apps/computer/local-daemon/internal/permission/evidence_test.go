package permission

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestScriptEvidenceAttachesTheScriptACommandRuns(t *testing.T) {
	workspace := t.TempDir()
	if err := os.WriteFile(filepath.Join(workspace, "send.py"), []byte("import smtplib\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	evidence := ScriptEvidence("python3 -u send.py --to boss", workspace)
	if evidence == nil || evidence.Script == nil || evidence.Script.Path != "send.py" || evidence.Script.Body != "import smtplib\n" ||
		len(evidence.Script.SHA256) != 64 || len(evidence.Missing) != 0 {
		t.Fatalf("evidence = %+v", evidence)
	}
	if evidence := ScriptEvidence("python3 "+filepath.Join(workspace, "send.py"), workspace); evidence == nil || evidence.Script == nil {
		t.Fatalf("absolute path inside the workspace: %+v", evidence)
	}
}

func TestScriptEvidenceReportsWhatItCouldNotRead(t *testing.T) {
	workspace := t.TempDir()
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "secret.py"), []byte("print(1)\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := createTestDirectoryLink(outside, filepath.Join(workspace, "linked")); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(workspace, "long.py"), []byte(strings.Repeat("x", maxScriptBytes+10)), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, command := range []string{"python3 missing.py", "python3 ../secret.py", "python3 " + filepath.Join(outside, "secret.py"), "python3 " + filepath.Join("linked", "secret.py")} {
		if evidence := ScriptEvidence(command, workspace); evidence == nil || evidence.Script != nil || len(evidence.Missing) != 1 {
			t.Errorf("%s: %+v", command, evidence)
		}
	}
	long := ScriptEvidence("python3 long.py", workspace)
	if long == nil || long.Script == nil || len(long.Script.Body) != maxScriptBytes || len(long.Missing) != 1 {
		t.Fatalf("long script: %+v", long)
	}
	for _, command := range []string{"git push", "python3", "python3 -c 'print(1)'", "node -e 1"} {
		if evidence := ScriptEvidence(command, workspace); evidence != nil {
			t.Errorf("%s attached %+v", command, evidence)
		}
	}
}

func TestTrimKeepsTheNewestHistoryInOrder(t *testing.T) {
	var entries []TranscriptEntry
	for index := 0; index < maxTranscriptEntries+5; index++ {
		entries = append(entries, TranscriptEntry{Kind: "tool_result", Text: string(rune('a' + index%26))})
	}
	entries = append(entries, TranscriptEntry{Kind: "assistant", Text: strings.Repeat("€", maxAssistantRunes+1)})
	trimmed := Trim(entries)
	if len(trimmed) != maxTranscriptEntries {
		t.Fatalf("kept %d entries", len(trimmed))
	}
	last := trimmed[len(trimmed)-1]
	if last.Kind != "assistant" || !last.Truncated || len([]rune(last.Text)) != maxAssistantRunes {
		t.Fatalf("newest entry: %+v", last)
	}
	if trimmed[0] != entries[len(entries)-maxTranscriptEntries] {
		t.Fatalf("oldest kept entry: %+v", trimmed[0])
	}
	huge := []TranscriptEntry{{Kind: "assistant", Text: "old"}}
	for index := 0; index < 10; index++ {
		huge = append(huge, TranscriptEntry{Kind: "assistant", Text: strings.Repeat("x", maxAssistantRunes)})
	}
	if trimmed := Trim(huge); len(trimmed) != maxTranscriptTotalRune/maxAssistantRunes || trimmed[0].Text == "old" {
		t.Fatalf("total budget kept %d entries", len(trimmed))
	}
}
