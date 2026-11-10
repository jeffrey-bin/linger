package mcpproxy

import (
	"bufio"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestProxyStreamsSSEBeforeUpstreamCloses(t *testing.T) {
	for _, rpcMethod := range []string{"GET", "subscriptions/listen", "initialize", "tools/list"} {
		for _, stop := range []string{"client_cancel", "proxy_close"} {
			t.Run(rpcMethod+"/"+stop, func(t *testing.T) {
				frames := make(chan string)
				upstreamDone := make(chan struct{})
				upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					defer close(upstreamDone)
					w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
					w.WriteHeader(http.StatusOK)
					w.(http.Flusher).Flush()
					for {
						select {
						case frame := <-frames:
							if _, err := io.WriteString(w, frame); err != nil {
								return
							}
							w.(http.Flusher).Flush()
						case <-r.Context().Done():
							return
						}
					}
				}))
				defer upstream.Close()
				set, err := Open(t.Context(), mustDescriptors(t, []Descriptor{{
					Name: "relay", RelayURL: upstream.URL, RelayToken: strings.Repeat("x", 32),
					ExpiresAt: time.Now().Add(time.Minute),
				}}), OperationIdentity{OperationID: "operation", ExecutionLeaseID: "lease"})
				if err != nil {
					t.Fatal(err)
				}
				defer set.Close()
				// This is a watchdog, not a startup SLA. Each frame is released only
				// after the client observes the preceding headers/frame.
				ctx, cancel := context.WithTimeout(t.Context(), 3*time.Second)
				defer cancel()
				var body io.Reader
				method := http.MethodGet
				if rpcMethod != "GET" {
					method = http.MethodPost
					body = strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"` + rpcMethod + `","params":{}}`)
				}
				request, err := http.NewRequestWithContext(ctx, method, localServerURL(t, set.Config(), "relay"), body)
				if err != nil {
					t.Fatal(err)
				}
				request.Header.Set("Content-Type", "application/json")
				response, err := http.DefaultClient.Do(request)
				if err != nil {
					t.Fatalf("SSE headers were not delivered while upstream remained open: %v", err)
				}
				defer response.Body.Close()
				if response.StatusCode != http.StatusOK || mediaType(response.Header.Get("Content-Type")) != "text/event-stream" {
					t.Fatalf("unexpected SSE response: %s %v", response.Status, response.Header)
				}
				reader := bufio.NewReader(response.Body)
				for _, frame := range []string{
					"data: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/subscriptions/acknowledged\",\"params\":{}}\n\n",
					"data: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/tools/list_changed\"}\n\n",
				} {
					select {
					case frames <- frame:
					case <-ctx.Done():
						t.Fatal(ctx.Err())
					}
					got := make([]byte, len(frame))
					if _, err := io.ReadFull(reader, got); err != nil {
						t.Fatalf("SSE frame was not delivered while upstream remained open: %v", err)
					}
					if string(got) != frame {
						t.Fatalf("frame changed: got %q, want %q", got, frame)
					}
				}
				if stop == "client_cancel" {
					cancel()
				} else if err := set.Close(); err != nil {
					t.Fatal(err)
				}
				select {
				case <-upstreamDone:
				case <-time.After(3 * time.Second):
					t.Fatal("upstream SSE survived client cancellation or proxy close")
				}
			})
		}
	}
}
