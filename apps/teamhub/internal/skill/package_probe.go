package skill

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	artifactstore "github.com/simplexai-labs/linger/apps/teamhub/internal/artifact"
)

// probeEdgeManifestCount bounds the oldest and newest sealed Manifests probed at startup.
const probeEdgeManifestCount = 4

// ProbeStats describes the bounded startup storage probe.
type ProbeStats struct {
	ObjectCount   int
	BytesVerified int64
	Duration      time.Duration
}

type probeCandidate struct {
	manifestID string
	path       string
	objectKey  string
	sizeBytes  int64
	sha256     []byte
}

// ProbePackageStorage verifies a bounded sample of sealed Skill Package objects.
// It reads the root SKILL.md of up to four oldest and four newest sealed
// Manifests, so the cost does not grow with total Skill bytes. Every Skill
// Package read is still verified on access by the handler layer.
func ProbePackageStorage(
	ctx context.Context,
	pool *pgxpool.Pool,
	objects artifactstore.ObjectStore,
) (stats ProbeStats, err error) {
	started := time.Now()
	defer func() { stats.Duration = time.Since(started) }()
	if pool == nil || objects == nil {
		return stats, fmt.Errorf("%w: PostgreSQL and Object Store are required", ErrPackageAudit)
	}
	oldest, err := loadProbeCandidates(ctx, pool, "ASC")
	if err != nil {
		return stats, fmt.Errorf("%w: load oldest sealed Skill Manifests: %w", ErrPackageAudit, err)
	}
	newest, err := loadProbeCandidates(ctx, pool, "DESC")
	if err != nil {
		return stats, fmt.Errorf("%w: load newest sealed Skill Manifests: %w", ErrPackageAudit, err)
	}
	seen := make(map[string]bool, len(oldest)+len(newest))
	for _, candidate := range append(oldest, newest...) {
		if seen[candidate.objectKey] {
			continue
		}
		seen[candidate.objectKey] = true
		size, err := verifyProbeCandidate(ctx, objects, candidate)
		if err != nil {
			return stats, err
		}
		stats.ObjectCount++
		stats.BytesVerified += size
	}
	return stats, nil
}

// loadProbeCandidates reads at most probeEdgeManifestCount sealed root SKILL.md
// rows. sealed_at is NOT NULL for sealed Manifests by schema CHECK, but NULLS LAST
// keeps the order deterministic if that constraint is ever relaxed.
func loadProbeCandidates(ctx context.Context, pool *pgxpool.Pool, direction string) ([]probeCandidate, error) {
	rows, err := pool.Query(ctx, `
		SELECT manifest.manifest_id,file.path,file.object_key,file.size_bytes,decode(file.sha256,'hex')
		FROM skill_manifests manifest
		CROSS JOIN LATERAL jsonb_to_recordset(manifest.files)
		  AS file(path text,object_key text,size_bytes bigint,sha256 text)
		WHERE manifest.package_state='sealed' AND file.path='SKILL.md'
		ORDER BY manifest.sealed_at `+direction+` NULLS LAST, manifest.manifest_id `+direction+`
		LIMIT $1`, probeEdgeManifestCount)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var candidates []probeCandidate
	for rows.Next() {
		var candidate probeCandidate
		if err := rows.Scan(
			&candidate.manifestID,
			&candidate.path,
			&candidate.objectKey,
			&candidate.sizeBytes,
			&candidate.sha256,
		); err != nil {
			return nil, err
		}
		candidates = append(candidates, candidate)
	}
	return candidates, rows.Err()
}

func verifyProbeCandidate(
	ctx context.Context,
	objects artifactstore.ObjectStore,
	candidate probeCandidate,
) (int64, error) {
	size, digest, err := readProbeObject(ctx, objects, candidate)
	if err != nil {
		return 0, fmt.Errorf("%w: Manifest %s file %q object %q: %w",
			ErrPackageAudit, candidate.manifestID, candidate.path, candidate.objectKey, err)
	}
	if size != candidate.sizeBytes {
		return 0, fmt.Errorf("%w: Manifest %s file %q object %q: size %d differs from metadata %d",
			ErrPackageAudit, candidate.manifestID, candidate.path, candidate.objectKey, size, candidate.sizeBytes)
	}
	if !bytes.Equal(digest[:], candidate.sha256) {
		return 0, fmt.Errorf("%w: Manifest %s file %q object %q: sha256 differs from metadata",
			ErrPackageAudit, candidate.manifestID, candidate.path, candidate.objectKey)
	}
	return size, nil
}

// readProbeObject reads at most one byte beyond the recorded size so that an
// oversized object is detected without reading the whole object.
func readProbeObject(
	ctx context.Context,
	objects artifactstore.ObjectStore,
	candidate probeCandidate,
) (int64, [sha256.Size]byte, error) {
	var digest [sha256.Size]byte
	reader, err := objects.Open(ctx, candidate.objectKey)
	if err != nil {
		return 0, digest, err
	}
	hash := sha256.New()
	size, readErr := io.Copy(hash, io.LimitReader(reader, candidate.sizeBytes+1))
	closeErr := reader.Close()
	if err := errors.Join(readErr, closeErr, ctx.Err()); err != nil {
		return 0, digest, err
	}
	copy(digest[:], hash.Sum(nil))
	return size, digest, nil
}
