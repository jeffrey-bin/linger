// Package documenttext keeps document_texts current: the Markdown of every
// active Document's current version, normalized once, with the plain words
// keyword search matches. Search, Memory and the Wiki read this one copy. A
// database trigger queues one River job when a version becomes current; the
// job extracts that version and writes it only while it is still current.
package documenttext

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/riverqueue/river"

	artifactstore "github.com/simplexai-labs/linger/apps/teamhub/internal/artifact"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/jobs"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

const (
	// maxSourceBytes mirrors the normalization contract's 50 MiB input limit.
	maxSourceBytes = 50 * 1024 * 1024
	itemTimeout    = 4 * time.Minute
	// maxSyncAttempts is the River attempt budget, also written by
	// enqueue_document_text_sync. Every failed attempt records a failure
	// against its version, which stays until a newer version queues a sync.
	maxSyncAttempts = 6
)

// normalizerAbsentDelay spaces the waits of a file Version sync on a TeamHub
// without a normalizer; a snooze spends no attempt.
const normalizerAbsentDelay = 10 * time.Minute

// retryDelays spaces the attempts before the final one.
var retryDelays = []time.Duration{time.Minute, 5 * time.Minute, 30 * time.Minute, 2 * time.Hour, 12 * time.Hour}

// SyncArgs asks for one Document's text to be synced from its current
// version. enqueue_document_text_sync inserts it; its queue and attempt budget
// are set there.
type SyncArgs struct {
	DocumentID string `json:"document_id"`
}

// Kind names the River job, as enqueue_document_text_sync inserts it.
func (SyncArgs) Kind() string { return "document_text.sync" }

// InsertOpts matches the rows the database function inserts.
func (SyncArgs) InsertOpts() river.InsertOpts {
	return river.InsertOpts{Queue: jobs.QueueIndexing, MaxAttempts: maxSyncAttempts}
}

// Queries is the slice of the sqlc store the Worker drives.
type Queries interface {
	GetCurrentDocumentTextSource(ctx context.Context, documentID string) (store.GetCurrentDocumentTextSourceRow, error)
	UpsertDocumentText(ctx context.Context, params store.UpsertDocumentTextParams) (int64, error)
}

// DocumentSource resolves the current body of a Document: the latest native
// projection, or the object key and metadata of a file Version.
type DocumentSource interface {
	LatestDocumentRuntimeProjection(ctx context.Context, documentID string) (document.LatestRuntimeProjection, error)
	GetTenantVersionContent(ctx context.Context, tenantID, versionID string) (document.VersionContent, error)
}

// ObjectOpener reads immutable Version bytes from the object store.
type ObjectOpener interface {
	Open(ctx context.Context, key string) (io.ReadCloser, error)
}

// Normalizer converts one file Version into Markdown.
type Normalizer interface {
	Normalize(ctx context.Context, source NormalizationSource) (NormalizedDocument, error)
}

var (
	_ Queries        = (*store.Queries)(nil)
	_ DocumentSource = (*document.Service)(nil)
	_ ObjectOpener   = (artifactstore.ObjectStore)(nil)
	_ Normalizer     = (*NormalizerClient)(nil)
)

// Worker runs one text sync. Native Documents render through the Document
// Service's latest projection; file Versions go through the normalization
// contract. Without a normalizer (no Node Services) file Version syncs wait.
type Worker struct {
	river.WorkerDefaults[SyncArgs]
	queries    Queries
	documents  DocumentSource
	objects    ObjectOpener
	normalizer Normalizer
	logger     *slog.Logger
}

func NewWorker(
	queries Queries,
	documents DocumentSource,
	objects ObjectOpener,
	normalizer Normalizer,
	logger *slog.Logger,
) *Worker {
	if logger == nil {
		logger = slog.Default()
	}
	return &Worker{queries: queries, documents: documents, objects: objects, normalizer: normalizer, logger: logger}
}

// Work runs one attempt. Every failure is recorded against the job's source;
// earlier attempts then return it for River to retry, while the final attempt
// finishes without an error.
func (w *Worker) Work(ctx context.Context, job *river.Job[SyncArgs]) error {
	return w.sync(ctx, job.Args, job.Attempt >= maxSyncAttempts)
}

// NextRetry follows the text sync backoff schedule.
func (w *Worker) NextRetry(job *river.Job[SyncArgs]) time.Time {
	index := min(max(job.Attempt-1, 0), len(retryDelays)-1)
	return time.Now().Add(retryDelays[index])
}

// AddJobWorkers registers the sync worker with the TeamHub processing client.
func AddJobWorkers(workers *river.Workers, worker *Worker) {
	river.AddWorker(workers, worker)
}

