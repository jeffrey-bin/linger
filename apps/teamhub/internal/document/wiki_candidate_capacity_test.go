package document

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"runtime"
	"sync/atomic"
	"testing"
	"time"
)

// Run the same probe in a Linux container before and after the fix. The receiver
// drains complete requests without retaining their bodies, like an external
// service; all four request writers must be active before it starts draining.
func TestHTTPWikiCandidateConcurrentMemoryProbe(t *testing.T) {
	if os.Getenv("TEAMHUB_WIKI_MEMORY_PROBE") != "1" {
		t.Skip("opt-in memory capacity probe")
	}
	var entered atomic.Int32
	ready := make(chan struct{})
	received := make(chan int64, 4)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if entered.Add(1) == 4 {
			close(ready)
		}
		select {
		case <-ready:
		case <-r.Context().Done():
			return
		}
		n, err := io.Copy(io.Discard, r.Body)
		if err != nil {
			t.Error(err)
		}
		received <- n
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = io.WriteString(w, `{"error":{"disposition":"retryable"}}`)
	}))
	defer server.Close()
	client := server.Client()
	client.Timeout = time.Minute
	generator, err := NewHTTPWikiCandidateGenerator(server.URL, "test-token", client)
	if err != nil {
		t.Fatal(err)
	}
	content := bytes.Repeat([]byte("x"), 4<<20)
	digest := sha256.Sum256(content)
	request := WikiCandidateGenerationRequest{RefreshID: "refresh_capacity", TenantID: "tenant_capacity", GeneratorAgentActorID: "agent_capacity", Mode: "initialize"}
	for index := range 32 {
		request.Changes.Added = append(request.Changes.Added, WikiCandidateSource{
			DocumentID: fmt.Sprintf("document_%d", index), DocumentVersionID: fmt.Sprintf("version_%d", index),
			Filename:  "source.txt",
			SizeBytes: int64(len(content)), SHA256: hex.EncodeToString(digest[:]), Content: content,
		})
	}
	runtime.GC()
	var before, after runtime.MemStats
	runtime.ReadMemStats(&before)
	started := time.Now()
	results := make(chan error, 4)
	for range 4 {
		go func() {
			_, err := generator.GenerateWikiCandidates(t.Context(), request)
			results <- err
		}()
	}
	for range 4 {
		if err := <-results; !errors.Is(err, ErrRuntimeUnavailable) {
			t.Fatalf("unexpected candidate result: %v", err)
		}
		if n := <-received; n < 170<<20 {
			t.Fatalf("lost content: request bytes=%d", n)
		}
	}
	runtime.ReadMemStats(&after)
	peak, _ := os.ReadFile("/sys/fs/cgroup/memory.peak")
	events, _ := os.ReadFile("/sys/fs/cgroup/memory.events")
	t.Logf("concurrency=4 source_bytes_per_request=%d elapsed=%s allocated_bytes=%d cgroup_peak_bytes=%s cgroup_events=%s", 128<<20, time.Since(started), after.TotalAlloc-before.TotalAlloc, bytes.TrimSpace(peak), events)
}
