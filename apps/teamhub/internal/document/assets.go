package document

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	artifactstore "github.com/simplexai-labs/linger/apps/teamhub/internal/artifact"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/idempotency"
	"golang.org/x/text/unicode/norm"
)

const documentAssetUploadLease = 5 * time.Minute

var (
	documentAssetKeyPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$`)
	documentAssetSHA256     = regexp.MustCompile(`^[a-f0-9]{64}$`)
)

type AssetOptions struct {
	MaxAssetBytes, MaxDocumentBytes, MaxTenantBytes, StorageReserveBytes int64
	MaxDocumentObjects, MaxTenantObjects                                 int32
}

// assetObjectID derives the object an Asset's bytes are stored under, the same
// for every way a Document gains an Asset, so a retried upload finds its bytes.
func assetObjectID(assetID string) string {
	digest := sha256.Sum256([]byte("linger/room-document/asset-object/" + assetID))
	return "object_" + hex.EncodeToString(digest[:16])
}

// defaultAssetOptions holds the Document Asset quotas, including the free
// space the Artifact filesystem keeps after admitting a plan. Tests replace
// them; a zero option keeps the quota below.
func defaultAssetOptions() AssetOptions {
	return AssetOptions{
		MaxAssetBytes: 50 << 20, MaxDocumentBytes: 512 << 20,
		MaxTenantBytes: 10 << 30, StorageReserveBytes: 1 << 30,
		MaxDocumentObjects: 4096, MaxTenantObjects: 65536,
	}
}

func (s *Service) ConfigureAssets(options AssetOptions) {
	defaults := defaultAssetOptions()
	if options.MaxAssetBytes <= 0 {
		options.MaxAssetBytes = defaults.MaxAssetBytes
	}
	if options.MaxDocumentBytes <= 0 {
		options.MaxDocumentBytes = defaults.MaxDocumentBytes
	}
	if options.MaxTenantBytes <= 0 {
		options.MaxTenantBytes = defaults.MaxTenantBytes
	}
	if options.StorageReserveBytes <= 0 {
		options.StorageReserveBytes = defaults.StorageReserveBytes
	}
	if options.MaxDocumentObjects <= 0 {
		options.MaxDocumentObjects = defaults.MaxDocumentObjects
	}
	if options.MaxTenantObjects <= 0 {
		options.MaxTenantObjects = defaults.MaxTenantObjects
	}
	s.assetOptions = options
}

func (s *Service) resolvedAssetOptions() AssetOptions {
	if s.assetOptions.MaxAssetBytes <= 0 {
		return defaultAssetOptions()
	}
	return s.assetOptions
}

func (s *Service) MaxAssetBytes() int64 { return s.resolvedAssetOptions().MaxAssetBytes }

type Asset struct {
	ID         string    `json:"id"`
	DocumentID string    `json:"document_id"`
	Filename   string    `json:"filename"`
	MediaType  string    `json:"media_type"`
	SHA256     string    `json:"sha256"`
	Status     string    `json:"status"`
	SizeBytes  int64     `json:"size_bytes"`
	CreatedAt  time.Time `json:"created_at"`
	UpdatedAt  time.Time `json:"updated_at"`
}

type PlanAssetInput struct {
	AccountID, ActorID, TenantID, DocumentID, Filename, MediaType, SHA256, IdempotencyKey string
	SizeBytes                                                                             int64
}

type UploadAssetInput struct {
	AccountID, ActorID string
	AssetID            string
	Contents           io.Reader
}

type AssetResult struct {
	Asset  Asset
	Body   []byte
	Replay bool
}

type AssetContent struct {
	Asset  Asset
	Reader io.ReadCloser
}

type assetRecord struct {
	Asset
	TenantID, CreatorActorID, ObjectID string
	UploadAttemptID                    pgtype.Text
	UploadLeaseHash                    []byte
	UploadLeaseExpiresAt               pgtype.Timestamptz
}

func (s *Service) PlanAsset(ctx context.Context, input PlanAssetInput) (AssetResult, error) {
	return s.planAsset(ctx, input, false)
}

const assetPlanOperation = "document-asset-plan"

func (s *Service) planAsset(ctx context.Context, input PlanAssetInput, nativeImport bool) (AssetResult, error) {
	input.MediaType = strings.ToLower(strings.TrimSpace(input.MediaType))
	if !s.validAssetPlan(input) {
		return AssetResult{}, ErrInvalidInput
	}
	evidence := strings.Join([]string{
		input.DocumentID, input.Filename, input.MediaType,
		strconv.FormatInt(input.SizeBytes, 10), input.SHA256,
	}, "\x00")
	requestHash := sha256.Sum256([]byte(evidence))
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return AssetResult{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	replayKey := idempotency.AccountKey(input.AccountID, assetPlanOperation, input.IdempotencyKey)
	if err = idempotency.Lock(ctx, tx, replayKey); err != nil {
		return AssetResult{}, err
	}
	// The request hash covers the document ID, so a reused key for another document conflicts.
	replay, found, err := idempotency.Lookup(ctx, tx, replayKey, requestHash[:])
	if errors.Is(err, idempotency.ErrConflict) {
		return AssetResult{}, ErrIdempotencyConflict
	}
	if err != nil {
		return AssetResult{}, err
	}
	if found {
		var asset Asset
		if err = json.Unmarshal(replay.Body, &asset); err != nil {
			return AssetResult{}, err
		}
		if err = tx.Commit(ctx); err != nil {
			return AssetResult{}, err
		}
		return AssetResult{Asset: asset, Body: replay.Body, Replay: true}, nil
	}
	var tenantID, actorID string
	err = tx.QueryRow(ctx, `SELECT access.tenant_id,access.actor_id
		FROM documents document
		JOIN resolve_human_document_access_v2($1,$2) access ON access.tenant_id=document.tenant_id
		WHERE document.id=$2 AND document.status='active' AND (
		  document.format='blocknote' OR ($3 AND document.native_import_status='pending')
		)
		  AND access.can_write
		FOR UPDATE OF document`, input.AccountID, input.DocumentID, nativeImport).Scan(&tenantID, &actorID)
	if errors.Is(err, pgx.ErrNoRows) {
		return AssetResult{}, ErrNotFound
	}
	if err != nil {
		return AssetResult{}, err
	}
	if err = s.admitAsset(ctx, tx, tenantID, input); err != nil {
		return AssetResult{}, err
	}
	assetID := stableCreateID("document_asset_", input.AccountID, input.IdempotencyKey)
	objectID := assetObjectID(assetID)
	record, err := scanAsset(tx.QueryRow(ctx, `INSERT INTO document_assets(
		id,tenant_id,document_id,created_by_actor_id,request_hash,filename,media_type,
		sha256,size_bytes,content_object_id,status
	) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'planned')
	RETURNING id,document_id,filename,media_type,sha256,size_bytes,status,created_at,updated_at,
	          tenant_id,coalesce(created_by_actor_id,''),content_object_id,
	          upload_attempt_id,upload_lease_token_hash,upload_lease_expires_at`,
		assetID, tenantID, input.DocumentID, actorID, requestHash[:], input.Filename,
		input.MediaType, input.SHA256, input.SizeBytes, objectID))
	if err != nil {
		return AssetResult{}, err
	}
	body, err := json.Marshal(record.Asset)
	if err != nil {
		return AssetResult{}, err
	}
	if err = idempotency.Save(ctx, tx, replayKey, requestHash[:], idempotency.Record{
		ResourceID: assetID, Status: http.StatusCreated, Body: body,
	}); err != nil {
		return AssetResult{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return AssetResult{}, err
	}
	return AssetResult{Asset: record.Asset, Body: body}, nil
}

func (s *Service) UploadAsset(ctx context.Context, input UploadAssetInput) (AssetResult, error) {
	return s.uploadAsset(ctx, input, false)
}

func (s *Service) uploadAsset(ctx context.Context, input UploadAssetInput, nativeImport bool) (AssetResult, error) {
	if input.AccountID == "" || input.AssetID == "" || input.Contents == nil || s.objects == nil {
		return AssetResult{}, ErrInvalidInput
	}
	record, attemptID, tokenHash, replay, err := s.acquireAssetUpload(ctx, input.AccountID, input.AssetID, nativeImport)
	if err != nil {
		return AssetResult{}, err
	}
	return s.storeAssetUpload(ctx, input.Contents, record, attemptID, tokenHash, replay)
}

func (s *Service) storeAssetUpload(ctx context.Context, contents io.Reader, record assetRecord,
	attemptID string, tokenHash []byte, replay bool) (AssetResult, error) {
	if replay {
		if err := s.verifyAvailableAssetReplay(ctx, record); err != nil {
			return AssetResult{}, err
		}
		body, marshalErr := json.Marshal(record.Asset)
		return AssetResult{Asset: record.Asset, Body: body, Replay: true}, marshalErr
	}
	expected, err := hex.DecodeString(record.SHA256)
	if err != nil || len(expected) != sha256.Size {
		return AssetResult{}, ErrInvalidInput
	}
	var expectedDigest [sha256.Size]byte
	copy(expectedDigest[:], expected)
	object, storageReplay, err := s.objects.PutIfAbsent(
		ctx, record.ObjectID, contents, record.SizeBytes, expectedDigest)
	if errors.Is(err, artifactstore.ErrObjectConflict) {
		return AssetResult{}, s.quarantineAsset(ctx, record, attemptID, tokenHash)
	}
	if errors.Is(err, artifactstore.ErrContentMismatch) {
		_ = s.releaseAssetUpload(ctx, record.ID, attemptID, tokenHash)
		return AssetResult{}, ErrAssetContentMismatch
	}
	if err != nil {
		_ = s.releaseAssetUpload(ctx, record.ID, attemptID, tokenHash)
		return AssetResult{}, err
	}
	available, err := s.finalizeAssetUpload(ctx, record.ID, attemptID, tokenHash, object)
	if err != nil {
		if errors.Is(err, ErrAssetUnavailable) {
			err = errors.Join(err, s.cleanupFailedAssetUpload(ctx, record.ID, attemptID, tokenHash, record.ObjectID))
		}
		return AssetResult{}, err
	}
	body, err := json.Marshal(available.Asset)
	return AssetResult{Asset: available.Asset, Body: body, Replay: storageReplay}, err
}

func (s *Service) verifyAvailableAssetReplay(ctx context.Context, record assetRecord) error {
	head, err := s.objects.Head(ctx, record.ObjectID)
	if err != nil {
		return err
	}
	observedSHA := hex.EncodeToString(head.SHA256[:])
	if head.Size == record.SizeBytes && observedSHA == record.SHA256 {
		return nil
	}
	evidence := sha256.Sum256([]byte(record.ID + "\x00" + observedSHA))
	result, err := s.pool.Exec(ctx, `UPDATE document_assets SET status='quarantined',
		observed_size_bytes=$2,observed_sha256=$3,observed_at=clock_timestamp(),
		failure_code='object_hash_conflict',failure_evidence_hash=$4,
		quarantined_at=clock_timestamp(),updated_at=clock_timestamp()
	WHERE id=$1 AND status='available'`, record.ID, head.Size, observedSHA,
		hex.EncodeToString(evidence[:]))
	if err != nil {
		return err
	}
	if result.RowsAffected() != 1 {
		return ErrAssetUnavailable
	}
	return ErrAssetQuarantined
}

func (s *Service) GetAsset(ctx context.Context, accountID, assetID string) (Asset, error) {
	record, err := s.getAsset(ctx, accountID, assetID)
	return record.Asset, err
}

func (s *Service) OpenAssetContent(ctx context.Context, accountID, assetID string) (AssetContent, error) {
	record, err := s.getAsset(ctx, accountID, assetID)
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

func (s *Service) validAssetPlan(input PlanAssetInput) bool {
	return input.AccountID != "" && s.validAssetPlanPayload(input)
}

func (s *Service) validAssetPlanPayload(input PlanAssetInput) bool {
	options := s.resolvedAssetOptions()
	parsed, parameters, err := mime.ParseMediaType(input.MediaType)
	return input.DocumentID != "" &&
		documentAssetKeyPattern.MatchString(input.IdempotencyKey) &&
		validAssetFilename(input.Filename) &&
		err == nil && len(parameters) == 0 && parsed == input.MediaType &&
		input.SizeBytes > 0 && input.SizeBytes <= options.MaxAssetBytes &&
		s.objects != nil && input.SizeBytes <= s.objects.MaxBytes() &&
		documentAssetSHA256.MatchString(input.SHA256)
}

func validAssetFilename(filename string) bool {
	return filename != "" && utf8.RuneCountInString(filename) <= 255 &&
		filename == norm.NFC.String(filename) && filename != "." && filename != ".." &&
		filepath.Base(filename) == filename && !strings.ContainsAny(filename, "\\/\x00")
}

// admitAsset checks the quotas. The lock serializes admissions so concurrent
// plans cannot together exceed a quota or the filesystem reserve.
func (s *Service) admitAsset(ctx context.Context, tx pgx.Tx, tenantID string, input PlanAssetInput) error {
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('document-asset-admission',0))`); err != nil {
		return err
	}
	return s.admitAssetQuota(ctx, tx, tenantID, input)
}

