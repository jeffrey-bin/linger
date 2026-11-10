package document

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	idgen "github.com/simplexai-labs/linger/apps/teamhub/internal/ids"
)

type SharedFolderInput struct {
	AccountID, TenantID, Name string
	ParentID                  *string
}

type UpdateSharedFolderInput struct {
	AccountID, TenantID, FolderID, Name string
	ParentID                            *string
	MoveToRoot                          bool
}

// DeleteSharedFolderInput names an empty shared-view Folder to delete.
type DeleteSharedFolderInput struct{ AccountID, TenantID, FolderID string }

type MoveSharedDocumentInput struct {
	AccountID, TenantID, DocumentID string
	ParentID                        *string
	MoveToRoot                      bool
}

func (s *Service) GetSharedTree(ctx context.Context, accountID, tenantID string) ([]Placement, error) {
	if accountID == "" || tenantID == "" {
		return nil, ErrInvalidInput
	}
	rows, err := s.pool.Query(ctx, `
		WITH principal AS (
			SELECT actor.id,actor.tenant_id FROM actors actor
			WHERE actor.account_id=$1 AND actor.tenant_id=$2 AND actor.kind='human'
		), accessible AS (
			SELECT document.id,document.tenant_id,principal.id actor_id,
			       document.title,document.format,
			       CASE WHEN document.format='blocknote' THEN coalesce(document.native_representation_format,'markdown') ELSE document.format END representation_format,
			       document.status,owner.id owner_id,owner.kind owner_kind,owner.display_name owner_name,
			       access.can_read,access.can_write,access.can_manage,access.can_read AS can_comment,
			       access.access_sources,
			       EXISTS(SELECT 1 FROM document_bodies body WHERE body.document_id=document.id) draft_available,
			       greatest(document.updated_at,(SELECT body.updated_at FROM document_bodies body WHERE body.document_id=document.id)) document_updated_at
			FROM principal JOIN documents document ON document.tenant_id=principal.tenant_id
			JOIN LATERAL resolve_human_document_access_v2($1,document.id) access ON true
			JOIN actors owner ON owner.id=document.owner_actor_id AND owner.tenant_id=document.tenant_id
			WHERE document.status='active' AND document.owner_actor_id<>principal.id AND access.can_read
			`+excludeMeetingDocumentsSQL+`
			  AND NOT EXISTS (SELECT 1 FROM document_context_bindings wiki_binding
			    WHERE wiki_binding.document_id=document.id AND wiki_binding.tenant_id=document.tenant_id
			      AND wiki_binding.binding_kind='wiki_page' AND wiki_binding.status='active')
		), nodes AS (
			SELECT folder.id,'folder'::text node_kind,folder.name,''::text document_id,
			       folder.parent_id,folder.sort_key,folder.created_at,folder.updated_at,
			       ''::text title,''::text format,''::text representation_format,''::text status,
			       ''::text owner_id,''::text owner_kind,''::text owner_name,
			       false can_read,false can_write,false can_manage,false can_comment,
			       '[]'::jsonb access_sources,
			       false draft_available,folder.updated_at document_updated_at
			FROM document_placements folder JOIN principal ON principal.id=folder.owner_human_actor_id AND principal.tenant_id=folder.tenant_id
			WHERE folder.scope_kind='shared' AND folder.node_kind='folder'
			UNION ALL
			SELECT coalesce(mapping.id,'shared_document_'||md5(accessible.actor_id||E'\\000'||accessible.id)),
			       'document','',accessible.id,mapping.parent_id,coalesce(mapping.sort_key,accessible.id),
			       coalesce(mapping.created_at,document.created_at),coalesce(mapping.updated_at,greatest(document.updated_at,(SELECT body.updated_at FROM document_bodies body WHERE body.document_id=document.id))),
			       accessible.title,accessible.format,accessible.representation_format,accessible.status,
			       accessible.owner_id,accessible.owner_kind,accessible.owner_name,
			       accessible.can_read,accessible.can_write,accessible.can_manage,accessible.can_comment,
			       accessible.access_sources,
			       accessible.draft_available,accessible.document_updated_at
			FROM accessible JOIN documents document ON document.id=accessible.id AND document.tenant_id=accessible.tenant_id
			LEFT JOIN document_placements mapping ON mapping.scope_kind='shared' AND mapping.node_kind='document'
			 AND mapping.owner_human_actor_id=accessible.actor_id AND mapping.document_id=accessible.id
		)
		SELECT id,node_kind,name,document_id,parent_id,sort_key,created_at,updated_at,
		       title,format,representation_format,status,owner_id,owner_kind,owner_name,
		       can_read,can_write,can_manage,can_comment,access_sources,draft_available,document_updated_at FROM nodes
		ORDER BY coalesce(parent_id,''),sort_key,id`, accountID, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []Placement{}
	for rows.Next() {
		var item Placement
		var title, format, representation, status, ownerID, ownerKind, ownerName string
		var canRead, canWrite, canManage, canComment, draftAvailable bool
		var accessSourcesJSON []byte
		var documentUpdatedAt time.Time
		if err := rows.Scan(&item.ID, &item.NodeKind, &item.Name, &item.DocumentID, &item.ParentID, &item.SortKey, &item.CreatedAt, &item.UpdatedAt,
			&title, &format, &representation, &status, &ownerID, &ownerKind, &ownerName,
			&canRead, &canWrite, &canManage, &canComment, &accessSourcesJSON, &draftAvailable, &documentUpdatedAt); err != nil {
			return nil, err
		}
		if item.NodeKind == "document" {
			var accessSources []AccessSourceV2
			if err := json.Unmarshal(accessSourcesJSON, &accessSources); err != nil {
				return nil, err
			}
			active := status == "active"
			item.Document = &PlacementDocumentSummary{
				ID: item.DocumentID, Title: title, Format: format, RepresentationFormat: representation,
				Status: status, Owner: Actor{ID: ownerID, TenantID: tenantID, Kind: ownerKind, DisplayName: ownerName},
				Capabilities: Capabilities{Read: canRead, Write: canWrite, Manage: canManage, Delete: active && canManage,
					Duplicate: active && canRead, Export: active && canRead, Comment: canComment, UseAsContext: active && canRead},
				CanEditNativeContent: format == "blocknote" && draftAvailable,
				AccessSources:        accessSources, UpdatedAt: documentUpdatedAt,
			}
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *Service) CreateSharedFolder(ctx context.Context, input SharedFolderInput) (Placement, error) {
	input.Name = strings.TrimSpace(input.Name)
	if input.AccountID == "" || input.TenantID == "" || input.Name == "" || len(input.Name) > 255 {
		return Placement{}, ErrInvalidInput
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return Placement{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, input.AccountID+"|"+input.TenantID+"|shared-tree"); err != nil {
		return Placement{}, err
	}
	actor, err := resolveActiveHumanActorTx(ctx, tx, input.AccountID, input.TenantID)
	if err != nil {
		return Placement{}, err
	}
	if input.ParentID != nil {
		if _, err = getSharedFolder(ctx, tx, input.AccountID, input.TenantID, *input.ParentID); err != nil {
			return Placement{}, err
		}
	}
	id := idgen.New("shared_document_folder")
	var item Placement
	err = tx.QueryRow(ctx, `INSERT INTO document_placements(id,tenant_id,scope_kind,owner_human_actor_id,node_kind,parent_id,name,sort_key) VALUES($1,$2,'shared',$3,'folder',$4,$5,$1) RETURNING id,'folder',name,'',parent_id,sort_key,created_at,updated_at`, id, input.TenantID, actor, input.ParentID, input.Name).Scan(&item.ID, &item.NodeKind, &item.Name, &item.DocumentID, &item.ParentID, &item.SortKey, &item.CreatedAt, &item.UpdatedAt)
	if err != nil {
		return Placement{}, treeWriteError(err)
	}
	return item, tx.Commit(ctx)
}

func (s *Service) UpdateSharedFolder(ctx context.Context, input UpdateSharedFolderInput) (Placement, error) {
	input.Name = strings.TrimSpace(input.Name)
	if input.AccountID == "" || input.TenantID == "" || input.FolderID == "" || len(input.Name) > 255 || (input.Name == "" && input.ParentID == nil && !input.MoveToRoot) || (input.ParentID != nil && input.MoveToRoot) {
		return Placement{}, ErrInvalidInput
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return Placement{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, input.AccountID+"|"+input.TenantID+"|shared-tree"); err != nil {
		return Placement{}, err
	}
	item, err := getSharedFolder(ctx, tx, input.AccountID, input.TenantID, input.FolderID)
	if err != nil {
		return Placement{}, err
	}
	if input.ParentID != nil {
		if *input.ParentID == item.ID {
			return Placement{}, ErrConflict
		}
		if _, err = getSharedFolder(ctx, tx, input.AccountID, input.TenantID, *input.ParentID); err != nil {
			return Placement{}, err
		}
		var cycle bool
		if err = tx.QueryRow(ctx, `WITH RECURSIVE descendants AS (
			SELECT id FROM document_placements WHERE parent_id=$1
			UNION ALL SELECT child.id FROM document_placements child JOIN descendants parent ON child.parent_id=parent.id
		) SELECT EXISTS(SELECT 1 FROM descendants WHERE id=$2)`, item.ID, *input.ParentID).Scan(&cycle); err != nil {
			return Placement{}, err
		}
		if cycle {
			return Placement{}, ErrConflict
		}
	}
	_, err = tx.Exec(ctx, `UPDATE document_placements SET name=CASE WHEN $2='' THEN name ELSE $2 END,parent_id=CASE WHEN $4 THEN NULL WHEN $3::text IS NOT NULL THEN $3 ELSE parent_id END,updated_at=clock_timestamp() WHERE id=$1`, item.ID, input.Name, input.ParentID, input.MoveToRoot)
	if err != nil {
		return Placement{}, treeWriteError(err)
	}
	item, err = getSharedFolder(ctx, tx, input.AccountID, input.TenantID, item.ID)
	if err != nil {
		return Placement{}, err
	}
	return item, tx.Commit(ctx)
}

func (s *Service) DeleteSharedFolder(ctx context.Context, input DeleteSharedFolderInput) error {
	if input.AccountID == "" || input.TenantID == "" || input.FolderID == "" {
		return ErrInvalidInput
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, input.AccountID+"|"+input.TenantID+"|shared-tree"); err != nil {
		return err
	}
	item, err := getSharedFolder(ctx, tx, input.AccountID, input.TenantID, input.FolderID)
	if err != nil {
		return err
	}
	var children bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM document_placements WHERE parent_id=$1)`, item.ID).Scan(&children); err != nil {
		return err
	}
	if children {
		return ErrFolderNotEmpty
	}
	if _, err = tx.Exec(ctx, `DELETE FROM document_placements WHERE id=$1`, item.ID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Service) MoveSharedDocument(ctx context.Context, input MoveSharedDocumentInput) (Placement, error) {
	if input.AccountID == "" || input.TenantID == "" || input.DocumentID == "" || (input.ParentID == nil && !input.MoveToRoot) || (input.ParentID != nil && input.MoveToRoot) {
		return Placement{}, ErrInvalidInput
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return Placement{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, input.AccountID+"|"+input.TenantID+"|shared-tree"); err != nil {
		return Placement{}, err
	}
	actor, err := resolveActiveHumanActorTx(ctx, tx, input.AccountID, input.TenantID)
	if err != nil {
		return Placement{}, err
	}
	var owner string
	if err = tx.QueryRow(ctx, `SELECT document.owner_actor_id FROM documents document JOIN LATERAL resolve_human_document_access_v2($1,document.id) access ON true WHERE document.id=$2 AND document.tenant_id=$3 AND document.status='active' AND access.can_read`, input.AccountID, input.DocumentID, input.TenantID).Scan(&owner); errors.Is(err, pgx.ErrNoRows) {
		return Placement{}, ErrNotFound
	} else if err != nil {
		return Placement{}, err
	}
	if owner == actor {
		return Placement{}, ErrNotFound
	}
	if input.ParentID != nil {
		if _, err = getSharedFolder(ctx, tx, input.AccountID, input.TenantID, *input.ParentID); err != nil {
			return Placement{}, err
		}
	}
	id := stableTreeID("shared_document_mapping_", actor, input.DocumentID)
	_, err = tx.Exec(ctx, `INSERT INTO document_placements(id,tenant_id,scope_kind,owner_human_actor_id,node_kind,document_id,parent_id,sort_key) VALUES($1,$2,'shared',$3,'document',$4,$5,$4)
		ON CONFLICT(owner_human_actor_id,document_id) WHERE scope_kind='shared' AND node_kind='document' DO UPDATE SET parent_id=EXCLUDED.parent_id,updated_at=clock_timestamp()`, id, input.TenantID, actor, input.DocumentID, input.ParentID)
	if err != nil {
		return Placement{}, treeWriteError(err)
	}
	var item Placement
	err = tx.QueryRow(ctx, `SELECT id,'document','',document_id,parent_id,sort_key,created_at,updated_at FROM document_placements WHERE id=$1 AND owner_human_actor_id=$2 AND scope_kind='shared'`, id, actor).Scan(&item.ID, &item.NodeKind, &item.Name, &item.DocumentID, &item.ParentID, &item.SortKey, &item.CreatedAt, &item.UpdatedAt)
	if err != nil {
		return Placement{}, err
	}
	value, err := get(ctx, tx, input.AccountID, item.DocumentID)
	if err != nil {
		return Placement{}, err
	}
	item.Document = placementSummaryFromDocument(value)
	return item, tx.Commit(ctx)
}

func getSharedFolder(ctx context.Context, tx pgx.Tx, accountID, tenantID, id string) (Placement, error) {
	var item Placement
	err := tx.QueryRow(ctx, `SELECT folder.id,'folder',folder.name,'',folder.parent_id,folder.sort_key,folder.created_at,folder.updated_at FROM document_placements folder JOIN actors actor ON actor.id=folder.owner_human_actor_id AND actor.tenant_id=folder.tenant_id WHERE actor.account_id=$1 AND actor.tenant_id=$2 AND actor.kind='human' AND folder.id=$3 AND folder.scope_kind='shared' AND folder.node_kind='folder' FOR UPDATE OF folder`, accountID, tenantID, id).Scan(&item.ID, &item.NodeKind, &item.Name, &item.DocumentID, &item.ParentID, &item.SortKey, &item.CreatedAt, &item.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Placement{}, ErrNotFound
	}
	return item, err
}
