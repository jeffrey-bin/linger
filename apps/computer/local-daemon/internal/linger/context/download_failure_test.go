package lingercontext

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
)

func TestContextApplyDownloadFailuresLeaveNoStateAndCanRetry(t *testing.T) {
	for _, scenario := range []string{"http failure", "digest mismatch", "cancellation"} {
		t.Run(scenario, func(t *testing.T) {
			expected := []byte("authorized context bytes")
			requestStarted := make(chan struct{}, 1)
			var retry atomic.Bool
			server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
				if retry.Load() {
					_, _ = writer.Write(expected)
					return
				}
				switch scenario {
				case "http failure":
					writer.WriteHeader(http.StatusServiceUnavailable)
				case "digest mismatch":
					_, _ = writer.Write([]byte("wrong context bytes"))
				case "cancellation":
					requestStarted <- struct{}{}
					<-request.Context().Done()
				}
			}))
			defer server.Close()

			root := t.TempDir()
			store, err := OpenViewStore(filepath.Join(root, "state.sqlite"), filepath.Join(root, "views"), server.Client())
			if err != nil {
				t.Fatal(err)
			}
			defer store.Close()
			cleanupReadOnlyWorkspace(t, store.root)
			view := testView("view-download-failure")
			view.Mappings = []Mapping{mappingFile("memory", "input.txt", expected)}

			var applyErr error
			if scenario == "cancellation" {
				ctx, cancel := context.WithCancel(context.Background())
				done := make(chan error, 1)
				go func() {
					_, err := store.applyTestView(ctx, view, server.URL)
					done <- err
				}()
				<-requestStarted
				cancel()
				applyErr = <-done
			} else {
				_, applyErr = store.applyTestView(context.Background(), view, server.URL)
			}
			if applyErr == nil {
				t.Fatal("failed download applied Context")
			}
			assertNoContextApplyState(t, store, view)

			retry.Store(true)
			record, err := store.applyTestView(context.Background(), view, server.URL)
			if err != nil {
				t.Fatalf("retry failed: %v", err)
			}
			content, err := os.ReadFile(filepath.Join(record.WorkspacePath, "documents", "input.txt"))
			if err != nil || string(content) != string(expected) {
				t.Fatalf("published content=%q err=%v", content, err)
			}
		})
	}
}

func assertNoContextApplyState(t *testing.T, store *ViewStore, view View) {
	t.Helper()
	var count int
	if err := store.db.QueryRow(`SELECT COUNT(*) FROM context_views_v3 WHERE execution_context_key=?`, view.ExecutionContextKey).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("view rows=%d, want 0", count)
	}
	if err := filepath.WalkDir(store.root, func(targetPath string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() && entry.Name() == "workspace" {
			t.Fatalf("failed download published workspace %s", targetPath)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}
