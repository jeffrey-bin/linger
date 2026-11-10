package lingercontext

import (
	"net"
	"net/http"
	"net/http/httptest"
	"path"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

type warmServer struct {
	*httptest.Server
	mu          sync.Mutex
	connections int
	warmups     []string
	files       map[string][]byte
}

func newWarmServer(t *testing.T) *warmServer {
	t.Helper()
	server := &warmServer{files: make(map[string][]byte)}
	server.Server = httptest.NewUnstartedServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Method == http.MethodHead {
			server.mu.Lock()
			server.warmups = append(server.warmups, request.URL.RequestURI())
			server.mu.Unlock()
			writer.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		server.mu.Lock()
		content, ok := server.files[path.Base(request.URL.Path)]
		server.mu.Unlock()
		if !ok {
			writer.WriteHeader(http.StatusNotFound)
			return
		}
		_, _ = writer.Write(content)
	}))
	server.Config.ConnState = func(_ net.Conn, state http.ConnState) {
		if state == http.StateNew {
			server.mu.Lock()
			server.connections++
			server.mu.Unlock()
		}
	}
	server.Start()
	t.Cleanup(server.Close)
	return server
}

func (s *warmServer) counts() (int, []string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.connections, append([]string(nil), s.warmups...)
}

func freshClient() *http.Client {
	return &http.Client{Timeout: 5 * time.Second, Transport: &http.Transport{MaxIdleConnsPerHost: 16, IdleConnTimeout: 90 * time.Second}}
}

func TestViewStoreWarmsOnlyTheContentOriginWhileViewsAreRecent(t *testing.T) {
	server := newWarmServer(t)
	databasePath := filepath.Join(t.TempDir(), "state.sqlite")
	root := filepath.Join(t.TempDir(), "views")
	t.Cleanup(func() { makeWritable(root) })
	store, err := openViewStore(databasePath, root, freshClient(), downloadWarmSettings{interval: 10 * time.Millisecond, window: 50 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	store.noteDownloadActivity(server.URL + "/v1/context-content/payload.signature")
	time.Sleep(150 * time.Millisecond)
	_, settled := server.counts()
	if len(settled) == 0 {
		t.Fatal("store never warmed while Views were recent")
	}
	for _, uri := range settled {
		if uri != "/" {
			t.Fatalf("warm-up must not carry the content capability: %q", uri)
		}
	}
	time.Sleep(100 * time.Millisecond)
	if _, later := server.counts(); len(later) != len(settled) {
		t.Fatalf("idle store kept warming: %d -> %d", len(settled), len(later))
	}
}