func (s *Service) admitAssetQuota(ctx context.Context, tx pgx.Tx, tenantID string, input PlanAssetInput) error {
	options := s.resolvedAssetOptions()
	var documentObjects, tenantObjects int32
	var documentBytes, tenantBytes int64
	err := tx.QueryRow(ctx, `SELECT
		count(*) FILTER(WHERE document_id=$2)::integer,
		coalesce(sum(size_bytes) FILTER(WHERE document_id=$2),0)::bigint,
		count(*)::integer,coalesce(sum(size_bytes),0)::bigint
	FROM document_assets WHERE tenant_id=$1 AND status<>'deleted'`,
		tenantID, input.DocumentID).Scan(&documentObjects, &documentBytes, &tenantObjects, &tenantBytes)
	if err != nil {
		return err
	}
	if documentObjects+1 > options.MaxDocumentObjects ||
		documentBytes > options.MaxDocumentBytes-input.SizeBytes ||
		tenantObjects+1 > options.MaxTenantObjects ||
		tenantBytes > options.MaxTenantBytes-input.SizeBytes {
		return ErrAssetQuotaExceeded
	}
	available, err := s.objects.AvailableBytes()
	if err != nil {
		return err
	}
	if available < options.StorageReserveBytes ||
		input.SizeBytes > available-options.StorageReserveBytes {
		return ErrAssetStorageCapacity
	}
	var planned int64
	if err = tx.QueryRow(ctx, `SELECT coalesce(sum(size_bytes),0)::bigint
		FROM document_assets WHERE status='planned'`).Scan(&planned); err != nil {
		return err
	}
	capacity := available - options.StorageReserveBytes
	if planned > capacity || input.SizeBytes > capacity-planned {
		return ErrAssetStorageCapacity
	}
	return nil
}

