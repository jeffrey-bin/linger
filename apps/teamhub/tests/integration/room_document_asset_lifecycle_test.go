package integration_test

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	artifactstore "github.com/simplexai-labs/linger/apps/teamhub/internal/artifact"
	documentservice "github.com/simplexai-labs/linger/apps/teamhub/internal/document"
)

func TestRoomDocumentAssetCommandsRejectArchivingDocument(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newRoomDocumentRealtimeEnvWithAssetLifetimes(t, time.Hour, time.Hour)
	unique := strconv.FormatInt(time.Now().UnixNano(), 36)
	roomID := createPrivateRoom(t, env, alice, "Asset archive "+unique, "asset-archive-room-"+unique)
	document := createAssetInvariantDocument(t, env, alice, roomID, "asset-archive-document-"+unique)
	availableContents := []byte("available-before-archive:" + unique)
	available := createAvailableRoomDocumentAsset(t, env, alice, document.ID, unique+"a", availableContents)
	plannedContents := []byte("planned-before-archive:" + unique)
	planned := planRoomDocumentAsset(t, env, alice, document.ID, unique+"p", plannedContents)

	status, _, body := env.request(
		alice, http.MethodDelete, "/v0/documents/"+document.ID, nil, "trash-assets-"+unique,
	)
	if status != http.StatusNoContent {
		t.Fatalf("begin trash status=%d body=%s", status, body)
	}

	status, _, body = env.request(alice, http.MethodGet, "/v0/document-assets/"+available.ID, nil, "")
	if status != http.StatusNotFound {
		t.Fatalf("archiving Asset metadata status=%d body=%s", status, body)
	}
	status, _, body = requestAssetContent(
		t, alice, env.server.URL+"/v0/document-assets/"+available.ID+"/content",
		http.MethodGet, nil, "",
	)
	if status != http.StatusNotFound {
		t.Fatalf("archiving Asset content status=%d body=%s", status, body)
	}
	status, _, body = requestAssetContent(
		t, alice, env.server.URL+"/v0/document-assets/"+planned.ID+"/content",
		http.MethodPut, plannedContents, "application/octet-stream",
	)
	if status != http.StatusNotFound {
		t.Fatalf("archiving Asset upload status=%d body=%s", status, body)
	}
}

func TestRoomDocumentAvailableAssetReplayQuarantinesObjectConflict(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newRoomDocumentRealtimeEnvWithAssetLifetimes(t, time.Hour, time.Hour)
	unique := strconv.FormatInt(time.Now().UnixNano(), 36)
	roomID := createPrivateRoom(t, env, alice, "Available conflict "+unique, "asset-available-conflict-room-"+unique)
	document := createAssetInvariantDocument(t, env, alice, roomID, "asset-available-conflict-document-"+unique)
	contents := []byte("declared-content:" + unique)
	asset := createAvailableRoomDocumentAsset(t, env, alice, document.ID, unique, contents)
	writeRoomDocumentAssetObject(t, env, asset.ID, []byte("conflicting-content:"+unique))

	status, _, body := requestAssetContent(
		t, alice, env.server.URL+"/v0/document-assets/"+asset.ID+"/content",
		http.MethodPut, contents, "application/octet-stream",
	)
	if status != http.StatusConflict {
		t.Fatalf("available replay conflict status=%d body=%s", status, body)
	}
	status, _, body = env.request(alice, http.MethodGet, "/v0/document-assets/"+asset.ID, nil, "")
	var quarantined roomDocumentAssetResponse
	decode(t, body, &quarantined)
	if status != http.StatusOK || quarantined.Status != "quarantined" {
		t.Fatalf("available conflict status=%d asset=%+v body=%s", status, quarantined, body)
	}
}

func TestRoomDocumentAssetCollectorDrainsAllCandidateBatches(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newRoomDocumentRealtimeEnvWithRuntimeOptions(
		t, 0, 20*time.Millisecond, time.Hour,
		roomDocumentRuntimeTestOptions{disableRoomDocumentWorkers: true},
	)
	unique := strconv.FormatInt(time.Now().UnixNano(), 36)
	roomID := createPrivateRoom(t, env, alice, "Collector batches "+unique, "collector-batches-room-"+unique)
	document := createAssetInvariantDocument(t, env, alice, roomID, "collector-batches-document-"+unique)
	for index := 0; index < 3; index++ {
		planRoomDocumentAsset(t, env, alice, document.ID, unique+strconv.Itoa(index), []byte("candidate"+strconv.Itoa(index)))
	}

	collector := newRoomDocumentAssetCollector(t, env, time.Hour)
	if worked, runErr := collector.RunOne(t.Context()); worked || runErr != nil {
		t.Fatalf("fresh staging collected: worked=%v err=%v", worked, runErr)
	}
	waitForRoomDocumentAssetStagingExpiry(t, env, document.ID, 20*time.Millisecond)
	collector = newRoomDocumentAssetCollector(t, env, 20*time.Millisecond)
	for index := 0; index < 3; index++ {
		worked, runErr := collector.RunOne(t.Context())
		if !worked || runErr != nil {
			t.Fatalf("collector pass %d worked=%v err=%v", index+1, worked, runErr)
		}
	}
	if worked, runErr := collector.RunOne(t.Context()); worked || runErr != nil {
		t.Fatalf("collector terminal pass worked=%v err=%v", worked, runErr)
	}
	var remaining int
	if err := env.pool.QueryRow(t.Context(), `
		SELECT count(*) FROM document_assets
		WHERE document_id=$1 AND status<>'deleted'`, document.ID).Scan(&remaining); err != nil {
		t.Fatal(err)
	}
	if remaining != 0 {
		t.Fatalf("collector left %d candidates after one Job", remaining)
	}
}

