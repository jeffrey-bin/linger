package integration_test

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/rivertype"
	artifactstore "github.com/simplexai-labs/linger/apps/teamhub/internal/artifact"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/documenttext"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

// readyDocumentTexts runs every queued text sync job, as the background
// worker does after an upload or a native body commits, so a Wiki refresh
// finds each source's current text. File Version bytes are their own
// Markdown; a Version without a stored object reads as spaces of its size. A
// native body renders through runtime when given, otherwise as its title.
func readyDocumentTexts(t *testing.T, pool *pgxpool.Pool, objects artifactstore.ObjectStore, runtime *document.Service) {
	t.Helper()
	if err := syncQueuedDocumentTexts(t.Context(), pool, fixtureTextObjectStore(t, objects), runtime); err != nil {
		t.Fatal(err)
	}
}

func fixtureTextObjectStore(t *testing.T, objects artifactstore.ObjectStore) artifactstore.ObjectStore {
	t.Helper()
	if objects != nil {
		return objects
	}
	objects, err := artifactstore.NewLocalStore(t.TempDir(), 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	return objects
}

func syncQueuedDocumentTexts(ctx context.Context, pool *pgxpool.Pool, objects artifactstore.ObjectStore, runtime *document.Service) error {
	rows, err := pool.Query(ctx, `SELECT id,args->>'document_id' FROM river_job
		WHERE kind='document_text.sync' AND state IN ('available','scheduled','retryable')`)
	if err != nil {
		return err
	}
	type queued struct {
		JobID      int64
		DocumentID string
	}
	jobs, err := pgx.CollectRows(rows, pgx.RowToStructByPos[queued])
	if err != nil || len(jobs) == 0 {
		return err
	}
	source := &fixtureTextDocuments{pool: pool, service: document.NewWithObjectStore(pool, objects), runtime: runtime, sizes: map[string]int64{}}
	worker := documenttext.NewWorker(store.New(pool), source,
		fixtureTextObjects{objects: objects, sizes: source.sizes}, fixtureTextNormalizer{}, nil)
	for _, queued := range jobs {
		job := &river.Job[documenttext.SyncArgs]{JobRow: &rivertype.JobRow{Attempt: 1},
			Args: documenttext.SyncArgs{DocumentID: queued.DocumentID}}
		if err := worker.Work(ctx, job); err != nil {
			return fmt.Errorf("sync Document %s text: %w", queued.DocumentID, err)
		}
		if _, err := pool.Exec(ctx, `UPDATE river_job SET state='completed',finalized_at=now()
			WHERE id=$1`, queued.JobID); err != nil {
			return err
		}
	}
	return nil
}

type fixtureTextDocuments struct {
	pool    *pgxpool.Pool
	service *document.Service
	runtime *document.Service
	sizes   map[string]int64
}

func (d *fixtureTextDocuments) LatestDocumentRuntimeProjection(ctx context.Context, documentID string) (document.LatestRuntimeProjection, error) {
	if d.runtime != nil {
		return d.runtime.LatestDocumentRuntimeProjection(ctx, documentID)
	}
	var title string
	if err := d.pool.QueryRow(ctx, `SELECT title FROM documents WHERE id=$1`, documentID).Scan(&title); err != nil {
		return document.LatestRuntimeProjection{}, err
	}
	return document.LatestRuntimeProjection{DocumentID: documentID, Bytes: []byte("# " + title + "\n")}, nil
}

func (d *fixtureTextDocuments) GetTenantVersionContent(ctx context.Context, tenantID, versionID string) (document.VersionContent, error) {
	content, err := d.service.GetTenantVersionContent(ctx, tenantID, versionID)
	if err == nil {
		d.sizes[content.ObjectKey] = content.Version.SizeBytes
	}
	return content, err
}

type fixtureTextObjects struct {
	objects documenttext.ObjectOpener
	sizes   map[string]int64
}

func (o fixtureTextObjects) Open(ctx context.Context, key string) (io.ReadCloser, error) {
	if reader, err := o.objects.Open(ctx, key); err == nil {
		return reader, nil
	}
	size, ok := o.sizes[key]
	if !ok {
		return nil, errors.New("fixture object has no Version")
	}
	return io.NopCloser(bytes.NewReader(bytes.Repeat([]byte(" "), int(size)))), nil
}

type fixtureTextNormalizer struct{}

func (fixtureTextNormalizer) Normalize(_ context.Context, source documenttext.NormalizationSource) (documenttext.NormalizedDocument, error) {
	return documenttext.NormalizedDocument{Status: documenttext.StatusReady, Markdown: source.Bytes}, nil
}