func (s *Service) acquireAssetUpload(ctx context.Context, accountID, assetID string, nativeImport bool) (
	assetRecord, string, []byte, bool, error,
) {
	query := `JOIN documents document ON document.id=asset.document_id AND document.tenant_id=asset.tenant_id
	JOIN resolve_human_document_access_v2($1,asset.document_id) access
	  ON access.tenant_id=asset.tenant_id AND access.can_write
	WHERE asset.id=$2 AND document.status='active' AND (
	  document.format='blocknote' OR ($3 AND document.native_import_status='pending')
	)`
	return s.acquireAssetUploadWithQuery(ctx, accountID, assetID, query, nativeImport)
}

func (s *Service) acquireAssetUploadWithQuery(ctx context.Context, principalID, assetID, query string, args ...any) (
	assetRecord, string, []byte, bool, error,
) {
	// Retry only the transaction: request bytes have not been consumed yet.
	for attempt := 0; attempt < 3; attempt++ {
		record, attemptID, tokenHash, replay, err := s.acquireAssetUploadWithQueryOnce(ctx, principalID, assetID, query, args...)
		if !isDocumentSerializationFailure(err) || attempt == 2 {
			return record, attemptID, tokenHash, replay, err
		}
	}
	return assetRecord{}, "", nil, false, ErrConflict
}

