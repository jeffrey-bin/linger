package integration_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net/http"
	"testing"
	"time"
)

func TestRoomDocumentAssetUploadRetriesConcurrentSave(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newRoomDocumentRealtimeEnvWithRuntimeOptions(t, 0, 0, 0, roomDocumentRuntimeTestOptions{disableRoomDocumentWorkers: true})
	roomID := createPrivateRoom(t, env, alice, "Upload save race", "upload-save-race")
	doc := createRoomDocumentForAssetAdmission(t, env, alice, roomID, "upload-save-race")
	contents := []byte("asset concurrent save evidence")
	digest := sha256.Sum256(contents)
	status, _, body := env.request(alice, http.MethodPost, "/v0/documents/"+doc.ID+"/assets", map[string]any{"filename": "race.txt", "media_type": "text/plain", "size_bytes": len(contents), "sha256": hex.EncodeToString(digest[:])}, "upload-save-plan")
	if status != http.StatusCreated {
		t.Fatalf("plan=%d %s", status, body)
	}
	var asset roomDocumentAssetResponse
	decode(t, body, &asset)
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	tx, err := env.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	// A server commit on the Document updates the same row.
	if _, err = tx.Exec(ctx, "UPDATE documents SET updated_at=clock_timestamp() WHERE id=$1", doc.ID); err != nil {
		t.Fatal(err)
	}
	type result struct {
		status int
		body   []byte
		err    error
	}
	results := make(chan result, 1)
	go func() {
		req, err := http.NewRequestWithContext(ctx, http.MethodPut, env.server.URL+"/v0/document-assets/"+asset.ID+"/content", bytes.NewReader(contents))
		if err != nil {
			results <- result{err: err}
			return
		}
		req.Header.Set("Content-Type", "text/plain")
		response, err := alice.Do(req)
		if err != nil {
			results <- result{err: err}
			return
		}
		body, err := io.ReadAll(response.Body)
		if closeErr := response.Body.Close(); err == nil {
			err = closeErr
		}
		results <- result{status: response.StatusCode, body: body, err: err}
	}()
	waitForBlockedAssetReferenceLock(t, env)
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case got := <-results:
		if got.err != nil || got.status != http.StatusOK {
			t.Fatalf("concurrent Document save must not fail an authorized upload: status=%d err=%v", got.status, got.err)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	status, _, loaded := requestAssetContent(t, alice, env.server.URL+"/v0/document-assets/"+asset.ID+"/content", http.MethodGet, nil, "")
	if status != http.StatusOK || !bytes.Equal(loaded, contents) {
		t.Fatalf("retried upload did not preserve request bytes: status=%d", status)
	}
	var attempts int
	if err := env.pool.QueryRow(ctx, "SELECT upload_attempt_count FROM document_assets WHERE id=$1", asset.ID).Scan(&attempts); err != nil {
		t.Fatal(err)
	}
	if attempts != 1 {
		t.Fatalf("expected one committed upload lease, got %d", attempts)
	}
}

func waitForBlockedAssetReferenceLock(t *testing.T, env *testEnv) {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for {
		var blocked bool
		if err := env.pool.QueryRow(t.Context(), `
			SELECT EXISTS (
				SELECT 1 FROM pg_stat_activity
				WHERE datname=current_database()
				  AND query LIKE '%FROM document_assets%'
				  AND query LIKE '%FOR UPDATE%'
				  AND wait_event_type='Lock'
			)`,
		).Scan(&blocked); err != nil {
			t.Fatal(err)
		}
		if blocked {
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("Asset reference lock did not block")
		}
		time.Sleep(10 * time.Millisecond)
	}
}
