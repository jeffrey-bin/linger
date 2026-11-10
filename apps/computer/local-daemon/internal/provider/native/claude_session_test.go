package native

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

const claudeTestSession = "12345678-1234-4234-8234-123456789012"

func claudePrivateRoot(t *testing.T) string {
	t.Helper()
	root := filepath.Join(t.TempDir(), "sessions")
	if err := os.Mkdir(root, 0o700); err != nil {
		t.Fatal(err)
	}
	return root
}

func TestClaudeAssignedSessionBecomesResumeAndRefreshesInstructions(t *testing.T) {
	root := claudePrivateRoot(t)
	result := `{"type":"result","result":"ok","terminal_reason":"completed","session_id":"` + claudeTestSession + `"}`
	var sessions []string
	for i, prompt := range []string{"prompt A", "prompt B"} {
		dir := t.TempDir()
		profile := claudeFramesProfile(t, "frames", []string{result}, map[string]string{"CLAUDE_FAKE_DIR": dir, claudeSessionRoot: root})
		_, outcome := claudeFinish(t, claudeStart(t, profile, "hello", RunSpec{AssignSessionID: claudeTestSession, AppendPrompt: prompt}), 10*time.Second)
		if outcome.Status != statusCompleted {
			t.Fatalf("run %d = %+v", i, outcome)
		}
		sessions = append(sessions, outcome.SessionID)
		argv, _ := os.ReadFile(filepath.Join(dir, "argv"))
		args := strings.Split(string(argv), "\n")
		flag := "--session-id"
		if i == 1 {
			flag = "--resume"
		}
		if v := claudeFlagValue(args, flag); len(v) != 1 || v[0] != claudeTestSession {
			t.Fatalf("run %d argv lacks %s: %v", i, flag, args)
		}
		initLine, _ := os.ReadFile(filepath.Join(dir, "init"))
		var frame struct {
			Request struct {
				AppendSystemPrompt   string `json:"appendSystemPrompt"`
				SystemPromptSnapshot *bool  `json:"systemPromptSnapshot"`
			} `json:"request"`
		}
		if json.Unmarshal(initLine, &frame) != nil || frame.Request.AppendSystemPrompt != prompt || frame.Request.SystemPromptSnapshot == nil || *frame.Request.SystemPromptSnapshot {
			t.Fatalf("run %d initialize = %s", i, initLine)
		}
		if marker, err := claudeReadMarker(root, claudeTestSession); err != nil || marker.prompt != prompt {
			t.Fatalf("run %d marker = %+v %v", i, marker, err)
		}
	}
	if sessions[0] != claudeTestSession || sessions[1] != claudeTestSession {
		t.Fatalf("sessions = %v", sessions)
	}
}

