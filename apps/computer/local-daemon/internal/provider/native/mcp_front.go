package native

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"sync"
	"time"
)

const loopbackHeaderTimeout = 5 * time.Second

func freshToken(size int) (string, error) {
	buf := make([]byte, size)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

// residentMCPShape analyzes an MCP config for the resident front. The shape
// is the config with every server url blanked, in deterministic key order:
// a URL-only change keeps the shape, so a parked process needs no MCP
// reload. targets maps server names to their original URLs.
func residentMCPShape(config json.RawMessage) (shape string, targets map[string]string, eligible bool) {
	config = mcpNamespace(config)
	document, servers, ok := decodeMCPDocument(config)
	if !ok {
		return "", nil, false
	}
	targets = map[string]string{}
	for name, value := range servers {
		server, ok := value.(map[string]any)
		if !ok || server["type"] != "http" {
			return "", nil, false
		}
		target, ok := server["url"].(string)
		if !ok || target == "" {
			return "", nil, false
		}
		targets[name] = target
		server["url"] = ""
	}
	encoded, err := json.Marshal(document)
	if err != nil {
		return "", nil, false
	}
	return string(encoded), targets, true
}

// decodeMCPDocument decodes a config object, keeping numbers exact. A
// present mcpServers must be an object.
func decodeMCPDocument(config json.RawMessage) (map[string]any, map[string]any, bool) {
	decoder := json.NewDecoder(bytes.NewReader(config))
	decoder.UseNumber()
	var document map[string]any
	if decoder.Decode(&document) != nil || document == nil || decoder.More() {
		return nil, nil, false
	}
	raw, present := document["mcpServers"]
	if !present {
		return document, map[string]any{}, true
	}
	servers, ok := raw.(map[string]any)
	if !ok {
		return nil, nil, false
	}
	return document, servers, true
}

// mcpFront is the stable loopback reverse proxy of one resident process.
// The process's MCP config names the front; each Operation binds its own
// targets behind it. An unbound name answers 503, so a parked process can
// never reach a finished Operation's endpoint.
type mcpFront struct {
	server    *http.Server
	address   string
	prefix    string
	transport *http.Transport
	proxy     *httputil.ReverseProxy
	mu        sync.RWMutex
	targets   map[string]*url.URL
	closeOnce sync.Once
}

func newMCPFront() (*mcpFront, error) {
	token, err := freshToken(32)
	if err != nil {
		return nil, err
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	front := &mcpFront{
		address: listener.Addr().String(),
		prefix:  "/mcp/" + token + "/",
		transport: &http.Transport{
			Proxy:               nil,
			DialContext:         (&net.Dialer{Timeout: 30 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
			MaxIdleConnsPerHost: 4,
			IdleConnTimeout:     30 * time.Second,
		},
	}
	front.proxy = &httputil.ReverseProxy{
		Rewrite:       front.rewriteRequest,
		Transport:     front.transport,
		FlushInterval: -1,
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, _ error) {
			if r.Context().Err() != nil {
				return
			}
			http.Error(w, "MCP upstream is unavailable", http.StatusBadGateway)
		},
	}
	front.server = &http.Server{Handler: front, ReadHeaderTimeout: loopbackHeaderTimeout}
	go func() { _ = front.server.Serve(listener) }()
	return front, nil
}

// URL is the stable front address of one server name.
func (f *mcpFront) URL(name string) string {
	return "http://" + f.address + f.prefix + url.PathEscape(name)
}

// Rewrite returns config with every server url pointing at the front.
func (f *mcpFront) Rewrite(config json.RawMessage) (json.RawMessage, error) {
	document, servers, ok := decodeMCPDocument(config)
	if !ok {
		return nil, errors.New("MCP config is not eligible for the resident front")
	}
	for name, value := range servers {
		server, ok := value.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("MCP server %q is not an object", name)
		}
		server["url"] = f.URL(name)
	}
	return json.Marshal(document)
}

// Bind replaces the whole target map atomically. On error the previous
// binding stays.
func (f *mcpFront) Bind(targets map[string]string) error {
	parsed := make(map[string]*url.URL, len(targets))
	for name, raw := range targets {
		target, err := url.Parse(raw)
		if err != nil || (target.Scheme != "http" && target.Scheme != "https") || target.Host == "" {
			return fmt.Errorf("MCP server %q has an unusable url", name)
		}
		parsed[name] = target
	}
	f.mu.Lock()
	f.targets = parsed
	f.mu.Unlock()
	return nil
}

func (f *mcpFront) Unbind() {
	if f == nil {
		return
	}
	f.mu.Lock()
	f.targets = nil
	f.mu.Unlock()
}

func (f *mcpFront) Close() {
	if f == nil {
		return
	}
	f.closeOnce.Do(func() {
		f.Unbind()
		_ = f.server.Close()
		f.transport.CloseIdleConnections()
	})
}

func (f *mcpFront) target(r *http.Request) *url.URL {
	escaped, ok := strings.CutPrefix(r.URL.EscapedPath(), f.prefix)
	if !ok {
		return nil
	}
	name, err := url.PathUnescape(escaped)
	if err != nil {
		return nil
	}
	f.mu.RLock()
	defer f.mu.RUnlock()
	return f.targets[name]
}

type frontTargetKey struct{}

func (f *mcpFront) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	target := f.target(r)
	if target == nil {
		http.Error(w, "MCP route is unavailable", http.StatusServiceUnavailable)
		return
	}
	f.proxy.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), frontTargetKey{}, target)))
}

func (f *mcpFront) rewriteRequest(request *httputil.ProxyRequest) {
	target := request.In.Context().Value(frontTargetKey{}).(*url.URL)
	out := *target
	switch {
	case target.RawQuery != "" && request.In.URL.RawQuery != "":
		out.RawQuery = target.RawQuery + "&" + request.In.URL.RawQuery
	case request.In.URL.RawQuery != "":
		out.RawQuery = request.In.URL.RawQuery
	}
	request.Out.URL = &out
	request.Out.Host = target.Host
}
