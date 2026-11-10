package document

import (
	"context"
	"errors"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	idgen "github.com/simplexai-labs/linger/apps/teamhub/internal/ids"
)

type CreateDirectCollaboratorInput struct {
	AccountID, DocumentID, TargetActorID, Role string
}

type DirectCollaboratorResult struct {
	Source AccessSourceV2
}

type UpdateDirectCollaboratorInput struct {
	AccountID, DocumentID, SourceID, Role string
	ExpectedVersion                       int64
}

type RevokeDirectCollaboratorInput struct {
	AccountID, DocumentID, SourceID string
	ExpectedVersion                 int64
}

type ShareSourceV2 struct {
	Source                         AccessSourceV2
	Label                          string
	TargetActor                    *Actor
	SourceGroup, CallerAccessState string
}

type ShareViewV2 struct {
	SchemaVersion          int
	CallerContentRole      string
	CanManageCollaborators bool
	ManagementCapabilities ManagementCapabilitiesV2
	GeneralAccess          GeneralAccessV1
	Sources                []ShareSourceV2
}

type GeneralAccessV1 struct {
	Scope, CanonicalURL string
}

type ManagementCapabilitiesV2 struct {
	CanChangeOwnership, CanUpdateLinkPolicy, CanUpdateExternalPolicy bool
}

