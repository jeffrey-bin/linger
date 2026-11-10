package integration_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"os"
	"strconv"
	"testing"
	"time"

	artifactstore "github.com/simplexai-labs/linger/apps/teamhub/internal/artifact"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
)

type unknownDeleteObjectStore struct {
	artifactstore.ObjectStore
	loseResult bool
}

type blockingHeadObjectStore struct {
	artifactstore.ObjectStore
	started chan struct{}
	release chan struct{}
}

func (store *blockingHeadObjectStore) Head(ctx context.Context, key string) (artifactstore.Object, error) {
	close(store.started)
	select {
	case <-ctx.Done():
		return artifactstore.Object{}, ctx.Err()
	case <-store.release:
	}
	return store.ObjectStore.Head(ctx, key)
}

func (store *unknownDeleteObjectStore) Delete(ctx context.Context, key string) error {
	err := store.ObjectStore.Delete(ctx, key)
	if err == nil && store.loseResult {
		store.loseResult = false
		return errors.New("object delete response lost")
	}
	return err
}

func TestRoomDocumentAssetCollectorRecoversUnknownSuccessfulDelete(t *testing.T) {
	allowParallelIntegrationTest(t)
	ctx := t.Context()
	_, pool, rawObjects := newUnifiedDocumentSemanticMutationFixture(t)
	objects := &unknownDeleteObjectStore{ObjectStore: rawObjects, loseResult: true}
	service := document.NewWithObjectStore(pool, objects)
	service.ConfigureAssets(document.AssetOptions{StorageReserveBytes: 1})
	contents := []byte("canonical unknown delete")
	digest := sha256.Sum256(contents)
	planned, err := service.PlanAsset(ctx, document.PlanAssetInput{
		AccountID: "account_document_a", DocumentID: "document_human_a",
		Filename: "unknown-delete.txt", MediaType: "text/plain",
		SHA256: hex.EncodeToString(digest[:]), SizeBytes: int64(len(contents)),
		IdempotencyKey: "asset_unknown_delete",
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = service.UploadAsset(ctx, document.UploadAssetInput{
		AccountID: "account_document_a", AssetID: planned.Asset.ID,
		Contents: bytes.NewReader(contents),
	}); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `UPDATE document_assets
		SET available_at=clock_timestamp()-interval '1 hour' WHERE id=$1`, planned.Asset.ID); err != nil {
		t.Fatal(err)
	}
	collector := document.NewAssetCollector(service, document.AssetCollectorOptions{
		UploadStagingRetention: time.Hour, AssetGCGrace: time.Millisecond,
	})
	worked, err := collector.RunOne(ctx)
	if !worked || err == nil {
		t.Fatalf("unknown-result collection worked=%v err=%v, want true/error", worked, err)
	}
	var status, objectID string
	if err = pool.QueryRow(ctx, `SELECT status,content_object_id FROM document_assets WHERE id=$1`,
		planned.Asset.ID).Scan(&status, &objectID); err != nil {
		t.Fatal(err)
	}
	// A failed delete reverts its claim, so the next sweep retries the asset.
	if status == "deleting" || status == "deleted" {
		t.Fatalf("unknown-result Asset status=%q, want the claim reverted", status)
	}
	if _, err = objects.Head(ctx, objectID); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("unknown-result object still exists: %v", err)
	}
	worked, err = collector.RunOne(ctx)
	if !worked || err != nil {
		t.Fatalf("unknown-result recovery worked=%v err=%v", worked, err)
	}
	if err = pool.QueryRow(ctx, `SELECT status FROM document_assets WHERE id=$1`,
		planned.Asset.ID).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "deleted" {
		t.Fatalf("recovered Asset status=%q, want deleted", status)
	}
}

