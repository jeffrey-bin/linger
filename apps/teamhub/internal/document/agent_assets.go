package document

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"mime"
	"net/http"
	"path"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
)

// Agents place images and files in an existing native Document in two steps:
// upload the bytes here as an available Asset, then reference it from one
// image or file edit, which admission pins for that mutation.
const (
	MaxAgentAssetBytes = 15 << 20
	// MaxAgentImageBytes bounds an image; files may use the whole limit.
	MaxAgentImageBytes = 10 << 20
)

var agentImageMediaTypes = map[string]bool{
	"image/png": true, "image/jpeg": true, "image/gif": true, "image/webp": true,
}

// agentFileMediaTypes names, by file extension, the type a file of a sniffed
// kind is stored as. The bytes decide the kind; the extension only refines a
// container (an Office file is a ZIP, a CSV is text) and never widens it.
var agentFileMediaTypes = map[string]map[string]string{
	"application/pdf": {"": "application/pdf"},
	"application/zip": {
		"": "application/zip", ".zip": "application/zip",
		".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
		".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
	},
	"text/plain": {"": "text/plain", ".csv": "text/csv", ".md": "text/markdown", ".txt": "text/plain"},
}

// agentAssetMediaType is the type an Agent's upload is stored as, or "" when
// it is neither a supported image nor a supported file.
func agentAssetMediaType(contents []byte, filename string) string {
	sniffed, _, err := mime.ParseMediaType(http.DetectContentType(contents))
	if err != nil {
		return ""
	}
	if agentImageMediaTypes[sniffed] {
		if len(contents) > MaxAgentImageBytes {
			return ""
		}
		return sniffed
	}
	byExtension, ok := agentFileMediaTypes[sniffed]
	if !ok {
		return ""
	}
	if mediaType, ok := byExtension[strings.ToLower(path.Ext(filename))]; ok {
		return mediaType
	}
	return byExtension[""]
}

type CreateAgentAssetInput struct {
	TenantID, AgentID, DocumentID, Filename, OperationID string
	Contents                                             io.Reader
}

type AgentAssetResult struct {
	Asset    Asset
	Replayed bool
}

// agentDocumentAccess joins the Agent's current access to the Document.
const agentDocumentAccess = `
	JOIN resolve_agent_document_access_v2($1,document.id) access
	  ON access.tenant_id=document.tenant_id`

func (s *Service) CreateAgentAsset(ctx context.Context, input CreateAgentAssetInput) (AgentAssetResult, error) {
	if input.AgentID == "" || input.TenantID == "" || input.Contents == nil || s.objects == nil {
		return AgentAssetResult{}, ErrInvalidInput
	}
	contents, err := io.ReadAll(io.LimitReader(input.Contents, MaxAgentAssetBytes+1))
	if err != nil {
		return AgentAssetResult{}, err
	}
	if len(contents) > MaxAgentAssetBytes {
		return AgentAssetResult{}, ErrAssetQuotaExceeded
	}
	// The bytes decide the type; a filename or claimed type cannot.
	mediaType := agentAssetMediaType(contents, input.Filename)
	if mediaType == "" {
		return AgentAssetResult{}, ErrInvalidInput
	}
	digest := sha256.Sum256(contents)
	plan := PlanAssetInput{
		TenantID: input.TenantID, DocumentID: input.DocumentID, Filename: input.Filename,
		MediaType: mediaType, SHA256: hex.EncodeToString(digest[:]),
		SizeBytes: int64(len(contents)), IdempotencyKey: input.OperationID,
	}
	if !s.validAssetPlanPayload(plan) {
		return AgentAssetResult{}, ErrInvalidInput
	}
	planned, err := s.planAgentAsset(ctx, input.AgentID, plan)
	if err != nil {
		return AgentAssetResult{}, err
	}
	if planned.Replay && planned.Asset.Status == "available" {
		return AgentAssetResult{Asset: planned.Asset, Replayed: true}, nil
	}
	record, attemptID, tokenHash, replay, err := s.acquireAssetUploadWithQuery(ctx, input.AgentID, planned.Asset.ID, `
		JOIN documents document ON document.id=asset.document_id AND document.tenant_id=asset.tenant_id`+
		agentDocumentAccess+`
		WHERE asset.id=$2 AND asset.created_by_actor_id=access.actor_id
		  AND document.status='active' AND document.format='blocknote' AND access.can_write`)
	if err != nil {
		return AgentAssetResult{}, err
	}
	stored, err := s.storeAssetUpload(ctx, bytes.NewReader(contents), record, attemptID, tokenHash, replay)
	if err != nil {
		return AgentAssetResult{}, err
	}
	return AgentAssetResult{Asset: stored.Asset, Replayed: planned.Replay}, nil
}

