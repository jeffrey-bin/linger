package integration_test

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	artifactstore "github.com/simplexai-labs/linger/apps/teamhub/internal/artifact"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
)

type roomDocumentAssetResponse struct {
	ID         string `json:"id"`
	DocumentID string `json:"document_id"`
	Filename   string `json:"filename"`
	MediaType  string `json:"media_type"`
	SizeBytes  int64  `json:"size_bytes"`
	SHA256     string `json:"sha256"`
	Status     string `json:"status"`
}

type fixedAvailableObjectStore struct {
	artifactstore.ObjectStore
	availableBytes int64
}

func (s fixedAvailableObjectStore) AvailableBytes() (int64, error) {
	return s.availableBytes, nil
}

func TestRoomDocumentAssetPlanSerializesDocumentQuota(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newRoomDocumentRealtimeEnvWithRuntimeOptions(t, 0, 0, 0, roomDocumentRuntimeTestOptions{
		assetMaxBytes: 10, assetDocumentMaxBytes: 10, assetDocumentMaxObjects: 1,
		assetTenantMaxBytes: 100, assetTenantMaxObjects: 10,
	})
	unique := strings.ReplaceAll(time.Now().Format("150405.000000000"), ".", "")
	roomID := createPrivateRoom(t, env, alice, "Asset quota "+unique, "asset-quota-room-"+unique)
	document := createRoomDocumentForAssetAdmission(t, env, alice, roomID, "quota-"+unique)
	digest := sha256.Sum256([]byte("123456"))
	statuses := make(chan int, 2)
	var group sync.WaitGroup
	for index := range 2 {
		group.Add(1)
		go func() {
			defer group.Done()
			status, _, _ := env.request(alice, http.MethodPost, "/v0/documents/"+document.ID+"/assets", map[string]any{
				"filename": fmt.Sprintf("quota-%d.bin", index), "media_type": "application/octet-stream",
				"size_bytes": 6, "sha256": hex.EncodeToString(digest[:]),
			}, fmt.Sprintf("asset-document-quota-%d-%s", index, unique))
			statuses <- status
		}()
	}
	waitWithin(t, &group, 30*time.Second)
	close(statuses)
	counts := map[int]int{}
	for status := range statuses {
		counts[status]++
	}
	if counts[http.StatusCreated] != 1 || counts[http.StatusRequestEntityTooLarge] != 1 {
		t.Fatalf("quota statuses=%v", counts)
	}
}

