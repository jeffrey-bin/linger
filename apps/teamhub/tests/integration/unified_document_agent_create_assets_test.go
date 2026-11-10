package integration_test

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"image"
	"image/png"
	"io"
	"strings"
	"testing"

	artifactstore "github.com/simplexai-labs/linger/apps/teamhub/internal/artifact"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
)

type agentAssetFailingStore struct {
	artifactstore.ObjectStore
	fail bool
}

func (s *agentAssetFailingStore) PutIfAbsent(ctx context.Context, key string, reader io.Reader, size int64, digest [32]byte) (artifactstore.Object, bool, error) {
	if s.fail {
		return artifactstore.Object{}, false, document.ErrObjectStoreUnavailable
	}
	return s.ObjectStore.PutIfAbsent(ctx, key, reader, size, digest)
}

func TestUnifiedDocumentAgentCreateEmbeddedImages(t *testing.T) {
	allowParallelIntegrationTest(t)
	ctx := context.Background()
	db, pool, _ := newUnifiedDocumentSemanticMutationFixture(t)
	addUnifiedDocumentAgentRoomMember(t, ctx, db)
	local, err := artifactstore.NewLocalStore(t.TempDir(), 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	objects := &agentAssetFailingStore{ObjectStore: local, fail: true}
	var imageBytes bytes.Buffer
	if err := png.Encode(&imageBytes, image.NewRGBA(image.Rect(0, 0, 1, 1))); err != nil {
		t.Fatal(err)
	}
	imageURL := "data:image/png;base64," + base64.StdEncoding.EncodeToString(imageBytes.Bytes())
	failRuntime := true
	var assetID string
	runtimeCalls := 0
	runtime := func(ctx context.Context, input document.ImportRequest) (document.ImportedState, error) {
		runtimeCalls++
		source := string(input.SourceBytes)
		if len(input.AllowedAssetIDs) != 1 || input.SourceKind != "markdown" || strings.Contains(source, "base64") ||
			strings.Count(source, "document-asset:") != 2 {
			t.Fatalf("unexpected import: %+v", input)
		}
		if assetID != "" && assetID != input.AllowedAssetIDs[0] {
			t.Fatal("retry changed asset identity")
		}
		assetID = input.AllowedAssetIDs[0]
		var visible int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM documents WHERE title='Embedded images'`).Scan(&visible); err != nil || visible != 0 {
			t.Fatalf("partial document visible=%d err=%v", visible, err)
		}
		if failRuntime {
			return document.ImportedState{}, document.ErrRuntimeUnavailable
		}
		state := []byte{7, 8, 9}
		return document.ImportedState{StateBytes: state, StateBytesSHA256: semanticDigest(state), StateVector: []byte{1},
			FullStateFingerprint: semanticDigest(state), StateHashVersion: 1, CompleteAssetIDs: input.AllowedAssetIDs, CompleteThreadIDs: []string{}}, nil
	}
	service := document.NewWithRuntime(pool, documentRuntimeStub{importer: runtime}, objects)
	input := document.CreateAgentDocumentInput{Principal: issueAgentPrincipal(t, pool, "agent_document_a"),
		TargetKind: "room", TargetID: "room_document_a", SourceInvocationID: "embedded-image-create",
		Title: "Embedded images", Markdown: "# Pictures\n\n![Original](" + imageURL + ")\n\n![Again](" + imageURL + ")"}
	// A rejected import stores no image.
	if _, err := service.CreateAgentDocument(ctx, input); !errors.Is(err, document.ErrRuntimeUnavailable) || runtimeCalls != 1 {
		t.Fatalf("runtime failure err=%v calls=%d", err, runtimeCalls)
	}
	failRuntime = false
	if _, err := service.CreateAgentDocument(ctx, input); !errors.Is(err, document.ErrObjectStoreUnavailable) || runtimeCalls != 2 {
		t.Fatalf("storage failure err=%v calls=%d", err, runtimeCalls)
	}
	objects.fail = false
	created, err := service.CreateAgentDocument(ctx, input)
	if err != nil {
		t.Fatal(err)
	}
	var manifestAsset, objectID, sha, status string
	var assets int
	if err := pool.QueryRow(ctx, `SELECT
  (SELECT asset_manifest->0->>'asset_id' FROM document_revisions WHERE id=$1),
  (SELECT content_object_id FROM document_assets WHERE id=$2),
  (SELECT sha256 FROM document_assets WHERE id=$2),
  (SELECT status FROM document_assets WHERE id=$2),
  (SELECT count(*) FROM document_assets WHERE document_id=$3)`, created.RevisionID, assetID, created.DocumentID).
		Scan(&manifestAsset, &objectID, &sha, &status, &assets); err != nil {
		t.Fatal(err)
	}
	if manifestAsset != assetID || assets != 1 || status != "available" {
		t.Fatalf("manifest=%s assets=%d status=%s", manifestAsset, assets, status)
	}
	head, err := objects.Head(ctx, objectID)
	if err != nil || head.Size != int64(imageBytes.Len()) || hex.EncodeToString(head.SHA256[:]) != sha {
		t.Fatalf("object=%+v err=%v", head, err)
	}
	reader, err := objects.Open(ctx, objectID)
	if err != nil {
		t.Fatal(err)
	}
	data, err := io.ReadAll(reader)
	_ = reader.Close()
	if err != nil || !bytes.Equal(data, imageBytes.Bytes()) {
		t.Fatalf("content=%q err=%v", data, err)
	}
	replay, err := service.CreateAgentDocument(ctx, input)
	if err != nil || !replay.Replayed || replay.DocumentID != created.DocumentID || runtimeCalls != 3 {
		t.Fatalf("replay=%+v calls=%d err=%v", replay, runtimeCalls, err)
	}
	// Even after the collection grace passes, referenced media belongs to the body.
	if _, err := pool.Exec(ctx, `UPDATE document_assets SET available_at=clock_timestamp()-interval '2 days'`); err != nil {
		t.Fatal(err)
	}
	collector := document.NewAssetCollector(service, document.AssetCollectorOptions{})
	if worked, err := collector.RunOne(ctx); err != nil || worked {
		t.Fatalf("collected referenced image worked=%t err=%v", worked, err)
	}
}
