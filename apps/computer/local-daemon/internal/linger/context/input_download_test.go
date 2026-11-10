package lingercontext

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
)

func TestInputDownloadReportsEveryRefusalAsRetryable(t *testing.T) {
	content := []byte("recovered input")
	digest := sha256.Sum256(content)
	status := http.StatusServiceUnavailable
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.WriteHeader(status)
		if status == http.StatusOK {
			_, _ = writer.Write(content)
		}
	}))
	defer server.Close()
	store, err := OpenViewStore(filepath.Join(t.TempDir(), "views.sqlite"), t.TempDir(), server.Client())
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	job := downloadJob{
		input:      FileInput{SizeBytes: int64(len(content)), SHA256: hex.EncodeToString(digest[:])},
		target:     filepath.Join(t.TempDir(), "input.txt"),
		contentURL: server.URL,
	}
	if err := store.download(context.Background(), job); !errors.Is(err, ErrInputDownloadUnavailable) {
		t.Fatalf("503 classification: %v", err)
	}
	// The Agent Service refuses a file whose source changed after the
	// manifest named it; the next View names the new content.
	status = http.StatusConflict
	if err := store.download(context.Background(), job); !errors.Is(err, ErrInputDownloadUnavailable) {
		t.Fatalf("409 classification: %v", err)
	}
	status = http.StatusOK
	if err := store.download(context.Background(), job); err != nil {
		t.Fatalf("recovery: %v", err)
	}
	server.Close()
	if err := store.download(context.Background(), job); !errors.Is(err, ErrInputDownloadUnavailable) {
		t.Fatalf("connection failure classification: %v", err)
	}
}
