package document

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

type listedDocument struct {
	ID       string
	SortTime time.Time
}

// effectiveDocumentSQL returns no row unless resolve_human_document_access_v2
// grants the Account read access to the active Document.
const effectiveDocumentSQL = `
SELECT document.id,document.tenant_id,document.title,document.format,
       CASE WHEN document.format='blocknote'
            THEN coalesce(document.native_representation_format,'markdown')
            ELSE document.format END,
       document.status,
       document.created_at,greatest(document.updated_at,(SELECT body.updated_at FROM document_bodies body WHERE body.document_id=document.id)),
       owner.id,owner.kind,owner.display_name,creator.id,creator.kind,creator.display_name,
       version.id,version.version_number,version.sha256,
       access.can_manage,access.can_write,access.can_comment,
       EXISTS(SELECT 1 FROM document_bodies body WHERE body.document_id=document.id),
       access.content_role,access.access_sources,
       coalesce(document.link_share_status='active',false),
       EXISTS(SELECT 1 FROM document_context_bindings WHERE document_id=document.id
              AND tenant_id=document.tenant_id AND binding_kind='wiki_page' AND status='active'),
       access.actor_id,clock_timestamp()
FROM documents document
CROSS JOIN LATERAL resolve_human_document_access_v2($1,document.id) access
JOIN actors owner ON owner.id=document.owner_actor_id AND owner.tenant_id=document.tenant_id
JOIN actors creator ON creator.id=document.creator_actor_id AND creator.tenant_id=document.tenant_id
LEFT JOIN document_versions version ON version.id=document.current_version_id
                                  AND version.tenant_id=document.tenant_id
WHERE document.id=$2 AND document.status='active' AND access.can_read`

func get(ctx context.Context, tx pgx.Tx, accountID, documentID string) (Document, error) {
	var value Document
	var versionID, versionSHA *string
	var versionNumber *int
	var manage, write, comment, draftAvailable, wikiPage bool
	var projection documentAccessProjection
	err := tx.QueryRow(ctx, effectiveDocumentSQL, accountID, documentID).Scan(
		&value.ID, &value.TenantID, &value.Title, &value.Format, &value.RepresentationFormat, &value.Status,
		&value.CreatedAt, &value.UpdatedAt,
		&value.Owner.ID, &value.Owner.Kind, &value.Owner.DisplayName,
		&value.Creator.ID, &value.Creator.Kind, &value.Creator.DisplayName,
		&versionID, &versionNumber, &versionSHA,
		&manage, &write, &comment, &draftAvailable,
		&projection.role, &projection.sourcesJSON, &projection.hasActiveLink, &wikiPage,
		&value.currentActorID, &value.readAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return Document{}, ErrNotFound
	}
	if err != nil {
		return Document{}, err
	}
	value.Owner.TenantID = value.TenantID
	value.Creator.TenantID = value.TenantID
	if versionID != nil {
		value.CurrentVersion = &VersionRef{ID: *versionID, VersionNumber: *versionNumber, SHA256: *versionSHA}
	}
	value.DraftCapability = "none"
	if value.Format == "blocknote" && draftAvailable {
		value.DraftCapability = "read"
		if write {
			value.DraftCapability = "write"
		}
	}
	active := value.Status == "active"
	value.Capabilities = Capabilities{
		Read: true, Write: write, Manage: manage, Delete: manage && active, Duplicate: active,
		Export: active, Comment: comment, UseAsContext: active,
	}
	value.AccessV2, err = hydrateAccessV2(projection)
	if err != nil {
		return Document{}, err
	}
	value.Capabilities.Delete = active && (value.AccessV2.ContentRole == "owner" || value.AccessV2.ContentRole == "manager")
	value.CanEditNativeContent = value.Format == "blocknote" && draftAvailable
	if wikiPage {
		value.Capabilities = Capabilities{Read: true}
		value.DraftCapability = "read"
		value.CanEditNativeContent = false
	}
	from, err := listSources(ctx, tx, accountID, value.ID)
	if err != nil {
		return Document{}, err
	}
	value.From = from
	return value, nil
}

type documentAccessProjection struct {
	role          string
	sourcesJSON   []byte
	hasActiveLink bool
}