// planAgentAsset records the planned Asset under the Agent's write access.
// The same operation replays the same Asset; other content is a conflict.
func (s *Service) planAgentAsset(ctx context.Context, agentID string, input PlanAssetInput) (AssetResult, error) {
	evidence := strings.Join([]string{input.DocumentID, input.Filename, input.MediaType,
		strconv.FormatInt(input.SizeBytes, 10), input.SHA256}, "\x00")
	requestHash := sha256.Sum256([]byte(evidence))
	assetID := stableCreateID("document_asset_", input.DocumentID, "agent:"+input.IdempotencyKey)
	objectID := assetObjectID(assetID)
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return AssetResult{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,
		"document-agent-asset|"+assetID); err != nil {
		return AssetResult{}, err
	}
	var tenantID, actorID string
	err = tx.QueryRow(ctx, `SELECT document.tenant_id,access.actor_id FROM documents document`+
		agentDocumentAccess+`
		WHERE document.id=$2 AND document.tenant_id=$3 AND document.status='active'
		  AND document.format='blocknote' AND access.can_write
		FOR UPDATE OF document`, agentID, input.DocumentID, input.TenantID).Scan(&tenantID, &actorID)
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
			existing.SizeBytes != input.SizeBytes || existing.CreatorActorID != actorID {
			return AssetResult{}, ErrIdempotencyConflict
		}
		if err := tx.Commit(ctx); err != nil {
			return AssetResult{}, err
		}
		return AssetResult{Asset: existing.Asset, Replay: true}, nil
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
		input.DocumentID, actorID, requestHash[:], input.Filename, input.MediaType,
		input.SHA256, input.SizeBytes, objectID))
	if err != nil {
		return AssetResult{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return AssetResult{}, err
	}
	return AssetResult{Asset: record.Asset}, nil
}

// OpenAgentAssetContent returns an Asset of a Document the Agent can read.
func (s *Service) OpenAgentAssetContent(ctx context.Context, tenantID, agentID, documentID, assetID string) (AssetContent, error) {
	if s.objects == nil {
		return AssetContent{}, ErrAssetUnavailable
	}
	record, err := scanAsset(s.pool.QueryRow(ctx, `SELECT asset.id,asset.document_id,asset.filename,
		asset.media_type,asset.sha256,asset.size_bytes,asset.status,asset.created_at,asset.updated_at,
		asset.tenant_id,coalesce(asset.created_by_actor_id,''),asset.content_object_id,
		asset.upload_attempt_id,asset.upload_lease_token_hash,asset.upload_lease_expires_at
		FROM document_assets asset
		JOIN documents document ON document.id=asset.document_id AND document.tenant_id=asset.tenant_id`+
		agentDocumentAccess+`
		WHERE asset.id=$4 AND document.id=$2 AND document.tenant_id=$3
		  AND document.status='active' AND access.can_read`,
		agentID, documentID, tenantID, assetID))
	if errors.Is(err, pgx.ErrNoRows) {
		return AssetContent{}, ErrNotFound
	}
	if err != nil {
		return AssetContent{}, err
	}
	if record.Status == "quarantined" {
		return AssetContent{}, ErrAssetQuarantined
	}
	if record.Status != "available" && record.Status != "gc_pending" {
		return AssetContent{}, ErrAssetUnavailable
	}
	reader, err := s.objects.Open(ctx, record.ObjectID)
	if err != nil {
		return AssetContent{}, err
	}
	return AssetContent{Asset: record.Asset, Reader: reader}, nil
}
