package document

import (
	"context"
	"crypto/sha256"
	"errors"
	"sort"
	"strconv"

	"github.com/jackc/pgx/v5"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/idempotency"
	idgen "github.com/simplexai-labs/linger/apps/teamhub/internal/ids"
)

type BindDocumentToRoomInput struct {
	AccountID, DocumentID, RoomID string
}

type BindDocumentToWorkItemInput struct {
	AccountID, DocumentID, WorkItemID, IdempotencyKey string
}

type BindDocumentToPersonalWikiInput struct {
	AccountID, DocumentID, TenantID string
}

type BindDocumentResult struct {
	Document Document
	Replayed bool
}

// EnsureRoomBindingsInTransactionInput names the command that binds the
// Documents. IdempotencyKey identifies that command; its binding events derive
// their ID from it.
type EnsureRoomBindingsInTransactionInput struct {
	AccountID, TenantID, RoomID, InitiatedByActorID, IdempotencyKey, Role string
	DocumentIDs                                                           []string
}

type RoomBindingResult struct {
	BindingID  string `json:"binding_id"`
	DocumentID string `json:"document_id"`
	RoomID     string `json:"room_id"`
	Role       string `json:"role"`
	Status     string `json:"status"`
	Version    int64  `json:"version"`
}

type RemoveRoomBindingInput struct {
	AccountID, DocumentID, RoomID string
	ExpectedVersion               int64
}

// BindToRoom binds a Document to a Room the caller is in; binding an already
// bound Document changes nothing.
func (s *Service) BindToRoom(ctx context.Context, input BindDocumentToRoomInput) (BindDocumentResult, error) {
	if input.AccountID == "" || input.DocumentID == "" || input.RoomID == "" {
		return BindDocumentResult{}, ErrInvalidInput
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return BindDocumentResult{}, err
	}
	defer tx.Rollback(ctx)
	value, err := get(ctx, tx, input.AccountID, input.DocumentID)
	if err != nil {
		return BindDocumentResult{}, err
	}
	var actorID string
	if err := tx.QueryRow(ctx, `SELECT actor.id FROM actors actor JOIN active_room_members member ON member.actor_id=actor.id AND member.tenant_id=actor.tenant_id JOIN rooms room ON room.id=member.room_id WHERE actor.account_id=$1 AND actor.tenant_id=$2 AND actor.kind='human' AND member.room_id=$3 AND room.deletion_started_at IS NULL`, input.AccountID, value.TenantID, input.RoomID).Scan(&actorID); err != nil {
		return BindDocumentResult{}, ErrNotFound
	}
	if _, err := EnsureRoomBindingsInTransaction(ctx, tx, EnsureRoomBindingsInTransactionInput{AccountID: input.AccountID, TenantID: value.TenantID, RoomID: input.RoomID, InitiatedByActorID: actorID, IdempotencyKey: idgen.New("document_binding_command"), Role: "viewer", DocumentIDs: []string{input.DocumentID}}); err != nil {
		return BindDocumentResult{}, err
	}
	value, err = get(ctx, tx, input.AccountID, input.DocumentID)
	if err != nil {
		return BindDocumentResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return BindDocumentResult{}, err
	}
	return BindDocumentResult{Document: value}, nil
}

// EnsureRoomBindingsInTransaction creates or restores the minimum Room
// collaborator sources required by one Message command. Active stronger
// Bindings are reused without downgrade.
func EnsureRoomBindingsInTransaction(
	ctx context.Context,
	tx pgx.Tx,
	input EnsureRoomBindingsInTransactionInput,
) ([]RoomBindingResult, error) {
	return ensureRoomBindingsInTransaction(ctx, tx, input, nil)
}