func TestRoomDocumentExpiredUploadCannotLeaveObjectAfterCollection(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newRoomDocumentRealtimeEnvWithRuntimeOptions(t, 0, 20*time.Millisecond, time.Hour,
		roomDocumentRuntimeTestOptions{disableRoomDocumentWorkers: true})
	unique := strconv.FormatInt(time.Now().UnixNano(), 36)
	roomID := createPrivateRoom(t, env, alice, "Upload fence "+unique, "upload-fence-room-"+unique)
	document := createAssetInvariantDocument(t, env, alice, roomID, "upload-fence-document-"+unique)
	contents := []byte("upload-fence-content:" + unique)
	asset := planRoomDocumentAsset(t, env, alice, document.ID, unique, contents)

	reader, writer := io.Pipe()
	t.Cleanup(func() { _ = writer.CloseWithError(context.Canceled) })
	response := make(chan int, 1)
	go func() {
		request, err := http.NewRequest(
			http.MethodPut, env.server.URL+"/v0/document-assets/"+asset.ID+"/content", reader,
		)
		if err != nil {
			response <- 0
			return
		}
		request.Header.Set("Content-Type", "application/octet-stream")
		result, err := alice.Do(request)
		if err != nil {
			response <- 0
			return
		}
		defer result.Body.Close()
		_, _ = io.Copy(io.Discard, result.Body)
		response <- result.StatusCode
	}()
	if _, err := writer.Write(contents[:1]); err != nil {
		t.Fatal(err)
	}
	waitForAssetUploadLease(t, env, asset.ID)
	waitForRoomDocumentAssetStagingExpiry(t, env, document.ID, 20*time.Millisecond)
	if _, err := env.pool.Exec(t.Context(), `
		UPDATE document_assets
		SET upload_lease_expires_at=clock_timestamp()-interval '1 second'
		WHERE id=$1`, asset.ID); err != nil {
		t.Fatal(err)
	}

	collector := newRoomDocumentAssetCollector(t, env, 20*time.Millisecond)
	worked, err := collector.RunOne(t.Context())
	if !worked || err != nil {
		t.Fatalf("collector worked=%v err=%v", worked, err)
	}
	if _, err := writer.Write(contents[1:]); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	if status := receiveWithin(t, response, 30*time.Second); status != http.StatusConflict {
		t.Fatalf("late upload status=%d", status)
	}
	waitForAssetObjectAbsent(t, env, asset.ID, 5*time.Second)
}

func waitForAssetUploadLease(t *testing.T, env *testEnv, assetID string) {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for {
		var active bool
		err := env.pool.QueryRow(t.Context(), `
			SELECT upload_lease_token_hash IS NOT NULL FROM document_assets WHERE id=$1`, assetID,
		).Scan(&active)
		if err != nil {
			t.Fatal(err)
		}
		if active {
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("upload lease was not acquired")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func roomDocumentAssetObjectPath(env *testEnv, assetID string) string {
	digest := sha256.Sum256([]byte("linger/room-document/asset-object/" + assetID))
	return filepath.Join(env.artifactRoot, "object_"+hex.EncodeToString(digest[:16]))
}

func waitForAssetObjectAbsent(t *testing.T, env *testEnv, assetID string, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for {
		if _, err := os.Stat(roomDocumentAssetObjectPath(env, assetID)); os.IsNotExist(err) {
			return
		} else if err != nil {
			t.Fatal(err)
		}
		if time.Now().After(deadline) {
			t.Fatal("Asset object was not collected")
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// Wait for the database clock's actual retention boundary, rather than guessing
// that a fixed host sleep is long enough. Asset creation timestamps stay immutable.
func waitForRoomDocumentAssetStagingExpiry(t *testing.T, env *testEnv, documentID string, retention time.Duration) {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for {
		var expired bool
		if err := env.pool.QueryRow(t.Context(), `SELECT coalesce(bool_and(created_at+$2::interval <= clock_timestamp()),false)
   FROM document_assets WHERE document_id=$1 AND status IN ('planned','stored')`, documentID, retention.String()).Scan(&expired); err != nil {
			t.Fatal(err)
		}
		if expired {
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("staged assets did not reach retention boundary")
		}
		time.Sleep(time.Millisecond)
	}
}

func newRoomDocumentAssetCollector(t *testing.T, env *testEnv, retention time.Duration) *documentservice.AssetCollector {
	t.Helper()
	storage, err := artifactstore.NewLocalStore(env.artifactRoot, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	return documentservice.NewAssetCollector(documentservice.NewWithObjectStore(env.pool, storage), documentservice.AssetCollectorOptions{
		UploadStagingRetention: retention, AssetGCGrace: time.Hour,
	})
}
