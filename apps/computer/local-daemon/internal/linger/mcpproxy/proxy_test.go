package mcpproxy

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"testing/synctest"
	"time"
)

func TestProxyHidesRelayTokenAndAttachesOperationFence(t *testing.T) {
	received := make(chan http.Header, 1)
	upstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		received <- request.Header.Clone()
		writer.Header().Set("Mcp-Session-Id", "session-1")
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"jsonrpc":"2.0","id":1,"result":{}}`))
	}))
	defer upstream.Close()
	token := strings.Repeat("secret", 6)
	set, err := Open(context.Background(), mustDescriptors(t, []Descriptor{{
		Name: "teamhub_run", RelayURL: upstream.URL + "/relay", RelayToken: token,
		ToolNames: []string{"materialize_artifact"}, ExpiresAt: time.Now().Add(time.Minute),
	}}), OperationIdentity{OperationID: "operation-1", ExecutionLeaseID: "lease-1"})
	if err != nil {
		t.Fatal(err)
	}
	config := string(set.Config())
	if strings.Contains(config, token) || !strings.Contains(config, "127.0.0.1") {
		t.Fatalf("provider MCP config leaked Relay authority: %s", config)
	}
	localURL := localServerURL(t, set.Config(), "teamhub_run")
	request, _ := http.NewRequest(http.MethodPost, localURL, strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"tools/list"}`))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Mcp-Protocol-Version", "2025-06-18")
	request.Header.Set("X-Client-Hint", "preserved")
	request.Header.Set("Authorization", "Bearer attacker")
	request.Header.Set("Cookie", "session=attacker")
	request.Header.Set("Forwarded", "for=attacker")
	request.Header.Set("X-Forwarded-For", "attacker")
	request.Header.Set("X-Linger-Operation-Id", "attacker")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK || response.Header.Get("Mcp-Session-Id") != "session-1" {
		t.Fatalf("proxy response status=%d headers=%v", response.StatusCode, response.Header)
	}
	headers := <-received
	if headers.Get("Authorization") != "Bearer "+token || headers.Get("X-Linger-Operation-Id") != "operation-1" ||
		headers.Get("X-Linger-Execution-Lease-Id") != "lease-1" || headers.Get("X-Client-Hint") != "preserved" {
		t.Fatalf("upstream headers=%v", headers)
	}
	if headers.Get("Cookie") != "" || headers.Get("Forwarded") != "" || headers.Get("X-Forwarded-For") != "" {
		t.Fatalf("upstream received caller authority headers=%v", headers)
	}
	if err := set.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := http.Get(localURL); err == nil {
		t.Fatal("closed Local MCP proxy remained reachable")
	}
}

func TestProxyRejectsInvalidMethodsBodiesAndRedirects(t *testing.T) {
	requests := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		requests++
		if request.URL.Path == "/redirect" {
			http.Redirect(writer, request, "/target", http.StatusFound)
			return
		}
		writer.WriteHeader(http.StatusOK)
	}))
	defer upstream.Close()
	set, err := Open(context.Background(), mustDescriptors(t, []Descriptor{{
		Name: "relay", RelayURL: upstream.URL + "/redirect", RelayToken: strings.Repeat("x", 32),
		ExpiresAt: time.Now().Add(time.Minute),
	}}), OperationIdentity{OperationID: "operation-1", ExecutionLeaseID: "lease-1"})
	if err != nil {
		t.Fatal(err)
	}
	defer set.Close()
	localURL := localServerURL(t, set.Config(), "relay")
	patch, _ := http.NewRequest(http.MethodPatch, localURL, nil)
	response, err := http.DefaultClient.Do(patch)
	if err != nil || response.StatusCode != http.StatusMethodNotAllowed || response.Header.Get("Allow") != "GET, POST, DELETE" {
		t.Fatalf("PATCH response=%v err=%v", response, err)
	}
	_ = response.Body.Close()
	plain, _ := http.NewRequest(http.MethodPost, localURL, strings.NewReader("{}"))
	plain.Header.Set("Content-Type", "text/plain")
	response, err = http.DefaultClient.Do(plain)
	if err != nil || response.StatusCode != http.StatusUnsupportedMediaType {
		t.Fatalf("plain POST response=%v err=%v", response, err)
	}
	_ = response.Body.Close()
	oversized, _ := http.NewRequest(http.MethodPost, localURL, io.LimitReader(strings.NewReader(strings.Repeat("x", maxBodyBytes+1)), maxBodyBytes+1))
	oversized.ContentLength = maxBodyBytes + 1
	oversized.Header.Set("Content-Type", "application/json")
	response, err = http.DefaultClient.Do(oversized)
	if err != nil || response.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized POST response=%v err=%v", response, err)
	}
	_ = response.Body.Close()
	valid, _ := http.NewRequest(http.MethodPost, localURL, strings.NewReader("{}"))
	valid.Header.Set("Content-Type", "application/json")
	response, err = http.DefaultClient.Do(valid)
	if err != nil || response.StatusCode != http.StatusBadGateway {
		t.Fatalf("redirect response=%v err=%v", response, err)
	}
	_ = response.Body.Close()
	if requests != 1 {
		t.Fatalf("upstream requests=%d, want 1", requests)
	}
}

