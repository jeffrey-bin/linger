package document

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"

	"github.com/jackc/pgx/v5"
	idgen "github.com/simplexai-labs/linger/apps/teamhub/internal/ids"
)

type TrashDocumentInput struct {
	AccountID, DocumentID string
}

type RestoreDocumentInput struct {
	AccountID, DocumentID string
}

// Trash moves a Document to the trash in one transaction: the status, the
// revoked link share, the suspended Bindings and the new permission count
// commit together, and the Runtime closes the open connections after commit.
// Trashing a trashed Document changes nothing.
func (s *Service) Trash(ctx context.Context, input TrashDocumentInput) error {
	if input.AccountID == "" || input.DocumentID == "" {
		return ErrInvalidInput
	}
	// A serialization failure aborts the entire transaction. Retry with a new
	// snapshot so the authorization check and the trash stay atomic.
	const attempts = 3
	for attempt := 0; ; attempt++ {
		err := s.trashOnce(ctx, input)
		if err == nil || !isRetryableDocumentTransactionError(err) || attempt == attempts-1 || ctx.Err() != nil {
			return err
		}
	}
}

func (s *Service) trashOnce(ctx context.Context, input TrashDocumentInput) error {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tenantID, actorID, documentStatus, err := lockTrashRequester(ctx, tx, input.AccountID, input.DocumentID)
	if err != nil {
		return err
	}
	if documentStatus == "active" {
		commandID := idgen.New("document_lifecycle")
		updated, err := tx.Exec(ctx, `UPDATE documents SET status='trashed',
			trashed_at=GREATEST(updated_at,clock_timestamp()),updated_at=GREATEST(updated_at,clock_timestamp())
			WHERE id=$1 AND status='active'`, input.DocumentID)
		if err != nil {
			return err
		}
		if updated.RowsAffected() != 1 {
			return ErrConflict
		}
		if err := revokeDocumentLinkForTrash(ctx, tx, tenantID, input.DocumentID, actorID); err != nil {
			return err
		}
		if err := appendLifecycleEvent(ctx, tx, tenantID, input.DocumentID, actorID,
			commandID, "lifecycle_operation", "document.access_invalidated"); err != nil {
			return err
		}
		// Every token signed before the trash is stale, so a restore reopens
		// connections only under the access that is current then.
		if err := incrementPermissionCount(ctx, tx, input.DocumentID); err != nil {
			return err
		}
		if err := suspendDocumentBindingsForTrash(
			ctx, tx, tenantID, input.DocumentID, actorID, commandID,
		); err != nil {
			return err
		}
		if err := appendLifecycleEvent(ctx, tx, tenantID, input.DocumentID, actorID,
			commandID, "lifecycle_operation", "document.trashed"); err != nil {
			return err
		}
		if err := insertRuntimeDisconnect(ctx, tx, input.DocumentID, ""); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

func suspendDocumentBindingsForTrash(
	ctx context.Context,
	tx pgx.Tx,
	tenantID, documentID, initiatedByActorID, commandID string,
) error {
	updated, err := tx.Exec(ctx, `UPDATE document_context_bindings
		SET status='suspended',access_epoch=access_epoch+1,updated_at=clock_timestamp()
		WHERE tenant_id=$1 AND document_id=$2 AND status='active'`, tenantID, documentID)
	if err != nil {
		return err
	}
	if updated.RowsAffected() == 0 {
		return nil
	}
	return AppendBindingUpdatedEvents(
		ctx, tx, tenantID, initiatedByActorID, commandID, []string{documentID},
	)
}

// Restore makes a trashed Document active again for its owner. Revoked access
// stays revoked. Restoring an active Document changes nothing.
func (s *Service) Restore(ctx context.Context, input RestoreDocumentInput) error {
	if input.AccountID == "" || input.DocumentID == "" {
		return ErrInvalidInput
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tenantID, actorID, documentStatus, err := lockLifecycleOwner(ctx, tx, input.AccountID, input.DocumentID)
	if err != nil {
		return err
	}
	if documentStatus == "trashed" {
		updated, err := tx.Exec(ctx, `UPDATE documents SET status='active',restored_at=GREATEST(updated_at,clock_timestamp()),
			updated_at=GREATEST(updated_at,clock_timestamp()) WHERE id=$1 AND status='trashed'`, input.DocumentID)
		if err != nil {
			return err
		}
		if updated.RowsAffected() != 1 {
			return ErrConflict
		}
		commandID := idgen.New("document_lifecycle")
		if err := appendLifecycleEvent(ctx, tx, tenantID, input.DocumentID, actorID,
			commandID, "lifecycle_operation", "document.restored"); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

func lockTrashRequester(ctx context.Context, tx pgx.Tx, accountID, documentID string) (tenantID, actorID, status string, err error) {
	err = tx.QueryRow(ctx, `SELECT document.tenant_id,actor.id,document.status
        FROM documents document
        JOIN actors actor ON actor.tenant_id=document.tenant_id AND actor.account_id=$2 AND actor.kind='human'
        LEFT JOIN LATERAL resolve_human_document_access_v2($2,document.id) access ON true
        WHERE document.id=$1 AND (document.owner_actor_id=actor.id OR access.content_role IN ('owner','manager'))
        FOR UPDATE OF document`, documentID, accountID).Scan(&tenantID, &actorID, &status)
	if errors.Is(err, pgx.ErrNoRows) {
		err = ErrNotFound
	}
	return
}

func lockLifecycleOwner(
	ctx context.Context,
	tx pgx.Tx,
	accountID, documentID string,
) (tenantID, actorID, status string, err error) {
	err = tx.QueryRow(ctx, `SELECT document.tenant_id,owner.id,document.status
		FROM documents document
		JOIN actors owner ON owner.id=document.owner_actor_id AND owner.tenant_id=document.tenant_id
		WHERE document.id=$1 AND owner.account_id=$2 AND owner.kind='human'
		FOR UPDATE OF document`, documentID, accountID).Scan(&tenantID, &actorID, &status)
	if errors.Is(err, pgx.ErrNoRows) {
		err = ErrNotFound
	}
	return
}

func appendLifecycleEvent(
	ctx context.Context,
	tx pgx.Tx,
	tenantID, documentID, actorID, operationID, resourceKind, eventType string,
) error {
	eventID := stableLifecycleID("document_event_", operationID, eventType)
	return appendDocumentEvent(
		ctx, tx, tenantID, documentID, actorID, eventID, resourceKind, operationID, eventType,
	)
}

func appendDocumentEvent(
	ctx context.Context,
	tx pgx.Tx,
	tenantID, documentID, actorID, eventID, resourceKind, resourceID, eventType string,
) error {
	_, err := tx.Exec(ctx, `INSERT INTO document_events(
		id,tenant_id,document_id,event_type,actor_id,resource_kind,resource_id,projection_version,occurred_at
	) VALUES($1,$2,$3,
		$4,$5,$6,$7,1,GREATEST(clock_timestamp(),(SELECT updated_at FROM documents WHERE id=$3)))
		ON CONFLICT (id) DO NOTHING`,
		eventID, tenantID, documentID, eventType, actorID, resourceKind, resourceID)
	return err
}

func stableLifecycleID(prefix, left, right string) string {
	hash := sha256.Sum256([]byte(left + "\x00" + right))
	return prefix + hex.EncodeToString(hash[:16])
}