func TestRoomDocumentAssetPlanEnforcesTenantQuotaAndStorageCapacity(t *testing.T) {
	allowParallelIntegrationTest(t)
	t.Run("tenant quota", func(t *testing.T) {
		env, alice := newRoomDocumentRealtimeEnvWithRuntimeOptions(t, 0, 0, 0, roomDocumentRuntimeTestOptions{
			assetMaxBytes: 10, assetDocumentMaxBytes: 20, assetDocumentMaxObjects: 2,
			assetTenantMaxBytes: 10, assetTenantMaxObjects: 1,
		})
		unique := strings.ReplaceAll(time.Now().Format("150405.000000000"), ".", "")
		roomID := createPrivateRoom(t, env, alice, "Tenant quota "+unique, "asset-tenant-room-"+unique)
		first := createRoomDocumentForAssetAdmission(t, env, alice, roomID, "tenant-first-"+unique)
		second := createRoomDocumentForAssetAdmission(t, env, alice, roomID, "tenant-second-"+unique)
		if status := planAssetForAdmission(t, env, alice, first.ID, "tenant-first-"+unique, 6); status != http.StatusCreated {
			t.Fatalf("first tenant plan status=%d", status)
		}
		if status := planAssetForAdmission(t, env, alice, second.ID, "tenant-second-"+unique, 6); status != http.StatusRequestEntityTooLarge {
			t.Fatalf("second tenant plan status=%d", status)
		}
	})

	t.Run("plan replay without a rate limit", func(t *testing.T) {
		env, alice := newRoomDocumentRealtimeEnvWithRuntimeOptions(t, 0, 0, 0, roomDocumentRuntimeTestOptions{})
		unique := strings.ReplaceAll(time.Now().Format("150405.000000000"), ".", "")
		roomID := createPrivateRoom(t, env, alice, "Asset rate "+unique, "asset-rate-room-"+unique)
		document := createRoomDocumentForAssetAdmission(t, env, alice, roomID, "rate-"+unique)
		if status := planAssetForAdmission(t, env, alice, document.ID, "rate-first-"+unique, 5); status != http.StatusCreated {
			t.Fatalf("first rate plan status=%d", status)
		}
		if status := planAssetForAdmission(t, env, alice, document.ID, "rate-first-"+unique, 5); status != http.StatusCreated {
			t.Fatalf("rate replay status=%d", status)
		}
		if status := planAssetForAdmission(t, env, alice, document.ID, "rate-second-"+unique, 5); status != http.StatusCreated {
			t.Fatalf("second rate plan status=%d", status)
		}
	})

	t.Run("storage high water", func(t *testing.T) {
		env, alice := newRoomDocumentRealtimeEnvWithRuntimeOptions(t, 0, 0, 0, roomDocumentRuntimeTestOptions{
			assetStorageReserveBytes: math.MaxInt64,
		})
		unique := strings.ReplaceAll(time.Now().Format("150405.000000000"), ".", "")
		roomID := createPrivateRoom(t, env, alice, "Asset capacity "+unique, "asset-capacity-room-"+unique)
		document := createRoomDocumentForAssetAdmission(t, env, alice, roomID, "capacity-"+unique)
		if status := planAssetForAdmission(t, env, alice, document.ID, "capacity-"+unique, 5); status != http.StatusInsufficientStorage {
			t.Fatalf("capacity plan status=%d", status)
		}
	})
}

func TestRoomDocumentAssetPlanReservesFilesystemCapacityAcrossDocuments(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newRoomDocumentRealtimeEnv(t)
	unique := strings.ReplaceAll(time.Now().Format("150405.000000000"), ".", "")
	acmeRoomID := createPrivateRoom(t, env, alice, "Asset capacity Acme "+unique, "asset-capacity-acme-room-"+unique)
	acmeDocument := createRoomDocumentForAssetAdmission(t, env, alice, acmeRoomID, "capacity-acme-"+unique)

	otherRoomID := createPrivateRoom(t, env, alice, "Asset capacity other "+unique, "asset-capacity-other-room-"+unique)
	otherDocument := createRoomDocumentForAssetAdmission(t, env, alice, otherRoomID, "capacity-other-"+unique)

	const (
		planBytes    = int64(40 << 20)
		planBudget   = int64(64 << 20)
		storageMax   = int64(50 << 20)
		admissionMax = int64(512 << 20)
	)
	localStorage, err := artifactstore.NewLocalStore(env.artifactRoot, storageMax)
	if err != nil {
		t.Fatal(err)
	}
	const availableBytes = int64(128 << 20)
	storage := fixedAvailableObjectStore{ObjectStore: localStorage, availableBytes: availableBytes}
	service := document.NewWithObjectStore(env.pool, storage)
	service.ConfigureAssets(document.AssetOptions{
		MaxAssetBytes: planBytes, MaxDocumentBytes: admissionMax, MaxDocumentObjects: 10,
		MaxTenantBytes: admissionMax, MaxTenantObjects: 10,
		StorageReserveBytes: availableBytes - planBudget,
	})
	type planOutcome struct{ err error }
	outcomes := make(chan planOutcome, 2)
	plans := []document.PlanAssetInput{
		{
			AccountID: "account_alice", DocumentID: acmeDocument.ID,
			Filename: "capacity-acme.bin", MediaType: "application/octet-stream", SizeBytes: planBytes,
			SHA256: strings.Repeat("a", 64), IdempotencyKey: "capacity-acme-" + unique,
		},
		{
			AccountID: "account_alice", DocumentID: otherDocument.ID,
			Filename: "capacity-other.bin", MediaType: "application/octet-stream", SizeBytes: planBytes,
			SHA256: strings.Repeat("b", 64), IdempotencyKey: "capacity-other-" + unique,
		},
	}
	var group sync.WaitGroup
	for _, plan := range plans {
		group.Add(1)
		go func() {
			defer group.Done()
			_, err := service.PlanAsset(t.Context(), plan)
			outcomes <- planOutcome{err: err}
		}()
	}
	waitWithin(t, &group, 30*time.Second)
	close(outcomes)
	succeeded := 0
	rejected := 0
	for outcome := range outcomes {
		switch {
		case outcome.err == nil:
			succeeded++
		case errors.Is(outcome.err, document.ErrAssetStorageCapacity):
			rejected++
		default:
			t.Fatalf("unexpected plan error: %v", outcome.err)
		}
	}
	if succeeded != 1 || rejected != 1 {
		t.Fatalf("cross-Document capacity outcomes succeeded=%d rejected=%d", succeeded, rejected)
	}
}

