package mcpproxy

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

const (
	maxBodyBytes      = 1024 * 1024
	requestTimeout    = 30 * time.Second
	reconnectGrace    = 10 * time.Minute
	maxActiveRequests = 16
)

type Descriptor struct {
	Name       string    `json:"name"`
	RelayURL   string    `json:"relay_url"`
	RelayToken string    `json:"relay_token"`
	ToolNames  []string  `json:"tool_names"`
	ExpiresAt  time.Time `json:"expires_at"`
}

type OperationIdentity struct {
	OperationID      string
	ExecutionLeaseID string
	RuntimeType      string
	BeforeRequest    func(context.Context) error
	BeforeToolCall   func() error
}

type Set struct {
	proxies []*proxy
	local   []LocalBinding
	config  json.RawMessage
	once    sync.Once
	err     error
}

func Open(ctx context.Context, encoded json.RawMessage, operation OperationIdentity) (*Set, error) {
	if operation.OperationID == "" || operation.ExecutionLeaseID == "" {
		return nil, errors.New("Local MCP proxy Operation identity is incomplete")
	}
	var descriptors []Descriptor
	if len(encoded) == 0 {
		encoded = json.RawMessage(`[]`)
	}
	if err := json.Unmarshal(encoded, &descriptors); err != nil {
		return nil, fmt.Errorf("decode Local MCP Relay descriptors: %w", err)
	}
	names := make(map[string]bool, len(descriptors))
	set := &Set{proxies: make([]*proxy, 0, len(descriptors))}
	servers := make(map[string]any, len(descriptors))
	for _, descriptor := range descriptors {
		if names[descriptor.Name] {
			_ = set.Close()
			return nil, fmt.Errorf("Local MCP proxy name is duplicated: %s", descriptor.Name)
		}
		names[descriptor.Name] = true
		item, err := openProxy(ctx, descriptor, operation)
		if err != nil {
			_ = set.Close()
			return nil, err
		}
		set.proxies = append(set.proxies, item)
		server := map[string]any{"type": "http", "url": item.localURL}
		if operation.RuntimeType == "codex" {
			// Codex must allow the recovery wait plus one bounded upstream exchange.
			server["tool_timeout_sec"] = int((reconnectGrace + requestTimeout) / time.Second)
		}
		servers[descriptor.Name] = server
	}
	config, err := json.Marshal(map[string]any{"mcpServers": servers})
	if err != nil {
		_ = set.Close()
		return nil, err
	}
	set.config = config
	return set, nil
}

func (s *Set) Config() json.RawMessage {
	if s == nil {
		return nil
	}
	return append(json.RawMessage(nil), s.config...)
}

func (s *Set) Close() error {
	if s == nil {
		return nil
	}
	s.once.Do(func() {
		var closeErrors []error
		for _, binding := range s.local {
			if err := binding.Close(); err != nil {
				closeErrors = append(closeErrors, err)
			}
		}
		for _, item := range s.proxies {
			if err := item.close(); err != nil {
				closeErrors = append(closeErrors, err)
			}
		}
		s.err = errors.Join(closeErrors...)
	})
	return s.err
}

type proxy struct {
	descriptor Descriptor
	operation  OperationIdentity
	upstream   *url.URL
	client     *http.Client
	server     *http.Server
	listener   net.Listener
	localURL   string
	localPath  string
	ctx        context.Context
	cancel     context.CancelFunc
	slots      chan struct{}
	catalog    *catalogState
}

func openProxy(ctx context.Context, descriptor Descriptor, operation OperationIdentity) (*proxy, error) {
	upstream, err := validateDescriptor(descriptor, time.Now())
	if err != nil {
		return nil, err
	}
	proxyCtx, cancel := context.WithCancel(ctx)
	item := &proxy{
		descriptor: descriptor, operation: operation, upstream: upstream,
		client: &http.Client{
			Timeout:       requestTimeout,
			CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("Local MCP redirect is forbidden") },
		},
		ctx: proxyCtx, cancel: cancel, slots: make(chan struct{}, maxActiveRequests),
		catalog: newCatalogState(),
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		cancel()
		return nil, err
	}
	item.listener = listener
	// Bind the path as well as the port: an old URL must not acquire the next
	// operation's authority if the OS eventually reuses an ephemeral port.
	item.localPath = "/mcp/" + url.PathEscape(operation.OperationID) + "/" + url.PathEscape(operation.ExecutionLeaseID)
	item.localURL = "http://" + listener.Addr().String() + item.localPath
	item.server = &http.Server{
		Handler: http.HandlerFunc(item.handle), ReadHeaderTimeout: 2 * time.Second,
	}
	go func() { _ = item.server.Serve(listener) }()
	return item, nil
}

func (p *proxy) close() error {
	p.cancel()
	err := p.server.Close()
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}

