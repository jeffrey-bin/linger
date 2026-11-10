package document

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	idgen "github.com/simplexai-labs/linger/apps/teamhub/internal/ids"
)

func insertPersonalDocumentPlacement(
	ctx context.Context,
	tx pgx.Tx,
	tenantID, ownerHumanActorID, documentID string,
	parentID *string,
) error {
	if tx == nil || tenantID == "" || ownerHumanActorID == "" || documentID == "" {
		return ErrInvalidInput
	}
	placementID := stableCreateID("document_placement_", ownerHumanActorID, documentID)
	_, err := tx.Exec(ctx, `INSERT INTO document_placements(
		id,tenant_id,scope_kind,owner_human_actor_id,node_kind,document_id,parent_id,sort_key
	) VALUES($1,$2,'personal',$3,'document',$4,$5,$4)`, placementID, tenantID,
		ownerHumanActorID, documentID, parentID)
	return err
}

var (
	ErrConflict       = errors.New("Document tree conflict")
	ErrFolderNotEmpty = errors.New("Document Folder is not empty")
	// ErrFolderNameTaken is a tree conflict the caller can fix by renaming.
	ErrFolderNameTaken = fmt.Errorf("%w: folder name is taken", ErrConflict)
)

type Placement struct {
	ID, NodeKind, Name, DocumentID, SortKey string
	ParentID                                *string
	CreatedAt, UpdatedAt                    time.Time
	Document                                *PlacementDocumentSummary
}

type PlacementDocumentSummary struct {
	ID, Title, Format, RepresentationFormat, Status string
	Owner                                           Actor
	Capabilities                                    Capabilities
	CanEditNativeContent                            bool
	AccessSources                                   []AccessSourceV2
	UpdatedAt                                       time.Time
}

type CreateFolderInput struct {
	AccountID, TenantID, Name string
	ParentID                  *string
}

type UpdatePlacementInput struct {
	AccountID, TenantID, PlacementID, Name string
	ParentID                               *string
	MoveToRoot                             bool
}

type DeleteFolderInput struct {
	AccountID, TenantID, PlacementID string
}