func TestOpenRejectsExpiredAndDuplicateDescriptors(t *testing.T) {
	identity := OperationIdentity{OperationID: "operation-1", ExecutionLeaseID: "lease-1"}
	if _, err := Open(context.Background(), mustDescriptors(t, []Descriptor{{
		Name: "expired", RelayURL: "http://127.0.0.1/relay", RelayToken: strings.Repeat("x", 32),
		ExpiresAt: time.Now().Add(-time.Second),
	}}), identity); err == nil {
		t.Fatal("expired descriptor was accepted")
	}
	descriptor := Descriptor{
		Name: "duplicate", RelayURL: "http://127.0.0.1/relay", RelayToken: strings.Repeat("x", 32),
		ExpiresAt: time.Now().Add(time.Minute),
	}
	if _, err := Open(context.Background(), mustDescriptors(t, []Descriptor{descriptor, descriptor}), identity); err == nil {
		t.Fatal("duplicate descriptor was accepted")
	}
}

func TestCloseInterruptsPartialLocalRequest(t *testing.T) {
	set, err := Open(context.Background(), mustDescriptors(t, []Descriptor{{
		Name: "relay", RelayURL: "http://127.0.0.1:1/relay", RelayToken: strings.Repeat("x", 32),
		ExpiresAt: time.Now().Add(time.Minute),
	}}), OperationIdentity{OperationID: "operation-1", ExecutionLeaseID: "lease-1"})
	if err != nil {
		t.Fatal(err)
	}
	reader, writer := io.Pipe()
	request, _ := http.NewRequest(http.MethodPost, localServerURL(t, set.Config(), "relay"), reader)
	request.ContentLength = 100
	request.Header.Set("Content-Type", "application/json")
	done := make(chan error, 1)
	go func() {
		response, err := http.DefaultClient.Do(request)
		if response != nil {
			_ = response.Body.Close()
		}
		done <- err
	}()
	_, _ = writer.Write([]byte("{"))
	time.Sleep(20 * time.Millisecond)
	if err := set.Close(); err != nil {
		t.Fatal(err)
	}
	_ = writer.Close()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("partial Local MCP request survived proxy close")
	}
}

func mustDescriptors(t *testing.T, descriptors []Descriptor) json.RawMessage {
	t.Helper()
	encoded, err := json.Marshal(descriptors)
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}

func localServerURL(t *testing.T, config json.RawMessage, name string) string {
	t.Helper()
	var decoded struct {
		MCPServers map[string]struct {
			URL string `json:"url"`
		} `json:"mcpServers"`
	}
	if err := json.Unmarshal(config, &decoded); err != nil {
		t.Fatal(err)
	}
	return decoded.MCPServers[name].URL
}

func TestProxyWaitsBeforeDispatchAndRetriesOnlyExplicitNonDispatch(t *testing.T) {
	for _, code := range []int{http.StatusServiceUnavailable, http.StatusBadGateway} {
		t.Run(http.StatusText(code), func(t *testing.T) {
			calls := make(chan struct{}, 4)
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls <- struct{}{}
				if len(calls) == 1 {
					w.Header().Set("X-Linger-Relay-Not-Dispatched", "1")
					w.WriteHeader(code)
					return
				}
				w.WriteHeader(http.StatusOK)
			}))
			defer upstream.Close()
			ready := make(chan struct{})
			set, err := Open(t.Context(), mustDescriptors(t, []Descriptor{{Name: "relay", RelayURL: upstream.URL, RelayToken: strings.Repeat("x", 32), ExpiresAt: time.Now().Add(time.Minute)}}), OperationIdentity{
				OperationID: "operation", ExecutionLeaseID: "lease", BeforeRequest: func(ctx context.Context) error {
					select {
					case <-ready:
						return nil
					case <-ctx.Done():
						return ctx.Err()
					}
				},
			})
			if err != nil {
				t.Fatal(err)
			}
			defer set.Close()
			result := make(chan *http.Response, 1)
			go func() {
				response, err := http.Get(localServerURL(t, set.Config(), "relay"))
				if err != nil {
					result <- nil
					return
				}
				result <- response
			}()
			select {
			case <-calls:
				t.Fatal("dispatched while disconnected")
			case <-time.After(25 * time.Millisecond):
			}
			close(ready)
			response := <-result
			if response == nil {
				t.Fatal("request failed")
			}
			defer response.Body.Close()
			expectedCalls, expectedStatus := 1, code
			if code == http.StatusServiceUnavailable {
				expectedCalls = 2
				expectedStatus = http.StatusOK
			}
			if len(calls) != expectedCalls || response.StatusCode != expectedStatus {
				t.Fatalf("calls=%d status=%d", len(calls), response.StatusCode)
			}
			if response.Header.Get("X-Linger-Relay-Not-Dispatched") != "" {
				t.Fatal("internal retry proof leaked")
			}
		})
	}
}

