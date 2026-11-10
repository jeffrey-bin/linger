//go:build !windows

package lingercontext

import (
	"errors"
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

func TestLocalCopyDoesNotBlockOnFIFOOtherAgentSource(t *testing.T) {
	body := []byte("fifo body\n")
	fixture := newLocalCopyServer(t, map[string][]byte{"/skill": body})
	store, _, logs := openLocalCopyStore(t, fixture.server.Client())
	skill := mappingFile("skills", "skill.md", body)
	first, _ := applyLocalCopyCommand(t, store, logs, fixture.server.URL, localCopyContextCommand("apply-a", "context-a", skill))
	source := filepath.Join(first.WorkspacePath, "skills", "skill.md")
	if err := os.Chmod(filepath.Dir(source), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(source); err != nil {
		t.Fatal(err)
	}
	if err := syscall.Mkfifo(source, 0o600); err != nil {
		t.Fatal(err)
	}

	otherAgent := localCopyContextCommand("apply-other-agent", "context-other-agent", skill)
	otherAgent.AgentID = "agent-2"
	type result struct {
		record ViewRecord
		event  map[string]any
		err    error
	}
	done := make(chan result, 1)
	go func() {
		logs.Reset()
		record, err := store.applyTestView(t.Context(), otherAgent, fixture.server.URL)
		done <- result{record, lastTimingEvent(t, logs), err}
	}()
	select {
	case got := <-done:
		if got.err != nil {
			t.Fatal(got.err)
		}
		requireLocalCopyTiming(t, got.event, 0, 1)
		content, err := os.ReadFile(filepath.Join(got.record.WorkspacePath, "skills", "skill.md"))
		if err != nil || string(content) != string(body) {
			t.Fatalf("FIFO fallback=%q err=%v", content, err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("apply blocked on a FIFO local copy source")
	}
}

func TestLocalCopyOpenDoesNotBlockOnFIFO(t *testing.T) {
	workspace := t.TempDir()
	if err := os.Mkdir(filepath.Join(workspace, "skills"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := syscall.Mkfifo(filepath.Join(workspace, "skills", "skill.md"), 0o600); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() {
		file, err := openContextFile(workspace, filepath.Join("skills", "skill.md"))
		if err != nil {
			done <- nil
			return
		}
		defer file.Close()
		info, err := file.Stat()
		if err != nil {
			done <- err
			return
		}
		if info.Mode().IsRegular() {
			done <- errors.New("FIFO source was accepted as a regular file")
			return
		}
		done <- nil
	}()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("openContextFile blocked on a FIFO")
	}
}
