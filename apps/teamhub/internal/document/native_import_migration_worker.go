package document

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/jobs"
)

const (
	nativeImportMigrationKind = "document.native_import_migration"
	// nativeImportMaxAttempts bounds retries of one import. The last attempt
	// marks the row failed, so readers never see a retryable import stuck pending.
	nativeImportMaxAttempts = 12
	// nativeImportBusyDelay retries a job while the in-process path holds the row.
	nativeImportBusyDelay = 5 * time.Second
)

var errNativeImportBusy = errors.New("Native import migration is held by another worker")

// NativeImportMigrationArgs asks for one native Document import to be finished.
type NativeImportMigrationArgs struct {
	DocumentID string `json:"document_id"`
}

func (NativeImportMigrationArgs) Kind() string { return nativeImportMigrationKind }

func (NativeImportMigrationArgs) InsertOpts() river.InsertOpts {
	return river.InsertOpts{
		Queue:       jobs.QueueDefault,
		MaxAttempts: nativeImportMaxAttempts,
		UniqueOpts:  jobs.UniqueUnfinished,
	}
}

// NativeImportMigrationWorker finishes a native Document import. Each import
// has one River job; RunDocument is the in-process fast path that upload and
// publication call after their commit. Both claim the migration row with a row
// lock held by one transaction, so exactly one of them completes the import.
type NativeImportMigrationWorker struct {
	river.WorkerDefaults[NativeImportMigrationArgs]
	documents *Service
}

type nativeImportClaim struct {
	DocumentID, TenantID, VersionID, ObjectID, SHA256 string
	Filename, ActorID                                 string
	SizeBytes                                         int64
}

func NewNativeImportMigrationWorker(documents *Service) *NativeImportMigrationWorker {
	return &NativeImportMigrationWorker{documents: documents}
}

// enqueueNativeImportMigrationTx enqueues the import inside the transaction
// that records it, so a rolled back import leaves no job.
func enqueueNativeImportMigrationTx(ctx context.Context, tx pgx.Tx, documentID string) error {
	return jobs.InsertTx(ctx, tx, NativeImportMigrationArgs{DocumentID: documentID}, nil)
}

func (worker *NativeImportMigrationWorker) Work(ctx context.Context, job *river.Job[NativeImportMigrationArgs]) error {
	_, err := worker.migrate(ctx, job.Args.DocumentID, job.Attempt >= nativeImportMaxAttempts)
	switch {
	case err == nil:
		return nil
	case errors.Is(err, errNativeImportBusy):
		return river.JobSnooze(nativeImportBusyDelay)
	case terminalNativeImportFailure(err):
		return river.JobCancel(err)
	default:
		return err
	}
}

// NextRetry applies the import backoff. River's default policy would retry too
// quickly for a Runtime outage.
func (worker *NativeImportMigrationWorker) NextRetry(job *river.Job[NativeImportMigrationArgs]) time.Time {
	return time.Now().Add(nativeImportRetryDelay(job.Attempt))
}

// RunDocument is the in-process fast path. It reports false when the import is
// already finished or another worker holds it; the job finishes it otherwise.
func (worker *NativeImportMigrationWorker) RunDocument(ctx context.Context, documentID string) (bool, error) {
	if documentID == "" {
		return false, ErrInvalidInput
	}
	worked, err := worker.migrate(ctx, documentID, false)
	if errors.Is(err, errNativeImportBusy) {
		return false, nil
	}
	return worked, err
}

