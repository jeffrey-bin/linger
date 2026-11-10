package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"slices"
	"sync"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/localtools"
)

// desktopStatusInterval is how often a Desktop-owned Daemon checks its state.
const desktopStatusInterval = 500 * time.Millisecond

// desktopPermissionTimeout bounds one permission request to the Desktop app.
const desktopPermissionTimeout = 10 * time.Second

// desktopPermissionsFeature is the hello feature of a Desktop app that
// answers permission requests.
const desktopPermissionsFeature = "permissions.v1"

// desktopStatus is one JSON line a Desktop-owned Daemon writes to stdout.
type desktopStatus struct {
	Type             string `json:"type"`
	GatewayState     string `json:"gateway_state"`
	ActiveOperations int    `json:"active_operations"`
}

type desktopStatusSource interface {
	GatewayState() string
	ActiveOperationCount() int
}

// desktopPermissionRequest asks the Desktop app about its own permissions.
type desktopPermissionRequest struct {
	Type       string `json:"type"`
	ID         string `json:"id"`
	Op         string `json:"op"`
	Permission string `json:"permission,omitempty"`
}

// desktopLine is any line the Desktop app writes to the Daemon's stdin.
type desktopLine struct {
	Type        string                        `json:"type"`
	Features    []string                      `json:"features"`
	ID          string                        `json:"id"`
	OK          bool                          `json:"ok"`
	Permissions []localtools.LingerPermission `json:"permissions"`
	Error       string                        `json:"error"`
}

// desktopChannel is the stdio channel to the Desktop app that runs this
// Daemon. Every stdout line goes through one locked encoder, so status lines
// and permission requests never interleave within a line.
type desktopChannel struct {
	writeMu sync.Mutex
	encoder *json.Encoder
	timeout time.Duration

	mu sync.Mutex
	// permissions is set once the app's hello announced permission requests;
	// an app without it never answers them.
	permissions bool
	closed      bool
	pending     map[string]chan desktopLine
}

func newDesktopChannel(stdout io.Writer) *desktopChannel {
	return &desktopChannel{encoder: json.NewEncoder(stdout), timeout: desktopPermissionTimeout, pending: map[string]chan desktopLine{}}
}

// encode writes one JSON line to the Desktop app.
func (c *desktopChannel) encode(value any) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	return c.encoder.Encode(value)
}

// read handles the Desktop app's stdin lines until EOF, then calls shutdown:
// the app closes the Daemon's stdin when it stops it, and the pipe closes
// when the app exits without stopping it.
func (c *desktopChannel) read(stdin io.Reader, shutdown func()) {
	lines := bufio.NewScanner(stdin)
	lines.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for lines.Scan() {
		var line desktopLine
		if err := json.Unmarshal(lines.Bytes(), &line); err != nil {
			slog.Warn("desktop.stdin_invalid_line", "error", err)
			continue
		}
		c.receive(line)
	}
	if err := lines.Err(); err != nil {
		slog.Warn("desktop.stdin_read_failed", "error", err)
		// An overlong line stops the scanner, but only EOF means the app is
		// gone.
		_, _ = io.Copy(io.Discard, stdin)
	}
	c.mu.Lock()
	c.closed = true
	for id, reply := range c.pending {
		close(reply)
		delete(c.pending, id)
	}
	c.mu.Unlock()
	shutdown()
}

func (c *desktopChannel) receive(line desktopLine) {
	c.mu.Lock()
	defer c.mu.Unlock()
	switch line.Type {
	case "hello":
		c.permissions = slices.Contains(line.Features, desktopPermissionsFeature)
	case "permission.response":
		// A response after its request timed out has no waiter.
		if reply, ok := c.pending[line.ID]; ok {
			delete(c.pending, line.ID)
			reply <- line
		}
	}
}

// LingerPermissions sends one permission request to the Desktop app and
// waits for its answer.
func (c *desktopChannel) LingerPermissions(ctx context.Context, op, permission string) ([]localtools.LingerPermission, error) {
	id := rand.Text()
	reply := make(chan desktopLine, 1)
	c.mu.Lock()
	if !c.permissions || c.closed {
		c.mu.Unlock()
		return nil, localtools.ErrLingerBridgeUnavailable
	}
	c.pending[id] = reply
	c.mu.Unlock()
	forget := func() {
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
	}
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()
	if err := c.encode(desktopPermissionRequest{Type: "permission.request", ID: id, Op: op, Permission: permission}); err != nil {
		forget()
		return nil, fmt.Errorf("write Desktop permission request: %w", err)
	}
	select {
	case line, ok := <-reply:
		switch {
		case !ok:
			return nil, errors.New("the Desktop app closed the Daemon's stdin")
		case !line.OK:
			return nil, &localtools.LingerBridgeError{Code: line.Error}
		}
		return line.Permissions, nil
	case <-ctx.Done():
		forget()
		return nil, ctx.Err()
	}
}

// reportDesktopStatus writes the Daemon state when it changes until ctx ends.
// Logs go to stderr, so stdout carries only Desktop channel lines.
func reportDesktopStatus(ctx context.Context, encode func(any) error, source desktopStatusSource, interval time.Duration) {
	var last *desktopStatus
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		current := desktopStatus{Type: "status", GatewayState: source.GatewayState(), ActiveOperations: source.ActiveOperationCount()}
		if last == nil || current != *last {
			if encode(current) != nil {
				return
			}
			last = &current
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}