func (s *Service) acquireAssetUploadWithQueryOnce(ctx context.Context, principalID, assetID, query string, args ...any) (
	assetRecord, string, []byte, bool, error,
) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return assetRecord{}, "", nil, false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	queryArgs := []any{principalID, assetID}
	queryArgs = append(queryArgs, args...)
	record, err := scanAsset(tx.QueryRow(ctx, `SELECT asset.id,asset.document_id,asset.filename,
		asset.media_type,asset.sha256,asset.size_bytes,asset.status,asset.created_at,asset.updated_at,
		asset.tenant_id,coalesce(asset.created_by_actor_id,''),asset.content_object_id,
		asset.upload_attempt_id,asset.upload_lease_token_hash,asset.upload_lease_expires_at
	FROM document_assets asset `+query+`
	FOR UPDATE OF asset FOR NO KEY UPDATE OF document`, queryArgs...))
	if errors.Is(err, pgx.ErrNoRows) {
		return assetRecord{}, "", nil, false, ErrNotFound
	}
	if err != nil {
		return assetRecord{}, "", nil, false, err
	}
	if record.Status == "quarantined" {
		return assetRecord{}, "", nil, false, ErrAssetQuarantined
	}
	if record.Status == "available" {
		if err = tx.Commit(ctx); err != nil {
			return assetRecord{}, "", nil, false, err
		}
		return record, "", nil, true, nil
	}
	if record.Status != "planned" && record.Status != "stored" {
		return assetRecord{}, "", nil, false, ErrAssetUnavailable
	}
	now := time.Now().UTC()
	if record.UploadAttemptID.Valid && record.UploadLeaseExpiresAt.Valid &&
		record.UploadLeaseExpiresAt.Time.After(now) {
		return assetRecord{}, "", nil, false, ErrAssetUnavailable
	}
	token := make([]byte, 32)
	if _, err = rand.Read(token); err != nil {
		return assetRecord{}, "", nil, false, err
	}
	hash := sha256.Sum256(token)
	attemptID := stableCreateID("document_asset_upload_attempt_", record.ID, hex.EncodeToString(hash[:]))
	_, err = tx.Exec(ctx, `UPDATE document_assets SET upload_attempt_count=upload_attempt_count+1,
		upload_attempt_id=$2,upload_lease_token_hash=$3,
		upload_lease_expires_at=$4,upload_started_at=$5,upload_completed_at=NULL,
		updated_at=clock_timestamp() WHERE id=$1`, record.ID, attemptID, hash[:],
		now.Add(documentAssetUploadLease), now)
	if err != nil {
		return assetRecord{}, "", nil, false, err
	}
	if err = tx.Commit(ctx); err != nil {
		return assetRecord{}, "", nil, false, err
	}
	return record, attemptID, hash[:], false, nil
}

