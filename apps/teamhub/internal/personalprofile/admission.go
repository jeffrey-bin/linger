// Package personalprofile generates the user profile from admitted sources.
package personalprofile

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/composio"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/documenttext"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/externalsource"
)

// fileAdmission checks the exact selected Version, including normalization failures.
// A still-current file without a text result must wait, not enter as unchecked bytes.
func (s *Service) fileAdmission(ctx context.Context, tenant, version string) (admitted, pending bool, err error) {
	err = s.pool.QueryRow(ctx, `SELECT
    t.source_id IS NOT NULL AND coalesce(d.native_import_status,'completed') IN ('completed','failed')
      AND source_rejection_reason(d.native_import_status, v.filename, v.representation_format,
          t.source_kind, v.media_type, t.status, t.scanned, octet_length(t.markdown), t.longest_line_bytes) IS NULL,
    (t.source_id IS NULL OR coalesce(d.native_import_status,'completed') NOT IN ('completed','failed')) AND coalesce(d.native_import_status,'completed') <> 'failed'
 FROM document_versions v JOIN documents d ON d.id=v.document_id AND d.tenant_id=v.tenant_id
 LEFT JOIN document_texts t ON t.document_id=d.id AND t.source_kind='file_version' AND t.source_id=v.id
 WHERE v.id=$1 AND v.tenant_id=$2 AND d.status='active' AND d.current_version_id=v.id
    AND d.format <> 'blocknote' AND NOT EXISTS (SELECT 1 FROM document_context_bindings b WHERE b.document_id=d.id AND b.binding_kind='wiki_page')`, version, tenant).Scan(&admitted, &pending)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, false, nil
	}
	return
}

func (s *Service) connectionAdmission(ctx context.Context, claimed claimedGeneration, source storedSource, documents []composio.AppDocument) ([]bool, bool, error) {
	if !externalsource.IsMailProvider(source.Provider) {
		allowed, err := s.transientAdmission(ctx, documents)
		return allowed, false, err
	}
	return s.mailAdmission(ctx, claimed, source.ConnectionID, documents)
}

// mailAdmission matches the selected mailbox snapshot to its bound Wiki document,
// including the content hash: a newer message version cannot authorize older bytes.
func (s *Service) mailAdmission(ctx context.Context, claimed claimedGeneration, connection string, documents []composio.AppDocument) ([]bool, bool, error) {
	keys := make([]string, 0, len(documents))
	hashes := make([]string, 0, len(documents))
	for _, d := range documents {
		if len(d.ProfileMarkdown) == 0 {
			continue
		}
		keys = append(keys, "mail:"+connection+":"+d.RemoteID)
		hash := sha256.Sum256(d.Markdown)
		hashes = append(hashes, hex.EncodeToString(hash[:]))
	}
	admitted := make([]bool, len(documents))
	if len(keys) == 0 {
		return admitted, false, nil
	}
	rows, err := s.pool.Query(ctx, `SELECT snapshot.key, v.document_id IS NULL AS pending, v.document_id IS NOT NULL AND v.reason IS NULL AS admitted
 FROM unnest($3::text[],$4::text[]) snapshot(key,hash)
 JOIN wiki_source_items i ON i.tenant_id=$1 AND i.owner_actor_id=$2 AND i.source_key=snapshot.key AND i.content_sha256=snapshot.hash
 JOIN documents d ON d.tenant_id=i.tenant_id AND d.id=i.document_id AND d.status='active' AND d.current_version_id=i.document_version_id
 JOIN document_context_bindings b ON b.tenant_id=i.tenant_id AND b.document_id=d.id AND b.binding_kind='wiki_source' AND b.status='active'
 LEFT JOIN wiki_document_verdicts v ON v.wiki_id=b.wiki_id AND v.document_id=d.id AND v.version_id=i.document_version_id`, claimed.TenantID, claimed.ActorID, keys, hashes)
	if err != nil {
		return nil, false, err
	}
	defer rows.Close()
	admittedKeys := make(map[string]bool, len(keys))
	for rows.Next() {
		var key string
		var wait, ok bool
		if err := rows.Scan(&key, &wait, &ok); err != nil {
			return nil, false, err
		}
		if wait {
			return nil, true, nil
		}
		admittedKeys[key] = ok
	}
	for i, d := range documents {
		admitted[i] = admittedKeys["mail:"+connection+":"+d.RemoteID]
	}
	return admitted, false, rows.Err()
}

// Transient imports have no Wiki binding. Apply the shared verdict to the complete
// Markdown before Profile extracts or budgets its evidence.
func (s *Service) transientAdmission(ctx context.Context, documents []composio.AppDocument) ([]bool, error) {
	if len(documents) == 0 {
		return nil, nil
	}
	names := make([]string, len(documents))
	sizes := make([]int64, len(documents))
	lines := make([]int64, len(documents))
	for i, d := range documents {
		names[i] = d.Filename
		sizes[i] = int64(len(d.Markdown))
		lines[i] = documenttext.LongestLineBytes(string(d.Markdown))
	}
	rows, err := s.pool.Query(ctx, `SELECT source_rejection_reason(NULL, name,'markdown','file_version','text/markdown','ready',false,size,longest) IS NULL
 FROM unnest($1::text[],$2::bigint[],$3::bigint[]) WITH ORDINALITY AS inputs(name,size,longest,n) ORDER BY n`, names, sizes, lines)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	allowed := make([]bool, 0, len(names))
	for rows.Next() {
		var ok bool
		if err := rows.Scan(&ok); err != nil {
			return nil, err
		}
		allowed = append(allowed, ok)
	}
	return allowed, rows.Err()
}
