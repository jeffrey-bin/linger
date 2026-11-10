package document

import (
	"context"
	"errors"
	"strconv"

	"github.com/google/uuid"

	"github.com/jackc/pgx/v5"
)

// ErrFilePublicationForbidden reports that the Agent cannot publish this file
// to the named target.
var ErrFilePublicationForbidden = errors.New("file publication forbidden")

type ShareAgentFileInput struct {
	AgentID, DocumentID, TargetKind, TargetID, Role string
}

func (s *Service) ShareAgentFile(ctx context.Context, input ShareAgentFileInput) error {
	if input.AgentID == "" || input.DocumentID == "" || input.TargetID == "" || !oneOf(input.TargetKind, "actor", "room", "task") || !oneOf(input.Role, "viewer", "editor", "manager") {
		return ErrInvalidInput
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tenantID, actorID, err := lockLinkShareManager(ctx, tx, LinkSharePrincipal{AgentID: input.AgentID}, input.DocumentID)
	if err != nil {
		return err
	}
	if input.TargetKind == "task" {
		var recipientID string
		err := tx.QueryRow(ctx, `SELECT item.created_by_actor_id FROM work_items item WHERE item.tenant_id=$1 AND item.id=$2 AND item.archived_at IS NULL AND item.state<>'resolved'
   AND (item.created_by_actor_id=$3 OR EXISTS(SELECT 1 FROM work_item_assignments assignment WHERE assignment.tenant_id=item.tenant_id AND assignment.work_item_id=item.id AND assignment.actor_id=$3))`, tenantID, input.TargetID, actorID).Scan(&recipientID)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrFilePublicationForbidden
		}
		if err != nil {
			return err
		}
		input.TargetKind, input.TargetID = "actor", recipientID
	}
	if input.TargetKind == "room" {
		var member bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM active_room_members member JOIN rooms room ON room.id=member.room_id AND room.tenant_id=member.tenant_id
   WHERE member.tenant_id=$1 AND member.room_id=$2 AND member.actor_id=$3 AND room.deletion_started_at IS NULL)`, tenantID, input.TargetID, actorID).Scan(&member); err != nil {
			return err
		}
		if !member {
			return ErrFilePublicationForbidden
		}
		var bindingID, oldRole string
		err = tx.QueryRow(ctx, `SELECT id,role FROM document_context_bindings WHERE document_id=$1 AND binding_kind='room' AND room_id=$2 AND status='active' FOR UPDATE`, input.DocumentID, input.TargetID).Scan(&bindingID, &oldRole)
		if err == nil {
			if roleRank(oldRole) >= roleRank(input.Role) {
				return tx.Commit(ctx)
			}
			if _, err := tx.Exec(ctx, `UPDATE document_context_bindings SET role=$2,access_epoch=access_epoch+1,updated_at=clock_timestamp() WHERE id=$1`, bindingID, input.Role); err != nil {
				return err
			}
		} else if errors.Is(err, pgx.ErrNoRows) {
			bindingID = stableCreateID("document_binding_", input.DocumentID, "room", input.TargetID)
			if _, err := upsertTypedBinding(ctx, tx, tenantID, input.DocumentID, bindingID, "room", input.TargetID, input.Role); err != nil {
				return err
			}
		} else {
			return err
		}
		if err := invalidateBindingAccess(ctx, tx, tenantID, input.DocumentID, "room", input.TargetID); err != nil {
			return err
		}
		if err := AppendBindingUpdatedEvents(ctx, tx, tenantID, actorID, uuid.NewString(), []string{input.DocumentID}); err != nil {
			return err
		}
	} else {
		var targetKind string
		err = tx.QueryRow(ctx, `SELECT kind FROM actors actor WHERE id=$1 AND tenant_id=$2 AND (
   (kind='agent' AND EXISTS(SELECT 1 FROM agent_registrations WHERE actor_id=actor.id AND status='active')) OR
   kind='human')`, input.TargetID, tenantID).Scan(&targetKind)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		if targetKind == "human" {
			// The Human already reads every active Document.
			return tx.Commit(ctx)
		}
		var ownerID string
		if err := tx.QueryRow(ctx, `SELECT owner_actor_id FROM documents WHERE id=$1`, input.DocumentID).Scan(&ownerID); err != nil {
			return err
		}
		if input.TargetID == ownerID {
			return tx.Commit(ctx)
		}
		var sourceID, oldRole string
		var oldVersion int64
		err = tx.QueryRow(ctx, `SELECT id,role,version FROM document_direct_collaborators WHERE document_id=$1 AND target_actor_id=$2 AND status='active' FOR UPDATE`, input.DocumentID, input.TargetID).Scan(&sourceID, &oldRole, &oldVersion)
		if err == nil {
			if roleRank(oldRole) >= roleRank(input.Role) {
				return tx.Commit(ctx)
			}
			if _, err := tx.Exec(ctx, `UPDATE document_direct_collaborators SET role=$2,version=version+1,updated_at=clock_timestamp() WHERE id=$1`, sourceID, input.Role); err != nil {
				return err
			}
		} else if errors.Is(err, pgx.ErrNoRows) {
			sourceID = stableCreateID("document_direct_source_", input.DocumentID, input.TargetID, uuid.NewString())
			if _, err := tx.Exec(ctx, `INSERT INTO document_direct_collaborators(id,tenant_id,document_id,target_actor_id,role,status,grantor_actor_id,version)
    VALUES($1,$2,$3,$4,$5,'active',$6,1)`, sourceID, tenantID, input.DocumentID, input.TargetID, input.Role, actorID); err != nil {
				return err
			}
		} else {
			return err
		}
		if err := recordCLIActorShare(ctx, tx, tenantID, actorID, sourceID, input, oldVersion); err != nil {
			return err
		}
		if oldVersion == 0 {
			var title string
			if err := tx.QueryRow(ctx, `SELECT title FROM documents WHERE id=$1`, input.DocumentID).Scan(&title); err != nil {
				return err
			}
			if err := notifySharedAgent(ctx, tx, tenantID, input.DocumentID, title, actorID, input.TargetID); err != nil {
				return err
			}
		}
	}
	return tx.Commit(ctx)
}

func recordCLIActorShare(ctx context.Context, tx pgx.Tx, tenantID, actorID, sourceID string, input ShareAgentFileInput, oldVersion int64) error {
	var version int64
	if err := tx.QueryRow(ctx, `SELECT version FROM document_direct_collaborators WHERE id=$1`, sourceID).Scan(&version); err != nil {
		return err
	}
	operation, eventType := "create", "document.collaborator.created"
	if oldVersion > 0 {
		operation, eventType = "update", "document.collaborator.updated"
	}
	commandID := stableCreateID("document_collaborator_command_", sourceID, operation, strconv.FormatInt(version, 10))
	return recordCollaboratorEvent(ctx, tx, tenantID, input.DocumentID, actorID, commandID, sourceID, eventType)
}
