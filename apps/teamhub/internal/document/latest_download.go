package document

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"

	"github.com/jackc/pgx/v5"
	artifactstore "github.com/simplexai-labs/linger/apps/teamhub/internal/artifact"
)

var ErrLatestProjectionNotReady = errors.New("latest Document changed during rendering; retry")

type LatestDownloadInput struct {
	AccountID, DocumentID string
}

type LatestDownloadContent struct {
	InlineBytes                            []byte
	Filename, MediaType, ObjectKey, SHA256 string
	SizeBytes                              int64
}

type latestProjectionReadMiss struct {
	tenantID  string
	candidate latestProjectionCandidate
}

func (*latestProjectionReadMiss) Error() string { return "latest Document cache miss" }

func (s *Service) GetLatestDownloadContent(ctx context.Context, input LatestDownloadInput) (LatestDownloadContent, error) {
	for attempt := 0; attempt < 3; attempt++ {
		content, err := s.getLatestDownloadContent(ctx, input)
		var miss *latestProjectionReadMiss
		if !errors.As(err, &miss) {
			return content, err
		}
		if _, err := s.ensureLatestProjection(ctx, miss.tenantID, miss.candidate); err != nil {
			return LatestDownloadContent{}, err
		}
	}
	return LatestDownloadContent{}, ErrLatestProjectionNotReady
}

