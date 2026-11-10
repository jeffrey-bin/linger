package document

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	artifactstore "github.com/simplexai-labs/linger/apps/teamhub/internal/artifact"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/idempotency"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

type UploadDocumentVersionInput struct {
	LinkToken                                                       string
	AccountID, DocumentID, ExpectedCurrentVersionID, IdempotencyKey string
	Filename, RepresentationFormat, MediaType                       string
	Content                                                         io.Reader
}

type UploadDocumentVersionResult struct {
	Version  Version
	Replayed bool
}

const uploadDocumentVersionOperation = "document.version.upload"

func (s *Service) UploadVersion(
	ctx context.Context,
	input UploadDocumentVersionInput,
) (result UploadDocumentVersionResult, err error) {
	input.Filename = strings.TrimSpace(input.Filename)
	input.RepresentationFormat = strings.TrimSpace(input.RepresentationFormat)
	input.MediaType = strings.TrimSpace(input.MediaType)
	if input.AccountID == "" || input.DocumentID == "" || input.ExpectedCurrentVersionID == "" ||
		len(input.IdempotencyKey) < 8 || len(input.IdempotencyKey) > 128 || input.Content == nil ||
		input.Filename == "" || len(input.Filename) > 255 || input.RepresentationFormat == "" ||
		len(input.RepresentationFormat) > 120 || input.MediaType == "" || len(input.MediaType) > 255 {
		return UploadDocumentVersionResult{}, ErrInvalidInput
	}
	if s.objects == nil {
		return UploadDocumentVersionResult{}, ErrObjectStoreUnavailable
	}
	object, putErr := s.objects.Put(ctx, input.Content)
	if putErr != nil {
		return UploadDocumentVersionResult{}, errors.Join(ErrObjectStoreUnavailable, putErr)
	}
	if object.Key == "" || len(object.Key) > 255 || object.Size < 0 {
		if cleanupErr := artifactstore.DeleteDetached(ctx, s.objects, object.Key); cleanupErr != nil {
			return UploadDocumentVersionResult{}, errors.Join(ErrObjectStoreUnavailable, cleanupErr)
		}
		return UploadDocumentVersionResult{}, ErrObjectStoreUnavailable
	}
	keepObject := false
	defer func() {
		if keepObject {
			return
		}
		if cleanupErr := artifactstore.DeleteDetached(ctx, s.objects, object.Key); cleanupErr != nil {
			err = errors.Join(err, cleanupErr)
		}
	}()

	requestHash := uploadDocumentVersionRequestHash(input, object)
	tx, beginErr := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if beginErr != nil {
		return UploadDocumentVersionResult{}, beginErr
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if lockErr := idempotency.Lock(ctx, tx, idempotency.AccountKey(input.AccountID, uploadDocumentVersionOperation, input.IdempotencyKey)); lockErr != nil {
		return UploadDocumentVersionResult{}, lockErr
	}
	if replay, found, replayErr := lookupUploadDocumentVersionReplayTx(ctx, tx, input, requestHash); replayErr != nil || found {
		if replayErr != nil {
			return UploadDocumentVersionResult{}, replayErr
		}
		if commitErr := tx.Commit(ctx); commitErr != nil {
			return UploadDocumentVersionResult{}, commitErr
		}
		return replay, nil
	}
	value, getErr := authorizeVersionUpload(ctx, tx, input)
	if getErr != nil {
		return UploadDocumentVersionResult{}, getErr
	}
	var tenantID, status string
	var currentVersionID *string
	var hasDraft bool
	if queryErr := tx.QueryRow(ctx, `SELECT document.tenant_id,document.current_version_id,document.status,
		EXISTS(SELECT 1 FROM document_bodies body WHERE body.document_id=document.id)
		FROM documents document WHERE document.id=$1 AND document.tenant_id=$2 FOR UPDATE`,
		input.DocumentID, value.TenantID).Scan(&tenantID, &currentVersionID, &status, &hasDraft); queryErr != nil {
		return UploadDocumentVersionResult{}, queryErr
	}
	if value.Format == "blocknote" || hasDraft {
		return UploadDocumentVersionResult{}, ErrInvalidInput
	}
	if status != "active" || currentVersionID == nil || *currentVersionID != input.ExpectedCurrentVersionID {
		return UploadDocumentVersionResult{}, ErrVersionConflict
	}
	if value.Format != input.RepresentationFormat {
		return UploadDocumentVersionResult{}, ErrInvalidInput
	}
	var currentVersionNumber int
	if queryErr := tx.QueryRow(ctx, `SELECT version_number FROM document_versions
		WHERE id=$1 AND tenant_id=$2 AND document_id=$3`, *currentVersionID, tenantID,
		input.DocumentID).Scan(&currentVersionNumber); queryErr != nil {
		return UploadDocumentVersionResult{}, queryErr
	}
	actorID, actorErr := resolveActiveHumanActorTx(ctx, tx, input.AccountID, tenantID)
	if actorErr != nil {
		return UploadDocumentVersionResult{}, actorErr
	}
	versionID := stableCreateID("document_version_", input.DocumentID, input.IdempotencyKey)
	versionNumber := currentVersionNumber + 1
	if _, insertErr := tx.Exec(ctx, `INSERT INTO document_versions(
		id,tenant_id,document_id,version_number,filename,representation_format,media_type,
		size_bytes,sha256,content_object_id,source,created_by_actor_id,base_version_id
	) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'replacement_upload',$11,$12)`,
		versionID, tenantID, input.DocumentID, versionNumber, input.Filename,
		input.RepresentationFormat, input.MediaType, object.Size, hex.EncodeToString(object.SHA256[:]),
		object.Key, actorID, *currentVersionID); insertErr != nil {
		return UploadDocumentVersionResult{}, insertErr
	}
	command, updateErr := tx.Exec(ctx, `UPDATE documents SET current_version_id=$2,title=$5,updated_at=GREATEST(updated_at,clock_timestamp())
		WHERE id=$1 AND tenant_id=$3 AND current_version_id=$4 AND status='active'`,
		input.DocumentID, versionID, tenantID, *currentVersionID, input.Filename)
	if updateErr != nil {
		return UploadDocumentVersionResult{}, updateErr
	}
	if command.RowsAffected() != 1 {
		return UploadDocumentVersionResult{}, ErrVersionConflict
	}
	if eventErr := appendLifecycleEvent(ctx, tx, tenantID, input.DocumentID, actorID, versionID, "document_version", "document.version_created"); eventErr != nil {
		return UploadDocumentVersionResult{}, eventErr
	}
	if insertErr := idempotency.Save(ctx, tx, idempotency.AccountKey(input.AccountID, uploadDocumentVersionOperation, input.IdempotencyKey), requestHash[:], idempotency.Record{ResourceID: versionID, Status: 201, Body: []byte{}}); insertErr != nil {
		return UploadDocumentVersionResult{}, insertErr
	}
	version, versionErr := getVersionTx(ctx, tx, versionID)
	if versionErr != nil {
		return UploadDocumentVersionResult{}, versionErr
	}
	keepObject = true
	if commitErr := tx.Commit(ctx); commitErr != nil {
		return UploadDocumentVersionResult{}, commitErr
	}
	return UploadDocumentVersionResult{Version: version}, nil
}

func lookupUploadDocumentVersionReplayTx(
	ctx context.Context,
	tx pgx.Tx,
	input UploadDocumentVersionInput,
	requestHash [sha256.Size]byte,
) (UploadDocumentVersionResult, bool, error) {
	record, found, err := lookupCommandRecord(ctx, tx, input.AccountID, uploadDocumentVersionOperation, input.IdempotencyKey, requestHash[:])
	if err != nil || !found {
		return UploadDocumentVersionResult{}, false, err
	}
	versionID := record.ResourceID
	version, err := getVersionTx(ctx, tx, versionID)
	if err != nil {
		return UploadDocumentVersionResult{}, true, err
	}
	if _, err := resolveActiveHumanActorTx(ctx, tx, input.AccountID, version.CreatedBy.TenantID); err != nil {
		return UploadDocumentVersionResult{}, true, err
	}
	_, err = authorizeVersionUpload(ctx, tx, input)
	return UploadDocumentVersionResult{Version: version, Replayed: true}, true, err
}

func authorizeVersionUpload(ctx context.Context, tx pgx.Tx, input UploadDocumentVersionInput) (Document, error) {
	var value Document
	err := tx.QueryRow(ctx, `SELECT tenant_id,format FROM documents WHERE id=$1 AND status='active' FOR UPDATE`, input.DocumentID).Scan(&value.TenantID, &value.Format)
	if errors.Is(err, pgx.ErrNoRows) {
		return Document{}, ErrNotFound
	}
	if err != nil {
		return Document{}, err
	}
	if input.LinkToken == "" {
		value, err = get(ctx, tx, input.AccountID, input.DocumentID)
		if err == nil && !value.Capabilities.Write {
			err = ErrNotFound
		}
		return value, err
	}
	digest, valid := linkTokenDigest(input.LinkToken)
	if !valid {
		return Document{}, ErrNotFound
	}
	var role string
	err = tx.QueryRow(ctx, `SELECT link_share_role FROM documents WHERE id=$1 AND link_share_token_sha256=$2 AND link_share_status='active'`, input.DocumentID, digest).Scan(&role)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && role != "editor") {
		return Document{}, ErrNotFound
	}
	if err != nil {
		return Document{}, err
	}
	if _, err := resolveActiveHumanActorTx(ctx, tx, input.AccountID, value.TenantID); err != nil {
		return Document{}, err
	}
	return value, nil
}

