package lingercontext

import (
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// gatedContextServer holds every download until release is called, and
// reports each request it receives.
func gatedContextServer(t *testing.T) (*httptest.Server, chan struct{}, func()) {
	t.Helper()
	started := make(chan struct{}, 16)
	release := make(chan struct{})
	var once sync.Once
	releaseAll := func() { once.Do(func() { close(release) }) }
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		started <- struct{}{}
		select {
		case <-release:
		case <-request.Context().Done():
			return
		}
		_, _ = writer.Write(gatedBodies[strings.TrimPrefix(request.URL.Path, "/files/")])
	}))
	t.Cleanup(server.Close)
	t.Cleanup(releaseAll)
	return server, started, releaseAll
}

// gatedBodies maps a file digest to the body the gated server returns.
var gatedBodies = map[string][]byte{}

func gatedMapping(relative, body string) Mapping {
	mapping := mappingFile("memory", relative, []byte(body))
	gatedBodies[mapping.Files[0].SHA256] = []byte(body)
	return mapping
}

func TestApplyDownloadDoesNotBlockOtherContextKeys(t *testing.T) {
	server, started, releaseAll := gatedContextServer(t)
	store, err := OpenViewStore(filepath.Join(t.TempDir(), "state.sqlite"), filepath.Join(t.TempDir(), "views"), server.Client())
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	cleanupReadOnlyWorkspace(t, store.root)
	ctx := context.Background()

	slow := testView("view-slow")
	slow.ExecutionContextKey = "context-slow"
	slow.Mappings = []Mapping{gatedMapping("slow.txt", "/slow")}
	slowDone := make(chan error, 1)
	go func() {
		_, err := store.applyTestView(ctx, slow, server.URL)
		slowDone <- err
	}()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("slow download did not start")
	}

	fast := testView("view-fast")
	fast.ExecutionContextKey = "context-fast"
	fastDone := make(chan error, 1)
	go func() {
		if _, err := store.applyTestView(ctx, fast, server.URL); err != nil {
			fastDone <- err
			return
		}
		_, err := store.CurrentView(ctx, "context-fast", "")
		fastDone <- err
	}()
	select {
	case err := <-fastDone:
		if err != nil {
			releaseAll()
			t.Fatal("other Context could not apply or read its View", err)
		}
	case <-time.After(5 * time.Second):
		releaseAll()
		t.Fatal("other Context apply waited for another Context's download")
	}

	releaseAll()
	if err := <-slowDone; err != nil {
		t.Fatal(err)
	}
	if _, err := store.CurrentView(ctx, "context-slow", ""); err != nil {
		t.Fatal(err)
	}
}
