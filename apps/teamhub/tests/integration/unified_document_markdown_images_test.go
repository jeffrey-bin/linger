package integration_test

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"testing"
	"time"

	artifactstore "github.com/simplexai-labs/linger/apps/teamhub/internal/artifact"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
)

func TestUnifiedDocumentMarkdownImagesRetryAndReplay(t *testing.T) {
	allowParallelIntegrationTest(t)
	ctx := context.Background()
	db, pool, _ := newUnifiedDocumentSemanticMutationFixture(t)
	objects, err := artifactstore.NewLocalStore(t.TempDir(), 50<<20)
	if err != nil {
		t.Fatal(err)
	}
	const encoded = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII="
	source := []byte("# Image\n\n![first](data:image/png;base64," + encoded + ")\n\n![again](data:image/png;base64," + encoded + ")")
	calls := 0
	materializer := func(_ context.Context, in document.ImportRequest) (document.ImportedState, error) {
		calls++
		if len(in.AllowedAssetIDs) != 1 || in.SourceKind != "markdown" || bytes.Contains(in.SourceBytes, []byte("data:image/")) || strings.Count(string(in.SourceBytes), "document-asset:"+in.AllowedAssetIDs[0]) != 2 {
			t.Fatalf("expected two image references and one asset, got kind=%s assets=%v", in.SourceKind, in.AllowedAssetIDs)
		}
		if calls == 1 {
			return document.ImportedState{}, document.ErrRuntimeUnavailable
		}
		state := []byte("materialized-images")
		return document.ImportedState{StateBytes: state, StateBytesSHA256: unifiedDocumentDigest(state), StateVector: []byte{1}, FullStateFingerprint: unifiedDocumentDigest(state), StateHashVersion: 1, CompleteAssetIDs: in.AllowedAssetIDs, CompleteThreadIDs: []string{}}, nil
	}
	service := document.NewWithRuntime(pool, documentRuntimeStub{importer: materializer}, objects)
	service.ConfigureAssets(document.AssetOptions{StorageReserveBytes: 1})
	input := document.UploadDocumentInput{AccountID: "account_document_a", TenantID: "tenant_document_a", Filename: "images.md", RepresentationFormat: "markdown", MediaType: "text/markdown", IdempotencyKey: "markdown-images-retry", Content: bytes.NewReader(source)}
	uploaded, err := service.Upload(ctx, input)
	if err != nil {
		t.Fatal(err)
	}
	id := uploaded.Document.ID
	var format, migrationStatus, assetID string
	var drafts, assets, versions int
	if err := db.QueryRowContext(ctx, `SELECT d.format,d.native_import_status,(SELECT count(*) FROM document_bodies WHERE document_id=d.id),(SELECT count(*) FROM document_assets WHERE document_id=d.id),(SELECT count(*) FROM document_versions WHERE document_id=d.id) FROM documents d WHERE d.id=$1 AND d.native_import_status IS NOT NULL`, id).Scan(&format, &migrationStatus, &drafts, &assets, &versions); err != nil {
		t.Fatal(err)
	}
	if format != "markdown" || migrationStatus != "pending" || drafts != 0 || assets != 1 || versions != 1 {
		t.Fatalf("partial failure lost source or published draft: %s %s drafts=%d assets=%d versions=%d", format, migrationStatus, drafts, assets, versions)
	}

	if _, err := db.ExecContext(ctx, `UPDATE document_assets SET available_at=clock_timestamp()-interval '2 days' WHERE document_id=$1`, id); err != nil {
		t.Fatal(err)
	}
	collector := document.NewAssetCollector(service, document.AssetCollectorOptions{AssetGCGrace: time.Second})
	if worked, err := collector.RunOne(ctx); worked || err != nil {
		t.Fatalf("collector removed in-flight import: worked=%t err=%v", worked, err)
	}
	restarted := document.NewNativeImportMigrationWorker(service)
	if worked, err := restarted.RunDocument(ctx, id); !worked || err != nil {
		t.Fatalf("retry=%t %v", worked, err)
	}
	var manifest []byte
	if err := db.QueryRowContext(ctx, `SELECT d.format,d.native_import_status,r.asset_manifest FROM documents d JOIN document_bodies body ON body.document_id=d.id JOIN document_revisions r ON r.id=current_document_revision_id(body.document_id) WHERE d.id=$1`, id).Scan(&format, &migrationStatus, &manifest); err != nil {
		t.Fatal(err)
	}
	var refs []struct {
		AssetID string `json:"asset_id"`
	}
	if err := json.Unmarshal(manifest, &refs); err != nil {
		t.Fatal(err)
	}
	if format != "blocknote" || migrationStatus != "completed" || len(refs) != 1 {
		t.Fatalf("completed format=%s migration=%s refs=%s", format, migrationStatus, manifest)
	}
	// The finished import tells readers that the file became an editable Draft.
	var imported int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM document_events
		WHERE document_id=$1 AND event_type='document.draft_updated' AND resource_kind='native_import'`,
		id).Scan(&imported); err != nil || imported != 1 {
		t.Fatalf("native import Draft events=%d err=%v", imported, err)
	}
	assetID = refs[0].AssetID
	content, err := service.OpenAssetContent(ctx, "account_document_a", assetID)
	if err != nil {
		t.Fatal(err)
	}
	got, err := io.ReadAll(content.Reader)
	_ = content.Reader.Close()
	if err != nil {
		t.Fatal(err)
	}
	want, _ := base64.StdEncoding.DecodeString(encoded)
	if !bytes.Equal(got, want) {
		t.Fatal("stored image bytes changed")
	}
	input.Content = bytes.NewReader(source)
	replay, err := service.Upload(ctx, input)
	if err != nil || replay.Document.ID != id || calls != 2 {
		t.Fatalf("replay calls=%d error=%v", calls, err)
	}
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM document_assets WHERE document_id=$1`, id).Scan(&assets); err != nil || assets != 1 {
		t.Fatalf("duplicate assets=%d error=%v", assets, err)
	}
	input.IdempotencyKey = "markdown-images-invalid"
	input.Content = strings.NewReader("![bad](data:image/svg+xml;base64,PHN2Zy8+)")
	if _, err := service.Upload(ctx, input); !errors.Is(err, document.ErrInvalidInput) {
		t.Fatalf("invalid image error=%v", err)
	}
}

