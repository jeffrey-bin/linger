package localtools

import (
	"crypto/rand"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/mcpproxy"
)

// nativeCDPProxy admits browser messages only inside the host action receipt.
// It uses a private endpoint per Operation; runtimes never see Chrome's port.
type nativeCDPProxy struct {
	mu       sync.Mutex
	server   *http.Server
	base     string
	endpoint string
	prefix   string
	active   bool
	unknown  bool
	pending  int
	sockets  map[*websocket.Conn]bool
}

func openNativeCDPProxy(base string) (*nativeCDPProxy, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	p := &nativeCDPProxy{base: base, prefix: "/cdp/" + rand.Text(), sockets: map[*websocket.Conn]bool{}}
	p.endpoint = "http://" + listener.Addr().String() + p.prefix
	p.server = &http.Server{Handler: http.HandlerFunc(p.handle), ReadHeaderTimeout: 5 * time.Second}
	go func() { _ = p.server.Serve(listener) }()
	return p, nil
}

func (p *nativeCDPProxy) resume() { p.mu.Lock(); p.active = true; p.mu.Unlock() }

var cdpDrainTimeout = 10 * time.Second

func (p *nativeCDPProxy) pause() bool {
	p.mu.Lock()
	p.active = false
	p.mu.Unlock()
	// Replies normally drain within milliseconds. A busy Computer can take
	// seconds after Chrome starts; an undrained command is an unknown outcome.
	deadline := time.Now().Add(cdpDrainTimeout)
	for {
		p.mu.Lock()
		pending, unknown := p.pending, p.unknown
		p.mu.Unlock()
		if pending == 0 && !unknown {
			return true
		}
		if unknown || time.Now().After(deadline) {
			slog.Warn("browser action did not drain", "pending_commands", pending, "connection_lost", unknown)
			return false
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func cdpSetupCommand(method string) bool {
	switch method {
	case "Runtime.runIfWaitingForDebugger", "Emulation.setUserAgentOverride", "Target.setAutoAttach", "Page.getFrameTree", "Page.setLifecycleEventsEnabled":
		return true
	}
	return strings.HasSuffix(method, ".enable")
}

func (p *nativeCDPProxy) close() error {
	clean := p.pause()
	err := p.server.Close()
	p.mu.Lock()
	for socket := range p.sockets {
		_ = socket.Close()
	}
	p.mu.Unlock()
	if !clean {
		return errors.Join(err, mcpproxy.ErrCleanupUnconfirmed)
	}
	return err
}

func (p *nativeCDPProxy) handle(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("Origin") != "" || !strings.HasPrefix(r.URL.EscapedPath(), p.prefix+"/") {
		http.Error(w, "Invalid browser authority", http.StatusForbidden)
		return
	}
	p.mu.Lock()
	active := p.active && !p.unknown
	p.mu.Unlock()
	if !active {
		http.Error(w, "Browser action is not active", http.StatusConflict)
		return
	}
	suffix := strings.TrimPrefix(r.URL.Path, p.prefix)
	if websocket.IsWebSocketUpgrade(r) {
		if !strings.HasPrefix(suffix, "/devtools/") {
			http.NotFound(w, r)
			return
		}
		p.socket(w, r, suffix)
		return
	}
	if r.Method != http.MethodGet || (suffix != "/json/version" && suffix != "/json/version/" && suffix != "/json/list" && suffix != "/json") {
		http.NotFound(w, r)
		return
	}
	request, _ := http.NewRequestWithContext(r.Context(), http.MethodGet, p.base+suffix, nil)
	response, err := (&http.Client{Timeout: 5 * time.Second}).Do(request)
	if err != nil {
		http.Error(w, "Chrome unavailable", http.StatusServiceUnavailable)
		return
	}
	defer response.Body.Close()
	var result any
	if response.StatusCode != http.StatusOK || json.NewDecoder(io.LimitReader(response.Body, 1024*1024)).Decode(&result) != nil {
		http.Error(w, "Chrome unavailable", http.StatusBadGateway)
		return
	}
	var rewrite func(any)
	rewrite = func(value any) {
		switch v := value.(type) {
		case map[string]any:
			for key, item := range v {
				if key == "webSocketDebuggerUrl" {
					raw, _ := item.(string)
					parsed, err := url.Parse(raw)
					if err == nil {
						v[key] = "ws" + strings.TrimPrefix(p.endpoint, "http") + parsed.EscapedPath()
					}
				} else {
					rewrite(item)
				}
			}
		case []any:
			for _, item := range v {
				rewrite(item)
			}
		}
	}
	rewrite(result)
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(result)
}

func (p *nativeCDPProxy) socket(w http.ResponseWriter, r *http.Request, suffix string) {
	upstream, _, err := websocket.DefaultDialer.DialContext(r.Context(), "ws"+strings.TrimPrefix(p.base, "http")+suffix, nil) //nolint:bodyclose // gorilla/websocket documents that the handshake response body needs no Close
	if err != nil {
		http.Error(w, "Chrome unavailable", http.StatusServiceUnavailable)
		return
	}
	client, err := (&websocket.Upgrader{CheckOrigin: func(r *http.Request) bool { return r.Header.Get("Origin") == "" }}).Upgrade(w, r, nil)
	if err != nil {
		_ = upstream.Close()
		return
	}
	client.SetReadLimit(4 * 1024 * 1024)
	upstream.SetReadLimit(maxMCPBytes)
	p.mu.Lock()
	p.sockets[client] = true
	p.sockets[upstream] = true
	p.mu.Unlock()
	var localMu sync.Mutex
	pending := map[uint64]bool{}
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			kind, data, err := client.ReadMessage()
			if err != nil {
				return
			}
			var message struct {
				ID     uint64 `json:"id"`
				Method string `json:"method"`
			}
			if json.Unmarshal(data, &message) != nil || message.ID == 0 || message.Method == "" {
				return
			}
			p.mu.Lock()
			if !p.active || p.unknown {
				p.mu.Unlock()
				return
			}
			localMu.Lock()
			if pending[message.ID] {
				localMu.Unlock()
				p.mu.Unlock()
				return
			}
			// Target setup has no user-visible effect. Chrome may never answer
			// it for a worker it keeps paused, and Playwright does not wait.
			if !cdpSetupCommand(message.Method) {
				pending[message.ID] = true
				p.pending++
			}
			localMu.Unlock()
			p.mu.Unlock()
			if upstream.WriteMessage(kind, data) != nil {
				return
			}
		}
	}()
	go func() { <-done; _ = upstream.Close() }()
	for {
		kind, data, err := upstream.ReadMessage()
		if err != nil {
			break
		}
		var message struct {
			ID uint64 `json:"id"`
		}
		_ = json.Unmarshal(data, &message)
		if message.ID != 0 {
			p.mu.Lock()
			localMu.Lock()
			if pending[message.ID] {
				delete(pending, message.ID)
				p.pending--
			}
			localMu.Unlock()
			p.mu.Unlock()
		}
		if client.WriteMessage(kind, data) != nil {
			break
		}
	}
	_ = client.Close()
	_ = upstream.Close()
	<-done
	p.mu.Lock()
	localMu.Lock()
	if len(pending) > 0 {
		p.unknown = true
	}
	localMu.Unlock()
	delete(p.sockets, client)
	delete(p.sockets, upstream)
	p.mu.Unlock()
}
