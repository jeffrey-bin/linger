package localtools

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"strconv"
	"strings"
	"sync"
)

// focusGate admits any number of browser calls at once, or one desktop input
// that depends on the front window or the clipboard. A browser call can bring
// Chrome forward, as a new or selected tab or a page Playwright opens again
// does, and a key combination in the page can copy or paste through the
// clipboard; keys, pastes and foreground clicks sent to the desktop at that
// moment would land in Chrome or paste the page's text. A waiting desktop
// input holds back new browser calls, so a stream of them cannot starve it.
type focusGate struct {
	mu      sync.Mutex
	readers int
	writer  bool
	waiting int
	changed chan struct{}
	// chromium remembers the pids found running a Chromium browser; see
	// chromiumProcess.
	chromium map[int]bool
}

// focusHeld marks a context whose call holds the gate; its value is true for
// the exclusive hold.
type focusHeld struct{}

// holdFocus takes the gate, shared for a browser call or exclusive for a
// desktop input. A context that already holds it exclusively takes nothing.
func (m *Manager) holdFocus(ctx context.Context, exclusive bool) (context.Context, func(), error) {
	if held, ok := ctx.Value(focusHeld{}).(bool); ok {
		if held || !exclusive {
			return ctx, func() {}, nil
		}
		return ctx, nil, errors.New("a call that holds the browser side of the focus gate cannot send desktop input")
	}
	g := &m.focus
	g.mu.Lock()
	if exclusive {
		g.waiting++
	}
	for {
		free := !g.writer && (exclusive && g.readers == 0 || !exclusive && g.waiting == 0)
		if free {
			if exclusive {
				g.waiting--
				g.writer = true
			} else {
				g.readers++
			}
			g.mu.Unlock()
			return context.WithValue(ctx, focusHeld{}, exclusive), func() { g.release(exclusive) }, nil
		}
		if g.changed == nil {
			g.changed = make(chan struct{})
		}
		changed := g.changed
		g.mu.Unlock()
		select {
		case <-changed:
			g.mu.Lock()
		case <-ctx.Done():
			g.mu.Lock()
			if exclusive {
				g.waiting--
				g.wake()
			}
			g.mu.Unlock()
			return ctx, nil, fmt.Errorf("COMPUTER_BUSY: desktop input and browser calls were taking turns until this call ended (%v): %w", ctx.Err(), errNotSent) //nolint:errorlint // the wait's end is detail; the call classifies as not sent only
		}
	}
}

// holdFocusedInput takes the gate for a desktop input that needs the front
// window or the clipboard. A browser action of unknown outcome may still bring
// Chrome forward or use the clipboard, so it refuses the input until that
// action settles.
func (m *Manager) holdFocusedInput(ctx context.Context) (context.Context, func(), error) {
	held := holdsFocus(ctx)
	ctx, release, err := m.holdFocus(ctx, true)
	if err != nil || held {
		return ctx, release, err
	}
	if unknown := m.browserActionUnknown(); unknown != "" {
		release()
		return ctx, nil, fmt.Errorf("COMPUTER_ACTION_UNKNOWN: an earlier browser action has no verified cleanup receipt, so input that needs the front window or the clipboard waits; %s: %w", unknown, errNotSent)
	}
	return ctx, release, nil
}

// holdBrowserFocus takes the gate for a browser call, which an unknown
// desktop input that needed the front window or the clipboard refuses.
func (m *Manager) holdBrowserFocus(ctx context.Context) (context.Context, func(), error) {
	ctx, release, err := m.holdFocus(ctx, false)
	if err != nil {
		return ctx, nil, err
	}
	if m.journal.blocksFocus() {
		release()
		return ctx, nil, fmt.Errorf("COMPUTER_ACTION_UNKNOWN: an earlier desktop input that needed the front window or the clipboard has no verified cleanup receipt; browser calls wait until its task ends; a restart alone does not clear it: %w", errNotSent)
	}
	return ctx, release, nil
}

// holdsFocus reports whether ctx holds the gate exclusively.
func holdsFocus(ctx context.Context) bool {
	held, _ := ctx.Value(focusHeld{}).(bool)
	return held
}

// chromiumProcess reports whether pid runs a Chromium browser other than the
// Computer's own browser, which only Cua drives. A pid found running one is
// not looked up again.
func (m *Manager) chromiumProcess(ctx context.Context, pid int) bool {
	m.mu.Lock()
	own := m.agentChromePID == pid
	m.mu.Unlock()
	if own {
		return false
	}
	m.focus.mu.Lock()
	known := m.focus.chromium[pid]
	m.focus.mu.Unlock()
	if known {
		return true
	}
	app, err := processCommand(ctx, pid)
	if err != nil {
		// Unknown counts as Chromium; an exited pid is not remembered.
		return true
	}
	chromium := strings.Contains(app, "Chrom") || strings.Contains(app, "Microsoft Edge") || strings.Contains(app, "Brave")
	if chromium {
		// Only Chromium is remembered: a reused pid then errs toward
		// waiting for browser calls, never toward running beside them.
		m.focus.mu.Lock()
		if m.focus.chromium == nil || len(m.focus.chromium) > 256 {
			m.focus.chromium = map[int]bool{}
		}
		m.focus.chromium[pid] = true
		m.focus.mu.Unlock()
	}
	return chromium
}

// processCommand returns the executable a macOS process runs; a test seam.
var processCommand = func(ctx context.Context, pid int) (string, error) {
	output, err := exec.CommandContext(ctx, "/bin/ps", "-o", "comm=", "-p", strconv.Itoa(pid)).Output()
	return string(output), err
}

func (g *focusGate) release(exclusive bool) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if exclusive {
		g.writer = false
	} else {
		g.readers--
	}
	g.wake()
}

// wake lets every waiter check the gate again. The caller holds g.mu.
func (g *focusGate) wake() {
	if g.changed != nil {
		close(g.changed)
		g.changed = nil
	}
}
