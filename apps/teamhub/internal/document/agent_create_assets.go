package document

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"slices"

	"github.com/jackc/pgx/v5"
	artifactstore "github.com/simplexai-labs/linger/apps/teamhub/internal/artifact"
)

// agentDocumentAsset is one embedded image of an Agent's Markdown, stored
// under an Asset ID derived from the creation command.
type agentDocumentAsset struct {
	Plan     PlanAssetInput
	Contents []byte
}

// planAgentDocumentAssets names the embedded images of an Agent's Markdown and
// returns the import that places them. The IDs derive from the creation
// command, so a retry names the same Assets.
func (s *Service) planAgentDocumentAssets(commandID, documentID, markdown string, prepared Import,
) (ImportRequest, []agentDocumentAsset, error) {
	request := ImportRequest{
		OperationID: agentImportID(commandID), SourceKind: importMarkdown,
		SourceBytes: []byte(markdown),
	}
	if len(prepared.Assets) == 0 {
		return request, nil, nil
	}
	ids := make(map[string]string, len(prepared.Assets))
	assets := make([]agentDocumentAsset, 0, len(prepared.Assets))
	for _, asset := range prepared.Assets {
		assetID := stableCreateID("document_asset_", commandID, asset.Key)
		plan := PlanAssetInput{DocumentID: documentID, Filename: asset.Filename, MediaType: asset.MediaType,
			SHA256: asset.SHA256, SizeBytes: int64(len(asset.Contents)), IdempotencyKey: assetID}
		if !s.validAssetPlanPayload(plan) {
			return request, nil, ErrInvalidInput
		}
		ids[asset.Key] = assetID
		assets = append(assets, agentDocumentAsset{Plan: plan, Contents: asset.Contents})
		request.AllowedAssetIDs = append(request.AllowedAssetIDs, assetID)
	}
	rewritten, err := prepared.Rewrite(ids)
	if err != nil {
		return request, nil, markdownError(err)
	}
	request.SourceBytes = rewritten
	slices.Sort(request.AllowedAssetIDs)
	return request, assets, nil
}

// storeAgentDocumentAssets stores the images right before the transaction
// that records them, so a rejected import stores nothing; an image of a
// creation whose transaction then fails stays only in the object store, where
// the retry finds it.
func (s *Service) storeAgentDocumentAssets(ctx context.Context, assets []agentDocumentAsset) error {
	for _, asset := range assets {
		expected := sha256.Sum256(asset.Contents)
		_, _, err := s.objects.PutIfAbsent(ctx, assetObjectID(asset.Plan.IdempotencyKey),
			bytes.NewReader(asset.Contents), int64(len(asset.Contents)), expected)
		if errors.Is(err, artifactstore.ErrObjectConflict) {
			return ErrAssetQuarantined
		}
		if err != nil {
			return err
		}
	}
	return nil
}

// insertAgentDocumentAssets admits and records the stored images the imported
// state references and returns the Revision Asset manifest.
func (s *Service) insertAgentDocumentAssets(ctx context.Context, tx pgx.Tx,
	tenantID, agentActorID, documentID string, assets []agentDocumentAsset, assetIDs []string,
) ([]byte, error) {
	if len(assetIDs) == 0 {
		return []byte("[]"), nil
	}
	stored := make([]string, 0, len(assets))
	for _, asset := range assets {
		stored = append(stored, asset.Plan.IdempotencyKey)
	}
	slices.Sort(stored)
	if !slices.Equal(stored, assetIDs) {
		return nil, ErrAssetUnavailable
	}
	for _, item := range assets {
		asset := item.Plan
		if err := s.admitAsset(ctx, tx, tenantID, asset); err != nil {
			return nil, err
		}
		if _, err := tx.Exec(ctx, `INSERT INTO document_assets
			(id,tenant_id,document_id,created_by_actor_id,filename,media_type,sha256,size_bytes,content_object_id,
			status,stored_at,available_at)
			VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'available',clock_timestamp(),clock_timestamp())`,
			asset.IdempotencyKey, tenantID, documentID, agentActorID, asset.Filename, asset.MediaType,
			asset.SHA256, asset.SizeBytes, assetObjectID(asset.IdempotencyKey)); err != nil {
			return nil, err
		}
	}
	return s.restoreAssetManifest(ctx, tx, tenantID, documentID, assetIDs)
}