func createRoomDocumentForAssetAdmission(t *testing.T, env *testEnv, client *http.Client, roomID, identity string) roomDocumentResponse {
	t.Helper()
	status, _, body := env.request(client, http.MethodPost, "/v0/rooms/"+roomID+"/documents", map[string]any{}, "asset-admission-document-"+identity)
	if status != http.StatusCreated {
		t.Fatalf("create Document status=%d body=%s", status, body)
	}
	var document roomDocumentResponse
	decode(t, body, &document)
	return document
}

func planAssetForAdmission(t *testing.T, env *testEnv, client *http.Client, documentID, identity string, size int) int {
	t.Helper()
	digest := sha256.Sum256(bytes.Repeat([]byte{'x'}, size))
	status, _, _ := env.request(client, http.MethodPost, "/v0/documents/"+documentID+"/assets", map[string]any{
		"filename": identity + ".bin", "media_type": "application/octet-stream",
		"size_bytes": size, "sha256": hex.EncodeToString(digest[:]),
	}, "asset-admission-plan-"+identity)
	return status
}

func TestRoomDocumentAssetPermitBecomesDraftReferenceOnAppend(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newRoomDocumentRealtimeEnv(t)
	unique := strings.ReplaceAll(time.Now().Format("150405.000000000"), ".", "")
	roomID := createPrivateRoom(t, env, alice, "Asset refs "+unique, "asset-refs-room-"+unique)
	status, _, body := env.request(alice, http.MethodPost, "/v0/rooms/"+roomID+"/documents", map[string]any{}, "asset-refs-document-"+unique)
	if status != http.StatusCreated {
		t.Fatalf("create Document status=%d body=%s", status, body)
	}
	var document roomDocumentResponse
	decode(t, body, &document)
	asset := createAvailableRoomDocumentAsset(t, env, alice, document.ID, unique, []byte("asset-ref-content"))

	status, _, body = env.request(alice, http.MethodPost, "/v0/documents/"+document.ID+"/collaboration-credentials", nil, "")
	if status != http.StatusCreated {
		t.Fatalf("issue collaboration credential status=%d body=%s", status, body)
	}
	var credential roomDocumentCollaborationCredential
	decode(t, body, &credential)

	if check := checkRuntimeReferences(t, env, document.ID, []string{asset.ID}, []string{}); check != "available" {
		t.Fatalf("Asset reference check=%s", check)
	}
	if _, saved, err := saveDocumentBody(t.Context(), env.pool, documentBodySave{
		DocumentID: document.ID, BaseSeq: 0, State: []byte{9, 10, 11, 12}, StateVector: []byte{1},
		AssetIDs: []string{asset.ID}, EditorIDs: []string{credential.claims(t).ActorID},
	}); err != nil || !saved {
		t.Fatalf("save Asset reference saved=%t error=%v", saved, err)
	}
	reopened, ok := loadRuntimeDocumentBody(t, env, document.ID)
	if !ok || len(reopened.AssetIDs) != 1 || reopened.AssetIDs[0] != asset.ID {
		t.Fatalf("reopened body refs=%v, want [%s]", reopened.AssetIDs, asset.ID)
	}
}