func (s *Service) GetMyTree(ctx context.Context, accountID, tenantID string) ([]Placement, error) {
	if accountID == "" || tenantID == "" {
		return nil, ErrInvalidInput
	}
	rows, err := s.pool.Query(ctx, `
		SELECT placement.id,placement.node_kind,coalesce(placement.name,''),
		       coalesce(placement.document_id,''),placement.parent_id,placement.sort_key,
		       placement.created_at,placement.updated_at,
		       coalesce(document.title,''),coalesce(document.format,''),
		       coalesce(CASE WHEN document.format='blocknote' THEN document.native_representation_format ELSE document.format END,''),
		       coalesce(document.status,''),coalesce(owner.id,''),coalesce(owner.kind,''),
		       coalesce(owner.display_name,''),coalesce(greatest(document.updated_at,(SELECT body.updated_at FROM document_bodies body WHERE body.document_id=document.id)),placement.updated_at),
		       EXISTS(SELECT 1 FROM document_bodies body WHERE body.document_id=document.id)
		FROM document_placements placement
		JOIN actors actor ON actor.account_id=$1 AND actor.tenant_id=$2 AND actor.kind='human'
		                 AND actor.id=placement.owner_human_actor_id
		                 AND actor.tenant_id=placement.tenant_id
		LEFT JOIN documents document ON document.id=placement.document_id
		                            AND document.tenant_id=placement.tenant_id
		LEFT JOIN actors owner ON owner.id=document.owner_actor_id AND owner.tenant_id=document.tenant_id
		WHERE placement.scope_kind='personal' AND placement.deleted_at IS NULL
		  AND (placement.node_kind='folder' OR document.status='active')
		ORDER BY coalesce(placement.parent_id,''),placement.sort_key,placement.id
	`, accountID, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]Placement, 0)
	for rows.Next() {
		var item Placement
		var title, format, representation, status, ownerID, ownerKind, ownerName string
		var documentUpdatedAt time.Time
		var draftAvailable bool
		if err := rows.Scan(&item.ID, &item.NodeKind, &item.Name, &item.DocumentID,
			&item.ParentID, &item.SortKey, &item.CreatedAt, &item.UpdatedAt,
			&title, &format, &representation, &status, &ownerID, &ownerKind, &ownerName,
			&documentUpdatedAt, &draftAvailable); err != nil {
			return nil, err
		}
		if item.NodeKind == "document" {
			active := status == "active"
			item.Document = &PlacementDocumentSummary{
				ID: item.DocumentID, Title: title, Format: format, RepresentationFormat: representation,
				Status: status, Owner: Actor{ID: ownerID, TenantID: tenantID, Kind: ownerKind, DisplayName: ownerName},
				Capabilities: Capabilities{Read: true, Write: active, Manage: true, Delete: active,
					Duplicate: active, Export: active, Comment: active, UseAsContext: active},
				CanEditNativeContent: format == "blocknote" && draftAvailable, UpdatedAt: documentUpdatedAt,
			}
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *Service) CreateFolder(ctx context.Context, input CreateFolderInput) (Placement, error) {
	input.Name = strings.TrimSpace(input.Name)
	if input.AccountID == "" || input.Name == "" || len(input.Name) > 255 {
		return Placement{}, ErrInvalidInput
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return Placement{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tenantID, actorID, err := personalTreePrincipal(ctx, tx, input.AccountID, input.TenantID)
	if err != nil {
		return Placement{}, err
	}
	if input.ParentID != nil {
		if _, err := getPersonalPlacement(ctx, tx, input.AccountID, *input.ParentID, true, tenantID); err != nil {
			return Placement{}, err
		}
	}
	id := idgen.New("document_placement")
	item := Placement{ID: id}
	err = tx.QueryRow(ctx, `
		INSERT INTO document_placements(
			id,tenant_id,scope_kind,owner_human_actor_id,node_kind,parent_id,name,sort_key
		) VALUES($1,$2,'personal',$3,'folder',$4,$5,$1)
		RETURNING id,node_kind,name,coalesce(document_id,''),parent_id,sort_key,created_at,updated_at
	`, id, tenantID, actorID, input.ParentID, input.Name).Scan(
		&item.ID, &item.NodeKind, &item.Name, &item.DocumentID, &item.ParentID,
		&item.SortKey, &item.CreatedAt, &item.UpdatedAt,
	)
	if err != nil {
		return Placement{}, treeWriteError(err)
	}
	if err := tx.Commit(ctx); err != nil {
		return Placement{}, treeWriteError(err)
	}
	return item, nil
}

func (s *Service) UpdatePlacement(ctx context.Context, input UpdatePlacementInput) (Placement, error) {
	input.Name = strings.TrimSpace(input.Name)
	if input.AccountID == "" || input.PlacementID == "" ||
		(input.Name == "" && input.ParentID == nil && !input.MoveToRoot) ||
		(input.ParentID != nil && input.MoveToRoot) || len(input.Name) > 255 {
		return Placement{}, ErrInvalidInput
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return Placement{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tenantID, actorID, err := personalTreePrincipal(ctx, tx, input.AccountID, input.TenantID)
	if err != nil {
		return Placement{}, err
	}
	if err := lockPersonalTree(ctx, tx, tenantID, actorID); err != nil {
		return Placement{}, treeWriteError(err)
	}
	item, err := getPersonalPlacement(ctx, tx, input.AccountID, input.PlacementID, false, input.TenantID)
	if err != nil {
		return Placement{}, err
	}
	if input.Name != "" && item.NodeKind != "folder" {
		return Placement{}, ErrInvalidInput
	}
	if input.ParentID != nil {
		if *input.ParentID == item.ID {
			return Placement{}, ErrConflict
		}
		if _, err := getPersonalPlacement(ctx, tx, input.AccountID, *input.ParentID, true, input.TenantID); err != nil {
			return Placement{}, err
		}
		var descendant bool
		if err := tx.QueryRow(ctx, `WITH RECURSIVE descendants AS (
			SELECT id FROM document_placements WHERE parent_id=$1 AND tenant_id=$3 AND deleted_at IS NULL
			UNION ALL
			SELECT child.id FROM document_placements child JOIN descendants parent ON child.parent_id=parent.id
			WHERE child.tenant_id=$3 AND child.deleted_at IS NULL
		) SELECT EXISTS(SELECT 1 FROM descendants WHERE id=$2)`, item.ID, *input.ParentID, tenantID).Scan(&descendant); err != nil {
			return Placement{}, err
		}
		if descendant {
			return Placement{}, ErrConflict
		}
	}
	err = tx.QueryRow(ctx, `
		UPDATE document_placements SET
			name=CASE WHEN $2<>'' THEN $2 ELSE name END,
			parent_id=CASE WHEN $3 THEN NULL WHEN $4::text IS NOT NULL THEN $4 ELSE parent_id END,
			updated_at=clock_timestamp()
		WHERE id=$1
		RETURNING id,node_kind,coalesce(name,''),coalesce(document_id,''),parent_id,sort_key,created_at,updated_at
	`, item.ID, input.Name, input.MoveToRoot, input.ParentID).Scan(
		&item.ID, &item.NodeKind, &item.Name, &item.DocumentID, &item.ParentID,
		&item.SortKey, &item.CreatedAt, &item.UpdatedAt,
	)
	if err != nil {
		return Placement{}, treeWriteError(err)
	}
	if item.NodeKind == "document" {
		value, err := get(ctx, tx, input.AccountID, item.DocumentID)
		if err != nil {
			return Placement{}, err
		}
		item.Document = placementSummaryFromDocument(value)
		if err := appendDocumentPlacementEvent(
			ctx, tx, tenantID, actorID, item.DocumentID, item.ID,
		); err != nil {
			return Placement{}, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return Placement{}, treeWriteError(err)
	}
	return item, nil
}

func placementSummaryFromDocument(value Document) *PlacementDocumentSummary {
	return &PlacementDocumentSummary{
		ID: value.ID, Title: value.Title, Format: value.Format,
		RepresentationFormat: value.RepresentationFormat, Status: value.Status,
		Owner: value.Owner, Capabilities: value.Capabilities,
		CanEditNativeContent: value.CanEditNativeContent, UpdatedAt: value.UpdatedAt,
	}
}

func lockPersonalTree(ctx context.Context, tx pgx.Tx, tenantID, actorID string) error {
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, actorID+"|personal-tree"); err != nil {
		return err
	}
	rows, err := tx.Query(ctx, `SELECT id FROM document_placements
		WHERE tenant_id=$1 AND owner_human_actor_id=$2 AND scope_kind='personal' AND deleted_at IS NULL
		ORDER BY id FOR UPDATE`, tenantID, actorID)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return err
		}
	}
	return rows.Err()
}

func (s *Service) DeleteFolder(ctx context.Context, input DeleteFolderInput) error {
	if input.AccountID == "" || input.PlacementID == "" {
		return ErrInvalidInput
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	item, err := getPersonalPlacement(ctx, tx, input.AccountID, input.PlacementID, true, input.TenantID)
	if err != nil {
		return err
	}
	var hasChildren bool
	if err := tx.QueryRow(ctx, `
		SELECT EXISTS(SELECT 1 FROM document_placements WHERE parent_id=$1 AND deleted_at IS NULL)
	`, item.ID).Scan(&hasChildren); err != nil {
		return err
	}
	if hasChildren {
		return ErrFolderNotEmpty
	}
	if _, _, err := personalTreePrincipal(ctx, tx, input.AccountID, input.TenantID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM document_placements WHERE id=$1`, item.ID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func getPersonalPlacement(ctx context.Context, tx pgx.Tx, accountID, placementID string, requireFolder bool, tenantIDs ...string) (Placement, error) {
	tenantID := ""
	if len(tenantIDs) > 0 {
		tenantID = tenantIDs[0]
	}
	var item Placement
	err := tx.QueryRow(ctx, `
		SELECT placement.id,placement.node_kind,coalesce(placement.name,''),
		       coalesce(placement.document_id,''),placement.parent_id,placement.sort_key,
		       placement.created_at,placement.updated_at
		FROM document_placements placement
		JOIN actors actor ON actor.account_id=$1 AND actor.kind='human'
		                 AND actor.id=placement.owner_human_actor_id
		                 AND actor.tenant_id=placement.tenant_id
		LEFT JOIN documents document ON document.id=placement.document_id
		                            AND document.tenant_id=placement.tenant_id
		WHERE placement.id=$2 AND placement.scope_kind='personal' AND placement.deleted_at IS NULL
		  AND ($4='' OR placement.tenant_id=$4)
		  AND (NOT $3 OR placement.node_kind='folder')
		  AND (placement.node_kind='folder' OR document.status='active')
		FOR UPDATE OF placement
	`, accountID, placementID, requireFolder, tenantID).Scan(
		&item.ID, &item.NodeKind, &item.Name, &item.DocumentID, &item.ParentID,
		&item.SortKey, &item.CreatedAt, &item.UpdatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return Placement{}, ErrNotFound
	}
	return item, err
}

type treeQuerier interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

func personalTreePrincipal(ctx context.Context, tx treeQuerier, accountID, tenantID string) (string, string, error) {
	if tenantID == "" {
		return "", "", ErrInvalidInput
	}
	var actorID string
	err := tx.QueryRow(ctx, `SELECT actor.id
		FROM actors actor
		WHERE actor.account_id=$1 AND actor.kind='human' AND actor.tenant_id=$2`, accountID, tenantID).Scan(&actorID)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", "", ErrNotFound
	}
	if err != nil {
		return "", "", err
	}
	return tenantID, actorID, nil
}

func appendDocumentPlacementEvent(
	ctx context.Context,
	tx pgx.Tx,
	tenantID, actorID, documentID, placementID string,
) error {
	eventID := idgen.New("document_event")
	_, err := tx.Exec(ctx, `
		INSERT INTO document_events(
			id,tenant_id,document_id,event_type,actor_id,resource_kind,resource_id,projection_version
		) VALUES(
			$1,$2,$3,
			'document.placement_updated',$4,'placement',$5,1
		)
	`, eventID, tenantID, documentID, actorID, placementID)
	return err
}

func stableTreeID(prefix string, parts ...string) string {
	hash := sha256.Sum256([]byte(strings.Join(parts, "\x00")))
	return prefix + hex.EncodeToString(hash[:])
}

func treeWriteError(err error) error {
	if err == nil {
		return nil
	}
	var postgresError *pgconn.PgError
	if errors.As(err, &postgresError) {
		if postgresError.Code == "23505" && postgresError.ConstraintName == "document_placements_active_folder_name_key" {
			return ErrFolderNameTaken
		}
		switch postgresError.Code {
		case "23503", "23505", "23514", "40001", "40P01", "P0001":
			return ErrConflict
		}
	}
	return err
}
