package document

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"slices"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	artifactstore "github.com/simplexai-labs/linger/apps/teamhub/internal/artifact"
)

type latestProjectionCandidate struct {
	documentID, revisionID, representationFormat string
}

type LatestRuntimeProjection struct {
	DocumentID, Filename, MediaType, SHA256 string
	Bytes                                   []byte
}

// LatestDocumentRuntimeProjection returns the exact current readable
// serialization.
func (s *Service) LatestDocumentRuntimeProjection(
	ctx context.Context,
	documentID string,
) (LatestRuntimeProjection, error) {
	if s == nil || s.pool == nil || s.runtime == nil || s.objects == nil || documentID == "" {
		return LatestRuntimeProjection{}, ErrInvalidInput
	}
	var tenantID string
	for attempt := 0; attempt < 3; attempt++ {
		var candidate latestProjectionCandidate
		candidate.representationFormat = "markdown"
		// The snapshot copies a body edited since its last Revision, so the
		// projection pins the state it renders.
		err := s.pool.QueryRow(ctx, `SELECT document.tenant_id,body.document_id,snapshot_document_body(body.document_id)
			FROM documents document
			JOIN document_bodies body ON body.document_id=document.id
			WHERE document.id=$1 AND document.status='active' AND document.format='blocknote'`,
			documentID).Scan(&tenantID, &candidate.documentID, &candidate.revisionID)
		if errors.Is(err, pgx.ErrNoRows) {
			return LatestRuntimeProjection{}, ErrNotFound
		}
		if err != nil {
			return LatestRuntimeProjection{}, err
		}
		var current bool
		if err := s.pool.QueryRow(ctx, `SELECT EXISTS(
			SELECT 1 FROM document_latest_projections projection
			WHERE projection.tenant_id=$1 AND projection.document_id=$2
			  AND projection.revision_id=$3 AND projection.representation_format='markdown'
		)`, tenantID, candidate.documentID, candidate.revisionID).Scan(&current); err != nil {
			return LatestRuntimeProjection{}, err
		}
		if !current {
			settled, err := s.ensureLatestProjection(ctx, tenantID, candidate)
			if err != nil {
				return LatestRuntimeProjection{}, err
			}
			if !settled {
				continue
			}
		}
		projection, err := s.readLatestRuntimeProjection(ctx, tenantID, documentID, candidate.revisionID)
		if errors.Is(err, ErrConflict) {
			continue
		}
		return projection, err
	}
	return LatestRuntimeProjection{}, ErrConflict
}

func (s *Service) readLatestRuntimeProjection(
	ctx context.Context,
	tenantID, documentID, revisionID string,
) (LatestRuntimeProjection, error) {
	var result LatestRuntimeProjection
	var objectKey string
	var sizeBytes int64
	err := s.pool.QueryRow(ctx, `SELECT projection.document_id,projection.filename,
		projection.media_type,projection.sha256,projection.content_object_id,projection.size_bytes
		FROM document_latest_projections projection
			WHERE projection.revision_id=current_document_revision_id(projection.document_id)
			  AND projection.tenant_id=$1 AND projection.document_id=$2 AND projection.revision_id=$3
			  AND projection.representation_format='markdown'`,
		tenantID, documentID, revisionID).Scan(
		&result.DocumentID, &result.Filename, &result.MediaType, &result.SHA256,
		&objectKey, &sizeBytes,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return LatestRuntimeProjection{}, ErrConflict
	}
	if err != nil {
		return LatestRuntimeProjection{}, err
	}
	projectionContent := LatestDownloadContent{
		Filename: result.Filename, MediaType: result.MediaType, ObjectKey: objectKey,
		SHA256: result.SHA256, SizeBytes: sizeBytes,
	}
	invalidate := func() (LatestRuntimeProjection, error) {
		if err := s.invalidateLatestProjection(
			ctx, tenantID, documentID, revisionID, "markdown", projectionContent,
		); err != nil {
			return LatestRuntimeProjection{}, errors.Join(ErrObjectStoreUnavailable, err)
		}
		return LatestRuntimeProjection{}, ErrConflict
	}
	object, err := s.objects.Head(ctx, objectKey)
	if errors.Is(err, os.ErrNotExist) {
		return invalidate()
	}
	if err != nil {
		return LatestRuntimeProjection{}, errors.Join(ErrObjectStoreUnavailable, err)
	}
	want, decodeErr := hex.DecodeString(result.SHA256)
	if decodeErr != nil || object.Key != objectKey || object.Size != sizeBytes || sizeBytes > 32<<20 ||
		!bytes.Equal(object.SHA256[:], want) {
		return invalidate()
	}
	reader, err := s.objects.Open(ctx, objectKey)
	if errors.Is(err, os.ErrNotExist) {
		return invalidate()
	}
	if err != nil {
		return LatestRuntimeProjection{}, errors.Join(ErrObjectStoreUnavailable, err)
	}
	result.Bytes, err = io.ReadAll(io.LimitReader(reader, sizeBytes+1))
	closeErr := reader.Close()
	if err != nil {
		return LatestRuntimeProjection{}, errors.Join(ErrObjectStoreUnavailable, err)
	}
	if closeErr != nil {
		return LatestRuntimeProjection{}, errors.Join(ErrObjectStoreUnavailable, closeErr)
	}
	if int64(len(result.Bytes)) != sizeBytes || documentBytesHash(result.Bytes) != result.SHA256 {
		return invalidate()
	}
	return result, nil
}