func resolveAccessV2(ctx context.Context, tx pgx.Tx, accountID, documentID string) (*AccessEnvelopeV2, error) {
	var projection documentAccessProjection
	err := tx.QueryRow(ctx, `SELECT access.content_role,access.access_sources,
        coalesce(document.link_share_status='active',false)
        FROM documents document
        CROSS JOIN LATERAL resolve_human_document_access_v2($1,document.id) access
        WHERE document.id=$2`, accountID, documentID).Scan(
		&projection.role, &projection.sourcesJSON, &projection.hasActiveLink)
	if err != nil {
		return nil, err
	}
	return hydrateAccessV2(projection)
}

func hydrateAccessV2(projection documentAccessProjection) (*AccessEnvelopeV2, error) {
	var sources []AccessSourceV2
	if err := json.Unmarshal(projection.sourcesJSON, &sources); err != nil {
		return nil, fmt.Errorf("decode Document Access V2 sources: %w", err)
	}
	access := &AccessEnvelopeV2{
		SchemaVersion: 2, ContentRole: projection.role, LinkScope: "restricted",
		AuthorizationMode: "human_native", Sources: sources,
	}
	if projection.hasActiveLink {
		access.LinkScope = "anyone_with_link"
	}
	if err := validateAccessV2Projection(access); err != nil {
		return nil, err
	}
	return access, nil
}

func validateAccessV2Projection(access *AccessEnvelopeV2) error {
	if access == nil || access.SchemaVersion != 2 ||
		!oneOf(access.ContentRole, "viewer", "editor", "manager", "owner") ||
		!oneOf(access.LinkScope, "restricted", "tenant_members", "anyone_with_link") ||
		!oneOf(access.AuthorizationMode, "human_native", "agent_native") {
		return fmt.Errorf("Document Access V2 resolver returned an invalid envelope")
	}
	for _, source := range access.Sources {
		if source.SchemaVersion != 2 || source.SourceID == "" || source.SourceVersion < 1 ||
			!oneOf(source.SourceKind, "owner", "direct", "context", "link") ||
			!oneOf(source.Status, "active", "revoked", "disabled") ||
			!oneOf(source.Role, "viewer", "editor", "manager", "owner") ||
			source.Provenance.SchemaVersion != 2 ||
			!oneOf(source.Provenance.Kind, "owner", "direct_grant", "context_binding", "link_policy") {
			return fmt.Errorf("Document Access V2 resolver returned an invalid source")
		}
		if source.Provenance.BindingKind != nil &&
			!oneOf(*source.Provenance.BindingKind, "room", "task", "wiki_source", "wiki_page") {
			return fmt.Errorf("Document Access V2 resolver returned invalid Binding provenance")
		}
		if source.Target != nil && !oneOf(source.Target.Kind, "human", "agent", "room") {
			return fmt.Errorf("Document Access V2 resolver returned an invalid target")
		}
	}
	return nil
}

func oneOf(value string, allowed ...string) bool {
	for _, candidate := range allowed {
		if value == candidate {
			return true
		}
	}
	return false
}

func recordRecentOpen(ctx context.Context, tx pgx.Tx, documentID string) error {
	// The authorized read keeps its Repeatable Read snapshot. A competing open
	// may already have updated this optional recency value in a newer snapshot;
	// roll back only that write instead of failing the Document read.
	recentTx, err := tx.Begin(ctx)
	if err != nil {
		return err
	}
	defer recentTx.Rollback(ctx)
	err = upsertRecentOpen(ctx, recentTx, documentID)
	if isDocumentSerializationFailure(err) {
		return recentTx.Rollback(ctx)
	}
	if err != nil {
		return err
	}
	return recentTx.Commit(ctx)
}

// upsertRecentOpen records that the Space's Human opened the Document, so every
// session of the Human lists it under Recent. Read Committed callers can write
// directly; the savepoint above is only for a Repeatable Read snapshot that
// may predate another open.
func upsertRecentOpen(ctx context.Context, tx pgx.Tx, documentID string) error {
	_, err := tx.Exec(ctx, `
		INSERT INTO document_recent_opens(tenant_id,document_id,last_opened_at)
		SELECT tenant_id,id,clock_timestamp() FROM documents WHERE id=$1
		ON CONFLICT (document_id) DO UPDATE SET last_opened_at=EXCLUDED.last_opened_at
	`, documentID)
	return err
}

