// Package localtools binds trusted local desktop tools to the existing
// Operation lifecycle. It is a tool transport, not a Runtime executor.
package localtools

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"sync"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/mcpproxy"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/transport"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/process"
)

const maxMCPBytes = 24 * 1024 * 1024

var errOutcomeUnknown = errors.New("local tool outcome is unknown")

type rpcReply struct {
	ID     uint64          `json:"id"`
	Result json.RawMessage `json:"result"`
	Error  json.RawMessage `json:"error"`
}

type mcpClient struct {
	mu        sync.Mutex
	next      uint64
	pending   map[uint64]chan rpcReply
	stdin     io.WriteCloser
	stdout    io.ReadCloser
	writeSlot chan struct{}
	done      chan struct{}
	exited    chan struct{}
	stop      context.CancelFunc
	closeOnce sync.Once
	err       error
}

func startClient(ctx context.Context, command string, args []string, cwd string, env []string) (*mcpClient, error) {
	return startClientWith(ctx, process.Run, command, args, cwd, env)
}

// startClientWith owns the child through run; the user's Chrome relay owns
// only its direct child, so a Chrome it starts outlives the task.
func startClientWith(ctx context.Context, run func(context.Context, *exec.Cmd, time.Duration) error, command string, args []string, cwd string, env []string) (*mcpClient, error) {
	processCtx, stop := context.WithCancel(context.Background())
	cmd := exec.Command(command, args...)
	cmd.Dir, cmd.Env = cwd, env
	stdin, err := cmd.StdinPipe()
	if err != nil {
		stop()
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		stop()
		_ = stdin.Close()
		return nil, err
	}
	// Tool stderr can contain private URLs, headers, and application contents.
	// Diagnostics report the executable identity and protocol failure instead.
	cmd.Stderr = io.Discard
	c := &mcpClient{pending: map[uint64]chan rpcReply{}, stdin: stdin, stdout: stdout,
		writeSlot: make(chan struct{}, 1), done: make(chan struct{}), exited: make(chan struct{}), stop: stop}
	go c.read()
	go func() {
		err := run(processCtx, cmd, time.Second)
		c.mu.Lock()
		c.err = err
		c.mu.Unlock()
		_ = stdin.Close()
		_ = stdout.Close()
		close(c.exited)
	}()
	initialized, err := c.request(ctx, "initialize", map[string]any{
		"protocolVersion": "2025-03-26", "capabilities": map[string]any{},
		"clientInfo": map[string]string{"name": "linger-computer", "version": transport.ReleaseVersion},
	})
	if err == nil {
		var result struct {
			ProtocolVersion string          `json:"protocolVersion"`
			Capabilities    json.RawMessage `json:"capabilities"`
		}
		if json.Unmarshal(initialized, &result) != nil || result.ProtocolVersion == "" || len(result.Capabilities) == 0 {
			err = errors.New("invalid local MCP initialization")
		}
	}
	if err == nil {
		err = c.notify(ctx, "notifications/initialized", nil)
	}
	if err != nil {
		// The caller must retain the original child when cleanup is unknown,
		// including failures before an MCP initialization receipt exists.
		if cleanupErr := c.close(); cleanupErr != nil {
			return c, errors.Join(err, cleanupErr)
		}
		return nil, err
	}
	return c, nil
}

func (c *mcpClient) read() {
	defer close(c.done)
	scanner := bufio.NewScanner(c.stdout)
	scanner.Buffer(make([]byte, 64*1024), maxMCPBytes)
	for scanner.Scan() {
		var envelope struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
		}
		if json.Unmarshal(scanner.Bytes(), &envelope) != nil {
			return
		}
		if envelope.Method != "" {
			// Server requests cannot grant permissions or select another root.
			if len(envelope.ID) > 0 {
				response, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": envelope.ID, "error": map[string]any{"code": -32601, "message": "Client request is unavailable"}})
				go func() {
					ctx, cancel := context.WithTimeout(context.Background(), time.Second)
					defer cancel()
					_ = c.write(ctx, response)
				}()
			}
			continue
		}
		var response rpcReply
		if json.Unmarshal(scanner.Bytes(), &response) != nil || response.ID == 0 {
			return
		}
		c.mu.Lock()
		reply := c.pending[response.ID]
		delete(c.pending, response.ID)
		c.mu.Unlock()
		if reply != nil {
			reply <- response
		}
	}
}

