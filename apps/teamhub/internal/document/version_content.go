package document

import (
	"bytes"
	"context"
	"encoding/hex"
	"errors"

	"github.com/jackc/pgx/v5"
)

type VersionContent struct {
	Version   Version
	ObjectKey string
}

func (s *Service) GetVersion(ctx context.Context, accountID, versionID string) (Version, error) {
	content, err := s.loadAccessibleVersion(ctx, accountID, versionID)
	return content.Version, err
}

func (s *Service) GetVersionContent(ctx context.Context, accountID, versionID string) (VersionContent, error) {
	if s.objects == nil {
		return VersionContent{}, ErrObjectStoreUnavailable
	}
	content, err := s.loadAccessibleVersion(ctx, accountID, versionID)
	if err != nil {
		return VersionContent{}, err
	}
	object, err := s.objects.Head(ctx, content.ObjectKey)
	if err != nil {
		return VersionContent{}, errors.Join(ErrObjectStoreUnavailable, err)
	}
	wantSHA, err := hex.DecodeString(content.Version.SHA256)
	if err != nil || object.Key != content.ObjectKey || object.Size != content.Version.SizeBytes ||
		!bytes.Equal(object.SHA256[:], wantSHA) {
		return VersionContent{}, ErrObjectStoreUnavailable
	}
	return content, nil
}

// GetTenantVersionContent resolves one immutable Version of an active Document
// for a trusted internal workload. Authorization is scoped to the supplied
// tenant; the caller never needs to know whether the configured object store
// is local or provider-backed.
func (s *Service) GetTenantVersionContent(ctx context.Context, tenantID, versionID string) (VersionContent, error) {
	if s == nil || s.pool == nil || s.objects == nil || tenantID == "" || versionID == "" {
		return VersionContent{}, ErrInvalidInput
	}
	content := VersionContent{Version: Version{ID: versionID}}
	err := s.pool.QueryRow(ctx, `SELECT file.document_id,file.filename,file.representation_format,
		file.media_type,file.size_bytes,file.sha256,file.created_at,file.content_object_id
		FROM document_versions file
		JOIN documents document ON document.id=file.document_id AND document.tenant_id=file.tenant_id
		WHERE file.id=$1 AND file.tenant_id=$2 AND document.status='active'`, versionID, tenantID).Scan(
		&content.Version.DocumentID, &content.Version.Filename, &content.Version.RepresentationFormat,
		&content.Version.MediaType, &content.Version.SizeBytes, &content.Version.SHA256,
		&content.Version.CreatedAt, &content.ObjectKey,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return VersionContent{}, ErrNotFound
	}
	if err != nil {
		return VersionContent{}, err
	}
	return content, nil
}

func (s *Service) loadAccessibleVersion(ctx context.Context, accountID, versionID string) (VersionContent, error) {
	if accountID == "" || versionID == "" {
		return VersionContent{}, ErrInvalidInput
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return VersionContent{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	version, err := getVersionTx(ctx, tx, versionID)
	if errors.Is(err, pgx.ErrNoRows) {
		return VersionContent{}, ErrNotFound
	}
	if err != nil {
		return VersionContent{}, err
	}
	documentValue, err := get(ctx, tx, accountID, version.DocumentID)
	if err != nil {
		return VersionContent{}, err
	}
	if documentValue.Status != "active" || !documentValue.Capabilities.Read {
		return VersionContent{}, ErrNotFound
	}
	var objectKey string
	if err := tx.QueryRow(ctx, `SELECT content_object_id FROM document_versions
		WHERE id=$1 AND document_id=$2`, versionID, version.DocumentID).Scan(&objectKey); err != nil {
		return VersionContent{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return VersionContent{}, err
	}
	return VersionContent{Version: version, ObjectKey: objectKey}, nil
}