func TestRoomDocumentAssetCollectorLifecycle(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newRoomDocumentRealtimeEnvWithRuntimeOptions(
		t, 0, time.Hour, time.Hour,
		roomDocumentRuntimeTestOptions{disableRoomDocumentWorkers: true},
	)
	t.Run("draft removal after grace", func(t *testing.T) {
		testRoomDocumentAssetDraftRemovalIsCollectedAfterGrace(t, env, alice)
	})
	t.Run("abandoned planned and stored", func(t *testing.T) {
		testRoomDocumentAbandonedPlannedAndStoredAssetsAreCollected(t, env, alice)
	})
	t.Run("available without draft reference", func(t *testing.T) {
		testRoomDocumentAvailableAssetWithoutDraftReferenceIsCollected(t, env, alice)
	})
	t.Run("delete hash mismatch", func(t *testing.T) {
		testRoomDocumentAssetDeleteHashMismatchIsQuarantined(t, env, alice)
	})
}

func testRoomDocumentAssetDraftRemovalIsCollectedAfterGrace(t *testing.T, env *testEnv, alice *http.Client) {
	unique := strings.ReplaceAll(time.Now().Format("150405.000000000"), ".", "")
	roomID := createPrivateRoom(t, env, alice, "Asset GC "+unique, "asset-gc-room-"+unique)
	status, _, body := env.request(alice, http.MethodPost, "/v0/rooms/"+roomID+"/documents", map[string]any{}, "asset-gc-document-"+unique)
	if status != http.StatusCreated {
		t.Fatalf("create Document status=%d body=%s", status, body)
	}
	var document roomDocumentResponse
	decode(t, body, &document)
	asset := createAvailableRoomDocumentAsset(t, env, alice, document.ID, unique, []byte("asset-gc-content"))

	status, _, body = env.request(alice, http.MethodPost, "/v0/documents/"+document.ID+"/collaboration-credentials", nil, "")
	if status != http.StatusCreated {
		t.Fatalf("issue collaboration credential status=%d body=%s", status, body)
	}
	var credential roomDocumentCollaborationCredential
	decode(t, body, &credential)

	appendRoomDocumentAssetRefs(t, env, credential, document.ID, 0, []string{asset.ID}, "attach_"+unique)
	appendRoomDocumentAssetRefs(t, env, credential, document.ID, 1, []string{}, "remove_"+unique)
	if _, err := env.pool.Exec(t.Context(), `UPDATE document_assets
		SET available_at=clock_timestamp()-interval '1 hour' WHERE id=$1`, asset.ID); err != nil {
		t.Fatal(err)
	}
	runRoomDocumentAssetCollector(t, env, time.Hour, time.Millisecond, 1)
	status, _, body = requestAssetContent(
		t, alice, env.server.URL+"/v0/document-assets/"+asset.ID+"/content", http.MethodGet, nil, "",
	)
	if status != http.StatusConflict {
		t.Fatalf("deleted Asset content status=%d body=%s", status, body)
	}
}