// migrate runs one import attempt in a transaction that holds the migration
// row lock until it commits. final marks the last job attempt, after which a
// retryable failure is recorded as failed instead of left pending.
func (worker *NativeImportMigrationWorker) migrate(ctx context.Context, documentID string, final bool) (bool, error) {
	if worker == nil || worker.documents == nil || worker.documents.pool == nil || worker.documents.objects == nil {
		return false, ErrInvalidInput
	}
	tx, err := worker.documents.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	claim, found, err := worker.lock(ctx, tx, documentID)
	if err != nil || !found {
		return false, err
	}
	fail := func(cause error) (bool, error) {
		// Release the row lock before recording the outcome. A retryable cause
		// stays pending for the job; a terminal cause or the final attempt fails it.
		_ = tx.Rollback(ctx)
		if !terminalNativeImportFailure(cause) && !final {
			return true, cause
		}
		_, markErr := worker.documents.pool.Exec(ctx, `UPDATE documents
			SET native_import_status='failed'
			WHERE id=$1 AND tenant_id=$2 AND native_import_status='pending'`,
			claim.DocumentID, claim.TenantID)
		return true, errors.Join(cause, markErr)
	}
	if claim.SizeBytes < 0 || claim.SizeBytes > MaxImportBytes {
		return fail(ErrInvalidInput)
	}
	reader, err := worker.documents.objects.Open(ctx, claim.ObjectID)
	if err != nil {
		return fail(errors.Join(ErrObjectStoreUnavailable, err))
	}
	sourceBytes, readErr := io.ReadAll(io.LimitReader(reader, claim.SizeBytes+1))
	closeErr := reader.Close()
	if readErr != nil || closeErr != nil || int64(len(sourceBytes)) != claim.SizeBytes {
		return fail(errors.Join(ErrObjectStoreUnavailable, readErr, closeErr))
	}
	digest := sha256.Sum256(sourceBytes)
	if hex.EncodeToString(digest[:]) != claim.SHA256 {
		return fail(ErrRevisionUnavailable)
	}
	if worker.documents.runtime == nil {
		return fail(ErrRuntimeUnavailable)
	}
	materializationID := uuid.NewSHA1(uuid.NameSpaceOID, []byte(strings.Join([]string{
		claim.TenantID, claim.DocumentID, claim.VersionID, claim.SHA256,
	}, "\x00"))).String()
	allowedAssetIDs := []string{}
	materializationBytes := sourceBytes
	prepared, prepareErr := PrepareImport(sourceBytes)
	if prepareErr != nil {
		return fail(markdownError(prepareErr))
	}
	if len(prepared.Assets) > 0 {
		assetIDs := make(map[string]string, len(prepared.Assets))
		for _, asset := range prepared.Assets {
			assetIdentity := sha256.Sum256([]byte(materializationID + "\x00" + asset.Key))
			planned, planErr := worker.documents.planNativeImportAsset(ctx, PlanAssetInput{
				ActorID: claim.ActorID, TenantID: claim.TenantID, DocumentID: claim.DocumentID,
				Filename: asset.Filename, MediaType: asset.MediaType, SHA256: asset.SHA256,
				SizeBytes: int64(len(asset.Contents)), IdempotencyKey: "native-import:" + hex.EncodeToString(assetIdentity[:]),
			})
			if planErr != nil {
				return fail(planErr)
			}
			uploaded, uploadErr := worker.documents.uploadNativeImportAsset(ctx, UploadAssetInput{
				ActorID: claim.ActorID, AssetID: planned.Asset.ID, Contents: bytes.NewReader(asset.Contents),
			})
			if uploadErr != nil || uploaded.Asset.Status != "available" {
				return fail(errors.Join(ErrAssetUnavailable, uploadErr))
			}
			assetIDs[asset.Key] = uploaded.Asset.ID
			allowedAssetIDs = append(allowedAssetIDs, uploaded.Asset.ID)
		}
		slices.Sort(allowedAssetIDs)
		materializationBytes, err = prepared.Rewrite(assetIDs)
		if err != nil {
			return fail(markdownError(err))
		}
	}

	computed, err := worker.documents.runtime.Import(ctx, ImportRequest{
		OperationID: materializationID, SourceKind: importMarkdown,
		SourceBytes: materializationBytes, AllowedAssetIDs: allowedAssetIDs,
	})
	if err != nil {
		return fail(err)
	}
	if !validNativeMaterialization(computed, allowedAssetIDs) {
		return fail(ErrRuntimeResultInvalid)
	}
	if err := requireStateBundleBudget(
		computed.StateBytes,
		computed.StateVector,
		computed.CompleteAssetIDs,
		computed.CompleteThreadIDs,
	); err != nil {
		return fail(err)
	}
	if err := worker.complete(ctx, tx, claim, materializationID, allowedAssetIDs, computed); err != nil {
		return fail(err)
	}
	if err := tx.Commit(ctx); err != nil {
		return fail(err)
	}
	return true, nil
}

func terminalNativeImportFailure(err error) bool {
	return errors.Is(err, ErrInvalidInput) || errors.Is(err, ErrAssetContentMismatch) ||
		errors.Is(err, ErrAssetQuarantined) || errors.Is(err, ErrAssetQuotaExceeded) ||
		errors.Is(err, ErrRecoveryBudgetExceeded)
}

func nativeImportRetryDelay(attempt int) time.Duration {
	shift := min(max(attempt-1, 0), 8)
	return time.Duration(1<<shift) * time.Second
}

