package document

import (
	"context"
	"sort"

	"github.com/jackc/pgx/v5"
)

type bindingAccessActor struct {
	actorID string
	owner   bool
}

// humanVisibleBindingsSQL is the FROM and WHERE of the active Context Bindings
// whose names a search matches for the Document aliased document. Each row
// joins its Room as room and its Task as item.
const humanVisibleBindingsSQL = `
 document_context_bindings binding
 LEFT JOIN rooms room ON room.id=binding.room_id AND room.tenant_id=binding.tenant_id
 LEFT JOIN work_items item ON item.id=binding.work_item_id AND item.tenant_id=binding.tenant_id
 WHERE binding.document_id=document.id AND binding.tenant_id=document.tenant_id
   AND binding.status='active'
   AND ((binding.binding_kind='room' AND room.deletion_started_at IS NULL)
     OR binding.binding_kind='task')`

// CanReadInTx applies the read rule of Get without loading the Document: the
// Space's Human reads every active Document of the Space.
func CanReadInTx(ctx context.Context, tx pgx.Tx, accountID, documentID string) (bool, error) {
	if tx == nil || accountID == "" || documentID == "" {
		return false, ErrInvalidInput
	}
	var readable bool
	err := tx.QueryRow(ctx, `SELECT EXISTS(
		SELECT 1 FROM documents document
		JOIN actors principal ON principal.account_id=$1 AND principal.kind='human'
		 AND principal.tenant_id=document.tenant_id
		WHERE document.id=$2 AND document.status='active')`,
		accountID, documentID).Scan(&readable)
	return readable, err
}

// RecomputeRoomMemberRevocationAccess invalidates the actor's access to every
// active Document whose authority may change when a Room membership is revoked.
func RecomputeRoomMemberRevocationAccess(
	ctx context.Context,
	tx pgx.Tx,
	tenantID, roomID, actorID, initiatedByActorID string,
) error {
	rows, err := tx.Query(ctx, `SELECT binding.document_id
		FROM document_context_bindings binding
		JOIN documents document ON document.id=binding.document_id
			AND document.tenant_id=$1 AND document.status='active'
		WHERE binding.tenant_id=$1 AND binding.binding_kind='room'
		  AND binding.room_id=$2 AND binding.status='active'
		ORDER BY binding.document_id
		FOR KEY SHARE OF document`, tenantID, roomID)
	if err != nil {
		return err
	}
	documentIDs := make([]string, 0)
	for rows.Next() {
		var documentID string
		if err := rows.Scan(&documentID); err != nil {
			rows.Close()
			return err
		}
		documentIDs = append(documentIDs, documentID)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	for _, documentID := range documentIDs {
		if err := invalidateActorAccess(
			ctx, tx, tenantID, documentID, actorID, initiatedByActorID,
		); err != nil {
			return err
		}
	}
	return nil
}

// LockTaskBoundDocuments takes the advisory Document locks for every Document
// bound to a Work Item. Work Item writes that also take delivery Accounts call
// it before those Account locks.
func LockTaskBoundDocuments(ctx context.Context, tx pgx.Tx, tenantID, workItemID string) error {
	rows, err := tx.Query(ctx, `SELECT binding.document_id
		FROM document_context_bindings binding
		WHERE binding.tenant_id=$1 AND binding.binding_kind='task' AND binding.work_item_id=$2`,
		tenantID, workItemID)
	if err != nil {
		return err
	}
	documentIDs, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return err
	}
	return Lock(ctx, tx, documentIDs)
}