type extracted struct {
	Status   string
	Markdown string
	// Scanned marks a PDF whose Markdown came from OCR alone.
	Scanned bool
}

// sync extracts the Document's current version and records the result. The
// write is conditional on that version still being current, so a sync
// superseded mid-extraction writes nothing; the newer version queued its own.
func (w *Worker) sync(ctx context.Context, args SyncArgs, finalAttempt bool) error {
	source, err := w.queries.GetCurrentDocumentTextSource(ctx, args.DocumentID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("load Document %s text source: %w", args.DocumentID, err)
	}
	if source.SourceKind == "file_version" && w.normalizer == nil {
		// Nothing else queues this version again, so the job waits for a
		// TeamHub configured with a normalizer instead of finishing textless.
		return river.JobSnooze(normalizerAbsentDelay)
	}
	itemCtx, cancel := context.WithTimeout(ctx, itemTimeout)
	result, extractErr := w.extract(itemCtx, args.DocumentID, source)
	cancel()
	if extractErr != nil {
		if finalAttempt {
			w.logger.ErrorContext(ctx, "document_text.sync_failed",
				"document_id", args.DocumentID, "source_kind", source.SourceKind, "error", extractErr)
		}
		result = extracted{Status: StatusFailed}
	}
	params := store.UpsertDocumentTextParams{
		DocumentID: args.DocumentID, SourceKind: source.SourceKind, SourceID: source.SourceID,
		Status: result.Status,
	}
	if result.Status == StatusReady {
		digest := sha256.Sum256([]byte(result.Markdown))
		params.Markdown = result.Markdown
		params.MarkdownSha256 = pgtype.Text{String: hex.EncodeToString(digest[:]), Valid: true}
		params.SearchText = document.MarkdownToSearchText(result.Markdown)
		params.Scanned = result.Scanned
		params.LongestLineBytes = LongestLineBytes(result.Markdown)
	}
	if _, err := w.queries.UpsertDocumentText(ctx, params); err != nil {
		return fmt.Errorf("record Document %s text: %w", args.DocumentID, err)
	}
	if extractErr != nil && !finalAttempt {
		return fmt.Errorf("sync Document %s text: %w", args.DocumentID, extractErr)
	}
	w.logger.Debug("document_text.synced",
		"document_id", args.DocumentID, "source_kind", source.SourceKind, "status", result.Status, "chars", len(result.Markdown))
	return nil
}

func (w *Worker) extract(ctx context.Context, documentID string, source store.GetCurrentDocumentTextSourceRow) (extracted, error) {
	switch source.SourceKind {
	case "native_body":
		projection, err := w.documents.LatestDocumentRuntimeProjection(ctx, documentID)
		if err != nil {
			return extracted{}, fmt.Errorf("render native Document: %w", err)
		}
		if len(projection.Bytes) > MaxNormalizedMarkdownBytes {
			return extracted{Status: StatusTooLarge}, nil
		}
		return extracted{Status: StatusReady, Markdown: string(projection.Bytes)}, nil
	case "file_version":
		content, err := w.documents.GetTenantVersionContent(ctx, source.TenantID, source.SourceID)
		if err != nil {
			return extracted{}, fmt.Errorf("resolve Document Version: %w", err)
		}
		if content.Version.SizeBytes > maxSourceBytes {
			return extracted{Status: StatusTooLarge}, nil
		}
		reader, err := w.objects.Open(ctx, content.ObjectKey)
		if err != nil {
			return extracted{}, fmt.Errorf("open Document Version object: %w", err)
		}
		source, readErr := io.ReadAll(io.LimitReader(reader, content.Version.SizeBytes+1))
		closeErr := reader.Close()
		if readErr != nil || closeErr != nil {
			return extracted{}, fmt.Errorf("read Document Version object: %w", errors.Join(readErr, closeErr))
		}
		if int64(len(source)) != content.Version.SizeBytes {
			return extracted{}, errors.New("Document Version object size does not match its record")
		}
		normalized, err := w.normalizer.Normalize(ctx, NormalizationSource{
			MediaType: content.Version.MediaType, Filename: content.Version.Filename,
			RepresentationFormat: content.Version.RepresentationFormat, Bytes: source,
		})
		if err != nil {
			return extracted{}, fmt.Errorf("normalize Document Version: %w", err)
		}
		if normalized.Status != StatusReady {
			return extracted{Status: normalized.Status}, nil
		}
		return extracted{Status: StatusReady, Markdown: string(normalized.Markdown), Scanned: scannedPDF(source)}, nil
	default:
		return extracted{}, fmt.Errorf("unknown Document text source kind %q", source.SourceKind)
	}
}