func ensureRoomBindingsInTransaction(ctx context.Context, tx pgx.Tx, input EnsureRoomBindingsInTransactionInput,
	reviewedAccess *AccessEnvelopeV2,
) ([]RoomBindingResult, error) {
	if tx == nil || input.AccountID == "" || input.TenantID == "" || input.RoomID == "" ||
		input.InitiatedByActorID == "" || len(input.IdempotencyKey) < 8 ||
		len(input.IdempotencyKey) > 128 || !oneOf(input.Role, "viewer", "editor", "manager") {
		return nil, ErrInvalidInput
	}
	documentIDs := append([]string(nil), input.DocumentIDs...)
	sort.Strings(documentIDs)
	documentIDs = compactUniqueStrings(documentIDs)
	if len(documentIDs) == 0 {
		return []RoomBindingResult{}, nil
	}
	var memberActorID string
	if err := tx.QueryRow(ctx, `SELECT actor.id
		FROM actors actor
		JOIN active_room_members member ON member.actor_id=actor.id
		 AND member.tenant_id=actor.tenant_id AND member.room_id=$4
		JOIN rooms room ON room.id=member.room_id AND room.tenant_id=member.tenant_id
		WHERE actor.id=$1 AND actor.tenant_id=$2 AND actor.account_id=$3
		 AND actor.kind='human' AND room.deletion_started_at IS NULL
		FOR SHARE OF actor,member,room`, input.InitiatedByActorID, input.TenantID,
		input.AccountID, input.RoomID).Scan(&memberActorID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			if reviewedAccess != nil {
				return nil, errRoomCreationSharingForbidden
			}
			return nil, ErrNotFound
		}
		return nil, err
	}

	results := make([]RoomBindingResult, 0, len(documentIDs))
	changedDocumentIDs := make([]string, 0, len(documentIDs))
	for _, documentID := range documentIDs {
		result, changed, err := ensureRoomBinding(ctx, tx, input, documentID, reviewedAccess)
		if err != nil {
			return nil, err
		}
		results = append(results, result)
		if !changed {
			continue
		}
		changedDocumentIDs = append(changedDocumentIDs, documentID)
		if err := invalidateBindingAccess(
			ctx, tx, input.TenantID, documentID, "room", input.RoomID,
		); err != nil {
			return nil, err
		}
	}
	if len(changedDocumentIDs) > 0 {
		resourceID := stableCreateID(
			"document_binding_command_", input.InitiatedByActorID, input.IdempotencyKey,
		)
		if err := AppendBindingUpdatedEvents(
			ctx, tx, input.TenantID, input.InitiatedByActorID, resourceID, changedDocumentIDs,
		); err != nil {
			return nil, err
		}
	}
	return results, nil
}

