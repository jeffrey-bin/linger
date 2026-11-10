package document

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
)

func (s *Service) planNativeImportAsset(ctx context.Context, input PlanAssetInput) (AssetResult, error) {
	input.MediaType = strings.ToLower(strings.TrimSpace(input.MediaType))
	if input.ActorID == "" || input.TenantID == "" || !s.validAssetPlanPayload(input) {
		return AssetResult{}, ErrInvalidInput
	}
	evidence := strings.Join([]string{input.DocumentID, input.Filename, input.MediaType,
		strconv.FormatInt(input.SizeBytes, 10), input.SHA256}, "\x00")
	requestHash := sha256.Sum256([]byte(evidence))
	assetID := stableCreateID("document_asset_", input.DocumentID, input.IdempotencyKey)
	objectID := assetObjectID(assetID)
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return AssetResult{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,
		"document-native-import-asset|"+assetID); err != nil {
		return AssetResult{}, err
	}
	var tenantID string
	err = tx.QueryRow(ctx, `SELECT document.tenant_id FROM documents document
		WHERE document.native_import_status='pending' AND document.id=$1 AND document.tenant_id=$2 AND document.status='active'
		 AND document.owner_actor_id=$3
		FOR NO KEY UPDATE OF document`, input.DocumentID, input.TenantID, input.ActorID).Scan(&tenantID)
	if errors.Is(err, pgx.ErrNoRows) {
		return AssetResult{}, ErrNotFound
	}
	if err != nil {
		return AssetResult{}, err
	}
	existing, existingErr := scanAsset(tx.QueryRow(ctx, `SELECT id,document_id,filename,media_type,
		sha256,size_bytes,status,created_at,updated_at,tenant_id,coalesce(created_by_actor_id,''),
		content_object_id,upload_attempt_id,upload_lease_token_hash,upload_lease_expires_at
		FROM document_assets WHERE id=$1 FOR UPDATE`, assetID))
	if existingErr == nil {
		if existing.DocumentID != input.DocumentID || existing.Filename != input.Filename ||
			existing.MediaType != input.MediaType || existing.SHA256 != input.SHA256 ||
			existing.SizeBytes != input.SizeBytes || existing.CreatorActorID != input.ActorID {
			return AssetResult{}, ErrIdempotencyConflict
		}
		body, marshalErr := json.Marshal(existing.Asset)
		if marshalErr != nil {
			return AssetResult{}, marshalErr
		}
		if err := tx.Commit(ctx); err != nil {
			return AssetResult{}, err
		}
		return AssetResult{Asset: existing.Asset, Body: body, Replay: true}, nil
	}
	if !errors.Is(existingErr, pgx.ErrNoRows) {
		return AssetResult{}, existingErr
	}
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('document-asset-admission',0))`); err != nil {
		return AssetResult{}, err
	}
	if err = s.admitAssetQuota(ctx, tx, tenantID, input); err != nil {
		return AssetResult{}, err
	}
	record, err := scanAsset(tx.QueryRow(ctx, `INSERT INTO document_assets(
		id,tenant_id,document_id,created_by_actor_id,request_hash,filename,media_type,
		sha256,size_bytes,content_object_id,status
	) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'planned')
	RETURNING id,document_id,filename,media_type,sha256,size_bytes,status,created_at,updated_at,
	 tenant_id,coalesce(created_by_actor_id,''),content_object_id,
	 upload_attempt_id,upload_lease_token_hash,upload_lease_expires_at`, assetID, tenantID,
		input.DocumentID, input.ActorID, requestHash[:], input.Filename, input.MediaType,
		input.SHA256, input.SizeBytes, objectID))
	if err != nil {
		return AssetResult{}, err
	}
	body, err := json.Marshal(record.Asset)
	if err != nil {
		return AssetResult{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return AssetResult{}, err
	}
	return AssetResult{Asset: record.Asset, Body: body}, nil
}

func (s *Service) uploadNativeImportAsset(ctx context.Context, input UploadAssetInput) (AssetResult, error) {
	if input.ActorID == "" || input.AssetID == "" || input.Contents == nil || s.objects == nil {
		return AssetResult{}, ErrInvalidInput
	}
	record, attemptID, tokenHash, replay, err := s.acquireNativeImportAssetUpload(ctx, input.ActorID, input.AssetID)
	if err != nil {
		return AssetResult{}, err
	}
	return s.storeAssetUpload(ctx, input.Contents, record, attemptID, tokenHash, replay)
}

func (s *Service) acquireNativeImportAssetUpload(ctx context.Context, actorID, assetID string) (
	assetRecord, string, []byte, bool, error,
) {
	return s.acquireAssetUploadWithQuery(ctx, actorID, assetID, `
		JOIN documents document ON document.id=asset.document_id AND document.tenant_id=asset.tenant_id
		 AND document.native_import_status='pending'
		WHERE asset.id=$2 AND document.status='active' AND document.owner_actor_id=$1`)
}
