package mcpproxy

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
)

// catalogState records the first terminal outcome of the Provider's own MCP
// startup through this Operation-bound endpoint. The endpoint path is the
// generation: a previous lease's proxy is closed and cannot resolve this one.
type catalogState struct {
	once sync.Once
	done chan struct{}
	err  error
}

func newCatalogState() *catalogState { return &catalogState{done: make(chan struct{})} }

func (s *catalogState) finish(err error) {
	s.once.Do(func() {
		s.err = err
		close(s.done)
	})
}

// WaitReady returns after every proxied server has returned an installable
// tools/list catalog to the Provider. Servers are awaited together so the first
// settled failure is reported even while another server is still pending.
func (s *Set) WaitReady(ctx context.Context) error {
	if s == nil {
		return nil
	}
	listed := s.proxies
	if len(listed)+len(s.local) == 0 {
		return nil
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	results := make(chan error, len(listed)+len(s.local))
	for _, binding := range s.local {
		go func() { results <- binding.WaitReady(ctx) }()
	}
	for _, item := range listed {
		go func() {
			select {
			case <-item.catalog.done:
				if item.catalog.err != nil {
					results <- fmt.Errorf("Local MCP %s: %w", item.descriptor.Name, item.catalog.err)
				} else {
					results <- nil
				}
			case <-ctx.Done():
				results <- context.Cause(ctx)
			}
		}()
	}
	for range len(listed) + len(s.local) {
		if err := <-results; err != nil {
			return err
		}
	}
	return nil
}

type rpcRequest struct {
	ID     json.RawMessage `json:"id"`
	Method string          `json:"method"`
}

func parseRPCRequest(body []byte) rpcRequest {
	var request rpcRequest
	_ = json.Unmarshal(body, &request)
	return request
}

func (r rpcRequest) startsCatalog() bool {
	return len(r.ID) > 0 && (r.Method == "initialize" || r.Method == "tools/list")
}

func (p *proxy) observeCatalog(request rpcRequest, status int, contentType string, body []byte, complete bool) {
	if status < 200 || status > 299 {
		p.catalog.finish(fmt.Errorf("%s returned HTTP %d", request.Method, status))
		return
	}
	if !complete {
		return // An oversized or interrupted reply cannot prove the catalog.
	}
	frames := [][]byte{body}
	if contentType == "text/event-stream" {
		frames = nil
		for _, line := range strings.Split(string(body), "\n") {
			if data, ok := strings.CutPrefix(line, "data:"); ok {
				frames = append(frames, []byte(strings.TrimSpace(data)))
			}
		}
	}
	for _, frame := range frames {
		response, ok := decodeSerdeStruct(frame)
		if !ok || !sameRPCID(response["id"], request.ID) {
			continue
		}
		switch {
		case response["error"] != nil && !isJSONNull(response["error"]):
			p.catalog.finish(fmt.Errorf("%s returned a JSON-RPC error", request.Method))
		case !response.required("jsonrpc", isJSONStringIn("2.0")):
			p.catalog.finish(fmt.Errorf("%s returned an invalid JSON-RPC envelope", request.Method))
		case request.Method != "tools/list":
		case !response.required("result", installableToolCatalog):
			// Codex rejects the whole server when any listed tool fails to decode.
			p.catalog.finish(fmt.Errorf("tools/list returned a catalog Codex cannot install"))
		default:
			// Codex 0.155.1 installs the first page and never follows nextCursor.
			p.catalog.finish(nil)
		}
		return
	}
}

func sameRPCID(left, right json.RawMessage) bool {
	var a, b bytes.Buffer
	return json.Compact(&a, left) == nil && json.Compact(&b, right) == nil && bytes.Equal(a.Bytes(), b.Bytes())
}

// catalogWriter records what the Provider actually received for one catalog
// request, including local failures written before any upstream dispatch.
type catalogWriter struct {
	http.ResponseWriter
	status      int
	body        cappedBuffer
	interrupted bool
}

// Preserve ResponseController operations through the catalog observer, while
// writes still pass through Write so readiness observes the delivered reply.
func (w *catalogWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

func (w *catalogWriter) WriteHeader(status int) {
	if w.status == 0 {
		w.status = status
	}
	w.ResponseWriter.WriteHeader(status)
}

func (w *catalogWriter) Write(content []byte) (int, error) {
	if w.status == 0 {
		w.status = http.StatusOK
	}
	_, _ = w.body.Write(content)
	return w.ResponseWriter.Write(content)
}

// cappedBuffer retains a bounded copy of a streamed reply without limiting
// what reaches the Provider.
type cappedBuffer struct {
	bytes.Buffer
	overflow bool
}

func (b *cappedBuffer) Write(content []byte) (int, error) {
	if !b.overflow && b.Len()+len(content) <= maxBodyBytes {
		b.Buffer.Write(content)
	} else {
		b.overflow = true
	}
	return len(content), nil
}