func TestProxyOldEndpointCannotBorrowNextOperationAuthority(t *testing.T) {
	received := make(chan http.Header, 2)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		received <- r.Header.Clone()
		w.WriteHeader(http.StatusOK)
	}))
	defer upstream.Close()
	open := func(operationID, leaseID string) *Set {
		t.Helper()
		set, err := Open(t.Context(), mustDescriptors(t, []Descriptor{{Name: "relay", RelayURL: upstream.URL,
			RelayToken: strings.Repeat("x", 32), ExpiresAt: time.Now().Add(time.Minute)}}),
			OperationIdentity{OperationID: operationID, ExecutionLeaseID: leaseID})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = set.Close() })
		return set
	}
	old := open("operation-old", "lease-old")
	next := open("operation-next", "lease-next")
	if err := old.Close(); err != nil {
		t.Fatal(err)
	}
	// Model OS reuse of the old port: the old URL reaches the new listener.
	// The path itself must still fence it from the next Operation's authority.
	oldRequest := httptest.NewRequest(http.MethodGet, old.proxies[0].localURL, nil)
	rejected := httptest.NewRecorder()
	next.proxies[0].handle(rejected, oldRequest)
	if rejected.Code != http.StatusNotFound {
		t.Fatalf("old path status=%d", rejected.Code)
	}
	response, err := http.Get(next.proxies[0].localURL)
	if err != nil {
		t.Fatal(err)
	}
	_ = response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("current request status=%d", response.StatusCode)
	}
	if len(received) != 1 {
		t.Fatalf("upstream calls=%d; old request must never dispatch", len(received))
	}
	headers := <-received
	if headers.Get("X-Linger-Operation-Id") != "operation-next" || headers.Get("X-Linger-Execution-Lease-Id") != "lease-next" {
		t.Fatalf("current request identity=%v", headers)
	}
}

func TestProxyCancelledRetryCannotUseNextOperation(t *testing.T) {
	requests := make(chan http.Header, 4)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests <- r.Header.Clone()
		if r.Header.Get("X-Linger-Operation-Id") == "old" {
			w.Header().Set("X-Linger-Relay-Not-Dispatched", "1")
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer upstream.Close()
	descriptors := mustDescriptors(t, []Descriptor{{Name: "relay", RelayURL: upstream.URL,
		RelayToken: strings.Repeat("x", 32), ExpiresAt: time.Now().Add(time.Minute)}})
	retrying := make(chan struct{})
	checks := 0
	old, err := Open(t.Context(), descriptors, OperationIdentity{OperationID: "old", ExecutionLeaseID: "lease-old",
		BeforeRequest: func(ctx context.Context) error {
			checks++
			if checks == 1 {
				return nil
			}
			close(retrying)
			<-ctx.Done()
			return ctx.Err()
		}})
	if err != nil {
		t.Fatal(err)
	}
	defer old.Close()
	oldDone := make(chan struct{})
	go func() {
		defer close(oldDone)
		response, _ := http.Get(old.proxies[0].localURL)
		if response != nil {
			_ = response.Body.Close()
		}
	}()
	select {
	case <-retrying:
	case <-time.After(5 * time.Second):
		t.Fatal("old request did not enter retry")
	}
	next, err := Open(t.Context(), descriptors, OperationIdentity{OperationID: "new", ExecutionLeaseID: "lease-new"})
	if err != nil {
		t.Fatal(err)
	}
	defer next.Close()
	if err := old.Close(); err != nil {
		t.Fatal(err)
	}
	response, err := http.Get(next.proxies[0].localURL)
	if err != nil {
		t.Fatal(err)
	}
	_ = response.Body.Close()
	select {
	case <-oldDone:
	case <-time.After(5 * time.Second):
		t.Fatal("old retry survived cancellation")
	}
	if len(requests) != 2 {
		t.Fatalf("upstream requests=%d, want old attempt and new request", len(requests))
	}
	oldHeaders, newHeaders := <-requests, <-requests
	if oldHeaders.Get("X-Linger-Operation-Id") != "old" || oldHeaders.Get("X-Linger-Execution-Lease-Id") != "lease-old" ||
		newHeaders.Get("X-Linger-Operation-Id") != "new" || newHeaders.Get("X-Linger-Execution-Lease-Id") != "lease-new" {
		t.Fatalf("operation identity crossed retry boundary: old=%v new=%v", oldHeaders, newHeaders)
	}
}

func TestProxyAllowsDeploymentRecoveryWithinCapability(t *testing.T) {
	for _, lifetime := range []time.Duration{time.Hour, 3 * time.Minute} {
		t.Run(lifetime.String(), func(t *testing.T) {
			var remaining time.Duration
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) }))
			defer upstream.Close()
			expires := time.Now().Add(lifetime)
			set, err := Open(t.Context(), mustDescriptors(t, []Descriptor{{Name: "relay", RelayURL: upstream.URL, RelayToken: strings.Repeat("x", 32), ExpiresAt: expires}}), OperationIdentity{OperationID: "op", ExecutionLeaseID: "lease", BeforeRequest: func(ctx context.Context) error {
				deadline, _ := ctx.Deadline()
				remaining = time.Until(deadline)
				if deadline.After(expires) {
					t.Error("wait exceeds capability")
				}
				return nil
			}})
			if err != nil {
				t.Fatal(err)
			}
			defer set.Close()
			response, err := http.Get(localServerURL(t, set.Config(), "relay"))
			if err != nil {
				t.Fatal(err)
			}
			_ = response.Body.Close()
			expected := min(lifetime, 10*time.Minute)
			if remaining < expected-time.Second || remaining > expected {
				t.Fatalf("recovery wait = %s, want %s", remaining, expected)
			}
		})
	}
}