func ensureRoomBinding(
	ctx context.Context,
	tx pgx.Tx,
	input EnsureRoomBindingsInTransactionInput,
	documentID string,
	reviewedAccess *AccessEnvelopeV2,
) (RoomBindingResult, bool, error) {
	var result RoomBindingResult
	err := tx.QueryRow(ctx, `SELECT id,role,status,access_epoch
		FROM document_context_bindings
		WHERE tenant_id=$1 AND document_id=$2 AND binding_kind='room' AND room_id=$3
		ORDER BY status='active' DESC,updated_at DESC,id LIMIT 1 FOR UPDATE`,
		input.TenantID, documentID, input.RoomID).Scan(
		&result.BindingID, &result.Role, &result.Status, &result.Version,
	)
	if err == nil && result.Status == "active" && reviewedAccess == nil {
		result.DocumentID, result.RoomID = documentID, input.RoomID
		return result, false, nil
	}
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return RoomBindingResult{}, false, err
	}
	access := reviewedAccess
	var accessErr error
	if access == nil {
		access, accessErr = resolveAccessV2(ctx, tx, input.AccountID, documentID)
	}
	if accessErr != nil || !canManageCollaboratorsForAccess(access) {
		if accessErr != nil && !errors.Is(accessErr, pgx.ErrNoRows) {
			return RoomBindingResult{}, false, accessErr
		}
		if reviewedAccess != nil {
			return RoomBindingResult{}, false, errRoomCreationSharingForbidden
		}
		return RoomBindingResult{}, false, ErrNotFound
	}
	if result.Status == "active" {
		result.DocumentID, result.RoomID = documentID, input.RoomID
		return result, false, nil
	}
	var admittedDocumentID string
	if err := tx.QueryRow(ctx, `SELECT id FROM documents
		WHERE id=$1 AND tenant_id=$2 AND status='active' FOR KEY SHARE`,
		documentID, input.TenantID).Scan(&admittedDocumentID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			if reviewedAccess != nil {
				return RoomBindingResult{}, false, errRoomCreationSharingForbidden
			}
			return RoomBindingResult{}, false, ErrNotFound
		}
		return RoomBindingResult{}, false, err
	}
	if result.BindingID == "" {
		result = RoomBindingResult{
			BindingID:  stableCreateID("document_binding_", documentID, "room", input.RoomID),
			DocumentID: documentID, RoomID: input.RoomID, Role: input.Role,
			Status: "active", Version: 1,
		}
		if _, err := tx.Exec(ctx, `INSERT INTO document_context_bindings(
			id,tenant_id,document_id,binding_kind,room_id,status,role
		) VALUES($1,$2,$3,'room',$4,'active',$5)`, result.BindingID, input.TenantID,
			documentID, input.RoomID, input.Role); err != nil {
			return RoomBindingResult{}, false, err
		}
		return result, true, nil
	}
	oldVersion := result.Version
	result.DocumentID, result.RoomID, result.Role, result.Status = documentID, input.RoomID, input.Role, "active"
	result.Version++
	command, err := tx.Exec(ctx, `UPDATE document_context_bindings
		SET status='active',role=$4,access_epoch=access_epoch+1,updated_at=clock_timestamp()
		WHERE id=$1 AND tenant_id=$2 AND access_epoch=$3 AND status='suspended'`,
		result.BindingID, input.TenantID, oldVersion, input.Role)
	if err != nil {
		return RoomBindingResult{}, false, err
	}
	if command.RowsAffected() != 1 {
		return RoomBindingResult{}, false, ErrVersionConflict
	}
	return result, true, nil
}

