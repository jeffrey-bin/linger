package document

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// retentionRowsPerStep bounds each step of one Document's cleanup, so a large
// backlog never holds one transaction for long.
const retentionRowsPerStep = 200

// RetentionCollector deletes the Revisions that nothing reads any more. A
// pass visits every native Document in ID order, one transaction per
// Document.
type RetentionCollector struct {
	pool *pgxpool.Pool
	// after is the last Document the current pass finished; empty starts a pass.
	after string
}

// NewRetentionCollector returns a collector that starts a new pass.
func NewRetentionCollector(pool *pgxpool.Pool) *RetentionCollector {
	return &RetentionCollector{pool: pool}
}

// RunOnce cleans the next Document of the pass and reports false once the
// pass is complete; the next call starts a new pass. A Document with more work
// than one transaction allows is cleaned again before the pass moves on, and
// a Document that fails is retried in the next pass.
func (collector *RetentionCollector) RunOnce(ctx context.Context) (bool, error) {
	if collector == nil || collector.pool == nil {
		return false, ErrInvalidInput
	}
	var documentID string
	err := collector.pool.QueryRow(ctx, `SELECT document_id FROM document_bodies
		WHERE document_id>$1 ORDER BY document_id LIMIT 1`, collector.after).Scan(&documentID)
	if errors.Is(err, pgx.ErrNoRows) {
		collector.after = ""
		return false, nil
	}
	if err != nil {
		return false, err
	}
	more, err := collector.clean(ctx, documentID)
	if err != nil || !more {
		collector.after = documentID
	}
	return true, err
}

// clean deletes the released Revisions of one Document and reports whether
// it hit its bound.
func (collector *RetentionCollector) clean(ctx context.Context, documentID string) (bool, error) {
	tx, err := collector.pool.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('teamhub.document_retention','on',true)`); err != nil {
		return false, err
	}
	revisions, err := tx.Exec(ctx, deleteReleasedRevisionsSQL, documentID, retentionRowsPerStep)
	if err != nil {
		return false, err
	}
	return revisions.RowsAffected() == retentionRowsPerStep, tx.Commit(ctx)
}

// deleteReleasedRevisionsSQL deletes the pinned snapshots of Document $1 that
// a later History point already covers and that nothing references: not a
// History point, not the head, no row that references it by foreign key, and not
// frozen in a pending Room creation approval.
const deleteReleasedRevisionsSQL = `DELETE FROM document_revisions WHERE id IN (
	SELECT revision.id FROM document_revisions revision
	WHERE revision.document_id=$1
	  AND revision.history_trigger IS NULL
	  AND revision.persisted_seq<(
		SELECT max(point.persisted_seq) FROM document_revisions point
		WHERE point.document_id=$1 AND point.history_trigger IS NOT NULL)
	  AND NOT EXISTS (SELECT 1 FROM document_bodies body
		WHERE body.document_id=$1 AND body.seq=revision.persisted_seq)
	  AND NOT EXISTS (SELECT 1 FROM document_versions version
		WHERE version.document_id=$1 AND version.source_revision_id=revision.id)
	  AND NOT EXISTS (SELECT 1 FROM document_latest_projections projection
		WHERE projection.document_id=$1 AND projection.revision_id=revision.id)
	  AND NOT EXISTS (SELECT 1 FROM decisions decision
		WHERE decision.tenant_id=revision.tenant_id AND decision.kind='room_creation' AND decision.status='pending'
		  AND decision.request->'fulfillment_snapshot'->'artifacts' @> jsonb_build_array(jsonb_build_object(
			'document_id',revision.document_id,'document_revision_id',revision.id)))
	ORDER BY revision.persisted_seq LIMIT $2)`