func (c *mcpClient) write(ctx context.Context, data []byte) error {
	if len(data) > 1024*1024 {
		return errors.New("local MCP request is too large")
	}
	select {
	case c.writeSlot <- struct{}{}:
	case <-ctx.Done():
		return context.Cause(ctx)
	case <-c.done:
		return io.ErrClosedPipe
	}
	defer func() { <-c.writeSlot }()
	if err := ctx.Err(); err != nil {
		return context.Cause(ctx)
	}
	finished := make(chan error, 1)
	go func() { _, err := c.stdin.Write(append(data, '\n')); finished <- err }()
	select {
	case err := <-finished:
		return err
	case <-ctx.Done():
		c.stop()
		return errors.Join(errOutcomeUnknown, context.Cause(ctx))
	case <-c.done:
		return errors.Join(errOutcomeUnknown, io.ErrClosedPipe)
	}
}

func (c *mcpClient) request(ctx context.Context, method string, params any) (json.RawMessage, error) {
	if err := ctx.Err(); err != nil {
		return nil, context.Cause(ctx)
	}
	c.mu.Lock()
	c.next++
	id := c.next
	reply := make(chan rpcReply, 1)
	c.pending[id] = reply
	c.mu.Unlock()
	data, err := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": params})
	if err == nil {
		err = c.write(ctx, data)
	}
	if err != nil {
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
		return nil, err
	}
	select {
	case response := <-reply:
		if len(response.Error) > 0 && string(response.Error) != "null" {
			if method == "tools/call" {
				return nil, errors.Join(errOutcomeUnknown, errors.New("local MCP server failed without a tool completion receipt"))
			}
			return nil, errors.New("local MCP server rejected the request")
		}
		if len(response.Result) == 0 {
			return nil, errors.Join(errOutcomeUnknown, errors.New("missing local MCP response"))
		}
		return response.Result, nil
	case <-ctx.Done():
		return nil, errors.Join(errOutcomeUnknown, context.Cause(ctx))
	case <-c.done:
		select {
		case response := <-reply:
			if len(response.Result) > 0 {
				return response.Result, nil
			}
		default:
		}
		return nil, errors.Join(errOutcomeUnknown, io.ErrUnexpectedEOF)
	}
}

// closed reports whether the child's output has ended.
func (c *mcpClient) closed() bool {
	select {
	case <-c.done:
		return true
	default:
		return false
	}
}

func (c *mcpClient) notify(ctx context.Context, method string, params any) error {
	data, err := json.Marshal(map[string]any{"jsonrpc": "2.0", "method": method, "params": params})
	if err != nil {
		return err
	}
	return c.write(ctx, data)
}

func (c *mcpClient) close() error {
	if c == nil {
		return nil
	}
	c.closeOnce.Do(func() { _ = c.stdin.Close(); c.stop() })
	select {
	case <-c.exited:
		c.mu.Lock()
		defer c.mu.Unlock()
		if c.err != nil && !errors.Is(c.err, context.Canceled) {
			return errors.Join(mcpproxy.ErrCleanupUnconfirmed, fmt.Errorf("local MCP child cleanup failed: %w", c.err))
		}
		return nil
	case <-time.After(10 * time.Second):
		return errors.Join(mcpproxy.ErrCleanupUnconfirmed, errors.New("local MCP child did not stop"))
	}
}

type tool struct {
	Name        string          `json:"name"`
	Description string          `json:"description,omitempty"`
	InputSchema json.RawMessage `json:"inputSchema"`
	Annotations json.RawMessage `json:"annotations,omitempty"`
}

func (c *mcpClient) tools(ctx context.Context) ([]tool, error) {
	var tools []tool
	cursor := ""
	seen := map[string]bool{}
	for page := 0; page < 8; page++ {
		params := map[string]string{}
		if cursor != "" {
			params["cursor"] = cursor
		}
		data, err := c.request(ctx, "tools/list", params)
		if err != nil {
			return nil, err
		}
		var result struct {
			Tools []tool `json:"tools"`
			Next  string `json:"nextCursor"`
		}
		if json.Unmarshal(data, &result) != nil {
			return nil, errors.New("invalid local tool catalog")
		}
		for _, item := range result.Tools {
			if item.Name == "" || seen[item.Name] || !json.Valid(item.InputSchema) {
				return nil, errors.New("invalid or duplicate local tool")
			}
			seen[item.Name] = true
			tools = append(tools, item)
		}
		if result.Next == "" {
			return tools, nil
		}
		if result.Next == cursor {
			return nil, errors.New("local tool catalog cursor repeated")
		}
		cursor = result.Next
	}
	return nil, errors.New("local tool catalog has too many pages")
}