func TestRoomDocumentAssetCollectorRejectsStaleAttemptBeforeDeletion(t *testing.T) {
	allowParallelIntegrationTest(t)
	ctx := t.Context()
	_, pool, rawObjects := newUnifiedDocumentSemanticMutationFixture(t)
	blockedObjects := &blockingHeadObjectStore{
		ObjectStore: rawObjects, started: make(chan struct{}), release: make(chan struct{}),
	}
	service := document.NewWithObjectStore(pool, blockedObjects)
	service.ConfigureAssets(document.AssetOptions{StorageReserveBytes: 1})
	contents := []byte("canonical stale deletion attempt")
	digest := sha256.Sum256(contents)
	planned, err := service.PlanAsset(ctx, document.PlanAssetInput{
		AccountID: "account_document_a", DocumentID: "document_human_a",
		Filename: "stale-attempt.txt", MediaType: "text/plain",
		SHA256: hex.EncodeToString(digest[:]), SizeBytes: int64(len(contents)),
		IdempotencyKey: "asset_stale_attempt",
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = service.UploadAsset(ctx, document.UploadAssetInput{
		AccountID: "account_document_a", AssetID: planned.Asset.ID,
		Contents: bytes.NewReader(contents),
	}); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `UPDATE document_assets
		SET available_at=clock_timestamp()-interval '1 hour' WHERE id=$1`, planned.Asset.ID); err != nil {
		t.Fatal(err)
	}
	staleCollector := document.NewAssetCollector(service, document.AssetCollectorOptions{
		UploadStagingRetention: time.Hour, AssetGCGrace: time.Millisecond,
	})
	staleResult := make(chan error, 1)
	go func() {
		worked, runErr := staleCollector.RunOne(ctx)
		if !worked && runErr == nil {
			runErr = errors.New("stale collector found no candidate")
		}
		staleResult <- runErr
	}()
	<-blockedObjects.started
	// A sweep that crashed mid-deletion leaves the row deleting. Once it is older
	// than the recovery grace, a successor reclaims it.
	if _, err = pool.Exec(ctx, `UPDATE document_assets
		SET updated_at=clock_timestamp()-interval '1 hour'
		WHERE id=$1 AND status='deleting'`, planned.Asset.ID); err != nil {
		t.Fatal(err)
	}
	currentCollector := document.NewAssetCollector(
		document.NewWithObjectStore(pool, rawObjects),
		document.AssetCollectorOptions{
			UploadStagingRetention: time.Hour, AssetGCGrace: time.Millisecond,
		},
	)
	if worked, err := currentCollector.RunOne(ctx); !worked || err != nil {
		t.Fatalf("successor collector worked=%v err=%v", worked, err)
	}
	close(blockedObjects.release)
	if err := <-staleResult; !errors.Is(err, document.ErrAssetUnavailable) {
		t.Fatalf("stale collector error=%v, want ErrAssetUnavailable", err)
	}
	var status string
	if err = pool.QueryRow(ctx, `SELECT status FROM document_assets WHERE id=$1`,
		planned.Asset.ID).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "deleted" {
		t.Fatalf("successor Asset status=%q, want deleted", status)
	}
}

// A frame's new Asset references are checked when it arrives; the save that
// carries several frames stores only the references of its result state.
func TestRoomDocumentAppendSavesTheResultAssetReferences(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newRoomDocumentRealtimeEnv(t)
	unique := strconv.FormatInt(time.Now().UnixNano(), 36)
	roomID := createPrivateRoom(t, env, alice, "Asset reference transitions "+unique, "asset-reference-transitions-room-"+unique)
	document := createAssetInvariantDocument(t, env, alice, roomID, "asset-reference-transitions-document-"+unique)
	firstAsset := createAvailableRoomDocumentAsset(t, env, alice, document.ID, unique+"a", []byte("first:"+unique))
	finalAsset := createAvailableRoomDocumentAsset(t, env, alice, document.ID, unique+"b", []byte("final:"+unique))
	credential := issueAssetInvariantCredential(t, env, alice, document.ID)

	validateAssetInvariantReferences(t, env, document.ID, []string{firstAsset.ID})
	validateAssetInvariantReferences(t, env, document.ID, []string{firstAsset.ID, finalAsset.ID})
	validateAssetInvariantReferences(t, env, document.ID, []string{finalAsset.ID})
	seq, saved, err := requestAssetInvariantAppend(
		t, env, credential, document.ID, document.DurableHead.PersistedSeq, []string{finalAsset.ID},
	)
	if err != nil || !saved || seq != document.DurableHead.PersistedSeq+1 {
		t.Fatalf("save final Asset references seq=%d saved=%t error=%v", seq, saved, err)
	}
	if body, _ := loadRuntimeDocumentBody(t, env, document.ID); len(body.AssetIDs) != 1 || body.AssetIDs[0] != finalAsset.ID {
		t.Fatalf("saved Asset references=%v", body.AssetIDs)
	}
}

func TestRoomDocumentAssetReferencesStayInsideTheirDocument(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newRoomDocumentRealtimeEnv(t)
	unique := strconv.FormatInt(time.Now().UnixNano(), 36)

	sourceRoomID := createPrivateRoom(t, env, alice, "Asset source "+unique, "asset-source-room-"+unique)
	sourceDocument := createAssetInvariantDocument(t, env, alice, sourceRoomID, "asset-source-document-"+unique)
	assetContents := []byte("document-scoped-asset:" + unique)
	asset := createAvailableRoomDocumentAsset(t, env, alice, sourceDocument.ID, unique, assetContents)

	otherRoomID := createPrivateRoom(t, env, alice, "Asset other room "+unique, "asset-other-room-"+unique)
	otherRoomDocument := createAssetInvariantDocument(t, env, alice, otherRoomID, "asset-other-document-"+unique)

	for name, fixture := range map[string]struct {
		client   *http.Client
		document roomDocumentResponse
	}{
		"cross-room": {client: alice, document: otherRoomDocument},
	} {
		t.Run(name, func(t *testing.T) {
			issueAssetInvariantCredential(t, env, fixture.client, fixture.document.ID)
			if check := checkRuntimeReferences(t, env, fixture.document.ID, []string{asset.ID}, []string{}); check != "asset_unavailable" {
				t.Fatalf("check cross-scope Asset=%s", check)
			}
		})
	}

}

func createAssetInvariantDocument(
	t *testing.T,
	env *testEnv,
	client *http.Client,
	roomID string,
	identity string,
) roomDocumentResponse {
	t.Helper()
	status, _, body := env.request(client, http.MethodPost, "/v0/rooms/"+roomID+"/documents", map[string]any{}, identity)
	if status != http.StatusCreated {
		t.Fatalf("create Room Document status=%d body=%s", status, body)
	}
	var document roomDocumentResponse
	decode(t, body, &document)
	return document
}

func issueAssetInvariantCredential(
	t *testing.T,
	env *testEnv,
	client *http.Client,
	documentID string,
) roomDocumentCollaborationCredential {
	t.Helper()
	status, _, body := env.request(client, http.MethodPost, "/v0/documents/"+documentID+"/collaboration-credentials", nil, "")
	if status != http.StatusCreated {
		t.Fatalf("issue collaboration credential status=%d body=%s", status, body)
	}
	var credential roomDocumentCollaborationCredential
	decode(t, body, &credential)
	return credential
}

func validateAssetInvariantReferences(
	t *testing.T,
	env *testEnv,
	documentID string,
	assetIDs []string,
) {
	t.Helper()
	if check := checkRuntimeReferences(t, env, documentID, assetIDs, []string{}); check != "available" {
		t.Fatalf("check Asset references=%s", check)
	}
}

// requestAssetInvariantAppend saves the body as the Runtime does.
func requestAssetInvariantAppend(
	t *testing.T,
	env *testEnv,
	credential roomDocumentCollaborationCredential,
	documentID string,
	basePersistedSeq int64,
	assetIDs []string,
) (int64, bool, error) {
	t.Helper()
	return saveDocumentBody(t.Context(), env.pool, documentBodySave{
		DocumentID: documentID, BaseSeq: basePersistedSeq,
		State:       []byte{byte(basePersistedSeq + 1), 31, 32, 33},
		StateVector: []byte{byte(basePersistedSeq + 1)}, AssetIDs: assetIDs,
		EditorIDs: []string{credential.claims(t).ActorID},
	})
}

func TestRoomDocumentAssetCollectorCollectsAssetLeftDeletingByCrash(t *testing.T) {
	allowParallelIntegrationTest(t)
	ctx := t.Context()
	_, pool, objects := newUnifiedDocumentSemanticMutationFixture(t)
	service := document.NewWithObjectStore(pool, objects)
	service.ConfigureAssets(document.AssetOptions{StorageReserveBytes: 1})
	contents := []byte("canonical crashed deletion")
	digest := sha256.Sum256(contents)
	planned, err := service.PlanAsset(ctx, document.PlanAssetInput{
		AccountID: "account_document_a", DocumentID: "document_human_a",
		Filename: "crashed-delete.txt", MediaType: "text/plain",
		SHA256: hex.EncodeToString(digest[:]), SizeBytes: int64(len(contents)),
		IdempotencyKey: "asset_crashed_delete",
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = service.UploadAsset(ctx, document.UploadAssetInput{
		AccountID: "account_document_a", AssetID: planned.Asset.ID,
		Contents: bytes.NewReader(contents),
	}); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `UPDATE document_assets
		SET available_at=clock_timestamp()-interval '1 hour',
		    status='deleting',updated_at=clock_timestamp()-interval '1 hour'
		WHERE id=$1`, planned.Asset.ID); err != nil {
		t.Fatal(err)
	}
	collector := document.NewAssetCollector(service, document.AssetCollectorOptions{
		UploadStagingRetention: time.Hour, AssetGCGrace: time.Millisecond,
	})
	if worked, runErr := collector.RunOne(ctx); !worked || runErr != nil {
		t.Fatalf("crashed deletion recovery worked=%v err=%v", worked, runErr)
	}
	var status string
	if err = pool.QueryRow(ctx, `SELECT status FROM document_assets WHERE id=$1`,
		planned.Asset.ID).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "deleted" {
		t.Fatalf("crashed Asset status=%q, want deleted", status)
	}
}
