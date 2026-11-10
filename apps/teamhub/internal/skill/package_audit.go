package skill

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"math"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	artifactstore "github.com/simplexai-labs/linger/apps/teamhub/internal/artifact"
	"golang.org/x/sync/errgroup"
)

// This is the hard per-file bound enforced by the unified Skill schema.
const maximumAuditedPackageFileBytes = 8 << 20

// DefaultPackageAuditConcurrency bounds concurrent object-store verification.
const DefaultPackageAuditConcurrency = 8

// ErrPackageAudit identifies a persisted Package integrity failure that blocks readiness.
var ErrPackageAudit = errors.New("Skill Package object audit failed")

type packageAuditManifest struct {
	manifestID      string
	skillID         string
	manifestVersion string
	skillName       string
	description     string
	contentHash     []byte
	fileCount       int
	sizeBytes       int64
	files           []packageAuditFile
}

type packageAuditFile struct {
	path      string
	mediaType string
	sizeBytes int64
	sha256    []byte
	objectKey string
}

// AuditOptions controls the object-store portion of a sealed Package audit.
type AuditOptions struct {
	MaxConcurrency int
}

// AuditStats describes the work performed by one sealed Package audit.
type AuditStats struct {
	ManifestCount     int
	FileCount         int
	UniqueObjectCount int
	HeadChecks        int
	BodyReads         int
	BytesVerified     int64
	Duration          time.Duration
}

type packageAuditObjectReference struct {
	manifest *packageAuditManifest
	file     packageAuditFile
}

type packageAuditObject struct {
	key       string
	capture   bool
	reference packageAuditObjectReference
}

type packageAuditObjectEvidence struct {
	content []byte
	size    int64
	sha256  [sha256.Size]byte
}

