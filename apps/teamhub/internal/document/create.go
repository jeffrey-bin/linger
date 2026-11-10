package document

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"slices"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	idgen "github.com/simplexai-labs/linger/apps/teamhub/internal/ids"
)

type CreateDocumentInput struct {
	AccountID, TenantID, RoomID, RepresentationFormat string
	ParentID                                          *string
}

type CreateDocumentResult struct {
	Document Document
}

// Create makes a blank native Document; each call makes a new one.
func (s *Service) Create(ctx context.Context, input CreateDocumentInput) (CreateDocumentResult, error) {
	if input.RepresentationFormat == "" {
		input.RepresentationFormat = "markdown"
	}
	if input.AccountID == "" || (input.RoomID == "" && input.TenantID == "") ||
		(input.ParentID != nil && *input.ParentID == "") || (input.ParentID != nil && input.RoomID != "") ||
		(input.RepresentationFormat != "markdown" && input.RepresentationFormat != "html") {
		return CreateDocumentResult{}, ErrInvalidInput
	}
	// Reject unavailable authority before invoking the external Runtime. The
	// serializable transaction below rechecks the same authority before write.
	if _, _, err := resolveCreateOwner(ctx, s.pool, input.AccountID, input.TenantID, input.ParentID, input.RoomID); err != nil {
		return CreateDocumentResult{}, err
	}
	if s.runtime == nil {
		return CreateDocumentResult{}, ErrRuntimeUnavailable
	}
	materializationID := uuid.NewString()
	computed, err := s.runtime.Import(ctx, ImportRequest{OperationID: materializationID, SourceKind: importBlank})
	if err != nil {
		return CreateDocumentResult{}, err
	}
	if !validBlankMaterialization(computed) {
		return CreateDocumentResult{}, ErrRuntimeResultInvalid
	}
	if err := requireStateBundleBudget(
		computed.StateBytes,
		computed.StateVector,
		computed.CompleteAssetIDs,
		computed.CompleteThreadIDs,
	); err != nil {
		return CreateDocumentResult{}, err
	}

	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return CreateDocumentResult{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tenantID, actorID, err := resolveCreateOwner(ctx, tx, input.AccountID, input.TenantID, input.ParentID, input.RoomID)
	if err != nil {
		return CreateDocumentResult{}, err
	}
	if input.ParentID != nil {
		if _, err := getPersonalPlacement(ctx, tx, input.AccountID, *input.ParentID, true, tenantID); err != nil {
			return CreateDocumentResult{}, err
		}
	}
	documentID := idgen.New("document")
	revisionID := stableCreateID("document_revision_", documentID, materializationID)
	bindingID := stableCreateID("document_binding_", documentID, "room", input.RoomID)
	if _, err := tx.Exec(ctx, `INSERT INTO documents(
		id,tenant_id,title,format,native_representation_format,owner_actor_id,owner_actor_kind,creator_actor_id,
		creator_actor_kind,status
	) VALUES($1,$2,'untitled','blocknote',$3,$4,'human',$4,'human','active')`,
		documentID, tenantID, input.RepresentationFormat, actorID); err != nil {
		return CreateDocumentResult{}, err
	}
	assetManifest, err := json.Marshal([]any{})
	if err != nil {
		return CreateDocumentResult{}, err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO document_revisions(
		id,tenant_id,document_id,persisted_seq,state_vector,full_state_fingerprint,
		state_status,state_bytes,state_bytes_sha256,asset_manifest,thread_manifest,created_by_actor_id
	) VALUES($1,$2,$3,0,$4,$5,'available',$6,$7,$8,$9,$10)`, revisionID, tenantID,
		documentID, computed.StateVector, computed.FullStateFingerprint, computed.StateBytes,
		computed.StateBytesSHA256, assetManifest, computed.CompleteThreadIDs, actorID); err != nil {
		return CreateDocumentResult{}, err
	}
	if err := insertBodyTx(ctx, tx, documentID, computed.StateBytes, computed.StateVector,
		nil, computed.CompleteThreadIDs, actorID); err != nil {
		return CreateDocumentResult{}, err
	}
	if err := insertPersonalDocumentPlacement(ctx, tx, tenantID, actorID, documentID, input.ParentID); err != nil {
		return CreateDocumentResult{}, err
	}
	if input.RoomID != "" {
		if _, err := tx.Exec(ctx, `INSERT INTO document_context_bindings(
			id,tenant_id,document_id,binding_kind,room_id,status
		) VALUES($1,$2,$3,'room',$4,'active')`, bindingID, tenantID, documentID, input.RoomID); err != nil {
			return CreateDocumentResult{}, err
		}
	}
	if err := appendLifecycleEvent(ctx, tx, tenantID, documentID, actorID, documentID, "document", "document.created"); err != nil {
		return CreateDocumentResult{}, err
	}
	value, err := get(ctx, tx, input.AccountID, documentID)
	if err != nil {
		return CreateDocumentResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return CreateDocumentResult{}, err
	}
	return CreateDocumentResult{Document: value}, nil
}

type createOwnerQuerier interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

func resolveCreateOwner(ctx context.Context, tx createOwnerQuerier, accountID, requestedTenantID string, parentID *string, roomID string) (string, string, error) {
	if roomID != "" {
		var tenantID, actorID string
		err := tx.QueryRow(ctx, `SELECT room.tenant_id,actor.id
			FROM rooms room
			JOIN actors actor ON actor.tenant_id=room.tenant_id
			  AND actor.account_id=$2 AND actor.kind='human'
			JOIN active_room_members member ON member.room_id=room.id
			  AND member.tenant_id=room.tenant_id AND member.actor_id=actor.id
			WHERE room.id=$1 AND room.deletion_started_at IS NULL`, roomID, accountID).Scan(&tenantID, &actorID)
		if errors.Is(err, pgx.ErrNoRows) {
			return "", "", ErrNotFound
		}
		if requestedTenantID != "" && tenantID != requestedTenantID {
			return "", "", ErrNotFound
		}
		return tenantID, actorID, err
	}
	if parentID != nil {
		var tenantID, actorID string
		err := tx.QueryRow(ctx, `SELECT actor.tenant_id,actor.id
			FROM document_placements placement
			JOIN actors actor ON actor.id=placement.owner_human_actor_id
			  AND actor.tenant_id=placement.tenant_id AND actor.kind='human'
			WHERE placement.id=$1 AND placement.scope_kind='personal'
			  AND placement.node_kind='folder' AND actor.account_id=$2`, *parentID, accountID).Scan(&tenantID, &actorID)
		if errors.Is(err, pgx.ErrNoRows) || (err == nil && tenantID != requestedTenantID) {
			return "", "", ErrNotFound
		}
		return tenantID, actorID, err
	}
	var actorID string
	err := tx.QueryRow(ctx, `SELECT actor.id
		FROM actors actor
		WHERE actor.account_id=$1 AND actor.kind='human' AND actor.tenant_id=$2`,
		accountID, requestedTenantID).Scan(&actorID)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", "", ErrNotFound
	}
	return requestedTenantID, actorID, err
}

func validBlankMaterialization(value ImportedState) bool {
	return validNativeMaterialization(value, nil)
}

func validNativeMaterialization(value ImportedState, allowedAssetIDs []string) bool {
	if len(value.StateBytes) == 0 || len(value.StateBytes) > 32<<20 || len(value.StateVector) > 1<<20 ||
		value.StateHashVersion < 1 || value.StateHashVersion > 100 || !slices.Equal(value.CompleteAssetIDs, allowedAssetIDs) ||
		len(value.CompleteThreadIDs) != 0 || len(value.StateBytesSHA256) != 64 || len(value.FullStateFingerprint) != 64 {
		return false
	}
	if _, err := hex.DecodeString(value.StateBytesSHA256); err != nil {
		return false
	}
	if _, err := hex.DecodeString(value.FullStateFingerprint); err != nil {
		return false
	}
	digest := sha256.Sum256(value.StateBytes)
	return hex.EncodeToString(digest[:]) == value.StateBytesSHA256 &&
		strings.ToLower(value.StateBytesSHA256) == value.StateBytesSHA256 &&
		strings.ToLower(value.FullStateFingerprint) == value.FullStateFingerprint
}
