package localtools

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

// X11 input waits for browser calls in flight, and an input the journal
// refuses frees the desktop lane and the focus gate it took.
func TestLinuxInputTakesTurnsWithBrowserCallsAndFreesItsHoldsOnRefusal(t *testing.T) {
	m := laneManager(t, t.TempDir())
	op := agentBrowserOp(t, m, "a")
	_, releaseBrowser, err := m.holdBrowserFocus(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	waiting, cancel := context.WithTimeout(t.Context(), 150*time.Millisecond)
	defer cancel()
	if _, err := op.beginDesktop(waiting, true); !errors.Is(err, errNotSent) {
		t.Fatalf("input did not wait for the browser call in flight: %v", err)
	}
	releaseBrowser()
	leaveUnknown(t, m.journal)
	if _, err := op.beginDesktop(t.Context(), true); err == nil {
		t.Fatal("input began beside a desktop input of unknown outcome")
	}
	free, cancelFree := context.WithTimeout(t.Context(), time.Second)
	defer cancelFree()
	_, releaseLane, err := m.holdLane(free, desktopLane)
	if err != nil {
		t.Fatalf("refused input kept the desktop lane: %v", err)
	}
	releaseLane()
	_, releaseFocus, err := m.holdFocus(free, true)
	if err != nil {
		t.Fatalf("refused input kept the focus gate: %v", err)
	}
	releaseFocus()
}

// One Agent's Chrome that is slow to start does not hold up another Agent's.
func TestTwoAgentsStartTheirChromeTogether(t *testing.T) {
	bin, started := t.TempDir(), t.TempDir()
	chrome := filepath.Join(bin, "chromium")
	script := "#!/bin/sh\n: > \"" + started + "/$$\"\nexec /bin/sleep 60\n"
	if err := os.WriteFile(chrome, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	m := laneManager(t, t.TempDir())
	m.env = []string{"PATH=" + bin, "DISPLAY=:0", "HOME=" + t.TempDir()}
	m.options.StateDirectory = t.TempDir()
	if chromeExecutable(m.env) != chrome {
		t.Skip("a system Chrome comes before the fixture")
	}
	ctx, cancel := context.WithCancel(t.Context())
	var wg sync.WaitGroup
	defer func() { cancel(); wg.Wait() }()
	for _, agent := range []string{"a", "b"} {
		wg.Go(func() { _, _ = m.nativeBrowserFor(ctx, agent) })
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		if entries, _ := os.ReadDir(started); len(entries) == 2 {
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("the second Agent's Chrome waited for the first one to start")
		}
		time.Sleep(20 * time.Millisecond)
	}
}