func testRoomDocumentAbandonedPlannedAndStoredAssetsAreCollected(t *testing.T, env *testEnv, alice *http.Client) {
	unique := strings.ReplaceAll(time.Now().Format("150405.000000000"), ".", "")
	roomID := createPrivateRoom(t, env, alice, "Asset staging "+unique, "asset-staging-room-"+unique)
	status, _, body := env.request(alice, http.MethodPost, "/v0/rooms/"+roomID+"/documents", map[string]any{}, "asset-staging-document-"+unique)
	if status != http.StatusCreated {
		t.Fatalf("create Document status=%d body=%s", status, body)
	}
	var document roomDocumentResponse
	decode(t, body, &document)

	planned := planRoomDocumentAsset(t, env, alice, document.ID, "planned-"+unique, []byte("planned-content"))
	storedContents := []byte("stored-content")
	stored := planRoomDocumentAsset(t, env, alice, document.ID, "stored-"+unique, storedContents)
	writeRoomDocumentAssetObject(t, env, stored.ID, storedContents)
	if _, err := env.pool.Exec(t.Context(), `
		UPDATE document_assets
		SET status='stored',stored_at=clock_timestamp(),observed_size_bytes=size_bytes,
			observed_sha256=sha256,observed_at=clock_timestamp()
		WHERE id=$1`, stored.ID); err != nil {
		t.Fatal(err)
	}
	status, _, body = env.request(alice, http.MethodGet, "/v0/document-assets/"+stored.ID, nil, "")
	if status != http.StatusOK {
		t.Fatalf("get stored Asset status=%d body=%s", status, body)
	}
	var storedState roomDocumentAssetResponse
	decode(t, body, &storedState)
	if storedState.Status != "stored" {
		t.Fatalf("stored crash state=%q", storedState.Status)
	}
	time.Sleep(2 * time.Millisecond)
	runRoomDocumentAssetCollector(t, env, time.Millisecond, time.Hour, 2)
	assertRoomDocumentAssetStatus(t, env, alice, planned.ID, "deleted")
	assertRoomDocumentAssetStatus(t, env, alice, stored.ID, "deleted")
}

func testRoomDocumentAvailableAssetWithoutDraftReferenceIsCollected(t *testing.T, env *testEnv, alice *http.Client) {
	unique := strings.ReplaceAll(time.Now().Format("150405.000000000"), ".", "")
	roomID := createPrivateRoom(t, env, alice, "Asset orphan "+unique, "asset-orphan-room-"+unique)
	status, _, body := env.request(alice, http.MethodPost, "/v0/rooms/"+roomID+"/documents", map[string]any{}, "asset-orphan-document-"+unique)
	if status != http.StatusCreated {
		t.Fatalf("create Document status=%d body=%s", status, body)
	}
	var document roomDocumentResponse
	decode(t, body, &document)
	asset := createAvailableRoomDocumentAsset(t, env, alice, document.ID, unique, []byte("orphan-content"))
	if _, err := env.pool.Exec(t.Context(), `UPDATE document_assets
		SET available_at=clock_timestamp()-interval '1 hour' WHERE id=$1`, asset.ID); err != nil {
		t.Fatal(err)
	}
	runRoomDocumentAssetCollector(t, env, time.Hour, time.Millisecond, 1)
	assertRoomDocumentAssetStatus(t, env, alice, asset.ID, "deleted")
}

func TestRoomDocumentAssetUploadReconcilesStableObjectAndQuarantinesConflict(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newRoomDocumentRealtimeEnvWithAssetLifetimes(t, time.Hour, time.Hour)
	unique := strings.ReplaceAll(time.Now().Format("150405.000000000"), ".", "")
	roomID := createPrivateRoom(t, env, alice, "Asset reconcile "+unique, "asset-reconcile-room-"+unique)
	status, _, body := env.request(alice, http.MethodPost, "/v0/rooms/"+roomID+"/documents", map[string]any{}, "asset-reconcile-document-"+unique)
	if status != http.StatusCreated {
		t.Fatalf("create Document status=%d body=%s", status, body)
	}
	var document roomDocumentResponse
	decode(t, body, &document)

	exactContents := []byte("exact-object-before-response")
	exact := planRoomDocumentAsset(t, env, alice, document.ID, "exact-"+unique, exactContents)
	writeRoomDocumentAssetObject(t, env, exact.ID, exactContents)
	status, headers, body := requestAssetContent(
		t, alice, env.server.URL+"/v0/document-assets/"+exact.ID+"/content",
		http.MethodPut, exactContents, "application/octet-stream",
	)
	if status != http.StatusOK || headers.Get("Idempotent-Replay") != "true" {
		t.Fatalf("reconcile exact object status=%d headers=%v body=%s", status, headers, body)
	}
	var available roomDocumentAssetResponse
	decode(t, body, &available)
	if available.Status != "available" {
		t.Fatalf("reconciled Asset=%+v", available)
	}

	expectedContents := []byte("expected-object-content")
	conflicted := planRoomDocumentAsset(t, env, alice, document.ID, "conflict-"+unique, expectedContents)
	writeRoomDocumentAssetObject(t, env, conflicted.ID, []byte("different-object-content"))
	status, _, body = requestAssetContent(
		t, alice, env.server.URL+"/v0/document-assets/"+conflicted.ID+"/content",
		http.MethodPut, expectedContents, "application/octet-stream",
	)
	if status != http.StatusConflict {
		t.Fatalf("conflicting stable object status=%d body=%s", status, body)
	}
	status, _, body = env.request(alice, http.MethodGet, "/v0/document-assets/"+conflicted.ID, nil, "")
	var quarantined roomDocumentAssetResponse
	decode(t, body, &quarantined)
	if status != http.StatusOK || quarantined.Status != "quarantined" {
		t.Fatalf("conflicted Asset status=%d asset=%+v body=%s", status, quarantined, body)
	}
}