func (s *Service) finalizeAssetUpload(ctx context.Context, assetID, attemptID string, tokenHash []byte,
	object artifactstore.Object) (assetRecord, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return assetRecord{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	now := time.Now().UTC()
	result, err := tx.Exec(ctx, `UPDATE document_assets asset SET status='stored',
		observed_size_bytes=$4,observed_sha256=$5,observed_at=$6,stored_at=coalesce(stored_at,$6),
		upload_completed_at=$6,updated_at=clock_timestamp()
	FROM documents document
	WHERE asset.id=$1 AND asset.upload_attempt_id=$2 AND asset.upload_lease_token_hash=$3
	  AND asset.upload_lease_expires_at >= $6 AND asset.status IN ('planned','stored')
	  AND document.id=asset.document_id AND document.tenant_id=asset.tenant_id
	  AND document.status='active'`,
		assetID, attemptID, tokenHash, object.Size, hex.EncodeToString(object.SHA256[:]), now)
	if err != nil {
		return assetRecord{}, err
	}
	if result.RowsAffected() != 1 {
		return assetRecord{}, ErrAssetUnavailable
	}
	record, err := scanAsset(tx.QueryRow(ctx, `UPDATE document_assets SET status='available',
		available_at=coalesce(available_at,$2),upload_attempt_id=NULL,upload_lease_token_hash=NULL,
		upload_lease_expires_at=NULL,upload_started_at=NULL,updated_at=clock_timestamp()
	WHERE id=$1 AND status='stored'
	RETURNING id,document_id,filename,media_type,sha256,size_bytes,status,created_at,updated_at,
	          tenant_id,coalesce(created_by_actor_id,''),content_object_id,
		          upload_attempt_id,upload_lease_token_hash,upload_lease_expires_at`, assetID, now))
	if errors.Is(err, pgx.ErrNoRows) {
		return assetRecord{}, ErrAssetUnavailable
	}
	if err != nil {
		return assetRecord{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return assetRecord{}, err
	}
	return record, nil
}

func (s *Service) cleanupFailedAssetUpload(
	ctx context.Context,
	assetID, attemptID string,
	tokenHash []byte,
	objectID string,
) error {
	result, err := s.pool.Exec(ctx, `UPDATE document_assets SET
		upload_attempt_id=NULL,upload_lease_token_hash=NULL,upload_lease_expires_at=NULL,
		upload_started_at=NULL,upload_completed_at=NULL,updated_at=clock_timestamp()
	WHERE id=$1 AND upload_attempt_id=$2 AND upload_lease_token_hash=$3
	  AND status<>'available'`, assetID, attemptID, tokenHash)
	if err != nil {
		return err
	}
	if result.RowsAffected() == 0 {
		return nil
	}
	return artifactstore.DeleteDetached(ctx, s.objects, objectID)
}

func (s *Service) releaseAssetUpload(ctx context.Context, assetID, attemptID string, tokenHash []byte) error {
	_, err := s.pool.Exec(ctx, `UPDATE document_assets SET upload_attempt_id=NULL,
		upload_lease_token_hash=NULL,upload_lease_expires_at=NULL,upload_started_at=NULL,
		upload_completed_at=NULL,updated_at=clock_timestamp()
	WHERE id=$1 AND upload_attempt_id=$2 AND upload_lease_token_hash=$3
	  AND status IN ('planned','stored')`, assetID, attemptID, tokenHash)
	return err
}

func (s *Service) quarantineAsset(ctx context.Context, record assetRecord, attemptID string, tokenHash []byte) error {
	head, err := s.objects.Head(ctx, record.ObjectID)
	if err != nil {
		return errors.Join(ErrAssetQuarantined, err)
	}
	evidence := sha256.Sum256([]byte(record.ID + "\x00" + hex.EncodeToString(head.SHA256[:])))
	result, err := s.pool.Exec(ctx, `UPDATE document_assets SET status='quarantined',
		observed_size_bytes=$4,observed_sha256=$5,observed_at=clock_timestamp(),
		failure_code='object_hash_conflict',failure_evidence_hash=$6,
		quarantined_at=clock_timestamp(),upload_attempt_id=NULL,upload_lease_token_hash=NULL,
		upload_lease_expires_at=NULL,upload_started_at=NULL,updated_at=clock_timestamp()
	WHERE id=$1 AND upload_attempt_id=$2 AND upload_lease_token_hash=$3
	  AND status IN ('planned','stored')`, record.ID, attemptID, tokenHash, head.Size,
		hex.EncodeToString(head.SHA256[:]), hex.EncodeToString(evidence[:]))
	if err != nil {
		return err
	}
	if result.RowsAffected() != 1 {
		return ErrAssetUnavailable
	}
	return ErrAssetQuarantined
}

func (s *Service) getAsset(ctx context.Context, accountID, assetID string) (assetRecord, error) {
	record, err := scanAsset(s.pool.QueryRow(ctx, `SELECT asset.id,asset.document_id,asset.filename,
		asset.media_type,asset.sha256,asset.size_bytes,asset.status,asset.created_at,asset.updated_at,
		asset.tenant_id,coalesce(asset.created_by_actor_id,''),asset.content_object_id,
		asset.upload_attempt_id,asset.upload_lease_token_hash,asset.upload_lease_expires_at
	FROM document_assets asset
	JOIN documents document ON document.id=asset.document_id AND document.tenant_id=asset.tenant_id
	JOIN resolve_human_document_access_v2($1,asset.document_id) access
	  ON access.tenant_id=asset.tenant_id AND access.can_read
	WHERE asset.id=$2 AND document.status='active'`, accountID, assetID))
	if errors.Is(err, pgx.ErrNoRows) {
		return assetRecord{}, ErrNotFound
	}
	return record, err
}

type assetRowScanner interface{ Scan(...any) error }

func scanAsset(row assetRowScanner) (assetRecord, error) {
	var record assetRecord
	err := row.Scan(&record.ID, &record.DocumentID, &record.Filename, &record.MediaType,
		&record.SHA256, &record.SizeBytes, &record.Status, &record.CreatedAt, &record.UpdatedAt,
		&record.TenantID, &record.CreatorActorID, &record.ObjectID, &record.UploadAttemptID,
		&record.UploadLeaseHash, &record.UploadLeaseExpiresAt)
	return record, err
}
