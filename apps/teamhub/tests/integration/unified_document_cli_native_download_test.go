package integration_test

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"testing"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
)

func TestUnifiedDocumentCLINativeExportRechecksAccessAndCurrentRevision(t *testing.T) {
	allowParallelIntegrationTest(t)
	for _, format := range []string{"markdown", "html", "blocks"} {
		mediaType := map[string]string{"markdown": "text/markdown", "html": "text/html", "blocks": "application/json"}[format]
		scenarios := []string{"current", "trashed", "new_revision", "runtime_failure"}
		if format == "markdown" {
			scenarios = append(scenarios, "cache_missing")
		}
		for _, scenario := range scenarios {
			t.Run(format+"/"+scenario, func(t *testing.T) {
				ctx := context.Background()
				db, pool, objects := newUnifiedDocumentSemanticMutationFixture(t)
				calls := 0
				runtimeFailure := errors.New("native export failed")
				export := func(_ context.Context, input document.ExportRuntimeRequest) (document.ExportRuntimeResult, error) {
					calls++
					if input.RepresentationFormat != format {
						t.Fatalf("unexpected format %s", input.RepresentationFormat)
					}
					if scenario == "runtime_failure" {
						return document.ExportRuntimeResult{}, runtimeFailure
					}
					if calls == 1 && scenario == "trashed" {
						if _, err := db.ExecContext(ctx, `UPDATE documents SET status='trashed',trashed_at=GREATEST(updated_at,clock_timestamp()),updated_at=GREATEST(updated_at,clock_timestamp()) WHERE id='document_human_a'`); err != nil {
							t.Fatal(err)
						}
					}
					if calls == 1 && scenario == "new_revision" {
						if _, err := db.ExecContext(ctx, `INSERT INTO document_revisions(id,tenant_id,document_id,persisted_seq,state_vector,full_state_fingerprint,state_bytes,state_bytes_sha256,asset_manifest,created_by_actor_id)
 SELECT 'revision_download_new',tenant_id,document_id,2,state_vector,full_state_fingerprint,state_bytes,state_bytes_sha256,asset_manifest,created_by_actor_id FROM document_revisions WHERE id='revision_semantic_base';
 UPDATE document_bodies SET seq=2,state=(SELECT state_bytes FROM document_revisions WHERE id='revision_download_new'),state_vector=(SELECT state_vector FROM document_revisions WHERE id='revision_download_new') WHERE document_id='document_human_a'`); err != nil {
							t.Fatal(err)
						}
					}
					content := []byte(`<div data-id="block_original">` + input.RevisionID + `</div>`)
					digest := sha256.Sum256(content)
					return document.ExportRuntimeResult{MediaType: mediaType, Bytes: content, SizeBytes: int64(len(content)), SHA256: hex.EncodeToString(digest[:]), CompleteAssetIDs: []string{}, CompleteThreadIDs: []string{}, Warnings: []string{}}, nil
				}
				service := document.NewWithRuntime(pool, documentRuntimeStub{export: export}, objects)
				linkUnifiedDocumentTaskOriginRoom(t, ctx, db)
				if _, err := db.ExecContext(ctx, `DELETE FROM document_context_bindings WHERE document_id='document_human_a'`); err != nil {
					t.Fatal(err)
				}
				download, err := service.DownloadAgentFileAs(ctx, "tenant_document_a", "agent_document_a", "document_human_a", format)
				if scenario == "runtime_failure" {
					if !errors.Is(err, document.ErrRuntimeUnavailable) || !errors.Is(err, runtimeFailure) || calls != 1 || download.ObjectKey != "" {
						t.Fatalf("failed runtime download=%+v calls=%d error=%v", download, calls, err)
					}
					return
				}

				// The download rereads access after rendering: a Document trashed
				// meanwhile is gone for the Agent as for its Human.
				if scenario == "trashed" {
					if !errors.Is(err, document.ErrNotFound) {
						t.Fatalf("trashed download=%+v error=%v", download, err)
					}
					return
				}
				if err != nil {
					t.Fatal(err)
				}
				wantRevision, wantCalls := "revision_semantic_base", 1
				if scenario == "new_revision" {
					wantRevision, wantCalls = "revision_download_new", 2
				}
				if download.VersionID != wantRevision || calls != wantCalls || !download.ReadOnly || download.Role != "owner" || download.MediaType != mediaType {
					t.Fatalf("download=%+v calls=%d", download, calls)
				}
				reader, err := objects.Open(ctx, download.ObjectKey)
				if err != nil {
					t.Fatal(err)
				}
				content, err := io.ReadAll(reader)
				_ = reader.Close()
				if err != nil || string(content) != `<div data-id="block_original">`+wantRevision+`</div>` {
					t.Fatalf("content=%q error=%v", content, err)
				}
				if _, err := service.DownloadAgentFileAs(ctx, "tenant_document_a", "agent_document_a", "document_human_a", format); err != nil || calls != wantCalls {
					t.Fatalf("cached download calls=%d error=%v", calls, err)
				}
				var bindings, history int
				if err := db.QueryRowContext(ctx, `SELECT (SELECT count(*) FROM document_context_bindings WHERE document_id='document_human_a'),(SELECT count(*) FROM document_revisions WHERE document_id='document_human_a' AND history_trigger IS NOT NULL)`).Scan(&bindings, &history); err != nil || bindings != 0 || history != 0 {
					t.Fatalf("bindings=%d history=%d error=%v", bindings, history, err)
				}
			})
		}
	}
}