// AuditPackagesWithOptions verifies that every sealed unified Skill Manifest is
// backed by the exact immutable bytes described by PostgreSQL, and returns
// bounded object-store work statistics for operational observability.
func AuditPackagesWithOptions(
	ctx context.Context,
	pool *pgxpool.Pool,
	objects artifactstore.ObjectStore,
	options AuditOptions,
) (stats AuditStats, err error) {
	started := time.Now()
	defer func() { stats.Duration = time.Since(started) }()
	if pool == nil || objects == nil {
		return stats, fmt.Errorf("%w: PostgreSQL and Object Store are required", ErrPackageAudit)
	}
	tx, err := pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return stats, fmt.Errorf("%w: begin sealed Package metadata snapshot: %w", ErrPackageAudit, err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	manifests, err := loadSealedPackageAuditManifests(ctx, tx)
	if err != nil {
		return stats, fmt.Errorf("%w: load sealed Skill Manifests: %w", ErrPackageAudit, err)
	}
	if err := loadSealedPackageAuditFiles(ctx, tx, manifests); err != nil {
		return stats, fmt.Errorf("%w: load sealed Skill Package files: %w", ErrPackageAudit, err)
	}
	if err := tx.Commit(ctx); err != nil {
		return stats, fmt.Errorf("%w: close sealed Package metadata snapshot: %w", ErrPackageAudit, err)
	}
	return auditSealedPackageObjects(ctx, objects, manifests, options, stats)
}

func loadSealedPackageAuditManifests(
	ctx context.Context,
	tx pgx.Tx,
) ([]*packageAuditManifest, error) {
	rows, err := tx.Query(ctx, `
		SELECT manifest.manifest_id,manifest.skill_id,manifest.manifest_version,
		       skill.name,manifest.description,manifest.content_hash,
		       manifest.file_count,manifest.size_bytes
		FROM skill_manifests manifest
		JOIN skills skill ON skill.skill_id=manifest.skill_id
		WHERE manifest.package_state='sealed'
		ORDER BY manifest.manifest_id COLLATE "C"`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var manifests []*packageAuditManifest
	for rows.Next() {
		manifest := new(packageAuditManifest)
		if err := rows.Scan(
			&manifest.manifestID,
			&manifest.skillID,
			&manifest.manifestVersion,
			&manifest.skillName,
			&manifest.description,
			&manifest.contentHash,
			&manifest.fileCount,
			&manifest.sizeBytes,
		); err != nil {
			return nil, err
		}
		manifests = append(manifests, manifest)
	}
	return manifests, rows.Err()
}

func loadSealedPackageAuditFiles(
	ctx context.Context,
	tx pgx.Tx,
	manifests []*packageAuditManifest,
) error {
	byID := make(map[string]*packageAuditManifest, len(manifests))
	for _, manifest := range manifests {
		byID[manifest.manifestID] = manifest
	}
	rows, err := tx.Query(ctx, `
		SELECT manifest.manifest_id,file.path,file.media_type,file.size_bytes,
		       decode(file.sha256,'hex'),file.object_key
		FROM skill_manifests manifest
		CROSS JOIN LATERAL jsonb_to_recordset(manifest.files)
		  AS file(path text,media_type text,size_bytes bigint,sha256 text,object_key text)
		WHERE manifest.package_state='sealed'
		ORDER BY manifest.manifest_id COLLATE "C",file.path COLLATE "C"`)
	if err != nil {
		return err
	}
	defer rows.Close()

	for rows.Next() {
		var manifestID string
		var file packageAuditFile
		if err := rows.Scan(
			&manifestID,
			&file.path,
			&file.mediaType,
			&file.sizeBytes,
			&file.sha256,
			&file.objectKey,
		); err != nil {
			return err
		}
		manifest, ok := byID[manifestID]
		if !ok {
			return fmt.Errorf("sealed Skill Package file references unknown Manifest %q", manifestID)
		}
		manifest.files = append(manifest.files, file)
	}
	return rows.Err()
}

func auditSealedPackageObjects(
	ctx context.Context,
	objects artifactstore.ObjectStore,
	manifests []*packageAuditManifest,
	options AuditOptions,
	stats AuditStats,
) (AuditStats, error) {
	if options.MaxConcurrency <= 0 {
		options.MaxConcurrency = DefaultPackageAuditConcurrency
	}
	stats.ManifestCount = len(manifests)
	objectsByKey := make(map[string]*packageAuditObject)
	for _, manifest := range manifests {
		if manifest == nil || manifest.manifestID == "" || manifest.skillID == "" {
			return stats, packageAuditError("sealed Manifest identity is invalid")
		}
		stats.FileCount += len(manifest.files)
		for index, file := range manifest.files {
			if err := validatePackageAuditFile(manifest, index, file); err != nil {
				return stats, err
			}
			object, exists := objectsByKey[file.objectKey]
			if !exists {
				objectsByKey[file.objectKey] = &packageAuditObject{
					key: file.objectKey, capture: file.path == "SKILL.md",
					reference: packageAuditObjectReference{manifest: manifest, file: file},
				}
				continue
			}
			if object.reference.file.sizeBytes != file.sizeBytes || !bytes.Equal(object.reference.file.sha256, file.sha256) {
				return stats, packageAuditManifestError(manifest, "file %q reuses object %q with conflicting metadata", file.path, file.objectKey)
			}
			object.capture = object.capture || file.path == "SKILL.md"
		}
	}
	stats.UniqueObjectCount = len(objectsByKey)
	for _, object := range objectsByKey {
		if object.capture {
			stats.BodyReads++
		} else {
			stats.HeadChecks++
		}
	}

	type result struct {
		key      string
		evidence packageAuditObjectEvidence
	}
	results := make(chan result, len(objectsByKey))
	group, groupContext := errgroup.WithContext(ctx)
	group.SetLimit(options.MaxConcurrency)
	for _, object := range objectsByKey {

		group.Go(func() error {
			content, size, digest, err := readPackageAuditEvidence(
				groupContext, objects, object.reference.file, object.capture,
			)
			if err != nil {
				return packageAuditManifestError(object.reference.manifest, "file %q object %q: %v", object.reference.file.path, object.key, err)
			}
			results <- result{key: object.key, evidence: packageAuditObjectEvidence{content: content, size: size, sha256: digest}}
			return nil
		})
	}
	if err := group.Wait(); err != nil {
		return stats, err
	}
	close(results)
	evidenceByKey := make(map[string]packageAuditObjectEvidence, len(objectsByKey))
	for item := range results {
		evidenceByKey[item.key] = item.evidence
		if item.evidence.size > math.MaxInt64-stats.BytesVerified {
			return stats, packageAuditError("audited object size overflows int64")
		}
		stats.BytesVerified += item.evidence.size
	}
	for _, manifest := range manifests {
		if err := validatePackageAuditManifest(manifest, evidenceByKey); err != nil {
			return stats, err
		}
	}
	return stats, nil
}

func validatePackageAuditFile(manifest *packageAuditManifest, index int, file packageAuditFile) error {
	if !ValidatePackageFilePath(file.path) {
		return packageAuditManifestError(manifest, "file path %q is invalid", file.path)
	}
	if index > 0 && manifest.files[index-1].path >= file.path {
		return packageAuditManifestError(manifest, "file paths are not strictly ordered")
	}
	if file.sizeBytes < 0 || file.sizeBytes > maximumAuditedPackageFileBytes {
		return packageAuditManifestError(manifest, "file %q size %d is outside the audit bound", file.path, file.sizeBytes)
	}
	if len(file.sha256) != sha256.Size || file.objectKey == "" {
		return packageAuditManifestError(manifest, "file %q metadata is invalid", file.path)
	}
	return nil
}

func validatePackageAuditManifest(
	manifest *packageAuditManifest,
	evidenceByKey map[string]packageAuditObjectEvidence,
) error {
	actualFiles := make([]PackageFile, 0, len(manifest.files))
	var totalSize int64
	var skillMarkdown []byte
	var skillMarkdownFound bool
	for _, file := range manifest.files {
		evidence, ok := evidenceByKey[file.objectKey]
		if !ok || evidence.size != file.sizeBytes || !bytes.Equal(evidence.sha256[:], file.sha256) {
			return packageAuditManifestError(manifest, "file %q object evidence differs", file.path)
		}
		if evidence.size > math.MaxInt64-totalSize {
			return packageAuditManifestError(manifest, "Package size overflows int64")
		}
		totalSize += evidence.size
		actualFiles = append(actualFiles, PackageFile{
			Path: file.path, MediaType: file.mediaType, SizeBytes: evidence.size, SHA256: evidence.sha256,
		})
		if file.path == "SKILL.md" {
			skillMarkdown = evidence.content
			skillMarkdownFound = true
		}
	}
	if !skillMarkdownFound {
		return packageAuditManifestError(manifest, "root SKILL.md is missing")
	}
	frontmatter, err := ParsePackageFrontmatter(skillMarkdown)
	if err != nil {
		return packageAuditManifestError(manifest, "SKILL.md frontmatter is invalid: %v", err)
	}
	if frontmatter.Name != manifest.skillName {
		return packageAuditManifestError(
			manifest,
			"SKILL.md name %q differs from Skill name %q",
			frontmatter.Name,
			manifest.skillName,
		)
	}
	if frontmatter.Description != manifest.description {
		return packageAuditManifestError(manifest, "SKILL.md description differs from Manifest description")
	}
	if len(actualFiles) != manifest.fileCount || totalSize != manifest.sizeBytes {
		return packageAuditManifestError(
			manifest,
			"actual Package aggregate count=%d size=%d differs from Manifest count=%d size=%d",
			len(actualFiles),
			totalSize,
			manifest.fileCount,
			manifest.sizeBytes,
		)
	}
	actualContentHash := CanonicalPackageDigest(actualFiles)
	if len(manifest.contentHash) != sha256.Size || !bytes.Equal(actualContentHash[:], manifest.contentHash) {
		return packageAuditManifestError(manifest, "actual Package content hash differs from Manifest")
	}
	return nil
}

func readPackageAuditObject(
	ctx context.Context,
	objects artifactstore.ObjectStore,
	file packageAuditFile,
	capture bool,
) ([]byte, int64, [sha256.Size]byte, error) {
	reader, err := objects.Open(ctx, file.objectKey)
	if err != nil {
		return nil, 0, [sha256.Size]byte{}, err
	}
	digest := sha256.New()
	var content bytes.Buffer
	destination := io.Writer(digest)
	if capture {
		destination = io.MultiWriter(digest, &content)
	}
	actualSize, readErr := io.Copy(destination, io.LimitReader(reader, file.sizeBytes+1))
	closeErr := reader.Close()
	if err := errors.Join(readErr, closeErr, ctx.Err()); err != nil {
		return nil, 0, [sha256.Size]byte{}, err
	}
	var actualSHA256 [sha256.Size]byte
	copy(actualSHA256[:], digest.Sum(nil))
	return content.Bytes(), actualSize, actualSHA256, nil
}

func readPackageAuditEvidence(
	ctx context.Context,
	objects artifactstore.ObjectStore,
	file packageAuditFile,
	capture bool,
) ([]byte, int64, [sha256.Size]byte, error) {
	if capture {
		return readPackageAuditObject(ctx, objects, file, true)
	}
	object, err := objects.Head(ctx, file.objectKey)
	if err != nil {
		return nil, 0, [sha256.Size]byte{}, err
	}
	return nil, object.Size, object.SHA256, nil
}

func packageAuditManifestError(manifest *packageAuditManifest, format string, args ...any) error {
	detail := fmt.Sprintf(format, args...)
	return packageAuditError(
		"Manifest %s (%s@%s): %s",
		manifest.manifestID,
		manifest.skillID,
		manifest.manifestVersion,
		detail,
	)
}

func packageAuditError(format string, args ...any) error {
	return fmt.Errorf("%w: %s", ErrPackageAudit, fmt.Sprintf(format, args...))
}