// resolveActiveHumanActorTx returns the caller's Human Actor in the Tenant
// through the shared lookup, which also requires an active Tenant role.
func resolveActiveHumanActorTx(ctx context.Context, tx pgx.Tx, accountID, tenantID string) (string, error) {
	actor, err := store.New(tx).GetHumanActor(ctx, store.GetHumanActorParams{
		TenantID: tenantID, AccountID: pgtype.Text{String: accountID, Valid: true},
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrNotFound
	}
	return actor.ID, err
}

func getVersionTx(ctx context.Context, tx pgx.Tx, versionID string) (Version, error) {
	var value Version
	err := tx.QueryRow(ctx, `SELECT version.id,version.document_id,version.version_number,
		version.filename,version.representation_format,version.media_type,version.size_bytes,
		version.sha256,version.source,version.source_revision_id,version.base_version_id,
		version.source_invocation_id,
		COALESCE(version.exporter_schema_version,0),version.created_at,
		actor.id,actor.tenant_id,actor.kind,actor.display_name
		FROM document_versions version JOIN actors actor
		  ON actor.id=version.created_by_actor_id AND actor.tenant_id=version.tenant_id
		WHERE version.id=$1`, versionID).Scan(
		&value.ID, &value.DocumentID, &value.VersionNumber, &value.Filename,
		&value.RepresentationFormat, &value.MediaType, &value.SizeBytes, &value.SHA256,
		&value.Source, &value.SourceRevisionID, &value.BaseVersionID,
		&value.SourceInvocationID, &value.ExporterSchemaVersion,
		&value.CreatedAt, &value.CreatedBy.ID, &value.CreatedBy.TenantID,
		&value.CreatedBy.Kind, &value.CreatedBy.DisplayName,
	)
	return value, err
}

func uploadDocumentVersionRequestHash(input UploadDocumentVersionInput, object artifactstore.Object) [sha256.Size]byte {
	parts := []string{
		input.DocumentID, input.ExpectedCurrentVersionID, input.Filename,
		input.RepresentationFormat, input.MediaType, hex.EncodeToString(object.SHA256[:]),
		strconv.FormatInt(object.Size, 10),
	}
	if input.LinkToken != "" {
		parts = append(parts, input.LinkToken)
	}
	return sha256.Sum256([]byte(strings.Join(parts, "\x00")))
}