func testRoomDocumentAssetDeleteHashMismatchIsQuarantined(t *testing.T, env *testEnv, alice *http.Client) {
	unique := strings.ReplaceAll(time.Now().Format("150405.000000000"), ".", "")
	roomID := createPrivateRoom(t, env, alice, "Asset delete conflict "+unique, "asset-delete-conflict-room-"+unique)
	status, _, body := env.request(alice, http.MethodPost, "/v0/rooms/"+roomID+"/documents", map[string]any{}, "asset-delete-conflict-document-"+unique)
	if status != http.StatusCreated {
		t.Fatalf("create Document status=%d body=%s", status, body)
	}
	var document roomDocumentResponse
	decode(t, body, &document)
	asset := createAvailableRoomDocumentAsset(t, env, alice, document.ID, unique, []byte("delete-expected-content"))
	writeRoomDocumentAssetObject(t, env, asset.ID, []byte("delete-different-content"))
	if _, err := env.pool.Exec(t.Context(), `UPDATE document_assets
		SET available_at=clock_timestamp()-interval '1 hour' WHERE id=$1`, asset.ID); err != nil {
		t.Fatal(err)
	}
	runRoomDocumentAssetCollector(t, env, time.Hour, time.Millisecond, 1)
	assertRoomDocumentAssetStatus(t, env, alice, asset.ID, "quarantined")
}

