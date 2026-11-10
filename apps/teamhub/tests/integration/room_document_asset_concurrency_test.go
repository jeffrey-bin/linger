package integration_test

import (
	"context"
	"errors"
	"io"
	"net/http"
	"os"
	"strconv"
	"syscall"
	"testing"
	"time"

	artifactstore "github.com/simplexai-labs/linger/apps/teamhub/internal/artifact"
	documentservice "github.com/simplexai-labs/linger/apps/teamhub/internal/document"
)

func TestRoomDocumentAssetCollectorWinsAttachRace(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newRoomDocumentRealtimeEnvWithRuntimeOptions(
		t, 0, time.Hour, 20*time.Millisecond,
		roomDocumentRuntimeTestOptions{disableRoomDocumentWorkers: true},
	)
	unique := strconv.FormatInt(time.Now().UnixNano(), 36)
	roomID := createPrivateRoom(t, env, alice, "GC attach race "+unique, "gc-attach-race-room-"+unique)
	document := createAssetInvariantDocument(t, env, alice, roomID, "gc-attach-race-document-"+unique)
	contents := []byte("gc-attach-race:" + unique)
	asset := createAvailableRoomDocumentAsset(t, env, alice, document.ID, unique, contents)
	issueAssetInvariantCredential(t, env, alice, document.ID)
	if _, err := env.pool.Exec(t.Context(), `UPDATE document_assets
		SET available_at=clock_timestamp()-interval '1 hour' WHERE id=$1`, asset.ID); err != nil {
		t.Fatal(err)
	}

	objectPath := roomDocumentAssetObjectPath(env, asset.ID)
	if err := os.Remove(objectPath); err != nil {
		t.Fatal(err)
	}
	if err := syscall.Mkfifo(objectPath, 0o600); err != nil {
		t.Fatal(err)
	}
	storage, err := artifactstore.NewLocalStore(env.artifactRoot, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	collector := documentservice.NewAssetCollector(
		documentservice.NewWithObjectStore(env.pool, storage),
		documentservice.AssetCollectorOptions{
			UploadStagingRetention: time.Hour, AssetGCGrace: 20 * time.Millisecond,
		},
	)
	collected := make(chan error, 1)
	go func() {
		worked, err := collector.RunOne(t.Context())
		if !worked && err == nil {
			err = errors.New("canonical collector found no candidate")
		}
		collected <- err
	}()
	waitForRoomDocumentAssetDatabaseStatus(t, env, asset.ID, "deleting")
	if check := checkRuntimeReferences(t, env, document.ID, []string{asset.ID}, []string{}); check != "asset_unavailable" {
		t.Fatalf("attach after collector won check=%s", check)
	}
	fifo, err := os.OpenFile(objectPath, os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fifo.Write(contents); err != nil {
		_ = fifo.Close()
		t.Fatal(err)
	}
	if err := fifo.Close(); err != nil {
		t.Fatal(err)
	}
	if err := <-collected; err != nil {
		t.Fatal(err)
	}
	waitForAssetObjectAbsent(t, env, asset.ID, 5*time.Second)
}

func TestRoomDocumentArchiveFencesUploadFinalization(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newRoomDocumentRealtimeEnvWithAssetLifetimes(t, time.Hour, time.Hour)
	unique := strconv.FormatInt(time.Now().UnixNano(), 36)
	roomID := createPrivateRoom(t, env, alice, "Archive upload race "+unique, "archive-upload-race-room-"+unique)
	document := createAssetInvariantDocument(t, env, alice, roomID, "archive-upload-race-document-"+unique)
	contents := []byte("archive-upload-race:" + unique)
	asset := planRoomDocumentAsset(t, env, alice, document.ID, unique, contents)

	reader, writer := io.Pipe()
	t.Cleanup(func() { _ = writer.CloseWithError(context.Canceled) })
	response := uploadRoomDocumentAssetFromReader(t, alice, env.server.URL, asset.ID, reader)
	if _, err := writer.Write(contents[:1]); err != nil {
		t.Fatal(err)
	}
	waitForAssetUploadLease(t, env, asset.ID)

	status, _, body := env.request(
		alice, http.MethodDelete, "/v0/documents/"+document.ID, nil, "trash-upload-race-"+unique,
	)
	if status != http.StatusNoContent {
		t.Fatalf("begin trash status=%d body=%s", status, body)
	}
	if _, err := writer.Write(contents[1:]); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	if status := receiveWithin(t, response, 30*time.Second); status != http.StatusConflict {
		t.Fatalf("upload finalized after archive status=%d", status)
	}
	waitForAssetObjectAbsent(t, env, asset.ID, 5*time.Second)
}

func TestRoomDocumentAssetLateCleanupRejectsUploadRetry(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newRoomDocumentRealtimeEnvWithRuntimeOptions(
		t, 0, time.Hour, time.Hour,
		roomDocumentRuntimeTestOptions{disableRoomDocumentWorkers: true},
	)
	unique := strconv.FormatInt(time.Now().UnixNano(), 36)
	roomID := createPrivateRoom(t, env, alice, "Late cleanup retry "+unique, "late-cleanup-retry-room-"+unique)
	document := createAssetInvariantDocument(t, env, alice, roomID, "late-cleanup-retry-document-"+unique)
	contents := []byte("late-cleanup-retry:" + unique)
	asset := planRoomDocumentAsset(t, env, alice, document.ID, unique, contents)
	storage, err := artifactstore.NewLocalStore(env.artifactRoot, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	collector := documentservice.NewAssetCollector(
		documentservice.NewWithObjectStore(env.pool, storage),
		documentservice.AssetCollectorOptions{
			UploadStagingRetention: time.Millisecond, AssetGCGrace: time.Hour,
		},
	)
	time.Sleep(2 * time.Millisecond)
	if worked, err := collector.RunOne(t.Context()); !worked || err != nil {
		t.Fatalf("expired planned Asset collection worked=%v err=%v", worked, err)
	}

	status, _, body := requestAssetContent(
		t, alice, env.server.URL+"/v0/document-assets/"+asset.ID+"/content",
		http.MethodPut, contents, "application/octet-stream",
	)
	if status != http.StatusConflict {
		t.Fatalf("late-cleanup upload retry status=%d body=%s", status, body)
	}
	if _, err := os.Stat(roomDocumentAssetObjectPath(env, asset.ID)); !os.IsNotExist(err) {
		t.Fatalf("late-cleanup upload retry wrote object: %v", err)
	}
}

func TestRoomDocumentAssetCollectorSchedulesUploadLeaseContinuation(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newRoomDocumentRealtimeEnvWithRuntimeOptions(
		t, 0, 20*time.Millisecond, time.Hour,
		roomDocumentRuntimeTestOptions{disableRoomDocumentWorkers: true},
	)
	unique := strconv.FormatInt(time.Now().UnixNano(), 36)
	roomID := createPrivateRoom(t, env, alice, "Upload continuation "+unique, "upload-continuation-room-"+unique)
	document := createAssetInvariantDocument(t, env, alice, roomID, "upload-continuation-document-"+unique)
	contents := []byte("upload-continuation:" + unique)
	asset := planRoomDocumentAsset(t, env, alice, document.ID, unique, contents)

	reader, writer := io.Pipe()
	t.Cleanup(func() { _ = writer.CloseWithError(context.Canceled) })
	response := uploadRoomDocumentAssetFromReader(t, alice, env.server.URL, asset.ID, reader)
	if _, err := writer.Write(contents[:1]); err != nil {
		t.Fatal(err)
	}
	waitForAssetUploadLease(t, env, asset.ID)
	storage, err := artifactstore.NewLocalStore(env.artifactRoot, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	collector := documentservice.NewAssetCollector(
		documentservice.NewWithObjectStore(env.pool, storage),
		documentservice.AssetCollectorOptions{
			UploadStagingRetention: 20 * time.Millisecond, AssetGCGrace: time.Hour,
		},
	)
	worked, err := collector.RunOne(t.Context())
	if err != nil || worked {
		t.Fatalf("collector claimed active upload worked=%v err=%v", worked, err)
	}
	if _, err := writer.Write(contents[1:]); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	if status := receiveWithin(t, response, 30*time.Second); status != http.StatusOK {
		t.Fatalf("upload after continuation scheduling status=%d", status)
	}
	var assetStatus string
	if err := env.pool.QueryRow(t.Context(), `SELECT status FROM document_assets WHERE id=$1`, asset.ID).Scan(&assetStatus); err != nil {
		t.Fatal(err)
	}
	if assetStatus != "available" {
		t.Fatalf("completed Asset status=%q, want available", assetStatus)
	}
}

func TestRoomDocumentStaleUploadPreservesSuccessorObject(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newRoomDocumentRealtimeEnvWithAssetLifetimes(t, time.Hour, time.Hour)
	unique := strconv.FormatInt(time.Now().UnixNano(), 36)
	roomID := createPrivateRoom(t, env, alice, "Upload successor "+unique, "upload-successor-room-"+unique)
	document := createAssetInvariantDocument(t, env, alice, roomID, "upload-successor-document-"+unique)
	contents := []byte("upload-successor:" + unique)
	asset := planRoomDocumentAsset(t, env, alice, document.ID, unique, contents)

	reader, writer := io.Pipe()
	t.Cleanup(func() { _ = writer.CloseWithError(context.Canceled) })
	response := uploadRoomDocumentAssetFromReader(t, alice, env.server.URL, asset.ID, reader)
	if _, err := writer.Write(contents[:1]); err != nil {
		t.Fatal(err)
	}
	waitForAssetUploadLease(t, env, asset.ID)
	tx, err := env.pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(t.Context())
	if _, err := tx.Exec(t.Context(), `SELECT id FROM document_assets WHERE id=$1 FOR UPDATE`, asset.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(t.Context(), `
		UPDATE document_assets
		SET status='stored',stored_at=clock_timestamp(),observed_size_bytes=size_bytes,
			observed_sha256=sha256,observed_at=clock_timestamp(),upload_attempt_count=upload_attempt_count+1,
			upload_attempt_id=$2,upload_lease_token_hash=decode(repeat('ab',32),'hex'),
			upload_lease_expires_at=clock_timestamp()+interval '5 minutes',
			upload_started_at=clock_timestamp(),upload_completed_at=clock_timestamp()
		WHERE id=$1`, asset.ID, "document_asset_upload_attempt_successor_"+unique); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(t.Context(), `
		UPDATE document_assets SET status='available',available_at=clock_timestamp() WHERE id=$1`, asset.ID,
	); err != nil {
		t.Fatal(err)
	}
	if _, err := writer.Write(contents[1:]); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	waitForAssetObject(t, env, asset.ID)
	if err := tx.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
	if status := receiveWithin(t, response, 30*time.Second); status != http.StatusConflict {
		t.Fatalf("stale upload status=%d", status)
	}
	if _, err := os.Stat(roomDocumentAssetObjectPath(env, asset.ID)); err != nil {
		t.Fatalf("stale upload deleted successor object: %v", err)
	}
	var status string
	if err := env.pool.QueryRow(t.Context(), `SELECT status FROM document_assets WHERE id=$1`, asset.ID).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "available" {
		t.Fatalf("successor Asset status=%q", status)
	}
}

func uploadRoomDocumentAssetFromReader(
	t *testing.T,
	client *http.Client,
	serverURL, assetID string,
	reader io.Reader,
) <-chan int {
	t.Helper()
	response := make(chan int, 1)
	go func() {
		request, err := http.NewRequest(http.MethodPut, serverURL+"/v0/document-assets/"+assetID+"/content", reader)
		if err != nil {
			response <- 0
			return
		}
		request.Header.Set("Content-Type", "application/octet-stream")
		result, err := client.Do(request)
		if err != nil {
			response <- 0
			return
		}
		defer result.Body.Close()
		_, _ = io.Copy(io.Discard, result.Body)
		response <- result.StatusCode
	}()
	return response
}

func waitForAssetObject(t *testing.T, env *testEnv, assetID string) {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for {
		if _, err := os.Stat(roomDocumentAssetObjectPath(env, assetID)); err == nil {
			return
		} else if !os.IsNotExist(err) {
			t.Fatal(err)
		}
		if time.Now().After(deadline) {
			t.Fatal("Asset object was not written")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func waitForRoomDocumentAssetDatabaseStatus(t *testing.T, env *testEnv, assetID, want string) {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for {
		var status string
		if err := env.pool.QueryRow(t.Context(), `SELECT status FROM document_assets WHERE id=$1`, assetID).Scan(&status); err != nil {
			t.Fatal(err)
		}
		if status == want {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("Asset status=%q, want %q", status, want)
		}
		time.Sleep(10 * time.Millisecond)
	}
}
