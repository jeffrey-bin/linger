package localtools

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"sync"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/mcpproxy"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/transport"
)

type toolServer struct {
	server    *http.Server
	url       string
	path      string
	tools     []tool
	identity  mcpproxy.OperationIdentity
	ctx       context.Context
	call      func(context.Context, string, json.RawMessage) (json.RawMessage, error)
	ready     chan struct{}
	readyOnce sync.Once
	slots     chan struct{}
}

func openToolServer(ctx context.Context, identity mcpproxy.OperationIdentity, tools []tool, call func(context.Context, string, json.RawMessage) (json.RawMessage, error)) (*toolServer, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	s := &toolServer{path: "/mcp/" + rand.Text(), tools: tools, identity: identity, ctx: ctx, call: call, ready: make(chan struct{}), slots: make(chan struct{}, 16)}
	s.url = "http://" + listener.Addr().String() + s.path
	s.server = &http.Server{Handler: http.HandlerFunc(s.handle), ReadHeaderTimeout: 5 * time.Second}
	go func() { _ = s.server.Serve(listener) }()
	return s, nil
}

func (s *toolServer) waitReady(ctx context.Context) error {
	select {
	case <-s.ready:
		return nil
	case <-ctx.Done():
		return context.Cause(ctx)
	case <-s.ctx.Done():
		return context.Cause(s.ctx)
	}
}

func (s *toolServer) handle(w http.ResponseWriter, r *http.Request) {
	if r.URL.EscapedPath() != s.path || r.Header.Get("Origin") != "" {
		http.Error(w, "Invalid local tool authority", http.StatusForbidden)
		return
	}
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	if s.ctx.Err() != nil {
		http.Error(w, "Operation is no longer active", http.StatusGone)
		return
	}
	select {
	case s.slots <- struct{}{}:
		defer func() { <-s.slots }()
	default:
		http.Error(w, "Too many local tool requests", http.StatusTooManyRequests)
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 1024*1024+1))
	if err != nil || len(body) > 1024*1024 {
		http.Error(w, "Invalid local tool request", http.StatusBadRequest)
		return
	}
	var request struct {
		JSONRPC string          `json:"jsonrpc"`
		ID      json.RawMessage `json:"id"`
		Method  string          `json:"method"`
		Params  json.RawMessage `json:"params"`
	}
	if json.Unmarshal(body, &request) != nil || request.JSONRPC != "2.0" {
		http.Error(w, "Invalid MCP envelope", http.StatusBadRequest)
		return
	}
	if len(request.ID) == 0 {
		w.WriteHeader(http.StatusAccepted)
		return
	}
	var result any
	switch request.Method {
	case "initialize":
		result = map[string]any{"protocolVersion": "2025-03-26", "capabilities": map[string]any{"tools": map[string]any{"listChanged": false}}, "serverInfo": map[string]string{"name": "linger-local-tools", "version": transport.ReleaseVersion}}
	case "ping":
		result = map[string]any{}
	case "tools/list":
		result = map[string]any{"tools": s.tools}
	case "tools/call":
		var params struct {
			Name      string          `json:"name"`
			Arguments json.RawMessage `json:"arguments"`
		}
		if json.Unmarshal(request.Params, &params) != nil {
			err = errors.New("Invalid local tool arguments")
			break
		}
		if len(params.Arguments) == 0 {
			params.Arguments = json.RawMessage(`{}`)
		}
		var argumentObject map[string]json.RawMessage
		if json.Unmarshal(params.Arguments, &argumentObject) != nil || argumentObject == nil {
			err = errors.New("Local tool arguments must be an object")
			break
		}
		known := false
		for _, t := range s.tools {
			if t.Name == params.Name {
				known = true
				break
			}
		}
		if !known {
			err = errors.New("Local tool is not authorized")
			break
		}
		if s.identity.BeforeToolCall != nil {
			err = s.identity.BeforeToolCall()
			if err != nil {
				break
			}
		}
		ctx, cancel := context.WithTimeout(s.ctx, 2*time.Minute)
		defer cancel()
		if s.identity.BeforeRequest != nil {
			err = s.identity.BeforeRequest(ctx)
			if err != nil {
				break
			}
		}
		result, err = s.call(ctx, params.Name, params.Arguments)
	default:
		err = errors.New("MCP method is unavailable")
	}
	if err != nil {
		result = toolError(err.Error())
	}
	encoded, encodeErr := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": request.ID, "result": result})
	if encodeErr != nil || len(encoded) > maxMCPBytes {
		http.Error(w, "Local tool output exceeds its limit", http.StatusBadGateway)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	if _, writeErr := w.Write(encoded); writeErr == nil && request.Method == "tools/list" && err == nil {
		s.readyOnce.Do(func() { close(s.ready) })
	}
}

func toolError(message string) json.RawMessage {
	data, _ := json.Marshal(map[string]any{"isError": true, "content": []any{map[string]string{"type": "text", "text": message}}})
	return data
}
