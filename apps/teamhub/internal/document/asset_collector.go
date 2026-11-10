package document

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"time"

	"github.com/jackc/pgx/v5"
)

// assetDeletingRecoveryGrace is how long an asset may stay in deleting before a
// later sweep claims it again. A live sweep finishes or reverts its own claim
// well inside this window, so only a crashed sweep leaves a row this old.
const assetDeletingRecoveryGrace = 5 * time.Minute

type AssetCollectorOptions struct {
	UploadStagingRetention time.Duration
	AssetGCGrace           time.Duration
}

// AssetCollector deletes unreferenced Document assets. The status column is the
// claim: a row is 'deleting' while one sweep owns it, and a crashed sweep's row
// is reclaimed after assetDeletingRecoveryGrace. Deleting a missing object is success.
type AssetCollector struct {
	documents *Service
	options   AssetCollectorOptions
}

type claimedAssetDeletion struct {
	ID, ObjectID, SHA256 string
	PriorStatus          string
}

func NewAssetCollector(documents *Service, options AssetCollectorOptions) *AssetCollector {
	if options.UploadStagingRetention <= 0 {
		options.UploadStagingRetention = 24 * time.Hour
	}
	if options.AssetGCGrace <= 0 {
		options.AssetGCGrace = 24 * time.Hour
	}
	return &AssetCollector{documents: documents, options: options}
}

// RunOne claims one collectible asset and deletes its object. It reports false
// when no asset is collectible. On error the claim is reverted, so the next
// sweep retries it.
func (worker *AssetCollector) RunOne(ctx context.Context) (bool, error) {
	claim, found, err := worker.claim(ctx)
	if err != nil || !found {
		return found, err
	}
	head, err := worker.documents.objects.Head(ctx, claim.ObjectID)
	if errors.Is(err, os.ErrNotExist) {
		return true, worker.finish(ctx, claim)
	}
	if err != nil {
		return true, worker.release(ctx, claim, err)
	}
	if hex.EncodeToString(head.SHA256[:]) != claim.SHA256 {
		return true, worker.quarantine(ctx, claim, head.Size, hex.EncodeToString(head.SHA256[:]))
	}
	if err = worker.documents.objects.Delete(ctx, claim.ObjectID); err != nil {
		return true, worker.release(ctx, claim, err)
	}
	return true, worker.finish(ctx, claim)
}

func (worker *AssetCollector) claim(ctx context.Context) (claimedAssetDeletion, bool, error) {
	var claim claimedAssetDeletion
	err := worker.documents.pool.QueryRow(ctx, `WITH candidate AS (
		SELECT asset.id,asset.status
		FROM document_assets asset
		WHERE (
			(asset.status IN ('planned','stored')
			 AND asset.created_at <= clock_timestamp()-$1::interval
			 AND (asset.upload_attempt_id IS NULL OR asset.upload_lease_expires_at<clock_timestamp()))
			OR (asset.status='available'
			 AND asset.available_at <= clock_timestamp()-$2::interval
			 AND NOT EXISTS (
				SELECT 1 FROM document_bodies body
				WHERE body.document_id=asset.document_id AND asset.id=ANY(body.asset_ids)
			 )
			)
			OR (asset.status='deleting'
			 AND asset.updated_at<=clock_timestamp()-($3::bigint*interval '1 microsecond'))
		)
		AND NOT EXISTS (
		  SELECT 1 FROM documents importing
		  WHERE importing.id=asset.document_id AND importing.tenant_id=asset.tenant_id
		    AND importing.native_import_status='pending'
		)
		ORDER BY asset.created_at,asset.id
		FOR UPDATE OF asset SKIP LOCKED
		LIMIT 1
	)
	UPDATE document_assets asset SET status='deleting',
		gc_after=coalesce(asset.gc_after,clock_timestamp()),
		deletion_identity=coalesce(asset.deletion_identity,'document_asset_deletion_' || asset.id),
		deletion_result='pending',deleting_at=coalesce(asset.deleting_at,clock_timestamp()),
		updated_at=clock_timestamp()
	FROM candidate WHERE asset.id=candidate.id
	RETURNING asset.id,asset.content_object_id,asset.sha256,candidate.status`,
		worker.options.UploadStagingRetention.String(), worker.options.AssetGCGrace.String(),
		assetDeletingRecoveryGrace.Microseconds()).Scan(&claim.ID, &claim.ObjectID, &claim.SHA256, &claim.PriorStatus)
	if errors.Is(err, pgx.ErrNoRows) {
		return claimedAssetDeletion{}, false, nil
	}
	return claim, err == nil, err
}

// release reverts a claim after a failed delete, so the asset returns to its
// prior status. A row that was already deleting keeps that status, and its
// updated_at restarts the recovery grace.
func (worker *AssetCollector) release(ctx context.Context, claim claimedAssetDeletion, cause error) error {
	_, err := worker.documents.pool.Exec(ctx, `UPDATE document_assets SET status=$2,updated_at=clock_timestamp()
	WHERE id=$1 AND status='deleting'`, claim.ID, claim.PriorStatus)
	return errors.Join(cause, err)
}

func (worker *AssetCollector) finish(ctx context.Context, claim claimedAssetDeletion) error {
	result, err := worker.documents.pool.Exec(ctx, `UPDATE document_assets SET status='deleted',
		deleted_at=clock_timestamp(),deletion_result='confirmed_absent',
		failure_code=NULL,failure_evidence_hash=NULL,updated_at=clock_timestamp()
	WHERE id=$1 AND status='deleting'`, claim.ID)
	if err != nil {
		return err
	}
	if result.RowsAffected() != 1 {
		return ErrAssetUnavailable
	}
	return nil
}

func (worker *AssetCollector) quarantine(
	ctx context.Context,
	claim claimedAssetDeletion,
	observedSize int64,
	observedSHA string,
) error {
	evidence := sha256.Sum256([]byte(claim.ID + "\x00" + observedSHA))
	result, err := worker.documents.pool.Exec(ctx, `UPDATE document_assets SET status='quarantined',
		observed_size_bytes=$2,observed_sha256=$3,observed_at=clock_timestamp(),
		deletion_result='hash_conflict',failure_code='delete_hash_conflict',failure_evidence_hash=$4,
		quarantined_at=clock_timestamp(),updated_at=clock_timestamp()
	WHERE id=$1 AND status='deleting'`,
		claim.ID, observedSize, observedSHA, hex.EncodeToString(evidence[:]))
	if err != nil {
		return err
	}
	if result.RowsAffected() != 1 {
		return ErrAssetUnavailable
	}
	return nil
}