func TestUnifiedDocumentMarkdownImageQuotaFailureKeepsSourceAndCollectsStaging(t *testing.T) {
	allowParallelIntegrationTest(t)
	ctx := context.Background()
	db, pool, _ := newUnifiedDocumentSemanticMutationFixture(t)
	objects, err := artifactstore.NewLocalStore(t.TempDir(), 50<<20)
	if err != nil {
		t.Fatal(err)
	}
	const encoded = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII="
	first, _ := base64.StdEncoding.DecodeString(encoded)
	second := append(append([]byte{}, first...), 0)
	source := []byte("![first](data:image/png;base64," + encoded + ")\n\n![second](data:image/png;base64," + base64.StdEncoding.EncodeToString(second) + ")")
	materializer := func(context.Context, document.ImportRequest) (document.ImportedState, error) {
		t.Fatal("quota failure must precede materialization")
		return document.ImportedState{}, nil
	}
	service := document.NewWithRuntime(pool, documentRuntimeStub{importer: materializer}, objects)
	service.ConfigureAssets(document.AssetOptions{StorageReserveBytes: 1, MaxDocumentObjects: 1})
	uploaded, err := service.Upload(ctx, document.UploadDocumentInput{AccountID: "account_document_a", TenantID: "tenant_document_a", Filename: "quota.md", RepresentationFormat: "markdown", MediaType: "text/markdown", IdempotencyKey: "markdown-images-quota", Content: bytes.NewReader(source)})
	if err != nil {
		t.Fatal(err)
	}
	var migrationStatus string
	var drafts int
	if err := db.QueryRowContext(ctx, `SELECT native_import_status,(SELECT count(*) FROM document_bodies WHERE document_id=$1) FROM documents WHERE id=$1 AND native_import_status IS NOT NULL`, uploaded.Document.ID).Scan(&migrationStatus, &drafts); err != nil {
		t.Fatal(err)
	}
	if migrationStatus != "failed" || drafts != 0 {
		t.Fatalf("quota state=%s drafts=%d", migrationStatus, drafts)
	}
	if _, err := db.ExecContext(ctx, `UPDATE document_assets SET available_at=clock_timestamp()-interval '2 days' WHERE document_id=$1`, uploaded.Document.ID); err != nil {
		t.Fatal(err)
	}
	collector := document.NewAssetCollector(service, document.AssetCollectorOptions{AssetGCGrace: time.Second})
	if worked, err := collector.RunOne(ctx); !worked || err != nil {
		t.Fatalf("failed import staging not collected: worked=%t error=%v", worked, err)
	}
	var objectID string
	if err := db.QueryRowContext(ctx, `SELECT content_object_id FROM document_versions WHERE document_id=$1`, uploaded.Document.ID).Scan(&objectID); err != nil {
		t.Fatal(err)
	}
	reader, err := objects.Open(ctx, objectID)
	if err != nil {
		t.Fatal(err)
	}
	retained, err := io.ReadAll(reader)
	_ = reader.Close()
	if err != nil || !bytes.Equal(retained, source) {
		t.Fatal("failed import lost source")
	}
}