func (p *proxy) handle(writer http.ResponseWriter, request *http.Request) {
	if request.URL.EscapedPath() != p.localPath {
		writer.WriteHeader(http.StatusNotFound)
		return
	}
	if request.Method != http.MethodGet && request.Method != http.MethodPost && request.Method != http.MethodDelete {
		writer.Header().Set("Allow", "GET, POST, DELETE")
		writer.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	if request.Method == http.MethodPost && mediaType(request.Header.Get("Content-Type")) != "application/json" {
		writer.WriteHeader(http.StatusUnsupportedMediaType)
		return
	}
	select {
	case p.slots <- struct{}{}:
		defer func() { <-p.slots }()
	default:
		writer.WriteHeader(http.StatusServiceUnavailable)
		return
	}
	requestDone := make(chan struct{})
	go func() {
		select {
		case <-p.ctx.Done():
			_ = request.Body.Close()
		case <-requestDone:
		}
	}()
	defer close(requestDone)
	body, err := readBody(request)
	if err != nil {
		if errors.Is(err, errBodyLimit) {
			writer.WriteHeader(http.StatusRequestEntityTooLarge)
		} else {
			writer.WriteHeader(http.StatusBadGateway)
		}
		return
	}
	rpc := parseRPCRequest(body)
	var observed *catalogWriter
	if request.Method == http.MethodPost && rpc.startsCatalog() {
		observed = &catalogWriter{ResponseWriter: writer}
		writer = observed
		defer func() {
			p.observeCatalog(rpc, observed.status, mediaType(observed.Header().Get("Content-Type")),
				observed.body.Bytes(), !observed.body.overflow && !observed.interrupted)
		}()
	}
	if p.operation.BeforeToolCall != nil && request.Method == http.MethodPost && rpc.Method == "tools/call" {
		if err := p.operation.BeforeToolCall(); err != nil {
			writer.WriteHeader(http.StatusServiceUnavailable)
			return
		}
	}
	deadline := time.Now().Add(reconnectGrace)
	if p.descriptor.ExpiresAt.Before(deadline) {
		deadline = p.descriptor.ExpiresAt
	}
	upstreamCtx, cancel := context.WithDeadline(p.ctx, deadline)
	defer cancel()
	stopClientCancellation := context.AfterFunc(request.Context(), cancel)
	defer stopClientCancellation()
	// Wait before dispatch, or retry only an explicit relay proof that nothing
	// reached the upstream. A broken HTTP exchange may already have written data.
	var response *http.Response
	for {
		if p.operation.BeforeRequest != nil {
			if err := p.operation.BeforeRequest(upstreamCtx); err != nil {
				writer.WriteHeader(http.StatusServiceUnavailable)
				return
			}
		}
		upstream, err := http.NewRequestWithContext(upstreamCtx, request.Method, p.upstream.String(), bytes.NewReader(body))
		if err != nil {
			writer.WriteHeader(http.StatusBadGateway)
			return
		}
		copyHeaders(upstream.Header, request.Header)
		upstream.Header.Set("Authorization", "Bearer "+p.descriptor.RelayToken)
		upstream.Header.Set("X-Linger-Operation-Id", p.operation.OperationID)
		upstream.Header.Set("X-Linger-Execution-Lease-Id", p.operation.ExecutionLeaseID)
		response, err = p.client.Do(upstream)
		if err != nil {
			writer.WriteHeader(http.StatusBadGateway)
			return
		}
		if response.StatusCode != http.StatusServiceUnavailable || response.Header.Get("X-Linger-Relay-Not-Dispatched") != "1" {
			break
		}
		_ = response.Body.Close()
		select {
		case <-upstreamCtx.Done():
			writer.WriteHeader(http.StatusServiceUnavailable)
			return
		case <-time.After(100 * time.Millisecond):
		}
	}
	defer response.Body.Close()
	copyHeaders(writer.Header(), response.Header)
	writer.WriteHeader(response.StatusCode)
	var downstream io.Writer = writer
	if mediaType(response.Header.Get("Content-Type")) == "text/event-stream" {
		// A subscription may stay open after a small acknowledgement. Deliver
		// headers and each chunk without waiting for the HTTP buffer or EOF.
		if err := http.NewResponseController(writer).Flush(); err != nil {
			if observed != nil {
				observed.interrupted = true
			}
			return
		}
		downstream = sseResponseWriter{writer}
	}
	if _, err := io.Copy(downstream, response.Body); err != nil && observed != nil {
		observed.interrupted = true
	}
}

type sseResponseWriter struct {
	http.ResponseWriter
}

func (w sseResponseWriter) Write(content []byte) (int, error) {
	n, err := w.ResponseWriter.Write(content)
	if err == nil {
		err = http.NewResponseController(w.ResponseWriter).Flush()
	}
	return n, err
}

var errBodyLimit = errors.New("Local MCP request body exceeds one MiB")

func readBody(request *http.Request) ([]byte, error) {
	if request.Method == http.MethodGet {
		return nil, nil
	}
	if request.ContentLength > maxBodyBytes {
		return nil, errBodyLimit
	}
	reader := io.LimitReader(request.Body, maxBodyBytes+1)
	content, err := io.ReadAll(reader)
	if err != nil {
		return nil, err
	}
	if len(content) > maxBodyBytes {
		return nil, errBodyLimit
	}
	return content, nil
}

func validateDescriptor(descriptor Descriptor, now time.Time) (*url.URL, error) {
	upstream, err := url.Parse(descriptor.RelayURL)
	if err != nil || (upstream.Scheme != "http" && upstream.Scheme != "https") || upstream.Host == "" ||
		upstream.User != nil || upstream.Fragment != "" || descriptor.Name == "" || len(descriptor.RelayToken) < 32 ||
		!descriptor.ExpiresAt.After(now) {
		return nil, errors.New("Local MCP Relay descriptor is invalid or expired")
	}
	return upstream, nil
}

func mediaType(value string) string {
	if index := strings.IndexByte(value, ';'); index >= 0 {
		value = value[:index]
	}
	return strings.ToLower(strings.TrimSpace(value))
}

func copyHeaders(target, source http.Header) {
	for name, values := range source {
		lower := strings.ToLower(name)
		if lower == "x-linger-relay-not-dispatched" || lower == "host" || lower == "authorization" || lower == "content-length" ||
			lower == "cookie" || lower == "set-cookie" || lower == "forwarded" || lower == "via" ||
			strings.HasPrefix(lower, "x-forwarded-") || isHopByHopHeader(lower) {
			continue
		}
		for _, value := range values {
			target.Add(name, value)
		}
	}
}

func isHopByHopHeader(name string) bool {
	switch name {
	case "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade":
		return true
	default:
		return false
	}
}