func TestRoomDocumentAssetPlanThenUploadIsStableAndReadable(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newRoomDocumentRealtimeEnv(t)
	unique := strings.ReplaceAll(time.Now().Format("150405.000000000"), ".", "")
	roomID := createPrivateRoom(t, env, alice, "Asset Room "+unique, "asset-room-"+unique)
	status, _, body := env.request(alice, http.MethodPost, "/v0/rooms/"+roomID+"/documents", map[string]any{}, "asset-document-"+unique)
	if status != http.StatusCreated {
		t.Fatalf("create Document status=%d body=%s", status, body)
	}
	var document roomDocumentResponse
	decode(t, body, &document)

	contents := []byte("\x89PNG\r\n\x1a\nroom-document-asset")
	digest := sha256.Sum256(contents)
	planPath := "/v0/documents/" + document.ID + "/assets"
	planRequest := map[string]any{
		"filename": "diagram.png", "media_type": "image/png",
		"size_bytes": len(contents), "sha256": hex.EncodeToString(digest[:]),
	}
	status, _, body = env.request(alice, http.MethodPost, planPath, map[string]any{
		"filename": "../asset.bin", "media_type": "application/octet-stream",
		"size_bytes": len(contents), "sha256": hex.EncodeToString(digest[:]),
	}, "asset-invalid-filename-"+unique)
	if status != http.StatusUnprocessableEntity || !containsJSONText(body, "DOCUMENT_ASSET_INVALID") {
		t.Fatalf("invalid Asset filename status=%d body=%s", status, body)
	}
	status, _, body = env.request(alice, http.MethodPost, planPath, planRequest, "asset-plan-"+unique)
	if status != http.StatusCreated {
		t.Fatalf("plan Asset status=%d body=%s", status, body)
	}
	planBody := append([]byte(nil), body...)
	var planned roomDocumentAssetResponse
	decode(t, body, &planned)
	if planned.ID == "" || planned.DocumentID != document.ID || planned.Filename != "diagram.png" ||
		planned.MediaType != "image/png" || planned.SizeBytes != int64(len(contents)) ||
		planned.SHA256 != hex.EncodeToString(digest[:]) || planned.Status != "planned" {
		t.Fatalf("unexpected planned Asset: %+v", planned)
	}

	contentPath := "/v0/document-assets/" + planned.ID + "/content"
	status, _, unavailableBody := env.request(alice, http.MethodGet, contentPath, nil, "")
	if status != http.StatusConflict {
		t.Fatalf("planned Asset content status=%d body=%s", status, unavailableBody)
	}

	status, _, body = requestAssetContent(t, alice, env.server.URL+contentPath, http.MethodPut, contents, "image/png")
	if status != http.StatusOK {
		t.Fatalf("upload Asset content status=%d body=%s", status, body)
	}
	var available roomDocumentAssetResponse
	decode(t, body, &available)
	if available.ID != planned.ID || available.Status != "available" {
		t.Fatalf("unexpected available Asset: %+v", available)
	}

	status, headers, loadedContents := requestAssetContent(t, alice, env.server.URL+contentPath, http.MethodGet, nil, "")
	if status != http.StatusOK || headers.Get("Content-Type") != "image/png" ||
		headers.Get("Content-Disposition") != `attachment; filename=diagram.png` ||
		headers.Get("X-Content-Type-Options") != "nosniff" || !bytes.Equal(loadedContents, contents) {
		t.Fatalf("read Asset status=%d headers=%v body=%q", status, headers, loadedContents)
	}

	status, replayHeaders, replayBody := env.request(alice, http.MethodPost, planPath, planRequest, "asset-plan-"+unique)
	if status != http.StatusCreated || replayHeaders.Get("Idempotent-Replay") != "true" || !bytes.Equal(replayBody, planBody) {
		t.Fatalf("replay Asset plan status=%d headers=%v body=%s first=%s", status, replayHeaders, replayBody, planBody)
	}

	status, replayHeaders, replayBody = requestAssetContent(t, alice, env.server.URL+contentPath, http.MethodPut, contents, "image/png")
	if status != http.StatusOK || replayHeaders.Get("Idempotent-Replay") != "true" {
		t.Fatalf("replay Asset upload status=%d headers=%v body=%s", status, replayHeaders, replayBody)
	}
}

func requestAssetContent(
	t *testing.T,
	client *http.Client,
	url string,
	method string,
	contents []byte,
	mediaType string,
) (int, http.Header, []byte) {
	t.Helper()
	request, err := http.NewRequest(method, url, bytes.NewReader(contents))
	if err != nil {
		t.Fatal(err)
	}
	if mediaType != "" {
		request.Header.Set("Content-Type", mediaType)
	}
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	return response.StatusCode, response.Header, body
}

func createAvailableRoomDocumentAsset(
	t *testing.T,
	env *testEnv,
	client *http.Client,
	documentID string,
	unique string,
	contents []byte,
) roomDocumentAssetResponse {
	t.Helper()
	digest := sha256.Sum256(contents)
	status, _, body := env.request(client, http.MethodPost, "/v0/documents/"+documentID+"/assets", map[string]any{
		"filename": "asset.bin", "media_type": "application/octet-stream",
		"size_bytes": len(contents), "sha256": hex.EncodeToString(digest[:]),
	}, "asset-create-"+unique)
	if status != http.StatusCreated {
		t.Fatalf("plan Asset status=%d body=%s", status, body)
	}
	var asset roomDocumentAssetResponse
	decode(t, body, &asset)
	status, _, body = requestAssetContent(
		t, client, env.server.URL+"/v0/document-assets/"+asset.ID+"/content",
		http.MethodPut, contents, "application/octet-stream",
	)
	if status != http.StatusOK {
		t.Fatalf("upload Asset status=%d body=%s", status, body)
	}
	return asset
}