func retryOnDocumentSerializationFailure(fn func() error) error {
	var err error
	for attempt := 0; attempt < 3; attempt++ {
		err = fn()
		if !isDocumentSerializationFailure(err) || attempt == 2 {
			return err
		}
	}
	return err
}

func (s *Service) storeAndSettleLatestProjection(
	ctx context.Context,
	tenantID string,
	candidate latestProjectionCandidate,
	projection ExportRuntimeResult,
) (bool, error) {
	var settled bool
	err := retryOnDocumentSerializationFailure(func() error {
		var settleErr error
		settled, settleErr = s.storeAndSettleLatestProjectionOnce(
			ctx, tenantID, candidate, projection,
		)
		return settleErr
	})
	return settled, err
}

func (s *Service) lockLatestProjectionObject(ctx context.Context, objectKey string) (*pgxpool.Conn, error) {
	connection, err := s.pool.Acquire(ctx)
	if err != nil {
		return nil, err
	}
	if _, err := connection.Exec(ctx, `SELECT pg_advisory_lock(hashtextextended('document-latest-object:' || $1,0))`, objectKey); err != nil {
		discardPoolConnection(connection)
		return nil, err
	}
	return connection, nil
}

func (s *Service) storeAndSettleLatestProjectionOnce(
	ctx context.Context,
	tenantID string,
	candidate latestProjectionCandidate,
	projection ExportRuntimeResult,
) (bool, error) {
	digest := sha256.Sum256(projection.Bytes)
	objectKey := stableCreateID(
		"object_", "document_latest", candidate.documentID, candidate.revisionID,
		candidate.representationFormat, projection.SHA256,
	)
	// The object lock spans upload and settlement. GC only tries this lock and
	// backs off, so it never waits while holding a cleanup job or document lock.
	connection, err := s.lockLatestProjectionObject(ctx, objectKey)
	if err != nil {
		return false, err
	}
	discardConnection := false
	defer func() {
		if discardConnection {
			discardPoolConnection(connection)
		} else {
			connection.Release()
		}
	}()
	defer func() {
		unlockContext, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		var unlocked bool
		if err := connection.QueryRow(unlockContext, `SELECT pg_advisory_unlock(
			hashtextextended('document-latest-object:' || $1,0)
		)`, objectKey).Scan(&unlocked); err != nil || !unlocked {
			discardConnection = true
		}
	}()
	cleanupIntentTx, err := connection.Begin(ctx)
	if err != nil {
		return false, err
	}
	if err := s.enqueueLatestProjectionObjectCleanupTx(ctx, cleanupIntentTx, objectKey); err != nil {
		_ = cleanupIntentTx.Rollback(ctx)
		return false, err
	}
	if err := cleanupIntentTx.Commit(ctx); err != nil {
		return false, err
	}
	object, _, err := s.objects.PutIfAbsent(
		ctx, objectKey, bytes.NewReader(projection.Bytes), projection.SizeBytes, digest,
	)
	if errors.Is(err, artifactstore.ErrObjectConflict) {
		if err := artifactstore.DeleteDetached(ctx, s.objects, objectKey); err != nil {
			return false, err
		}
		object, _, err = s.objects.PutIfAbsent(
			ctx, objectKey, bytes.NewReader(projection.Bytes), projection.SizeBytes, digest,
		)
	}
	if err != nil {
		return false, errors.Join(ErrObjectStoreUnavailable, err)
	}
	if object.Key != objectKey || object.Size != projection.SizeBytes || object.SHA256 != digest {
		return false, ErrObjectStoreUnavailable
	}
	tx, err := connection.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(
		hashtextextended('document-latest-document:' || $1 || ':' || $2,0)
	)`, tenantID, candidate.documentID); err != nil {
		return false, err
	}
	var previousObjectKey string
	err = tx.QueryRow(ctx, `SELECT content_object_id FROM document_latest_projections
		WHERE tenant_id=$1 AND document_id=$2 AND representation_format=$3 FOR UPDATE`,
		tenantID, candidate.documentID, candidate.representationFormat).Scan(&previousObjectKey)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return false, err
	}
	command, err := tx.Exec(ctx, `INSERT INTO document_latest_projections(
			tenant_id,document_id,revision_id,persisted_seq,full_state_fingerprint,
			filename,media_type,content_object_id,size_bytes,sha256,input_schema_version,
			representation_format
		)
		SELECT revision.tenant_id,revision.document_id,revision.id,revision.persisted_seq,
		       revision.full_state_fingerprint,$4,$5,$6,$7,$8,1,$9
		FROM document_revisions revision
		WHERE revision.tenant_id=$1 AND revision.document_id=$2 AND revision.id=$3
		  AND revision.state_status='available'
		  AND revision.id=current_document_revision_id($2)
		ON CONFLICT (tenant_id,document_id,representation_format) DO UPDATE
		SET revision_id=excluded.revision_id,
		    persisted_seq=excluded.persisted_seq,
		    full_state_fingerprint=excluded.full_state_fingerprint,
		    filename=excluded.filename,
		    media_type=excluded.media_type,
		    content_object_id=excluded.content_object_id,
		    size_bytes=excluded.size_bytes,
		    sha256=excluded.sha256,
		    input_schema_version=excluded.input_schema_version,
		    updated_at=clock_timestamp()`,
		tenantID, candidate.documentID, candidate.revisionID,
		latestProjectionFilename(candidate.representationFormat), projection.MediaType,
		objectKey, projection.SizeBytes, projection.SHA256, candidate.representationFormat)
	if err != nil {
		return false, err
	}
	settled := command.RowsAffected() == 1
	if settled && previousObjectKey != "" && previousObjectKey != objectKey {
		if err := s.enqueueLatestProjectionObjectCleanupTx(ctx, tx, previousObjectKey); err != nil {
			return false, err
		}

	}
	if !settled {
		if err := s.enqueueLatestProjectionObjectCleanupTx(ctx, tx, objectKey); err != nil {
			return false, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return false, err
	}
	return settled, nil
}

func latestProjectionFilename(format string) string {
	switch format {
	case "html":
		return "latest.html"
	case "blocks":
		return "latest.json"
	case "plain_text":
		return "latest.txt"
	default:
		return "latest.md"
	}
}

func (s *Service) renderRevisionProjection(
	ctx context.Context,
	tenantID string,
	candidate latestProjectionCandidate,
) (ExportRuntimeResult, error) {
	if s.runtime == nil {
		return ExportRuntimeResult{}, ErrRuntimeUnavailable
	}
	if candidate.representationFormat == "markdown" {
		contents, digest, err := s.renderRevisionMarkdown(ctx, candidate.documentID, candidate.revisionID)
		if err != nil {
			return ExportRuntimeResult{}, err
		}
		return ExportRuntimeResult{
			MediaType: "text/markdown", Bytes: contents, SizeBytes: int64(len(contents)),
			SHA256: digest, CompleteAssetIDs: []string{}, CompleteThreadIDs: []string{},
			Warnings: []string{},
		}, nil
	}
	plan, err := s.loadRevisionProjectionPlan(ctx, tenantID, candidate.documentID, candidate.revisionID)
	if err != nil {
		return ExportRuntimeResult{}, err
	}
	assetIDs := make([]string, len(plan.Assets))
	for index := range plan.Assets {
		assetIDs[index] = plan.Assets[index].ID
	}
	result, err := s.runtime.Export(ctx, ExportRuntimeRequest{
		RevisionID: candidate.revisionID, RepresentationFormat: candidate.representationFormat,
		StateBytes: plan.StateBytes, StateBytesSHA256: plan.StateBytesSHA256,
		StateVector: plan.StateVector, FullStateFingerprint: plan.FullStateFingerprint,
		StateHashVersion: 1, AssetManifest: plan.Assets, CompleteAssetIDs: assetIDs,
		CompleteThreadIDs: plan.CompleteThreadIDs, Warnings: []string{},
	})
	if err != nil {
		return ExportRuntimeResult{}, errors.Join(ErrRuntimeUnavailable, err)
	}
	if !validExportRuntimeResult(candidate.representationFormat, assetIDs, plan.CompleteThreadIDs, result) {
		return ExportRuntimeResult{}, ErrRevisionUnavailable
	}
	return result, nil
}

func (s *Service) loadRevisionProjectionPlan(
	ctx context.Context,
	tenantID, documentID, revisionID string,
) (exportPlan, error) {
	plan := exportPlan{TenantID: tenantID, RevisionID: revisionID}
	var manifestJSON []byte
	err := s.pool.QueryRow(ctx, `SELECT revision.state_bytes,revision.state_bytes_sha256,
		revision.state_vector,revision.full_state_fingerprint,revision.asset_manifest,
		revision.thread_manifest
		FROM document_revisions revision
		JOIN documents document ON document.id=revision.document_id
		 AND document.tenant_id=revision.tenant_id AND document.status='active'
		WHERE revision.id=$1 AND revision.tenant_id=$2 AND revision.document_id=$3
		 AND revision.state_status='available'`, revisionID, tenantID, documentID).Scan(
		&plan.StateBytes, &plan.StateBytesSHA256, &plan.StateVector,
		&plan.FullStateFingerprint, &manifestJSON, &plan.CompleteThreadIDs,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return exportPlan{}, ErrRevisionUnavailable
	}
	if err != nil || documentBytesHash(plan.StateBytes) != plan.StateBytesSHA256 {
		if err != nil {
			return exportPlan{}, err
		}
		return exportPlan{}, ErrRevisionUnavailable
	}
	manifest, err := decodeHistoryAssetManifest(manifestJSON)
	if err != nil {
		return exportPlan{}, ErrRevisionUnavailable
	}
	slices.SortFunc(manifest, func(left, right HistoryAsset) int {
		return strings.Compare(left.AssetID, right.AssetID)
	})
	for _, item := range manifest {
		var asset ExportAsset
		err := s.pool.QueryRow(ctx, `SELECT id,filename,media_type,sha256,size_bytes
			FROM document_assets WHERE id=$1 AND tenant_id=$2 AND document_id=$3
			 AND sha256=$4 AND size_bytes=$5 AND status='available'`, item.AssetID,
			tenantID, documentID, item.SHA256, item.SizeBytes).Scan(
			&asset.ID, &asset.Filename, &asset.MediaType, &asset.SHA256, &asset.SizeBytes,
		)
		if errors.Is(err, pgx.ErrNoRows) {
			return exportPlan{}, ErrRevisionUnavailable
		}
		if err != nil {
			return exportPlan{}, err
		}
		plan.Assets = append(plan.Assets, asset)
	}
	if plan.Assets == nil {
		plan.Assets = []ExportAsset{}
	}
	if plan.CompleteThreadIDs == nil {
		plan.CompleteThreadIDs = []string{}
	}
	return plan, nil
}

// discardPoolConnection closes a connection whose advisory lock state is
// unknown instead of returning it to the pool.
func discardPoolConnection(connection *pgxpool.Conn) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = connection.Hijack().Close(ctx)
}