func (s *Service) RemoveFromRoom(
	ctx context.Context,
	input RemoveRoomBindingInput,
) (RoomBindingResult, error) {
	if input.AccountID == "" || input.DocumentID == "" || input.RoomID == "" ||
		input.ExpectedVersion < 1 {
		return RoomBindingResult{}, ErrInvalidInput
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return RoomBindingResult{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var result RoomBindingResult
	var tenantID, oldStatus string
	result.DocumentID, result.RoomID, result.Status = input.DocumentID, input.RoomID, "suspended"
	err = tx.QueryRow(ctx, `SELECT tenant_id,id,role,status,access_epoch
		FROM document_context_bindings WHERE document_id=$1 AND binding_kind='room'
		 AND room_id=$2 AND status='active' FOR UPDATE`, input.DocumentID, input.RoomID).Scan(
		&tenantID, &result.BindingID, &result.Role, &oldStatus, &result.Version,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return RoomBindingResult{}, ErrNotFound
		}
		return RoomBindingResult{}, err
	}
	access, err := resolveAccessV2(ctx, tx, input.AccountID, input.DocumentID)
	if err != nil || !canManageCollaboratorsForAccess(access) {
		if err != nil {
			return RoomBindingResult{}, err
		}
		return RoomBindingResult{}, ErrNotFound
	}
	actorID, err := resolveActiveHumanActorTx(ctx, tx, input.AccountID, tenantID)
	if err != nil {
		return RoomBindingResult{}, err
	}
	if result.Version != input.ExpectedVersion {
		return RoomBindingResult{}, ErrVersionConflict
	}
	oldVersion := result.Version
	result.Version++
	command, err := tx.Exec(ctx, `UPDATE document_context_bindings
		SET status='suspended',access_epoch=access_epoch+1,updated_at=clock_timestamp()
		WHERE id=$1 AND tenant_id=$2 AND status='active' AND access_epoch=$3`,
		result.BindingID, tenantID, oldVersion)
	if err != nil {
		return RoomBindingResult{}, err
	}
	if command.RowsAffected() != 1 {
		return RoomBindingResult{}, ErrVersionConflict
	}
	if err := invalidateBindingAccess(ctx, tx, tenantID, input.DocumentID, "room", input.RoomID); err != nil {
		return RoomBindingResult{}, err
	}
	resourceID := stableCreateID("document_binding_remove_", result.BindingID, strconv.FormatInt(result.Version, 10))
	if err := AppendBindingUpdatedEvents(
		ctx, tx, tenantID, actorID, resourceID, []string{input.DocumentID},
	); err != nil {
		return RoomBindingResult{}, err
	}
	return result, tx.Commit(ctx)
}

func compactUniqueStrings(values []string) []string {
	result := values[:0]
	for _, value := range values {
		if value == "" || (len(result) > 0 && result[len(result)-1] == value) {
			continue
		}
		result = append(result, value)
	}
	return result
}

func (s *Service) BindToWorkItem(ctx context.Context, input BindDocumentToWorkItemInput) (BindDocumentResult, error) {
	return s.bindToContext(ctx, bindingCommandInput{
		accountID: input.AccountID, documentID: input.DocumentID, contextID: input.WorkItemID,
		idempotencyKey: input.IdempotencyKey, kind: "task", operation: "document.bind.task",
	})
}

// BindToPersonalWiki adds a Document to the caller's Wiki sources; binding a
// bound source changes nothing.
func (s *Service) BindToPersonalWiki(ctx context.Context, input BindDocumentToPersonalWikiInput) (BindDocumentResult, error) {
	return s.bindToContext(ctx, bindingCommandInput{
		accountID: input.AccountID, documentID: input.DocumentID, tenantID: input.TenantID,
		kind: "wiki_source", operation: "document.bind.wiki",
	})
}

// bindingCommandInput is one binding command. A Work Item binding carries the
// caller's Idempotency-Key; a Wiki source binding carries none.
type bindingCommandInput struct {
	accountID, documentID, contextID, tenantID, idempotencyKey, kind, operation string
}

func (s *Service) bindToContext(ctx context.Context, input bindingCommandInput) (BindDocumentResult, error) {
	if input.accountID == "" || input.documentID == "" ||
		len(input.idempotencyKey) > 128 || input.operation == "" ||
		(input.kind != "task" && input.kind != "wiki_source") ||
		(input.kind == "wiki_source" && (input.tenantID == "" || input.contextID != "")) ||
		(input.kind != "wiki_source" && (input.contextID == "" || input.tenantID != "")) {
		return BindDocumentResult{}, ErrInvalidInput
	}
	requestHash := bindingRequestHash(input)
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return BindDocumentResult{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := idempotency.Lock(ctx, tx, idempotency.AccountKey(input.accountID, input.operation, input.idempotencyKey)); err != nil {
		return BindDocumentResult{}, err
	}
	if result, found, err := lookupBindingReplay(ctx, tx, input, requestHash); err != nil || found {
		if err != nil {
			return BindDocumentResult{}, err
		}
		return result, tx.Commit(ctx)
	}
	bindingID, err := bindInTransaction(ctx, tx, input)
	if err != nil {
		return BindDocumentResult{}, err
	}
	if err := idempotency.Save(ctx, tx, idempotency.AccountKey(input.accountID, input.operation, input.idempotencyKey), requestHash[:], idempotency.Record{ResourceID: bindingID, Status: 200, Body: []byte{}}); err != nil {
		return BindDocumentResult{}, err
	}
	value, err := get(ctx, tx, input.accountID, input.documentID)
	if err != nil {
		return BindDocumentResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return BindDocumentResult{}, err
	}
	return BindDocumentResult{Document: value}, nil
}

func bindInTransaction(ctx context.Context, tx pgx.Tx, input bindingCommandInput) (string, error) {
	tenantID, actorID, contextID, err := resolveBindingAuthority(ctx, tx, input)
	if err != nil {
		return "", err
	}
	bindingID := stableCreateID("document_binding_", input.documentID, input.kind, contextID)
	changed, err := upsertTypedBinding(ctx, tx, tenantID, input.documentID, bindingID, input.kind, contextID, "editor")
	if err != nil || !changed {
		return bindingID, err
	}
	if err := invalidateBindingAccess(
		ctx, tx, tenantID, input.documentID, input.kind, contextID,
	); err != nil {
		return "", err
	}
	return bindingID, AppendBindingUpdatedEvents(
		ctx, tx, tenantID, actorID, bindingID, []string{input.documentID},
	)
}

func resolveBindingAuthority(
	ctx context.Context,
	tx pgx.Tx,
	input bindingCommandInput,
) (string, string, string, error) {
	var tenantID, actorID string
	err := tx.QueryRow(ctx, `SELECT document.tenant_id,owner.id
		FROM documents document
		JOIN actors owner ON owner.id=document.owner_actor_id AND owner.tenant_id=document.tenant_id
		 AND owner.kind='human' AND owner.account_id=$2
		WHERE document.id=$1 AND document.status='active'
		FOR NO KEY UPDATE OF document`, input.documentID, input.accountID).Scan(&tenantID, &actorID)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", "", "", ErrNotFound
	}
	if err != nil {
		return "", "", "", err
	}
	contextID := input.contextID
	switch input.kind {
	case "task":
		err = tx.QueryRow(ctx, `SELECT item.id FROM work_items item
			WHERE item.id=$1 AND item.tenant_id=$2 AND item.archived_at IS NULL AND item.state<>'resolved'
			FOR SHARE OF item`, input.contextID, tenantID).Scan(&contextID)
	case "wiki_source":
		if input.tenantID != tenantID {
			return "", "", "", ErrNotFound
		}
		// Binding a Human's first source creates the Wiki root.
		contextID, err = EnsurePersonalWikiRoot(ctx, tx, tenantID, actorID)
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return "", "", "", ErrNotFound
	}
	return tenantID, actorID, contextID, err
}

func upsertTypedBinding(
	ctx context.Context,
	tx pgx.Tx,
	tenantID, documentID, bindingID, kind, contextID, role string,
) (bool, error) {
	var roomID, workItemID, wikiID any
	switch kind {
	case "room":
		roomID = contextID
	case "task":
		workItemID = contextID
	case "wiki_source":
		wikiID = contextID
	}
	var status string
	err := tx.QueryRow(ctx, `SELECT status FROM document_context_bindings
		WHERE id=$1 AND tenant_id=$2 AND document_id=$3 FOR UPDATE`,
		bindingID, tenantID, documentID).Scan(&status)
	if errors.Is(err, pgx.ErrNoRows) {
		_, err = tx.Exec(ctx, `INSERT INTO document_context_bindings(
			id,tenant_id,document_id,binding_kind,room_id,work_item_id,wiki_id,status,role
		) VALUES($1,$2,$3,$4,$5,$6,$7,'active',$8)`, bindingID, tenantID, documentID,
			kind, roomID, workItemID, wikiID, role)
		return err == nil, err
	}
	if err != nil {
		return false, err
	}
	if status == "active" {
		return false, nil
	}
	command, err := tx.Exec(ctx, `UPDATE document_context_bindings
		SET status='active',role=$4,access_epoch=access_epoch+1,updated_at=clock_timestamp()
		WHERE id=$1 AND tenant_id=$2 AND document_id=$3 AND status='suspended'`,
		bindingID, tenantID, documentID, role)
	return err == nil && command.RowsAffected() == 1, err
}

func lookupBindingReplay(
	ctx context.Context,
	tx pgx.Tx,
	input bindingCommandInput,
	requestHash [sha256.Size]byte,
) (BindDocumentResult, bool, error) {
	_, found, err := lookupCommandRecord(ctx, tx, input.accountID, input.operation, input.idempotencyKey, requestHash[:])
	if err != nil || !found {
		return BindDocumentResult{}, false, err
	}
	value, err := get(ctx, tx, input.accountID, input.documentID)
	return BindDocumentResult{Document: value, Replayed: true}, true, err
}

func bindingRequestHash(input bindingCommandInput) [sha256.Size]byte {
	return sha256.Sum256([]byte(input.documentID + "\x00" + input.kind + "\x00" + input.contextID + "\x00" + input.tenantID))
}