func planRoomDocumentAsset(
	t *testing.T,
	env *testEnv,
	client *http.Client,
	documentID string,
	identity string,
	contents []byte,
) roomDocumentAssetResponse {
	t.Helper()
	digest := sha256.Sum256(contents)
	status, _, body := env.request(client, http.MethodPost, "/v0/documents/"+documentID+"/assets", map[string]any{
		"filename": identity + ".bin", "media_type": "application/octet-stream",
		"size_bytes": len(contents), "sha256": hex.EncodeToString(digest[:]),
	}, "asset-plan-"+identity)
	if status != http.StatusCreated {
		t.Fatalf("plan Asset status=%d body=%s", status, body)
	}
	var asset roomDocumentAssetResponse
	decode(t, body, &asset)
	return asset
}

func runRoomDocumentAssetCollector(
	t *testing.T,
	env *testEnv,
	stagingRetention time.Duration,
	gcGrace time.Duration,
	wantRuns int,
) {
	t.Helper()
	storage, err := artifactstore.NewLocalStore(env.artifactRoot, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	collector := document.NewAssetCollector(
		document.NewWithObjectStore(env.pool, storage),
		document.AssetCollectorOptions{
			UploadStagingRetention: stagingRetention, AssetGCGrace: gcGrace,
		},
	)
	for run := 0; run <= wantRuns; run++ {
		worked, err := collector.RunOne(t.Context())
		if err != nil || worked != (run < wantRuns) {
			t.Fatalf("Asset collector run %d/%d worked=%v err=%v", run+1, wantRuns, worked, err)
		}
	}
}

func assertRoomDocumentAssetStatus(t *testing.T, env *testEnv, client *http.Client, assetID, want string) {
	t.Helper()
	status, _, body := env.request(client, http.MethodGet, "/v0/document-assets/"+assetID, nil, "")
	if status != http.StatusOK {
		t.Fatalf("get Asset status=%d body=%s", status, body)
	}
	var asset roomDocumentAssetResponse
	decode(t, body, &asset)
	if asset.Status != want {
		t.Fatalf("Asset status=%q want=%q", asset.Status, want)
	}
}

func writeRoomDocumentAssetObject(t *testing.T, env *testEnv, assetID string, contents []byte) {
	t.Helper()
	digest := sha256.Sum256([]byte("linger/room-document/asset-object/" + assetID))
	objectKey := "object_" + hex.EncodeToString(digest[:16])
	if err := os.WriteFile(filepath.Join(env.artifactRoot, objectKey), contents, 0o600); err != nil {
		t.Fatal(err)
	}
}

func appendRoomDocumentAssetRefs(
	t *testing.T,
	env *testEnv,
	credential roomDocumentCollaborationCredential,
	documentID string,
	basePersistedSeq int64,
	assetIDs []string,
	identity string,
) {
	t.Helper()
	if check := checkRuntimeReferences(t, env, documentID, assetIDs, []string{}); check != "available" {
		t.Fatalf("Asset refs check=%s", check)
	}
	appendRoomDocumentAssetBatch(t, env, credential, documentID, basePersistedSeq, assetIDs, identity)
}

// appendRoomDocumentAssetBatch saves the body as the Runtime does.
func appendRoomDocumentAssetBatch(
	t *testing.T,
	env *testEnv,
	credential roomDocumentCollaborationCredential,
	documentID string,
	basePersistedSeq int64,
	assetIDs []string,
	identity string,
) {
	t.Helper()
	state := []byte{byte(basePersistedSeq + 1), 20, 21, 22}
	if _, saved, err := saveDocumentBody(t.Context(), env.pool, documentBodySave{
		DocumentID: documentID, BaseSeq: basePersistedSeq, State: state,
		StateVector: []byte{byte(basePersistedSeq + 1)}, AssetIDs: assetIDs,
		EditorIDs: []string{credential.claims(t).ActorID},
	}); err != nil || !saved {
		t.Fatalf("save Asset refs %s saved=%t error=%v", identity, saved, err)
	}
}
