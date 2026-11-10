package document

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	artifactstore "github.com/simplexai-labs/linger/apps/teamhub/internal/artifact"
	idgen "github.com/simplexai-labs/linger/apps/teamhub/internal/ids"
)

type DuplicateDocumentInput struct {
	AccountID, DocumentID string
	TargetFolderID        *string
}

type DuplicateDocumentResult struct {
	Document Document
}

// Duplicate copies a Document into the caller's tree; each call makes a new copy.
func (s *Service) Duplicate(ctx context.Context, input DuplicateDocumentInput) (DuplicateDocumentResult, error) {
	if input.AccountID == "" || input.DocumentID == "" {
		return DuplicateDocumentResult{}, ErrInvalidInput
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return DuplicateDocumentResult{}, err
	}
	committed := false
	createdObjectKeys := []string{}
	defer func() {
		_ = tx.Rollback(ctx)
		if !committed && s.objects != nil {
			for _, key := range createdObjectKeys {
				_ = artifactstore.DeleteDetached(ctx, s.objects, key)
			}
		}
	}()
	source, err := get(ctx, tx, input.AccountID, input.DocumentID)
	if err != nil || !source.Capabilities.Duplicate || source.Status != "active" {
		if err == nil {
			err = ErrNotFound
		}
		return DuplicateDocumentResult{}, err
	}
	actorID, err := resolveActiveHumanActorTx(ctx, tx, input.AccountID, source.TenantID)
	if err != nil {
		return DuplicateDocumentResult{}, err
	}
	if err := lockDuplicateTargetFolder(
		ctx, tx, input.AccountID, source.TenantID, actorID, input.TargetFolderID,
	); err != nil {
		return DuplicateDocumentResult{}, err
	}
	title, err := allocateDuplicateTitle(
		ctx, tx, source.TenantID, actorID, input.TargetFolderID, source.Title,
	)
	if err != nil {
		return DuplicateDocumentResult{}, err
	}
	if err := tx.QueryRow(ctx, `SELECT id FROM documents WHERE id=$1 AND tenant_id=$2
		AND status='active' FOR SHARE`, input.DocumentID, source.TenantID).Scan(&source.ID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return DuplicateDocumentResult{}, ErrNotFound
		}
		return DuplicateDocumentResult{}, err
	}
	resultID := idgen.New("document")
	provenanceID := stableCreateID("document_duplicate_", resultID, input.DocumentID)
	placementID := stableCreateID("document_placement_", actorID, resultID)
	var nativeRepresentationFormat any
	if source.Format == "blocknote" {
		nativeRepresentationFormat = source.RepresentationFormat
	}
	if _, err := tx.Exec(ctx, `INSERT INTO documents(
		id,tenant_id,title,format,native_representation_format,owner_actor_id,owner_actor_kind,creator_actor_id,
		creator_actor_kind,status
	) VALUES($1,$2,$3,$4,$5,$6,'human',$6,'human','active')`, resultID, source.TenantID,
		title, source.Format, nativeRepresentationFormat, actorID); err != nil {
		return DuplicateDocumentResult{}, err
	}
	if source.Format == "blocknote" {
		createdObjectKeys, err = s.duplicateNativeRevision(ctx, tx, source, resultID, provenanceID, actorID)
		if err != nil {
			return DuplicateDocumentResult{}, err
		}
	} else if err := duplicateOrdinaryVersion(ctx, tx, source, resultID, actorID); err != nil {
		return DuplicateDocumentResult{}, err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO document_placements(
		id,tenant_id,scope_kind,owner_human_actor_id,node_kind,document_id,parent_id,sort_key
	) VALUES($1,$2,'personal',$3,'document',$4,$5,$4)`, placementID, source.TenantID,
		actorID, resultID, input.TargetFolderID); err != nil {
		return DuplicateDocumentResult{}, err
	}
	if err := appendLifecycleEvent(
		ctx, tx, source.TenantID, resultID, actorID, provenanceID, "duplicate_provenance", "document.created",
	); err != nil {
		return DuplicateDocumentResult{}, err
	}
	value, err := get(ctx, tx, input.AccountID, resultID)
	if err != nil {
		return DuplicateDocumentResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return DuplicateDocumentResult{}, err
	}
	committed = true
	return DuplicateDocumentResult{Document: value}, nil
}

type duplicateAssetManifestEntry struct {
	AssetID   string `json:"asset_id"`
	SHA256    string `json:"sha256"`
	SizeBytes int64  `json:"size_bytes"`
}

func (s *Service) duplicateNativeRevision(
	ctx context.Context,
	tx pgx.Tx,
	source Document,
	resultID, provenanceID, actorID string,
) ([]string, error) {
	sourceRevisionID, err := bodyRevisionTx(ctx, tx, source.ID)
	if errors.Is(err, ErrNotFound) {
		return nil, ErrRevisionUnavailable
	}
	if err != nil {
		return nil, err
	}
	var stateStatus, stateBytesSHA, fullStateFingerprint string
	var stateVector, stateBytes []byte
	var assetManifest []byte
	var threadManifest []string
	err = tx.QueryRow(ctx, `SELECT state_vector,full_state_fingerprint,state_status,state_bytes,
		state_bytes_sha256,asset_manifest,thread_manifest
		FROM document_revisions WHERE id=$1`, sourceRevisionID).Scan(
		&stateVector, &fullStateFingerprint, &stateStatus, &stateBytes, &stateBytesSHA,
		&assetManifest, &threadManifest,
	)
	if err != nil {
		return nil, err
	}
	digest := sha256.Sum256(stateBytes)
	if stateStatus != "available" || len(stateBytes) == 0 ||
		hex.EncodeToString(digest[:]) != stateBytesSHA {
		return nil, ErrRevisionUnavailable
	}
	var assets []duplicateAssetManifestEntry
	if json.Unmarshal(assetManifest, &assets) != nil {
		return nil, ErrRevisionUnavailable
	}
	createdObjectKeys := []string{}
	resultStateBytes, resultStateBytesSHA := stateBytes, stateBytesSHA
	resultStateVector, resultFingerprint := stateVector, fullStateFingerprint
	resultAssetManifest := assetManifest
	resultThreadManifest := threadManifest
	resultAssetIDs := make([]string, len(assets))
	for index := range assets {
		resultAssetIDs[index] = assets[index].AssetID
	}
	if len(assets) != 0 || len(threadManifest) != 0 {
		if s.runtime == nil {
			return nil, ErrRuntimeUnavailable
		}
		mappings, targetManifest, objectKeys, copyErr := s.copyDuplicateAssets(
			ctx, tx, source, resultID, assets,
		)
		createdObjectKeys = append(createdObjectKeys, objectKeys...)
		if copyErr != nil {
			return createdObjectKeys, copyErr
		}
		runtimeResult, runtimeErr := s.runtime.Import(ctx, ImportRequest{
			OperationID: provenanceID, SourceKind: importDocumentState,
			SourceBytes: stateBytes, AssetMappings: mappings,
		})
		if runtimeErr != nil {
			return createdObjectKeys, fmt.Errorf("%w: %v", ErrRuntimeUnavailable, runtimeErr) //nolint:errorlint // inner store errors such as ErrTooLarge must not preempt the unavailable mapping
		}
		targetAssetIDs := make([]string, len(mappings))
		for index := range mappings {
			targetAssetIDs[index] = mappings[index].TargetAssetID
		}
		slices.Sort(targetAssetIDs)
		resultDigest := sha256.Sum256(runtimeResult.StateBytes)
		if len(runtimeResult.StateBytes) == 0 ||
			hex.EncodeToString(resultDigest[:]) != runtimeResult.StateBytesSHA256 ||
			runtimeResult.FullStateFingerprint != runtimeResult.StateBytesSHA256 ||
			runtimeResult.StateHashVersion != 1 || len(runtimeResult.StateVector) == 0 ||
			!slices.Equal(runtimeResult.CompleteAssetIDs, targetAssetIDs) ||
			len(runtimeResult.CompleteThreadIDs) != 0 {
			return createdObjectKeys, ErrRevisionUnavailable
		}
		resultStateBytes, resultStateBytesSHA = runtimeResult.StateBytes, runtimeResult.StateBytesSHA256
		resultStateVector, resultFingerprint = runtimeResult.StateVector, runtimeResult.FullStateFingerprint
		resultAssetManifest = targetManifest
		resultAssetIDs = targetAssetIDs
		resultThreadManifest = []string{}
	}
	if err := requireStateBundleBudget(
		resultStateBytes,
		resultStateVector,
		resultAssetIDs,
		resultThreadManifest,
	); err != nil {
		return createdObjectKeys, err
	}
	revisionID := stableCreateID("document_revision_duplicate_", resultID, sourceRevisionID)
	if _, err := tx.Exec(ctx, `INSERT INTO document_revisions(
		id,tenant_id,document_id,persisted_seq,state_vector,full_state_fingerprint,
		state_status,state_bytes,state_bytes_sha256,asset_manifest,thread_manifest,created_by_actor_id
	) VALUES($1,$2,$3,0,$4,$5,'available',$6,$7,$8,$9,$10)`,
		revisionID, source.TenantID, resultID, resultStateVector, resultFingerprint,
		resultStateBytes, resultStateBytesSHA, resultAssetManifest, resultThreadManifest, actorID); err != nil {
		return createdObjectKeys, err
	}
	if err := insertBodyTx(ctx, tx, resultID, resultStateBytes, resultStateVector,
		resultAssetIDs, resultThreadManifest, actorID); err != nil {
		return createdObjectKeys, err
	}
	return createdObjectKeys, nil
}

func (s *Service) copyDuplicateAssets(
	ctx context.Context,
	tx pgx.Tx,
	source Document,
	resultID string,
	manifest []duplicateAssetManifestEntry,
) ([]DuplicateAssetMapping, []byte, []string, error) {
	if s.objects == nil {
		return nil, nil, nil, ErrObjectStoreUnavailable
	}
	mappings := make([]DuplicateAssetMapping, 0, len(manifest))
	targetManifest := make([]duplicateAssetManifestEntry, 0, len(manifest))
	createdObjectKeys := []string{}
	for _, entry := range manifest {
		var filename, mediaType, sha, sourceObjectID string
		var sizeBytes int64
		err := tx.QueryRow(ctx, `SELECT filename,media_type,sha256,size_bytes,content_object_id
			FROM document_assets WHERE id=$1 AND tenant_id=$2 AND document_id=$3
			AND status='available' FOR SHARE`, entry.AssetID, source.TenantID, source.ID).Scan(
			&filename, &mediaType, &sha, &sizeBytes, &sourceObjectID,
		)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil, createdObjectKeys, ErrRevisionUnavailable
		}
		if err != nil {
			return nil, nil, createdObjectKeys, err
		}
		if sha != entry.SHA256 || sizeBytes != entry.SizeBytes {
			return nil, nil, createdObjectKeys, ErrRevisionUnavailable
		}
		digestBytes, err := hex.DecodeString(sha)
		if err != nil || len(digestBytes) != sha256.Size {
			return nil, nil, createdObjectKeys, ErrRevisionUnavailable
		}
		var expectedDigest [sha256.Size]byte
		copy(expectedDigest[:], digestBytes)
		sourceReader, err := s.objects.Open(ctx, sourceObjectID)
		if err != nil {
			return nil, nil, createdObjectKeys, fmt.Errorf("%w: %v", ErrObjectStoreUnavailable, err) //nolint:errorlint // inner store errors such as ErrTooLarge must not preempt the unavailable mapping
		}
		targetAssetID := stableCreateID("document_asset_", resultID, entry.AssetID)
		targetObjectDigest := sha256.Sum256([]byte("document-duplicate-object\x00" + targetAssetID))
		targetObjectID := "object_" + hex.EncodeToString(targetObjectDigest[:16])
		_, replayed, putErr := s.objects.PutIfAbsent(
			ctx, targetObjectID, sourceReader, sizeBytes, expectedDigest,
		)
		closeErr := sourceReader.Close()
		if putErr != nil || closeErr != nil {
			if putErr == nil {
				putErr = closeErr
			}
			return nil, nil, createdObjectKeys, fmt.Errorf("%w: %v", ErrObjectStoreUnavailable, putErr) //nolint:errorlint // inner store errors such as ErrTooLarge must not preempt the unavailable mapping
		}
		if !replayed {
			createdObjectKeys = append(createdObjectKeys, targetObjectID)
		}
		if _, err := tx.Exec(ctx, `INSERT INTO document_assets(
			id,tenant_id,document_id,filename,media_type,sha256,size_bytes,content_object_id,status
		) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'available')`, targetAssetID, source.TenantID,
			resultID, filename, mediaType, sha, sizeBytes, targetObjectID); err != nil {
			return nil, nil, createdObjectKeys, err
		}
		mappings = append(mappings, DuplicateAssetMapping{SourceAssetID: entry.AssetID, TargetAssetID: targetAssetID})
		targetManifest = append(targetManifest, duplicateAssetManifestEntry{
			AssetID: targetAssetID, SHA256: sha, SizeBytes: sizeBytes,
		})
	}
	slices.SortFunc(mappings, func(left, right DuplicateAssetMapping) int {
		return strings.Compare(left.SourceAssetID, right.SourceAssetID)
	})
	slices.SortFunc(targetManifest, func(left, right duplicateAssetManifestEntry) int {
		return strings.Compare(left.AssetID, right.AssetID)
	})
	encoded, err := json.Marshal(targetManifest)
	return mappings, encoded, createdObjectKeys, err
}

func duplicateOrdinaryVersion(
	ctx context.Context,
	tx pgx.Tx,
	source Document,
	resultID, actorID string,
) error {
	if source.CurrentVersion == nil {
		return ErrRevisionUnavailable
	}
	var sourceVersionID, filename, representationFormat, mediaType, sha, contentObjectID string
	var sizeBytes int64
	err := tx.QueryRow(ctx, `SELECT version.id,version.filename,version.representation_format,
		version.media_type,version.size_bytes,version.sha256,version.content_object_id
		FROM document_versions version JOIN documents document
		 ON document.current_version_id=version.id AND document.tenant_id=version.tenant_id
		 AND document.id=version.document_id
		WHERE document.id=$1 AND document.tenant_id=$2 FOR SHARE OF version`,
		source.ID, source.TenantID).Scan(&sourceVersionID, &filename, &representationFormat,
		&mediaType, &sizeBytes, &sha, &contentObjectID)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrRevisionUnavailable
	}
	if err != nil {
		return err
	}
	versionID := stableCreateID("document_version_duplicate_", resultID, sourceVersionID)
	if _, err := tx.Exec(ctx, `INSERT INTO document_versions(
		id,tenant_id,document_id,version_number,filename,representation_format,media_type,
		size_bytes,sha256,content_object_id,source,created_by_actor_id
	) VALUES($1,$2,$3,1,$4,$5,$6,$7,$8,$9,'ordinary_upload',$10)`, versionID,
		source.TenantID, resultID, filename, representationFormat, mediaType, sizeBytes, sha,
		contentObjectID, actorID); err != nil {
		return err
	}
	if command, err := tx.Exec(ctx, `UPDATE documents SET current_version_id=$2,
		updated_at=GREATEST(updated_at,clock_timestamp()) WHERE id=$1 AND tenant_id=$3 AND current_version_id IS NULL`,
		resultID, versionID, source.TenantID); err != nil {
		return err
	} else if command.RowsAffected() != 1 {
		return ErrVersionConflict
	}
	return nil
}

func lockDuplicateTargetFolder(
	ctx context.Context,
	tx pgx.Tx,
	accountID, tenantID, actorID string,
	targetFolderID *string,
) error {
	lockKey := actorID + "|document-duplicate-root"
	if targetFolderID != nil {
		lockKey = actorID + "|document-duplicate-folder|" + *targetFolderID
		var folderID string
		err := tx.QueryRow(ctx, `SELECT placement.id
			FROM document_placements placement
			JOIN actors actor ON actor.id=placement.owner_human_actor_id
			 AND actor.tenant_id=placement.tenant_id AND actor.account_id=$1
			WHERE placement.id=$2 AND placement.tenant_id=$3
			  AND placement.owner_human_actor_id=$4 AND placement.scope_kind='personal'
			  AND placement.node_kind='folder' AND placement.deleted_at IS NULL
			FOR UPDATE OF placement`, accountID, *targetFolderID, tenantID, actorID).Scan(&folderID)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
	}
	_, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, lockKey)
	return err
}

func allocateDuplicateTitle(
	ctx context.Context,
	tx pgx.Tx,
	tenantID, actorID string,
	targetFolderID *string,
	sourceTitle string,
) (string, error) {
	rows, err := tx.Query(ctx, `SELECT document.title
		FROM document_placements placement
		JOIN documents document ON document.id=placement.document_id
		 AND document.tenant_id=placement.tenant_id AND document.status='active'
		WHERE placement.tenant_id=$1 AND placement.owner_human_actor_id=$2
		  AND placement.scope_kind='personal' AND placement.node_kind='document'
		  AND placement.deleted_at IS NULL AND placement.parent_id IS NOT DISTINCT FROM $3::text`,
		tenantID, actorID, targetFolderID)
	if err != nil {
		return "", err
	}
	defer rows.Close()
	existing := map[string]struct{}{}
	for rows.Next() {
		var title string
		if err := rows.Scan(&title); err != nil {
			return "", err
		}
		existing[title] = struct{}{}
	}
	if err := rows.Err(); err != nil {
		return "", err
	}
	for copyNumber := 1; copyNumber < 1_000_000; copyNumber++ {
		candidate := duplicateTitle(sourceTitle, copyNumber)
		if _, found := existing[candidate]; !found {
			return candidate, nil
		}
	}
	return "", ErrConflict
}

func duplicateTitle(source string, copyNumber int) string {
	suffix := " copy"
	if copyNumber > 1 {
		suffix += fmt.Sprintf(" %d", copyNumber)
	}
	prefix := strings.TrimSpace(source)
	extension := ""
	if extensionStart := strings.LastIndex(prefix, "."); extensionStart > 0 && extensionStart < len(prefix)-1 {
		candidate := prefix[extensionStart:]
		if len(candidate) <= 32 && !strings.ContainsAny(candidate, " \t\r\n/\\") {
			extension = candidate
			prefix = prefix[:extensionStart]
		}
	}
	maximumPrefixBytes := 255 - len(suffix) - len(extension)
	for len(prefix) > maximumPrefixBytes {
		_, size := utf8.DecodeLastRuneInString(prefix)
		if size == 0 {
			break
		}
		prefix = prefix[:len(prefix)-size]
	}
	return prefix + suffix + extension
}