func TestClaudeMarkerWrites(t *testing.T) {
	root := filepath.Join(t.TempDir(), "sessions")
	if _, err := claudeReadMarker(root, claudeTestSession); err != nil {
		t.Fatalf("missing root: %v", err)
	}
	for _, prompt := range []string{"first", "second"} {
		if err := claudeWriteMarker(root, claudeTestSession, prompt); err != nil {
			t.Fatal(err)
		}
	}
	marker, err := claudeReadMarker(root, claudeTestSession)
	if err != nil || marker.prompt != "second" || !claudeSessionMaterialized(root, claudeTestSession) {
		t.Fatalf("marker = %+v %v", marker, err)
	}
	entries, _ := os.ReadDir(root)
	if len(entries) != 1 {
		t.Fatalf("root entries = %v", entries)
	}
	if runtime.GOOS != "windows" {
		rootInfo, _ := os.Stat(root)
		fileInfo, _ := os.Stat(claudeMarkerPath(root, claudeTestSession))
		if rootInfo.Mode().Perm() != 0o700 || fileInfo.Mode().Perm() != 0o600 {
			t.Fatalf("modes = %v %v", rootInfo.Mode(), fileInfo.Mode())
		}
	}
	legacy := claudePrivateRoot(t)
	path := claudeMarkerPath(legacy, claudeTestSession)
	if err := os.WriteFile(path, []byte(`{"session_id":"`+claudeTestSession+`","extra":1}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if marker, err := claudeReadMarker(legacy, claudeTestSession); err != nil || marker.hasPrompt {
		t.Fatalf("legacy = %+v %v", marker, err)
	}
	if err := claudeWriteMarker(legacy, claudeTestSession, ""); err != nil {
		t.Fatal(err)
	}
	if marker, err := claudeReadMarker(legacy, claudeTestSession); err != nil || !marker.hasPrompt || marker.prompt != "" {
		t.Fatalf("empty prompt = %+v %v", marker, err)
	}
	if err := claudeWriteMarker(legacy, claudeTestSession, "current"); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(path)
	if !bytes.Contains(data, []byte(`"extra":1`)) || !bytes.Contains(data, []byte(`"current"`)) {
		t.Fatalf("rewrite lost keys: %s", data)
	}
}

func TestClaudeInvalidMarkersStayUntouched(t *testing.T) {
	for name, body := range map[string][]byte{
		"malformed": []byte(`{`), "null": []byte(`null`), "empty object": []byte(`{}`),
		"wrong id":    []byte(`{"session_id":"87654321-4321-4321-8321-210987654321"}`),
		"null prompt": []byte(`{"session_id":"` + claudeTestSession + `","system_prompt_append":null}`),
		"number":      []byte(`{"session_id":"` + claudeTestSession + `","system_prompt_append":3}`),
		"too large":   append([]byte(`{"session_id":"`+claudeTestSession+`","pad":"`), bytes.Repeat([]byte("a"), claudeMarkerLimit)...),
	} {
		t.Run(name, func(t *testing.T) {
			root := claudePrivateRoot(t)
			path := claudeMarkerPath(root, claudeTestSession)
			if err := os.WriteFile(path, body, 0o600); err != nil {
				t.Fatal(err)
			}
			if _, err := claudeReadMarker(root, claudeTestSession); err == nil {
				t.Fatal("validation accepted an invalid marker")
			}
			if err := claudeWriteMarker(root, claudeTestSession, "x"); err == nil {
				t.Fatal("write replaced an invalid marker")
			}
			if after, _ := os.ReadFile(path); !bytes.Equal(after, body) {
				t.Fatal("invalid marker changed")
			}
		})
	}
}

func TestClaudeUnsafeMarkerPaths(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("mode and symlink cases are POSIX")
	}
	valid := []byte(`{"session_id":"` + claudeTestSession + `"}`)
	cases := map[string]func(t *testing.T) string{
		"file symlink": func(t *testing.T) string {
			root := claudePrivateRoot(t)
			target := filepath.Join(t.TempDir(), "target.json")
			_ = os.WriteFile(target, valid, 0o600)
			_ = os.Symlink(target, claudeMarkerPath(root, claudeTestSession))
			return root
		},
		"root symlink": func(t *testing.T) string {
			real := claudePrivateRoot(t)
			link := filepath.Join(t.TempDir(), "link")
			_ = os.Symlink(real, link)
			return link
		},
		"file mode": func(t *testing.T) string {
			root := claudePrivateRoot(t)
			_ = os.WriteFile(claudeMarkerPath(root, claudeTestSession), valid, 0o644)
			_ = os.Chmod(claudeMarkerPath(root, claudeTestSession), 0o644)
			return root
		},
		"root mode": func(t *testing.T) string {
			root := claudePrivateRoot(t)
			_ = os.Chmod(root, 0o755)
			return root
		},
		"marker directory": func(t *testing.T) string {
			root := claudePrivateRoot(t)
			_ = os.Mkdir(claudeMarkerPath(root, claudeTestSession), 0o700)
			return root
		},
	}
	for name, setup := range cases {
		t.Run(name, func(t *testing.T) {
			root := setup(t)
			if _, err := claudeReadMarker(root, claudeTestSession); err == nil {
				t.Fatal("validation accepted an unsafe path")
			}
			if err := claudeWriteMarker(root, claudeTestSession, "x"); err == nil {
				t.Fatal("write accepted an unsafe path")
			}
		})
	}
	for _, identity := range []string{"", "../escape", "not-a-uuid"} {
		if _, err := claudeReadMarker(claudePrivateRoot(t), identity); err == nil {
			t.Fatalf("identity %q validated", identity)
		}
	}
	if _, err := claudeReadMarker("", claudeTestSession); err == nil {
		t.Fatal("missing root validated")
	}
}

func TestClaudeConcurrentMarkerWriters(t *testing.T) {
	root := filepath.Join(t.TempDir(), "sessions")
	var wg sync.WaitGroup
	prompts := []string{"one", "two", "three"}
	for _, prompt := range prompts {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := claudeWriteMarker(root, claudeTestSession, prompt); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	marker, err := claudeReadMarker(root, claudeTestSession)
	if err != nil || !strings.Contains(strings.Join(prompts, ","), marker.prompt) {
		t.Fatalf("marker = %+v %v", marker, err)
	}
	if err := claudeWriteMarker(root, claudeTestSession, "later"); err != nil {
		t.Fatal(err)
	}
	if marker, _ := claudeReadMarker(root, claudeTestSession); marker.prompt != "later" {
		t.Fatalf("later = %+v", marker)
	}
	if entries, _ := os.ReadDir(root); len(entries) != 1 {
		t.Fatalf("temp files left: %v", entries)
	}
}

func claudeReadPIDs(t *testing.T, dir string) []int {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(dir, "pids"))
	if err != nil {
		t.Fatal(err)
	}
	var pids []int
	for _, field := range strings.Fields(string(data)) {
		var pid int
		_, _ = fmt.Sscan(field, &pid)
		if pid > 0 {
			pids = append(pids, pid)
		}
	}
	return pids
}
