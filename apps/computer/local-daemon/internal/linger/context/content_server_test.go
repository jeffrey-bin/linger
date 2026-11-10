package lingercontext

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// testContent is a fake Agent Service content route: views/<digest> serves a
// published manifest and files/<sha256> the file with that content.
type testContent struct {
	server    *httptest.Server
	mu        sync.Mutex
	manifests map[string][]byte
	files     map[string][]byte
	requests  []string
	status    map[string]int
}

func newTestContent(t *testing.T) *testContent {
	t.Helper()
	content := &testContent{manifests: map[string][]byte{}, files: map[string][]byte{}, status: map[string]int{}}
	content.server = httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		resource := strings.TrimPrefix(request.URL.Path, "/content/")
		content.mu.Lock()
		content.requests = append(content.requests, resource)
		status := content.status[resource]
		var body []byte
		var ok bool
		if digest, found := strings.CutPrefix(resource, "views/"); found {
			body, ok = content.manifests[digest]
		} else if digest, found := strings.CutPrefix(resource, "files/"); found {
			body, ok = content.files[digest]
		}
		content.mu.Unlock()
		if status != 0 {
			writer.WriteHeader(status)
			return
		}
		if !ok {
			http.NotFound(writer, request)
			return
		}
		_, _ = writer.Write(body)
	}))
	t.Cleanup(content.server.Close)
	return content
}

func (c *testContent) url() string { return c.server.URL + "/content" }

// file stores content and returns its manifest entry.
func (c *testContent) file(relative string, body []byte) FileInput {
	sum := sha256.Sum256(body)
	digest := hex.EncodeToString(sum[:])
	c.mu.Lock()
	c.files[digest] = append([]byte(nil), body...)
	c.mu.Unlock()
	return FileInput{RelativePath: relative, MediaType: "text/plain", SizeBytes: int64(len(body)), SHA256: digest}
}

// publish serves a manifest and returns its digest.
func (c *testContent) publish(t *testing.T, key, runtimeInstance string, mappings []Mapping, scope *SharedTaskScope, skills []Skill) string {
	t.Helper()
	if mappings == nil {
		mappings = []Mapping{}
	}
	if skills == nil {
		skills = []Skill{}
	}
	manifest := map[string]any{
		"version": 1, "execution_context_key": key, "runtime_instance_id": runtimeInstance,
		"mappings": mappings, "skills": skills,
	}
	if scope != nil {
		manifest["shared_task_scope"] = scope
	}
	body, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(body)
	digest := hex.EncodeToString(sum[:])
	c.mu.Lock()
	c.manifests[digest] = body
	c.mu.Unlock()
	return digest
}

func (c *testContent) takeRequests() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	requests := c.requests
	c.requests = nil
	return requests
}

func testRequest(key, digest string) ViewRequest {
	return ViewRequest{
		TenantID: "tenant-1", RunnerID: "computer-1", AgentID: "agent-1", WorkspaceGrantID: "grant-1",
		ExecutionContextKey: key, RuntimeInstanceID: "runtime-1", ViewDigest: digest,
	}
}

// testView is a View whose content a test applies directly, without a
// manifest round trip.
func testView(seed string) View {
	sum := sha256.Sum256([]byte(seed))
	return View{
		TenantID: "tenant-1", RunnerID: "computer-1", AgentID: "agent-1", WorkspaceGrantID: "grant-1",
		ExecutionContextKey: "context-1", RuntimeInstanceID: "runtime-1", ViewDigest: hex.EncodeToString(sum[:]),
	}
}

// applyTestView publishes a View whose files are fetched from contentURL.
func (s *ViewStore) applyTestView(ctx context.Context, view View, contentURL string) (ViewRecord, error) {
	if err := validateView(view); err != nil {
		return ViewRecord{}, err
	}
	record, err := s.apply(ctx, view, contentURL, contextApplyTiming{startedAt: time.Now()})
	if err == nil {
		s.afterSharedTaskApply(record)
	}
	return record, err
}

// fileServer serves files/<sha256> for the given bodies and counts requests.
func fileServer(t *testing.T, hits *atomic.Int64, bodies ...[]byte) *httptest.Server {
	t.Helper()
	byDigest := map[string][]byte{}
	for _, body := range bodies {
		sum := sha256.Sum256(body)
		byDigest[hex.EncodeToString(sum[:])] = body
	}
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if hits != nil {
			hits.Add(1)
		}
		body, ok := byDigest[strings.TrimPrefix(request.URL.Path, "/files/")]
		if !ok {
			http.NotFound(writer, request)
			return
		}
		_, _ = writer.Write(body)
	}))
	t.Cleanup(server.Close)
	return server
}