func (s *Service) GetShareView(ctx context.Context, accountID, documentID string) (ShareViewV2, error) {
	if accountID == "" || documentID == "" {
		return ShareViewV2{}, ErrInvalidInput
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead})
	if err != nil {
		return ShareViewV2{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	value, err := get(ctx, tx, accountID, documentID)
	if err != nil {
		return ShareViewV2{}, err
	}
	visible := make(map[string]bool, len(value.AccessV2.Sources))
	for _, source := range value.AccessV2.Sources {
		visible[source.SourceID] = true
	}
	// The Human manages every Document it can write; only a Wiki page, which
	// only Wiki settlement writes, leaves sharing closed.
	canManage := canManageCollaboratorsForAccess(value.AccessV2)
	view := ShareViewV2{
		SchemaVersion: 2, CallerContentRole: value.AccessV2.ContentRole,
		CanManageCollaborators: canManage,
		ManagementCapabilities: ManagementCapabilitiesV2{
			CanChangeOwnership:  canManage,
			CanUpdateLinkPolicy: canManage, CanUpdateExternalPolicy: canManage,
		},
		GeneralAccess: GeneralAccessV1{
			Scope: value.AccessV2.LinkScope, CanonicalURL: "/t/" + value.TenantID + "/documents/" + value.ID,
		},
		Sources: make([]ShareSourceV2, 0),
	}
	directRows, err := tx.Query(ctx, `SELECT collaborator.id,collaborator.target_actor_id,
		collaborator.role,collaborator.version,collaborator.grantor_actor_id,
		collaborator.created_at,collaborator.updated_at,target.kind,target.display_name,
		collaborator.status
		FROM document_direct_collaborators collaborator
		JOIN actors target ON target.id=collaborator.target_actor_id AND target.tenant_id=collaborator.tenant_id
		WHERE collaborator.document_id=$1 AND collaborator.tenant_id=$2 AND collaborator.status='active'
		ORDER BY lower(target.display_name),collaborator.id`,
		documentID, value.TenantID)
	if err != nil {
		return ShareViewV2{}, err
	}
	for directRows.Next() {
		var sourceID, targetActorID, role, grantorActorID, targetKind, targetName, sourceStatus string
		var version int64
		var createdAt, updatedAt time.Time
		if err := directRows.Scan(&sourceID, &targetActorID, &role, &version, &grantorActorID,
			&createdAt, &updatedAt, &targetKind, &targetName, &sourceStatus); err != nil {
			directRows.Close()
			return ShareViewV2{}, err
		}
		target := Actor{ID: targetActorID, TenantID: value.TenantID, Kind: targetKind, DisplayName: targetName}
		view.Sources = append(view.Sources, ShareSourceV2{
			Source: directCollaboratorSource(sourceID, targetActorID, targetKind, role, sourceStatus, version,
				grantorActorID, createdAt, updatedAt),
			Label: targetName, TargetActor: &target, SourceGroup: "direct",
		})
	}
	if err := directRows.Err(); err != nil {
		directRows.Close()
		return ShareViewV2{}, err
	}
	directRows.Close()
	contextRows, err := tx.Query(ctx, `SELECT binding.id,binding.binding_kind,
		coalesce(binding.room_id,binding.work_item_id,binding.wiki_id),binding.access_epoch,
		CASE WHEN binding.binding_kind='task' AND (item.archived_at IS NOT NULL OR item.state='resolved')
		     THEN 'viewer' ELSE binding.role END,
		coalesce(room.name,item.title,'Personal Wiki'),binding.created_at,binding.updated_at
		FROM document_context_bindings binding
		LEFT JOIN rooms room ON room.id=binding.room_id AND room.tenant_id=binding.tenant_id
		LEFT JOIN work_items item ON item.id=binding.work_item_id AND item.tenant_id=binding.tenant_id
		LEFT JOIN personal_wikis wiki ON wiki.id=binding.wiki_id AND wiki.tenant_id=binding.tenant_id
		WHERE binding.document_id=$1 AND binding.tenant_id=$2 AND binding.status='active'
		  AND (binding.binding_kind<>'room' OR room.deletion_started_at IS NULL)
		  AND (binding.binding_kind NOT IN ('wiki_source','wiki_page') OR wiki.deleted_at IS NULL)
		ORDER BY binding.binding_kind,binding.id`, documentID, value.TenantID)
	if err != nil {
		return ShareViewV2{}, err
	}
	for contextRows.Next() {
		var sourceID, bindingKind, contextID, role, label string
		var version int64
		var createdAt, updatedAt time.Time
		if err := contextRows.Scan(&sourceID, &bindingKind, &contextID, &version, &role,
			&label, &createdAt, &updatedAt); err != nil {
			contextRows.Close()
			return ShareViewV2{}, err
		}
		view.Sources = append(view.Sources, ShareSourceV2{
			Source: AccessSourceV2{
				SchemaVersion: 2, SourceID: sourceID, SourceKind: "context", Status: "active",
				Role: role, SourceVersion: version,
				Provenance: AccessSourceProvenanceV2{SchemaVersion: 2, Kind: "context_binding",
					BindingKind: &bindingKind, ContextID: &contextID},
				CreatedAt: createdAt, UpdatedAt: updatedAt,
			},
			Label: label, SourceGroup: "context",
		})
	}
	if err := contextRows.Err(); err != nil {
		contextRows.Close()
		return ShareViewV2{}, err
	}
	contextRows.Close()
	winningRank := roleRank(value.AccessV2.ContentRole)
	for index := range view.Sources {
		source := &view.Sources[index]
		switch {
		case source.Source.Status != "active":
			source.CallerAccessState = "inactive"
		case !visible[source.Source.SourceID]:
			source.CallerAccessState = "not_caller"
		case roleRank(source.Source.Role) == winningRank:
			source.CallerAccessState = "winning"
		default:
			source.CallerAccessState = "remaining"
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return ShareViewV2{}, err
	}
	return view, nil
}

func (s *Service) CreateDirectCollaborator(
	ctx context.Context,
	input CreateDirectCollaboratorInput,
) (DirectCollaboratorResult, error) {
	if input.AccountID == "" || input.DocumentID == "" || input.TargetActorID == "" ||
		!oneOf(input.Role, "viewer", "editor", "manager") {
		return DirectCollaboratorResult{}, ErrInvalidInput
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return DirectCollaboratorResult{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	value, err := get(ctx, tx, input.AccountID, input.DocumentID)
	if err != nil || !canManageCollaboratorsForAccess(value.AccessV2) || value.Status != "active" {
		if err != nil {
			return DirectCollaboratorResult{}, err
		}
		return DirectCollaboratorResult{}, ErrNotFound
	}
	grantorActorID, err := resolveActiveHumanActorTx(ctx, tx, input.AccountID, value.TenantID)
	if err != nil {
		return DirectCollaboratorResult{}, err
	}
	if input.TargetActorID == value.Owner.ID {
		return DirectCollaboratorResult{}, ErrInvalidInput
	}
	// The Human reads every active Document, so a direct share names an Agent.
	var activeAgent bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM actors actor
		JOIN agent_registrations registration ON registration.actor_id=actor.id
		  AND registration.tenant_id=actor.tenant_id AND registration.status='active'
		WHERE actor.id=$1 AND actor.tenant_id=$2 AND actor.kind='agent')`,
		input.TargetActorID, value.TenantID).Scan(&activeAgent); err != nil {
		return DirectCollaboratorResult{}, err
	}
	if !activeAgent {
		return DirectCollaboratorResult{}, ErrNotFound
	}
	sourceID := idgen.New("document_direct_source")
	sourceVersion := int64(1)
	var createdAt, updatedAt time.Time
	err = tx.QueryRow(ctx, `INSERT INTO document_direct_collaborators(
		id,tenant_id,document_id,target_actor_id,role,status,grantor_actor_id,version
	) VALUES($1,$2,$3,$4,$5,'active',$6,1)
		RETURNING created_at,updated_at`, sourceID, value.TenantID, input.DocumentID,
		input.TargetActorID, input.Role, grantorActorID).Scan(&createdAt, &updatedAt)
	if err != nil {
		if isUniqueViolation(err) || errors.Is(err, pgx.ErrNoRows) {
			return DirectCollaboratorResult{}, ErrConflict
		}
		return DirectCollaboratorResult{}, err
	}
	source := directCollaboratorSource(sourceID, input.TargetActorID, "agent", input.Role,
		"active", sourceVersion, grantorActorID, createdAt, updatedAt)
	commandID := stableCreateID("document_collaborator_command_", sourceID, "create", strconv.FormatInt(sourceVersion, 10))
	if err := recordCollaboratorEvent(ctx, tx, value.TenantID, input.DocumentID,
		grantorActorID, commandID, sourceID, "document.collaborator.created"); err != nil {
		return DirectCollaboratorResult{}, err
	}
	if err := notifySharedAgent(ctx, tx, value.TenantID, input.DocumentID, value.Title,
		grantorActorID, input.TargetActorID); err != nil {
		return DirectCollaboratorResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return DirectCollaboratorResult{}, err
	}
	return DirectCollaboratorResult{Source: source}, nil
}

func (s *Service) UpdateDirectCollaborator(
	ctx context.Context,
	input UpdateDirectCollaboratorInput,
) (DirectCollaboratorResult, error) {
	if input.AccountID == "" || input.DocumentID == "" || input.SourceID == "" || input.ExpectedVersion < 1 ||
		!oneOf(input.Role, "viewer", "editor", "manager") {
		return DirectCollaboratorResult{}, ErrInvalidInput
	}
	return s.mutateDirectCollaborator(ctx, directCollaboratorMutation{
		accountID: input.AccountID, documentID: input.DocumentID, sourceID: input.SourceID,
		operation: "update", expectedVersion: input.ExpectedVersion, role: input.Role,
	})
}

func (s *Service) RevokeDirectCollaborator(
	ctx context.Context,
	input RevokeDirectCollaboratorInput,
) (DirectCollaboratorResult, error) {
	if input.AccountID == "" || input.DocumentID == "" || input.SourceID == "" || input.ExpectedVersion < 1 {
		return DirectCollaboratorResult{}, ErrInvalidInput
	}
	return s.mutateDirectCollaborator(ctx, directCollaboratorMutation{
		accountID: input.AccountID, documentID: input.DocumentID, sourceID: input.SourceID,
		operation: "revoke", expectedVersion: input.ExpectedVersion,
	})
}

type directCollaboratorMutation struct {
	accountID, documentID, sourceID, operation, role string
	expectedVersion                                  int64
}

func (s *Service) mutateDirectCollaborator(
	ctx context.Context,
	input directCollaboratorMutation,
) (DirectCollaboratorResult, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return DirectCollaboratorResult{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	value, err := get(ctx, tx, input.accountID, input.documentID)
	if err != nil || !canManageCollaboratorsForAccess(value.AccessV2) || value.Status != "active" {
		if err != nil {
			return DirectCollaboratorResult{}, err
		}
		return DirectCollaboratorResult{}, ErrNotFound
	}
	actorID, err := resolveActiveHumanActorTx(ctx, tx, input.accountID, value.TenantID)
	if err != nil {
		return DirectCollaboratorResult{}, err
	}
	var targetActorID, targetActorKind, role, status, grantorActorID string
	var version int64
	var revokedAt *time.Time
	var createdAt, updatedAt time.Time
	err = tx.QueryRow(ctx, `SELECT collaborator.target_actor_id,target.kind,collaborator.role,
		collaborator.status,collaborator.version,collaborator.grantor_actor_id,
		collaborator.revoked_at,collaborator.created_at,collaborator.updated_at
		FROM document_direct_collaborators collaborator
		JOIN actors target ON target.id=collaborator.target_actor_id AND target.tenant_id=collaborator.tenant_id
		WHERE collaborator.id=$1 AND collaborator.document_id=$2 AND collaborator.tenant_id=$3
		FOR UPDATE OF collaborator`, input.sourceID,
		input.documentID, value.TenantID).Scan(&targetActorID, &targetActorKind, &role, &status, &version,
		&grantorActorID, &revokedAt, &createdAt, &updatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return DirectCollaboratorResult{}, ErrNotFound
	}
	if err != nil {
		return DirectCollaboratorResult{}, err
	}
	if status != "active" || version != input.expectedVersion {
		return DirectCollaboratorResult{}, ErrCollaboratorConflict
	}
	newVersion := version + 1
	eventType := "document.collaborator.updated"
	if input.operation == "update" {
		err = tx.QueryRow(ctx, `UPDATE document_direct_collaborators
			SET role=$4,version=version+1,updated_at=clock_timestamp()
			WHERE id=$1 AND document_id=$2 AND tenant_id=$3 AND status='active' AND version=$5
			RETURNING updated_at`, input.sourceID, input.documentID, value.TenantID, input.role,
			input.expectedVersion).Scan(&updatedAt)
		role = input.role
	} else {
		eventType = "document.collaborator.revoked"
		err = tx.QueryRow(ctx, `UPDATE document_direct_collaborators
			SET status='revoked',revoked_at=clock_timestamp(),version=version+1,updated_at=clock_timestamp()
			WHERE id=$1 AND document_id=$2 AND tenant_id=$3 AND status='active' AND version=$4
			RETURNING updated_at,revoked_at`, input.sourceID, input.documentID, value.TenantID,
			input.expectedVersion).Scan(&updatedAt, &revokedAt)
		status = "revoked"
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return DirectCollaboratorResult{}, ErrCollaboratorConflict
	}
	if err != nil {
		return DirectCollaboratorResult{}, err
	}
	source := directCollaboratorSource(input.sourceID, targetActorID, targetActorKind, role, status,
		newVersion, grantorActorID, createdAt, updatedAt)
	commandID := stableCreateID("document_collaborator_command_", input.sourceID, input.operation, strconv.FormatInt(newVersion, 10))
	if err := recordCollaboratorEvent(ctx, tx, value.TenantID, input.documentID,
		actorID, commandID, input.sourceID, eventType); err != nil {
		return DirectCollaboratorResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return DirectCollaboratorResult{}, err
	}
	return DirectCollaboratorResult{Source: source}, nil
}

// canManageCollaboratorsForAccess reports whether the Human may share the
// Document: it owns every active Document except a read-only Wiki page.
func canManageCollaboratorsForAccess(access *AccessEnvelopeV2) bool {
	return access != nil && access.ContentRole == "owner"
}

func directCollaboratorSource(
	sourceID, targetActorID, targetActorKind, role, status string,
	version int64,
	grantorActorID string,
	createdAt, updatedAt time.Time,
) AccessSourceV2 {
	return AccessSourceV2{
		SchemaVersion: 2, SourceID: sourceID, SourceKind: "direct", Status: status,
		Role: role, SourceVersion: version, GrantorActorID: &grantorActorID,
		Target:     &AccessTargetV2{Kind: targetActorKind, ID: targetActorID},
		Provenance: AccessSourceProvenanceV2{SchemaVersion: 2, Kind: "direct_grant"},
		CreatedAt:  createdAt, UpdatedAt: updatedAt,
	}
}

func isUniqueViolation(err error) bool {
	var postgresError *pgconn.PgError
	return errors.As(err, &postgresError) && postgresError.Code == "23505"
}

func recordCollaboratorEvent(
	ctx context.Context,
	tx pgx.Tx,
	tenantID, documentID, actorID, commandID, sourceID, eventType string,
) error {
	return appendDocumentEvent(ctx, tx, tenantID, documentID, actorID,
		stableCreateID("document_event_collaborator_", commandID, eventType),
		"collaborator_source", sourceID, eventType)
}

func roleRank(role string) int {
	switch role {
	case "viewer":
		return 1
	case "editor":
		return 2
	case "manager":
		return 3
	case "owner":
		return 4
	default:
		return 0
	}
}