func TestProxyRecoveryBudgetReachesOnlyCodexConfiguration(t *testing.T) {
	for _, runtimeType := range []string{"codex", "claude"} {
		set, err := Open(t.Context(), mustDescriptors(t, []Descriptor{{Name: "relay", RelayURL: "http://localhost:1/mcp", RelayToken: strings.Repeat("x", 32), ExpiresAt: time.Now().Add(time.Hour)}}), OperationIdentity{OperationID: "op", ExecutionLeaseID: "lease", RuntimeType: runtimeType})
		if err != nil {
			t.Fatal(err)
		}
		defer set.Close()
		var config struct {
			Servers map[string]map[string]any `json:"mcpServers"`
		}
		if err := json.Unmarshal(set.Config(), &config); err != nil {
			t.Fatal(err)
		}
		timeout, exists := config.Servers["relay"]["tool_timeout_sec"]
		if runtimeType == "codex" {
			if timeout != float64(630) {
				t.Fatalf("Codex timeout=%v", timeout)
			}
		} else if exists {
			t.Fatalf("Codex timeout leaked into %s", runtimeType)
		}
	}
}

type recoveryRoundTripper func(*http.Request) (*http.Response, error)

func (f recoveryRoundTripper) RoundTrip(request *http.Request) (*http.Response, error) {
	return f(request)
}

func TestProxyWaitsThroughDeploymentWithoutReplayingDispatchedWork(t *testing.T) {
	for _, tc := range []struct {
		name                  string
		lifetime, cancelAfter time.Duration
	}{
		{"reconnected", time.Hour, 0},
		{"capability expired", 3 * time.Minute, 0},
		{"cancelled while reconnecting", time.Hour, time.Minute},
	} {
		t.Run(tc.name, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				ctx, cancel := context.WithCancel(t.Context())
				defer cancel()
				started := time.Now()
				if tc.cancelAfter > 0 {
					go func() { time.Sleep(tc.cancelAfter); cancel() }()
				}
				calls := 0
				upstream, _ := url.Parse("http://relay.invalid/mcp")
				item := &proxy{ctx: ctx, upstream: upstream, localPath: "/mcp", slots: make(chan struct{}, 1), descriptor: Descriptor{ExpiresAt: time.Now().Add(tc.lifetime)},
					operation: OperationIdentity{BeforeRequest: func(ctx context.Context) error {
						select {
						case <-time.After(6 * time.Minute):
							return nil
						case <-ctx.Done():
							return ctx.Err()
						}
					}},
					client: &http.Client{Transport: recoveryRoundTripper(func(request *http.Request) (*http.Response, error) {
						calls++
						return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: io.NopCloser(strings.NewReader("done"))}, nil
					})},
				}
				response := httptest.NewRecorder()
				item.handle(response, httptest.NewRequest(http.MethodGet, "/mcp", nil))
				if tc.name == "reconnected" {
					if calls != 1 || response.Code != 200 {
						t.Fatalf("calls=%d status=%d", calls, response.Code)
					}
				} else if calls != 0 || response.Code != 503 {
					t.Fatalf("expired or cancelled request dispatched: calls=%d status=%d", calls, response.Code)
				}
				if tc.cancelAfter > 0 && time.Since(started) != tc.cancelAfter {
					t.Fatal("cancellation waited for the reconnect window")
				}
			})
		})
	}
}