// GetLatestDownloadContent resolves the latest available Content Head. Ordinary
// files retain their exact current Version; native Documents use the exact
// current Draft projection selected by TeamHub.
func (s *Service) getLatestDownloadContent(
	ctx context.Context,
	input LatestDownloadInput,
) (LatestDownloadContent, error) {
	if s == nil || s.pool == nil || s.objects == nil || input.AccountID == "" ||
		input.DocumentID == "" {
		return LatestDownloadContent{}, ErrInvalidInput
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead})
	if err != nil {
		return LatestDownloadContent{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	value, err := get(ctx, tx, input.AccountID, input.DocumentID)
	if err != nil {
		return LatestDownloadContent{}, err
	}
	if value.Status != "active" || !value.Capabilities.Export {
		return LatestDownloadContent{}, ErrNotFound
	}
	var versionID string
	var projection *LatestDownloadContent
	var downloadAssets []downloadAssetEvidence
	var projectionRevisionID, projectionRepresentationFormat string
	if value.DraftCapability == "none" {
		if value.CurrentVersion == nil {
			return LatestDownloadContent{}, ErrRevisionUnavailable
		}
		versionID = value.CurrentVersion.ID
	} else {
		representationFormat := value.RepresentationFormat
		if representationFormat != "markdown" && representationFormat != "plain_text" &&
			representationFormat != "html" {
			return LatestDownloadContent{}, ErrInvalidInput
		}
		var err error
		if projectionRevisionID, err = bodyRevisionTx(ctx, tx, input.DocumentID); err != nil {
			return LatestDownloadContent{}, err
		}
		var current LatestDownloadContent
		err = tx.QueryRow(ctx, `SELECT projection.revision_id,projection.filename,projection.media_type,
			projection.content_object_id,projection.sha256,projection.size_bytes
			FROM document_latest_projections projection
			WHERE projection.document_id=$1 AND projection.tenant_id=$2
			  AND projection.representation_format=$3 AND projection.revision_id=$4`,
			input.DocumentID, value.TenantID, representationFormat, projectionRevisionID).Scan(
			&projectionRevisionID, &current.Filename, &current.MediaType, &current.ObjectKey,
			&current.SHA256, &current.SizeBytes,
		)
		if errors.Is(err, pgx.ErrNoRows) {
			observeLatestRead(ctx, "human", representationFormat, "miss", input.DocumentID, "")
			if err := tx.Commit(ctx); err != nil {
				return LatestDownloadContent{}, err
			}
			if s.runtime == nil {
				return LatestDownloadContent{}, ErrRuntimeUnavailable
			}
			return LatestDownloadContent{}, &latestProjectionReadMiss{tenantID: value.TenantID, candidate: latestProjectionCandidate{documentID: input.DocumentID, revisionID: projectionRevisionID, representationFormat: representationFormat}}
		}
		if err != nil {
			return LatestDownloadContent{}, err
		}
		projectionRepresentationFormat = representationFormat
		if representationFormat == "markdown" {
			var manifest []byte
			if err := tx.QueryRow(ctx, `SELECT asset_manifest FROM document_revisions WHERE id=$1 AND document_id=$2`, projectionRevisionID, input.DocumentID).Scan(&manifest); err != nil {
				return LatestDownloadContent{}, err
			}
			if err := json.Unmarshal(manifest, &downloadAssets); err != nil {
				return LatestDownloadContent{}, err
			}
		}
		projection = &current
	}
	if err := tx.Commit(ctx); err != nil {
		return LatestDownloadContent{}, err
	}
	if versionID != "" {
		content, err := s.GetVersionContent(ctx, input.AccountID, versionID)
		if err != nil {
			return LatestDownloadContent{}, err
		}
		return LatestDownloadContent{
			Filename: content.Version.Filename, MediaType: content.Version.MediaType,
			ObjectKey: content.ObjectKey, SHA256: content.Version.SHA256,
			SizeBytes: content.Version.SizeBytes,
		}, nil
	}
	if projection == nil {
		return LatestDownloadContent{}, &latestProjectionReadMiss{tenantID: value.TenantID, candidate: latestProjectionCandidate{documentID: input.DocumentID, revisionID: projectionRevisionID, representationFormat: projectionRepresentationFormat}}
	}
	object, err := s.objects.Head(ctx, projection.ObjectKey)
	if errors.Is(err, os.ErrNotExist) {
		observeLatestRead(ctx, "human", projectionRepresentationFormat, "miss", input.DocumentID, projectionRevisionID)
		if invalidateErr := s.invalidateLatestProjection(
			ctx, value.TenantID, input.DocumentID, projectionRevisionID,
			projectionRepresentationFormat, *projection,
		); invalidateErr != nil {
			return LatestDownloadContent{}, errors.Join(ErrObjectStoreUnavailable, invalidateErr)
		}
		return LatestDownloadContent{}, &latestProjectionReadMiss{tenantID: value.TenantID, candidate: latestProjectionCandidate{documentID: input.DocumentID, revisionID: projectionRevisionID, representationFormat: projectionRepresentationFormat}}
	}
	if err != nil {
		observeLatestRead(ctx, "human", projectionRepresentationFormat, "error", input.DocumentID, projectionRevisionID)
		return LatestDownloadContent{}, errors.Join(ErrObjectStoreUnavailable, err)
	}
	want, err := hex.DecodeString(projection.SHA256)
	if err != nil || object.Key != projection.ObjectKey || object.Size != projection.SizeBytes ||
		!bytes.Equal(object.SHA256[:], want) {
		observeLatestRead(ctx, "human", projectionRepresentationFormat, "miss", input.DocumentID, projectionRevisionID)
		if invalidateErr := s.invalidateLatestProjection(
			ctx, value.TenantID, input.DocumentID, projectionRevisionID,
			projectionRepresentationFormat, *projection,
		); invalidateErr != nil {
			return LatestDownloadContent{}, errors.Join(ErrObjectStoreUnavailable, invalidateErr)
		}
		return LatestDownloadContent{}, &latestProjectionReadMiss{tenantID: value.TenantID, candidate: latestProjectionCandidate{documentID: input.DocumentID, revisionID: projectionRevisionID, representationFormat: projectionRepresentationFormat}}
	}
	content, err := s.portableMarkdownDownload(ctx, input, *projection, downloadAssets)
	cacheResult := "hit"
	if err != nil {
		cacheResult = "error"
	}
	observeLatestRead(ctx, "human", projectionRepresentationFormat, cacheResult, input.DocumentID, projectionRevisionID)
	return content, err
}

func (s *Service) invalidateLatestProjection(
	ctx context.Context,
	tenantID, documentID, revisionID, representationFormat string,
	projection LatestDownloadContent,
) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(
		hashtextextended('document-latest-object:' || $1,0)
	)`, projection.ObjectKey); err != nil {
		return err
	}
	object, headErr := s.objects.Head(ctx, projection.ObjectKey)
	missing := errors.Is(headErr, os.ErrNotExist)
	if headErr != nil && !missing {
		return headErr
	}
	want, decodeErr := hex.DecodeString(projection.SHA256)
	if !missing && decodeErr == nil && object.Key == projection.ObjectKey &&
		object.Size == projection.SizeBytes && bytes.Equal(object.SHA256[:], want) {
		return tx.Commit(ctx)
	}
	result, err := tx.Exec(ctx, `DELETE FROM document_latest_projections
		WHERE tenant_id=$1 AND document_id=$2 AND revision_id=$3
		  AND representation_format=$4 AND content_object_id=$5 AND sha256=$6
		  AND size_bytes=$7`,
		tenantID, documentID, revisionID, representationFormat,
		projection.ObjectKey, projection.SHA256, projection.SizeBytes)
	if err != nil {
		return err
	}
	if result.RowsAffected() == 1 {
		if err := artifactstore.DeleteDetached(ctx, s.objects, projection.ObjectKey); err != nil {
			return err
		}

	}
	return tx.Commit(ctx)
}