// lock claims the pending import for tx. A transaction-scoped advisory lock is
// the claim: it blocks the other path until tx ends without holding the
// Document row, which asset uploads lock meanwhile. An import that is
// completed or failed by then, or that does not exist, is done.
func (worker *NativeImportMigrationWorker) lock(ctx context.Context, tx pgx.Tx, documentID string) (nativeImportClaim, bool, error) {
	var claimed bool
	if err := tx.QueryRow(ctx, `SELECT pg_try_advisory_xact_lock(hashtextextended($1,0))`,
		"document-native-import|"+documentID).Scan(&claimed); err != nil {
		return nativeImportClaim{}, false, err
	}
	if !claimed {
		return nativeImportClaim{}, false, errNativeImportBusy
	}
	var claim nativeImportClaim
	err := tx.QueryRow(ctx, `SELECT document.id,document.tenant_id,document.native_import_source_version_id,
		version.content_object_id,version.sha256,version.size_bytes,version.filename,
		document.owner_actor_id
		FROM documents document
		JOIN document_versions version ON version.id=document.native_import_source_version_id
		 AND version.tenant_id=document.tenant_id AND version.document_id=document.id
		JOIN actors actor ON actor.id=document.owner_actor_id AND actor.tenant_id=document.tenant_id
		WHERE document.id=$1 AND document.native_import_status='pending'`, documentID).Scan(
		&claim.DocumentID, &claim.TenantID, &claim.VersionID,
		&claim.ObjectID, &claim.SHA256, &claim.SizeBytes, &claim.Filename, &claim.ActorID,
	)
	if err == nil {
		return claim, true, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return nativeImportClaim{}, false, err
	}
	return nativeImportClaim{}, false, nil
}

// startNativeImportTx marks a just-uploaded Markdown Version as the pending
// import of its Document. Only one import ever starts per Document; when
// alreadyStarted is allowed, a Document that has one keeps it.
func startNativeImportTx(ctx context.Context, tx pgx.Tx, tenantID, documentID, versionID string, alreadyStarted bool) error {
	command, err := tx.Exec(ctx, `UPDATE documents
		SET native_import_status='pending',native_import_source_version_id=$3
		WHERE id=$1 AND tenant_id=$2 AND native_import_status IS NULL`, documentID, tenantID, versionID)
	if err != nil {
		return err
	}
	if command.RowsAffected() != 1 && !alreadyStarted {
		return fmt.Errorf("start Native import: %w", ErrConflict)
	}
	return nil
}

func (worker *NativeImportMigrationWorker) complete(
	ctx context.Context,
	tx pgx.Tx,
	claim nativeImportClaim,
	materializationID string,
	assetIDs []string,
	computed ImportedState,
) error {
	var format, currentVersionID string
	if err := tx.QueryRow(ctx, `SELECT document.format,document.current_version_id
		FROM documents document
		WHERE document.id=$1 AND document.tenant_id=$2
		FOR NO KEY UPDATE`, claim.DocumentID, claim.TenantID).Scan(&format, &currentVersionID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrConflict
		}
		return err
	}
	if (format != "markdown" && format != "md") || currentVersionID != claim.VersionID {
		return ErrConflict
	}
	revisionID := stableCreateID("document_revision_", claim.DocumentID, materializationID)
	manifest, err := worker.documents.restoreAssetManifest(ctx, tx, claim.TenantID, claim.DocumentID, assetIDs)
	if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO document_revisions(
		id,tenant_id,document_id,persisted_seq,state_vector,full_state_fingerprint,
		state_status,state_bytes,state_bytes_sha256,asset_manifest,thread_manifest,created_by_actor_id
	) VALUES($1,$2,$3,0,$4,$5,'available',$6,$7,$8,$9,$10)
	ON CONFLICT (id) DO NOTHING`, revisionID, claim.TenantID, claim.DocumentID,
		computed.StateVector, computed.FullStateFingerprint, computed.StateBytes,
		computed.StateBytesSHA256, manifest, computed.CompleteThreadIDs, claim.ActorID); err != nil {
		return err
	}
	title := claim.Filename
	if base := strings.TrimSuffix(claim.Filename, filepath.Ext(claim.Filename)); base != "" {
		title = base
	}
	if _, err := tx.Exec(ctx, `UPDATE documents SET title=$3,format='blocknote',
		native_representation_format='markdown',current_version_id=NULL,updated_at=GREATEST(updated_at,clock_timestamp())
		WHERE id=$1 AND tenant_id=$2`, claim.DocumentID, claim.TenantID, title); err != nil {
		return err
	}
	if err := insertBodyTx(ctx, tx, claim.DocumentID, computed.StateBytes, computed.StateVector,
		assetIDs, computed.CompleteThreadIDs, claim.ActorID); err != nil {
		return err
	}
	result, err := tx.Exec(ctx, `UPDATE documents
		SET native_import_status='completed'
		WHERE id=$1 AND tenant_id=$2 AND native_import_status='pending'`,
		claim.DocumentID, claim.TenantID)
	if err != nil {
		return err
	}
	if result.RowsAffected() != 1 {
		return fmt.Errorf("complete Native import migration: %w", ErrConflict)
	}
	// Readers learn that the uploaded file became an editable Draft.
	return appendDocumentEvent(ctx, tx, claim.TenantID, claim.DocumentID, claim.ActorID,
		stableCreateID("document_event_native_import_", claim.DocumentID, claim.VersionID),
		"native_import", claim.VersionID, "document.draft_updated")
}