func listSources(ctx context.Context, tx pgx.Tx, accountID, documentID string) ([]Source, error) {
	rows, err := tx.Query(ctx, `
		SELECT binding.binding_kind,
		       COALESCE(binding.room_id,binding.work_item_id,binding.wiki_id),
		       COALESCE(room.name,item.title,'Personal Wiki'),
		       COALESCE(wiki_page.page_key,'')
		FROM document_context_bindings binding
		JOIN actors principal ON principal.account_id=$1 AND principal.kind='human'
		                     AND principal.tenant_id=binding.tenant_id
		LEFT JOIN rooms room ON room.id=binding.room_id AND room.tenant_id=binding.tenant_id
		LEFT JOIN work_items item ON item.id=binding.work_item_id AND item.tenant_id=binding.tenant_id
		LEFT JOIN personal_wikis wiki ON wiki.id=binding.wiki_id AND wiki.tenant_id=binding.tenant_id
		LEFT JOIN document_wiki_pages wiki_page ON wiki_page.wiki_id=binding.wiki_id
		    AND wiki_page.tenant_id=binding.tenant_id AND wiki_page.document_id=binding.document_id
		WHERE binding.document_id=$2 AND binding.status='active'
		  AND (
		      (binding.binding_kind='room' AND room.deletion_started_at IS NULL)
		      OR (binding.binding_kind='task' AND item.id IS NOT NULL)
		      OR (binding.binding_kind IN ('wiki_source','wiki_page') AND wiki.deleted_at IS NULL)
		  )
		ORDER BY binding.binding_kind,COALESCE(binding.room_id,binding.work_item_id,binding.wiki_id)
	`, accountID, documentID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]Source, 0)
	for rows.Next() {
		var item Source
		if err := rows.Scan(&item.BindingKind, &item.ContextID, &item.Label, &item.PageKey); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func listIDs(ctx context.Context, tx pgx.Tx, input ListInput, cursor *cursorState) ([]listedDocument, error) {
	var cursorUpdated any
	var cursorID any
	if cursor != nil {
		cursorUpdated = cursor.Updated
		cursorID = cursor.ID
	}
	rows, err := tx.Query(ctx, `
		SELECT document.id,
		       CASE WHEN $2='recent' THEN recent.last_opened_at ELSE greatest(document.updated_at,(SELECT body.updated_at FROM document_bodies body WHERE body.document_id=document.id)) END AS sort_time
		FROM documents document
		JOIN actors principal ON principal.account_id=$1 AND principal.kind='human'
		                    AND principal.tenant_id=document.tenant_id
		LEFT JOIN document_recent_opens recent ON recent.document_id=document.id
		WHERE document.status='active'
		  AND ($2<>'recent' OR recent.document_id IS NOT NULL)
		  AND ($2<>'owned' OR document.owner_actor_id=principal.id)
		  AND ($2 NOT IN ('owned','unfiled') OR (true `+excludeWikiSourceItemsSQL+`))
		  AND ($2<>'shared' OR document.owner_actor_id<>principal.id)
		  AND ($2<>'shared' OR (true `+excludeMeetingDocumentsSQL+`))
		  AND ($2<>'shared' OR NOT EXISTS (SELECT 1 FROM document_context_bindings wiki_binding
		      WHERE wiki_binding.document_id=document.id AND wiki_binding.tenant_id=document.tenant_id
		        AND wiki_binding.binding_kind='wiki_page' AND wiki_binding.status='active'))
		  AND ($2<>'unfiled' OR (document.owner_actor_id=principal.id AND NOT EXISTS (
		      SELECT 1 FROM document_placements placement
		      WHERE placement.document_id=document.id AND placement.scope_kind='personal'
		        AND placement.owner_human_actor_id=principal.id AND placement.deleted_at IS NULL
		  )))
		  AND ($4::timestamptz IS NULL OR (
		      CASE WHEN $2='recent' THEN recent.last_opened_at ELSE greatest(document.updated_at,(SELECT body.updated_at FROM document_bodies body WHERE body.document_id=document.id)) END,
		      document.id
		  )<($4,$5))
		ORDER BY sort_time DESC,document.id DESC
		LIMIT $3
	`, input.AccountID, string(input.View), input.Limit+1, cursorUpdated, cursorID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]listedDocument, 0, input.Limit+1)
	for rows.Next() {
		var item listedDocument
		if err := rows.Scan(&item.ID, &item.SortTime); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func listRoomIDs(ctx context.Context, tx pgx.Tx, input ListRoomInput, cursor *cursorState) ([]listedDocument, error) {
	var cursorUpdated, cursorID any
	if cursor != nil {
		cursorUpdated = cursor.Updated
		cursorID = cursor.ID
	}
	rows, err := tx.Query(ctx, `
		SELECT document.id,greatest(document.updated_at,(SELECT body.updated_at FROM document_bodies body WHERE body.document_id=document.id)) AS updated_at
		FROM rooms room
		JOIN actors principal ON principal.account_id=$1 AND principal.kind='human'
		                           AND principal.tenant_id=room.tenant_id
		JOIN active_room_members member ON member.room_id=room.id
		                               AND member.tenant_id=room.tenant_id
		                               AND member.actor_id=principal.id
		JOIN document_context_bindings binding ON binding.tenant_id=room.tenant_id
		                                               AND binding.binding_kind='room'
		                                               AND binding.room_id=room.id
		                                               AND binding.status='active'
		JOIN documents document ON document.id=binding.document_id
		                       AND document.tenant_id=binding.tenant_id
		                       AND document.status='active'
		WHERE room.id=$2 AND room.deletion_started_at IS NULL
		  AND ($3::timestamptz IS NULL OR (greatest(document.updated_at,(SELECT body.updated_at FROM document_bodies body WHERE body.document_id=document.id)),document.id)<($3,$4))
		ORDER BY greatest(document.updated_at,(SELECT body.updated_at FROM document_bodies body WHERE body.document_id=document.id)) DESC,document.id DESC
		LIMIT $5
	`, input.AccountID, input.RoomID, cursorUpdated, cursorID, input.Limit+1)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]listedDocument, 0, input.Limit+1)
	for rows.Next() {
		var item listedDocument
		if err := rows.Scan(&item.ID, &item.SortTime); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func listPersonalWikiIDs(
	ctx context.Context,
	tx pgx.Tx,
	wikiID string,
	limit int,
	cursor *cursorState,
) ([]listedDocument, error) {
	var cursorUpdated, cursorID any
	if cursor != nil {
		cursorUpdated = cursor.Updated
		cursorID = cursor.ID
	}
	rows, err := tx.Query(ctx, `
		SELECT document.id,greatest(document.updated_at,(SELECT body.updated_at FROM document_bodies body WHERE body.document_id=document.id)) AS updated_at
		FROM documents document
		WHERE document.status='active'
		  AND EXISTS (
		      SELECT 1 FROM document_context_bindings binding
		      WHERE binding.tenant_id=document.tenant_id
		        AND binding.document_id=document.id
		        AND binding.wiki_id=$1
		        AND binding.binding_kind IN ('wiki_source','wiki_page')
		        AND binding.status='active'
		  )
		  AND ($2::timestamptz IS NULL OR (greatest(document.updated_at,(SELECT body.updated_at FROM document_bodies body WHERE body.document_id=document.id)),document.id)<($2,$3))
		ORDER BY greatest(document.updated_at,(SELECT body.updated_at FROM document_bodies body WHERE body.document_id=document.id)) DESC,document.id DESC
		LIMIT $4
	`, wikiID, cursorUpdated, cursorID, limit+1)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]listedDocument, 0, limit+1)
	for rows.Next() {
		var item listedDocument
		if err := rows.Scan(&item.ID, &item.SortTime); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

// searchHit is one Document the search page query admitted, with how its
// indexed body took part in the match.
type searchHit struct {
	ID        string
	UpdatedAt time.Time
	Match     SearchMatch
}

// searchSnippetContextChars is how much body text a snippet keeps on each side
// of the first body match.
const searchSnippetContextChars = 60

// searchHits selects one page of the active Documents the Human reads whose
// title, owner or creator name, bound Room name or Task title the Human sees,
// or indexed body contains the query. Only text the Human sees takes part:
// formats, Actor IDs and binding IDs do not. The body is compared last because
// it is the most expensive, and only the page rows compute a body snippet. A
// Document without a search text row is still pending indexing; only ready rows
// hold body text.
func searchHits(ctx context.Context, tx pgx.Tx, input SearchInput, cursor *cursorState) ([]searchHit, error) {
	var cursorUpdated, cursorID any
	if cursor != nil {
		cursorUpdated = cursor.Updated
		cursorID = cursor.ID
	}
	rows, err := tx.Query(ctx, `
		WITH page AS (
		    SELECT document.id,greatest(document.updated_at,(SELECT body.updated_at FROM document_bodies body WHERE body.document_id=document.id)) AS updated_at
		    FROM documents document
		    JOIN actors principal ON principal.account_id=$1 AND principal.kind='human'
		                        AND principal.tenant_id=document.tenant_id
		    JOIN actors owner ON owner.id=document.owner_actor_id AND owner.tenant_id=document.tenant_id
		    JOIN actors creator ON creator.id=document.creator_actor_id AND creator.tenant_id=document.tenant_id
		    WHERE document.status='active'
		      AND ($6::text IS NULL OR document.tenant_id=$6)
		      AND ($3::timestamptz IS NULL OR (greatest(document.updated_at,(SELECT body.updated_at FROM document_bodies body WHERE body.document_id=document.id)),document.id)<($3,$4))
		      AND (strpos(lower(document.title),lower($2))>0
		        OR strpos(lower(owner.display_name),lower($2))>0
		        OR strpos(lower(creator.display_name),lower($2))>0
		        OR EXISTS (SELECT 1 FROM `+humanVisibleBindingsSQL+`
		            AND strpos(lower(coalesce(room.name,item.title)),lower($2))>0)
		        OR EXISTS (SELECT 1 FROM document_texts search_text
		            WHERE search_text.document_id=document.id
		              AND strpos(lower(search_text.search_text),lower($2))>0))
		    ORDER BY greatest(document.updated_at,(SELECT body.updated_at FROM document_bodies body WHERE body.document_id=document.id)) DESC,document.id DESC
		    LIMIT $5)
		SELECT page.id,page.updated_at,coalesce(search_text.status,'pending'),
		       coalesce(substr(search_text.search_text,snippet.start,snippet.span),''),
		       coalesce(snippet.start>1,false),
		       coalesce(snippet.start+snippet.span<=length(search_text.search_text),false)
		FROM page
		LEFT JOIN document_texts search_text ON search_text.document_id=page.id
		LEFT JOIN LATERAL (
		    SELECT greatest(body_hit.position-$7::int,1) AS start,2*$7::int+length($2) AS span
		    FROM (SELECT strpos(lower(search_text.search_text),lower($2)) AS position) body_hit
		    WHERE body_hit.position>0) snippet ON true
		ORDER BY page.updated_at DESC,page.id DESC
	`, input.AccountID, input.Query, cursorUpdated, cursorID, input.Limit+1, optionalSearchValue(input.TenantID),
		searchSnippetContextChars)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	hits := make([]searchHit, 0, input.Limit+1)
	for rows.Next() {
		var hit searchHit
		var snippet string
		var cutBefore, cutAfter bool
		if err := rows.Scan(&hit.ID, &hit.UpdatedAt, &hit.Match.BodyIndexStatus,
			&snippet, &cutBefore, &cutAfter); err != nil {
			return nil, err
		}
		if snippet != "" {
			hit.Match.BodySnippet = strings.TrimSpace(snippet)
			if cutBefore {
				hit.Match.BodySnippet = "…" + hit.Match.BodySnippet
			}
			if cutAfter {
				hit.Match.BodySnippet += "…"
			}
		}
		hits = append(hits, hit)
	}
	return hits, rows.Err()
}

func optionalSearchValue(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func listVersions(ctx context.Context, tx pgx.Tx, documentID string, cursor *cursorState, limit int) ([]Version, error) {
	var before any
	if cursor != nil {
		before = cursor.Version
	}
	rows, err := tx.Query(ctx, `
		SELECT version.id,version.document_id,version.version_number,version.filename,
		       version.representation_format,version.media_type,version.size_bytes,version.sha256,
		       version.source,version.source_revision_id,version.base_version_id,
		       version.source_invocation_id,
		       COALESCE(version.exporter_schema_version,0),version.created_at,
		       actor.id,actor.tenant_id,actor.kind,actor.display_name
		FROM document_versions version
		JOIN actors actor ON actor.id=version.created_by_actor_id AND actor.tenant_id=version.tenant_id
		WHERE version.document_id=$1
		  AND ($3::integer IS NULL OR version.version_number<$3)
		ORDER BY version.version_number DESC
		LIMIT $2
	`, documentID, limit, before)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]Version, 0)
	for rows.Next() {
		var item Version
		if err := rows.Scan(
			&item.ID, &item.DocumentID, &item.VersionNumber, &item.Filename,
			&item.RepresentationFormat, &item.MediaType, &item.SizeBytes, &item.SHA256,
			&item.Source, &item.SourceRevisionID, &item.BaseVersionID,
			&item.SourceInvocationID, &item.ExporterSchemaVersion,
			&item.CreatedAt, &item.CreatedBy.ID, &item.CreatedBy.TenantID,
			&item.CreatedBy.Kind, &item.CreatedBy.DisplayName,
		); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}