// RecomputeTaskActorAccess invalidates the actor's access to every active
// Document bound to a Work Item after that Actor's Task authority changes.
func RecomputeTaskActorAccess(
	ctx context.Context,
	tx pgx.Tx,
	tenantID, workItemID, actorID, initiatedByActorID string,
) error {
	if err := LockTaskBoundDocuments(ctx, tx, tenantID, workItemID); err != nil {
		return err
	}
	rows, err := tx.Query(ctx, `SELECT document.id
		FROM document_context_bindings binding
		JOIN documents document ON document.id=binding.document_id
		 AND document.tenant_id=binding.tenant_id
		WHERE binding.tenant_id=$1 AND binding.binding_kind='task'
		 AND binding.work_item_id=$2 AND binding.status='active' AND document.status='active'
		ORDER BY document.id
		FOR KEY SHARE OF binding,document`, tenantID, workItemID)
	if err != nil {
		return err
	}
	documentIDs := make([]string, 0)
	for rows.Next() {
		var documentID string
		if err := rows.Scan(&documentID); err != nil {
			rows.Close()
			return err
		}
		documentIDs = append(documentIDs, documentID)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	for _, documentID := range documentIDs {
		if err := invalidateActorAccess(
			ctx, tx, tenantID, documentID, actorID, initiatedByActorID,
		); err != nil {
			return err
		}
	}
	return nil
}

// RecomputeTaskAllActorAccess invalidates the access of every Actor whose
// access to a Task-bound Document can change with Work Item lifecycle.
func RecomputeTaskAllActorAccess(
	ctx context.Context,
	tx pgx.Tx,
	tenantID, workItemID, initiatedByActorID string,
) error {
	rows, err := tx.Query(ctx, `WITH bound_documents AS MATERIALIZED (
		SELECT document.id,document.owner_actor_id
		FROM document_context_bindings binding
		JOIN documents document ON document.id=binding.document_id
		 AND document.tenant_id=binding.tenant_id
		WHERE binding.tenant_id=$1 AND binding.binding_kind='task'
		 AND binding.work_item_id=$2 AND binding.status='active' AND document.status='active'
		FOR KEY SHARE OF binding,document
	), actors AS (
		SELECT owner_actor_id AS actor_id FROM bound_documents
		UNION
		SELECT item.created_by_actor_id
		FROM work_items item
		JOIN actors agent ON agent.id=item.created_by_actor_id AND agent.tenant_id=item.tenant_id
		 AND agent.kind='agent'
		WHERE item.id=$2 AND item.tenant_id=$1
		UNION
		SELECT assignment.actor_id
		FROM work_item_assignments assignment
		JOIN actors agent ON agent.id=assignment.actor_id AND agent.tenant_id=assignment.tenant_id
		 AND agent.kind='agent'
		WHERE assignment.work_item_id=$2 AND assignment.tenant_id=$1
		UNION
		SELECT reference.actor_id
		FROM work_item_description_references reference
		JOIN actors agent ON agent.id=reference.actor_id AND agent.tenant_id=reference.tenant_id
		 AND agent.kind='agent'
		WHERE reference.work_item_id=$2 AND reference.tenant_id=$1
		UNION
		SELECT reference.actor_id
		FROM work_item_comment_references reference
		JOIN actors agent ON agent.id=reference.actor_id AND agent.tenant_id=reference.tenant_id
		 AND agent.kind='agent'
		WHERE reference.work_item_id=$2 AND reference.tenant_id=$1
		UNION
		SELECT grant_row.actor_id
		FROM work_item_access_grants grant_row
		JOIN actors agent ON agent.id=grant_row.actor_id AND agent.tenant_id=grant_row.tenant_id
		 AND agent.kind='agent'
		WHERE grant_row.work_item_id=$2 AND grant_row.tenant_id=$1
	)
	SELECT actor_id FROM actors ORDER BY actor_id`, tenantID, workItemID)
	if err != nil {
		return err
	}
	actorIDs := make([]string, 0)
	for rows.Next() {
		var actorID string
		if err := rows.Scan(&actorID); err != nil {
			rows.Close()
			return err
		}
		actorIDs = append(actorIDs, actorID)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	for _, actorID := range actorIDs {
		if err := RecomputeTaskActorAccess(
			ctx, tx, tenantID, workItemID, actorID, initiatedByActorID,
		); err != nil {
			return err
		}
	}
	return nil
}

// RecomputeWikiAllActorAccess invalidates the access of every Actor whose
// access can change when a Personal Wiki is deleted.
func RecomputeWikiAllActorAccess(
	ctx context.Context,
	tx pgx.Tx,
	tenantID, wikiID, initiatedByActorID string,
) error {
	rows, err := tx.Query(ctx, `WITH bound_documents AS MATERIALIZED (
			SELECT DISTINCT document.id,document.owner_actor_id
			FROM document_context_bindings binding
			JOIN documents document ON document.id=binding.document_id
			 AND document.tenant_id=binding.tenant_id
			WHERE binding.tenant_id=$1 AND binding.wiki_id=$2
			 AND binding.binding_kind IN ('wiki_source','wiki_page')
			 AND document.status='active'
		)
		SELECT id,owner_actor_id FROM bound_documents ORDER BY id,owner_actor_id`, tenantID, wikiID)
	if err != nil {
		return err
	}
	type affectedAccess struct {
		documentID string
		actorID    string
	}
	affected := make([]affectedAccess, 0)
	for rows.Next() {
		var access affectedAccess
		if err := rows.Scan(&access.documentID, &access.actorID); err != nil {
			rows.Close()
			return err
		}
		affected = append(affected, access)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	for _, access := range affected {
		if err := invalidateActorAccess(
			ctx, tx, tenantID, access.documentID, access.actorID, initiatedByActorID,
		); err != nil {
			return err
		}
	}
	return nil
}

// AppendBindingUpdatedEvents records one aggregate invalidation for each
// Document whose existing Binding changed in the enclosing transaction.
func AppendBindingUpdatedEvents(
	ctx context.Context,
	tx pgx.Tx,
	tenantID, initiatedByActorID, resourceID string,
	documentIDs []string,
) error {
	sortedDocumentIDs := append([]string(nil), documentIDs...)
	sort.Strings(sortedDocumentIDs)
	previousDocumentID := ""
	for _, documentID := range sortedDocumentIDs {
		if documentID == "" || documentID == previousDocumentID {
			continue
		}
		previousDocumentID = documentID
		eventID := stableCreateID("document_binding_event_", documentID, resourceID)
		if err := appendDocumentEvent(
			ctx, tx, tenantID, documentID, initiatedByActorID, eventID,
			"binding_context", resourceID, "document.binding_updated",
		); err != nil {
			return err
		}
	}
	return nil
}

type actorAccess struct {
	CanRead, CanWrite bool
}

// invalidateActorAccess records that an Actor's access to a Document may have
// changed. It increments the Document's permission count, so every connection
// token signed before stops opening connections, and tells clients to refetch.
// When the Actor can no longer write, the Runtime also closes the Actor's open
// connections after commit, and they reopen under the current access.
func invalidateActorAccess(
	ctx context.Context,
	tx pgx.Tx,
	tenantID, documentID, actorID, initiatedByActorID string,
) error {
	// One invalidation per Document and transaction tells clients to refetch,
	// however many Actors the transaction recomputes.
	var transactionID string
	if err := tx.QueryRow(ctx, `SELECT txid_current()::text`).Scan(&transactionID); err != nil {
		return err
	}
	if err := appendLifecycleEvent(
		ctx, tx, tenantID, documentID, initiatedByActorID,
		stableCreateID("document_access_", documentID, transactionID),
		"access_epoch", "document.access_invalidated",
	); err != nil {
		return err
	}
	if err := incrementPermissionCount(ctx, tx, documentID); err != nil {
		return err
	}
	access, err := currentActorAccess(ctx, tx, tenantID, documentID, actorID)
	if err != nil || access.CanWrite {
		return err
	}
	return insertRuntimeDisconnect(ctx, tx, documentID, actorID)
}

// incrementPermissionCount makes every connection token of the Document stale.
// Callers take it after the Document advisory lock (the event they append
// takes it), so the count row is the last lock of a permission change.
func incrementPermissionCount(ctx context.Context, tx pgx.Tx, documentID string) error {
	_, err := tx.Exec(ctx, `UPDATE document_permission_counts SET permission_count=permission_count+1
		WHERE document_id=$1`, documentID)
	return err
}

// currentActorAccess derives the Actor's current Document capabilities from
// every access source.
func currentActorAccess(
	ctx context.Context,
	tx pgx.Tx,
	tenantID, documentID, actorID string,
) (actorAccess, error) {
	// Only settlement writes a Wiki page: owning one, as its
	// generator does, and a Wiki page binding both give read access only. The
	// Space's Human and its Agents read and write every other active Document.
	var access actorAccess
	err := tx.QueryRow(ctx, `WITH wiki_page AS (
		SELECT EXISTS(SELECT 1 FROM document_context_bindings binding
		  WHERE binding.document_id=$1 AND binding.tenant_id=$2
		    AND binding.binding_kind='wiki_page') AS value
	), task_items AS (
		SELECT item.id,item.tenant_id,item.created_by_actor_id,
		       item.archived_at IS NULL AND item.state<>'resolved' AS open
		FROM document_context_bindings binding
		JOIN work_items item ON item.id=binding.work_item_id AND item.tenant_id=binding.tenant_id
		WHERE binding.document_id=$1 AND binding.tenant_id=$2 AND binding.status='active'
		 AND binding.binding_kind='task'
	), sources AS (
		SELECT true AS can_read,NOT wiki_page.value AS can_write
		FROM documents document CROSS JOIN wiki_page
		WHERE document.id=$1 AND document.tenant_id=$2 AND document.owner_actor_id=$3
		UNION ALL
		SELECT true,NOT wiki_page.value
		FROM documents document CROSS JOIN wiki_page
		JOIN agent_registrations registration ON registration.actor_id=$3
		 AND registration.tenant_id=document.tenant_id AND registration.status='active'
		WHERE document.id=$1 AND document.tenant_id=$2 AND document.status='active'
		UNION ALL
		SELECT true,binding.role IN ('editor','manager')
		FROM document_context_bindings binding
		JOIN rooms room ON room.id=binding.room_id AND room.tenant_id=binding.tenant_id
		JOIN active_room_members member ON member.room_id=binding.room_id
		 AND member.tenant_id=binding.tenant_id AND member.actor_id=$3
		WHERE binding.document_id=$1 AND binding.tenant_id=$2 AND binding.status='active'
		 AND binding.binding_kind='room' AND room.deletion_started_at IS NULL
		UNION ALL
		SELECT true,NOT wiki_page.value
		FROM documents document CROSS JOIN wiki_page
		JOIN actors human ON human.id=$3 AND human.tenant_id=document.tenant_id AND human.kind='human'
		WHERE document.id=$1 AND document.tenant_id=$2 AND document.status='active'
		UNION ALL
		SELECT true,item.open
		FROM task_items item
		JOIN actors agent ON agent.id=$3 AND agent.tenant_id=item.tenant_id AND agent.kind='agent'
		WHERE item.created_by_actor_id=$3
		 OR EXISTS (SELECT 1 FROM work_item_assignments assignment
		   WHERE assignment.work_item_id=item.id AND assignment.tenant_id=item.tenant_id
		    AND assignment.actor_id=$3)
		 OR EXISTS (SELECT 1 FROM work_item_description_references reference
		   WHERE reference.work_item_id=item.id AND reference.tenant_id=item.tenant_id
		    AND reference.actor_id=$3)
		 OR EXISTS (SELECT 1 FROM work_item_comment_references reference
		   WHERE reference.work_item_id=item.id AND reference.tenant_id=item.tenant_id
		    AND reference.actor_id=$3)
		 OR EXISTS (SELECT 1 FROM work_item_access_grants grant_row
		   WHERE grant_row.work_item_id=item.id AND grant_row.tenant_id=item.tenant_id
		    AND grant_row.actor_id=$3)
	)
	SELECT coalesce(bool_or(can_read),false),coalesce(bool_or(can_write),false) FROM sources`,
		documentID, tenantID, actorID).Scan(&access.CanRead, &access.CanWrite)
	return access, err
}

// RecomputeRoomMemberAdmissionAccess invalidates a newly active member's
// access to every Document bound to the Room.
func RecomputeRoomMemberAdmissionAccess(
	ctx context.Context,
	tx pgx.Tx,
	tenantID, roomID, actorID, initiatedByActorID string,
) error {
	rows, err := tx.Query(ctx, `SELECT binding.document_id
		FROM document_context_bindings binding
		JOIN documents document ON document.id=binding.document_id
		 AND document.tenant_id=binding.tenant_id AND document.status='active'
		JOIN rooms room ON room.id=binding.room_id AND room.tenant_id=binding.tenant_id
		 AND room.deletion_started_at IS NULL
		WHERE binding.tenant_id=$1 AND binding.room_id=$2
		 AND binding.binding_kind='room' AND binding.status='active'
		ORDER BY binding.document_id`, tenantID, roomID)
	if err != nil {
		return err
	}
	defer rows.Close()
	var documentIDs []string
	for rows.Next() {
		var documentID string
		if err := rows.Scan(&documentID); err != nil {
			return err
		}
		documentIDs = append(documentIDs, documentID)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	for _, documentID := range documentIDs {
		if err := invalidateActorAccess(
			ctx, tx, tenantID, documentID, actorID, initiatedByActorID,
		); err != nil {
			return err
		}
	}
	return nil
}

// invalidateBindingAccess invalidates the access of every Actor that a changed
// Binding may grant or take away.
func invalidateBindingAccess(
	ctx context.Context,
	tx pgx.Tx,
	tenantID, documentID, bindingKind, contextID string,
) error {
	rows, err := tx.Query(ctx, `WITH sources AS (
		SELECT owner_actor_id AS actor_id
		FROM documents WHERE id=$1 AND tenant_id=$2
		UNION
		SELECT member.actor_id
		FROM active_room_members member
		JOIN rooms room ON room.id=member.room_id AND room.tenant_id=member.tenant_id
		WHERE $4='room' AND member.room_id=$3 AND member.tenant_id=$2
		 AND room.deletion_started_at IS NULL
		UNION
		SELECT item.created_by_actor_id
		FROM work_items item
		JOIN actors agent ON agent.id=item.created_by_actor_id AND agent.tenant_id=item.tenant_id
		 AND agent.kind='agent'
		WHERE $4='task' AND item.id=$3 AND item.tenant_id=$2
		 AND item.archived_at IS NULL AND item.state<>'resolved'
		UNION
		SELECT assignment.actor_id
		FROM work_item_assignments assignment
		JOIN work_items item ON item.id=assignment.work_item_id AND item.tenant_id=assignment.tenant_id
		JOIN actors agent ON agent.id=assignment.actor_id AND agent.tenant_id=assignment.tenant_id
		 AND agent.kind='agent'
		WHERE $4='task' AND assignment.work_item_id=$3 AND assignment.tenant_id=$2
		 AND item.archived_at IS NULL AND item.state<>'resolved'
		UNION
		SELECT reference.actor_id
		FROM work_item_description_references reference
		JOIN work_items item ON item.id=reference.work_item_id AND item.tenant_id=reference.tenant_id
		JOIN actors agent ON agent.id=reference.actor_id AND agent.tenant_id=reference.tenant_id
		 AND agent.kind='agent'
		WHERE $4='task' AND reference.work_item_id=$3 AND reference.tenant_id=$2
		 AND item.archived_at IS NULL AND item.state<>'resolved'
		UNION
		SELECT reference.actor_id
		FROM work_item_comment_references reference
		JOIN work_items item ON item.id=reference.work_item_id AND item.tenant_id=reference.tenant_id
		JOIN actors agent ON agent.id=reference.actor_id AND agent.tenant_id=reference.tenant_id
		 AND agent.kind='agent'
		WHERE $4='task' AND reference.work_item_id=$3 AND reference.tenant_id=$2
		 AND item.archived_at IS NULL AND item.state<>'resolved'
		UNION
		SELECT grant_row.actor_id
		FROM work_item_access_grants grant_row
		JOIN work_items item ON item.id=grant_row.work_item_id AND item.tenant_id=grant_row.tenant_id
		JOIN actors agent ON agent.id=grant_row.actor_id AND agent.tenant_id=grant_row.tenant_id
		 AND agent.kind='agent'
		WHERE $4='task' AND grant_row.work_item_id=$3 AND grant_row.tenant_id=$2
		 AND item.archived_at IS NULL AND item.state<>'resolved'
	)
	SELECT DISTINCT sources.actor_id,sources.actor_id=document.owner_actor_id
	FROM documents document JOIN sources ON true
	WHERE document.id=$1 AND document.tenant_id=$2 AND document.status='active'
	ORDER BY sources.actor_id`, documentID, tenantID, contextID, bindingKind)
	if err != nil {
		return err
	}
	accesses := make([]bindingAccessActor, 0)
	for rows.Next() {
		var actorID string
		var owner bool
		if err := rows.Scan(&actorID, &owner); err != nil {
			rows.Close()
			return err
		}
		accesses = append(accesses, bindingAccessActor{actorID: actorID, owner: owner})
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	initiatedByActorID := ""
	for _, access := range accesses {
		if access.owner {
			initiatedByActorID = access.actorID
			break
		}
	}
	if initiatedByActorID == "" {
		return ErrNotFound
	}
	for _, access := range accesses {
		if err := invalidateActorAccess(
			ctx, tx, tenantID, documentID, access.actorID, initiatedByActorID,
		); err != nil {
			return err
		}
	}
	return nil
}
