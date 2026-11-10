package document

import (
	"context"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
)

// Upload runs its native import inline, so a pending import normally
// finishes within a short worker retry, and the text sync its new version
// queued follows within seconds. Wait that long so admission neither freezes
// the temporary upload Version (a representation-only delta would cost a
// second LLM generation) nor leaves out a source whose text is not written
// yet. A stuck source must not block the whole Wiki: after the bound it is
// excluded like any unusable source, and its ready text queues a later
// refresh.
const wikiSourceImportWait = 5 * time.Second

func (s *Service) prepareWikiSources(ctx context.Context, input RequestWikiRefreshInput) error {
	return waitForWikiSourceImports(ctx, func(awaitImports bool) (bool, error) {
		return s.bindWikiSources(ctx, input, awaitImports)
	})
}

func waitForWikiSourceImports(ctx context.Context, prepare func(awaitImports bool) (bool, error)) error {
	deadline := time.Now().Add(wikiSourceImportWait)
	for {
		ready, err := prepare(time.Now().Before(deadline))
		if err != nil || ready {
			return err
		}
		timer := time.NewTimer(100 * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
	}
}

// bindWikiSources binds the Human's My pages to the Wiki and reports whether
// no source is still waiting for its native import or for the text of its
// current version. Each source is read from that normalized text, so nothing
// is exported here. A text of any status ends the wait: a failed or textless
// version stays excluded until a newer one replaces it.
func (s *Service) bindWikiSources(ctx context.Context, input RequestWikiRefreshInput, awaitImports bool) (bool, error) {
	rows, err := s.pool.Query(ctx, `SELECT document.id,
        coalesce(document.native_import_status,''),
		CASE WHEN document.format='blocknote'
			THEN EXISTS(SELECT 1 FROM document_bodies body WHERE body.document_id=document.id)
			 AND NOT EXISTS(SELECT 1 FROM document_texts text
				WHERE text.document_id=document.id AND text.source_kind='native_body')
			ELSE document.current_version_id IS NOT NULL
			 AND NOT EXISTS(SELECT 1 FROM document_texts text
				WHERE text.document_id=document.id AND text.source_id=document.current_version_id)
		END,
		EXISTS(SELECT 1 FROM document_context_bindings binding
			WHERE binding.document_id=document.id AND binding.tenant_id=document.tenant_id
			  AND binding.wiki_id=wiki.id AND binding.binding_kind='wiki_source' AND binding.status='active')
		FROM personal_wikis wiki
		JOIN actors owner ON owner.id=wiki.owner_actor_id AND owner.tenant_id=wiki.tenant_id
		JOIN documents document ON document.tenant_id=wiki.tenant_id AND document.status='active'
		WHERE wiki.tenant_id=$1 AND owner.account_id=$2 AND wiki.deleted_at IS NULL
		 AND (EXISTS(SELECT 1 FROM document_placements placement
			WHERE placement.document_id=document.id AND placement.tenant_id=document.tenant_id
			  AND placement.scope_kind='personal' AND placement.owner_human_actor_id=owner.id
			  AND placement.deleted_at IS NULL AND document.owner_actor_id=owner.id)
		 OR EXISTS(SELECT 1 FROM document_context_bindings binding
			WHERE binding.document_id=document.id AND binding.tenant_id=document.tenant_id
			  AND binding.wiki_id=wiki.id AND binding.binding_kind='wiki_source' AND binding.status='active'))
		 AND NOT EXISTS(SELECT 1 FROM document_context_bindings excluded
			WHERE excluded.document_id=document.id AND excluded.tenant_id=document.tenant_id
			  AND excluded.wiki_id=wiki.id AND excluded.binding_kind='wiki_source' AND excluded.status<>'active')
		 AND NOT EXISTS(SELECT 1 FROM document_context_bindings page
			WHERE page.document_id=document.id AND page.tenant_id=document.tenant_id AND page.binding_kind='wiki_page')
		ORDER BY document.id`, input.TenantID, input.AccountID)
	if err != nil {
		return false, err
	}
	type source struct {
		id, importStatus string
		textPending      bool
		bound            bool
	}
	sources := make([]source, 0)
	for rows.Next() {
		var value source
		if err := rows.Scan(&value.id, &value.importStatus, &value.textPending, &value.bound); err != nil {
			rows.Close()
			return false, err
		}
		sources = append(sources, value)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return false, err
	}
	// wiki_current_sources excludes these from the frozen source
	// set, exactly like a deleted source; only their IDs are logged.
	var failed, importing, textless []string
	for _, value := range sources {
		switch {
		case value.importStatus == "failed":
			failed = append(failed, value.id)
		case value.importStatus == "pending":
			importing = append(importing, value.id)
		case value.textPending:
			textless = append(textless, value.id)
		}
	}
	if len(importing)+len(textless) > 0 && awaitImports {
		return false, nil
	}
	if len(failed)+len(importing)+len(textless) > 0 {
		slog.Default().Warn("document.wiki_sources_excluded",
			"tenant_id", input.TenantID, "failed_count", len(failed), "failed_document_ids", failed,
			"importing_count", len(importing), "importing_document_ids", importing,
			"textless_count", len(textless), "textless_document_ids", textless)
	}
	for _, value := range sources {
		if value.bound {
			continue
		}
		if _, err := s.BindToPersonalWiki(ctx, BindDocumentToPersonalWikiInput{
			AccountID: input.AccountID, TenantID: input.TenantID, DocumentID: value.id,
		}); err != nil {
			return false, err
		}
	}
	return true, nil
}

// lockWikiSourceHeads holds the bound source Documents and their texts while
// admission freezes the text versions it reads.
func lockWikiSourceHeads(ctx context.Context, tx pgx.Tx, wikiID string) error {
	rows, err := tx.Query(ctx, `SELECT document.id FROM document_context_bindings binding
		JOIN documents document ON document.id=binding.document_id AND document.tenant_id=binding.tenant_id
		WHERE binding.wiki_id=$1 AND binding.binding_kind='wiki_source' AND binding.status='active'
		 AND document.status='active' ORDER BY document.id FOR SHARE OF document`, wikiID)
	if err != nil {
		return err
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	rows, err = tx.Query(ctx, `SELECT text.document_id FROM document_context_bindings binding
		JOIN document_texts text ON text.document_id=binding.document_id
		WHERE binding.wiki_id=$1 AND binding.binding_kind='wiki_source' AND binding.status='active'
		ORDER BY text.document_id FOR SHARE OF text`, wikiID)
	if err != nil {
		return err
	}
	rows.Close()
	return rows.Err()
}
