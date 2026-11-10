package document

import (
	"context"
	"errors"
	"fmt"
	"os"

	"github.com/jackc/pgx/v5"
)

// WikiPageVersionsKept is how many Versions an active Wiki page keeps. A page
// a refresh removed keeps only its current Version. Older Versions are never
// read: the Web shows the current page and the Wiki has no history view.
const WikiPageVersionsKept = 5

// WikiVersionPruner deletes the Versions of Wiki pages beyond what they keep,
// with their stored content. A pass visits each over-long page in ID order,
// one transaction per page.
type WikiVersionPruner struct {
	documents *Service
	// after is the last page the current pass finished; empty starts a pass.
	after string
}

// NewWikiVersionPruner returns a pruner that starts a new pass.
func NewWikiVersionPruner(documents *Service) *WikiVersionPruner {
	return &WikiVersionPruner{documents: documents}
}

// RunOnce prunes the next over-long Wiki page of the pass and reports false
// once the pass is complete; the next call starts a new pass. A page whose
// extra Versions are still referenced keeps them and is visited again in the
// next pass.
func (pruner *WikiVersionPruner) RunOnce(ctx context.Context) (bool, error) {
	if pruner == nil || pruner.documents == nil || pruner.documents.pool == nil {
		return false, ErrInvalidInput
	}
	var documentID string
	var keep int
	err := pruner.documents.pool.QueryRow(ctx, `
		SELECT binding.document_id, CASE WHEN binding.status='active' THEN $2::int ELSE 1 END
		FROM document_context_bindings binding
		JOIN document_versions version ON version.document_id=binding.document_id
		WHERE binding.binding_kind='wiki_page' AND binding.document_id>$1
		GROUP BY binding.document_id, binding.status
		HAVING count(*)>CASE WHEN binding.status='active' THEN $2::int ELSE 1 END
		ORDER BY binding.document_id LIMIT 1`, pruner.after, WikiPageVersionsKept).Scan(&documentID, &keep)
	if errors.Is(err, pgx.ErrNoRows) {
		pruner.after = ""
		return false, nil
	}
	if err != nil {
		return false, err
	}
	pruner.after = documentID
	return true, pruner.prune(ctx, documentID, keep)
}

// prune deletes one page's Versions older than its newest keep, except the
// current one and any another record still points at, then deletes their
// stored content once nothing else uses it.
func (pruner *WikiVersionPruner) prune(ctx context.Context, documentID string, keep int) error {
	tx, err := pruner.documents.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('teamhub.document_retention','on',true)`); err != nil {
		return err
	}
	rows, err := tx.Query(ctx, prunableWikiVersionsSQL, documentID, keep)
	if err != nil {
		return err
	}
	var versionIDs []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		versionIDs = append(versionIDs, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	if len(versionIDs) == 0 {
		return tx.Commit(ctx)
	}
	// The oldest kept Version no longer has a base to point at.
	if _, err := tx.Exec(ctx, `UPDATE document_versions SET base_version_id=NULL
		WHERE document_id=$1 AND base_version_id=ANY($2::text[]) AND NOT (id=ANY($2::text[]))`, documentID, versionIDs); err != nil {
		return err
	}
	objectRows, err := tx.Query(ctx, `DELETE FROM document_versions WHERE document_id=$1 AND id=ANY($2::text[])
		RETURNING content_object_id`, documentID, versionIDs)
	if err != nil {
		return err
	}
	var objectIDs []string
	for objectRows.Next() {
		var objectID string
		if err := objectRows.Scan(&objectID); err != nil {
			objectRows.Close()
			return err
		}
		objectIDs = append(objectIDs, objectID)
	}
	objectRows.Close()
	if err := objectRows.Err(); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	return pruner.deleteUnusedObjects(ctx, objectIDs)
}

// deleteUnusedObjects deletes stored content no Version, asset or latest
// download still names. A failed delete leaves only an unreferenced object.
func (pruner *WikiVersionPruner) deleteUnusedObjects(ctx context.Context, objectIDs []string) error {
	if pruner.documents.objects == nil {
		return nil
	}
	var errs []error
	for _, objectID := range objectIDs {
		var used bool
		if err := pruner.documents.pool.QueryRow(ctx, `SELECT
			EXISTS(SELECT 1 FROM document_versions WHERE content_object_id=$1)
			OR EXISTS(SELECT 1 FROM document_assets WHERE content_object_id=$1)
			OR EXISTS(SELECT 1 FROM document_latest_projections WHERE content_object_id=$1)`, objectID).Scan(&used); err != nil {
			errs = append(errs, err)
			continue
		}
		if used {
			continue
		}
		if err := pruner.documents.objects.Delete(ctx, objectID); err != nil && !errors.Is(err, os.ErrNotExist) {
			errs = append(errs, fmt.Errorf("delete Wiki page Version content %s: %w", objectID, err))
		}
	}
	return errors.Join(errs...)
}

// prunableWikiVersionsSQL lists the Versions of page $1 older than its newest
// $2 that nothing reads: not current, and not named by any record that keeps
// a Version ID. When adding a column that points at document_versions, add it
// here.
const prunableWikiVersionsSQL = `SELECT version.id FROM document_versions version
	WHERE version.document_id=$1
	  AND version.version_number<=(SELECT max(version_number) FROM document_versions WHERE document_id=$1)-$2
	  AND NOT EXISTS (SELECT 1 FROM documents document WHERE document.id=$1
		AND (document.current_version_id=version.id OR document.native_import_source_version_id=version.id))
	  AND NOT EXISTS (SELECT 1 FROM document_text_heads head WHERE head.current_version_id=version.id)
	  AND NOT EXISTS (SELECT 1 FROM document_wiki_published_sources source WHERE source.document_version_id=version.id)
	  AND NOT EXISTS (SELECT 1 FROM document_wiki_refresh_sources source WHERE source.frozen_document_version_id=version.id)
	  AND NOT EXISTS (SELECT 1 FROM wiki_current_sources source WHERE source.version_id=version.id)
	  AND NOT EXISTS (SELECT 1 FROM wiki_document_verdicts verdict WHERE verdict.version_id=version.id)
	  AND NOT EXISTS (SELECT 1 FROM wiki_session_sources source WHERE source.version_id=version.id)
	  AND NOT EXISTS (SELECT 1 FROM wiki_source_items item WHERE item.document_version_id=version.id)
	  AND NOT EXISTS (SELECT 1 FROM room_document_comment_threads thread WHERE thread.anchor_document_version_id=version.id)
	  AND NOT EXISTS (SELECT 1 FROM capture_media_outputs output WHERE output.document_version_id=version.id)
	  AND NOT EXISTS (SELECT 1 FROM capture_sessions session WHERE version.id IN (
		session.document_version_id, session.source_audio_document_version_id, session.transcript_document_version_id))
	ORDER BY version.version_number`
