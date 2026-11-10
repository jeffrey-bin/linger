package document

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
)

// This sentinel is emitted only before binding writes. An ErrNotFound from
// subsequent evidence writes must still roll back, never become a skip.
var errRoomCreationSharingForbidden = errors.New("reviewed Room artifact sharing forbidden")

// RoomCreationArtifactReview carries the Human's access to a Document locked in
// this transaction. It cannot be constructed by callers.
type RoomCreationArtifactReview struct {
	tx                              pgx.Tx
	accountID, tenantID, documentID string
	access                          *AccessEnvelopeV2
}

// LockRoomCreationArtifactInTransaction freezes the Document, its content and
// the Human, whose access to every active Document is constant.
func LockRoomCreationArtifactInTransaction(ctx context.Context, tx pgx.Tx,
	accountID, tenantID, documentID, versionID, revisionID string,
) (*RoomCreationArtifactReview, string, error) {
	var format string
	err := tx.QueryRow(ctx, `SELECT format FROM documents
  WHERE id=$1 AND tenant_id=$2 AND status='active' FOR SHARE`, documentID, tenantID).Scan(&format)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, "document_unavailable", nil
	}
	if err != nil {
		return nil, "", err
	}
	var contentID string
	if format == "blocknote" && revisionID != "" && versionID == "" {
		err = tx.QueryRow(ctx, `SELECT id FROM document_revisions WHERE id=$1
   AND tenant_id=$2 AND document_id=$3 AND state_status='available' FOR SHARE`,
			revisionID, tenantID, documentID).Scan(&contentID)
	} else if format != "blocknote" && versionID != "" && revisionID == "" {
		err = tx.QueryRow(ctx, `SELECT id FROM document_versions WHERE id=$1
   AND tenant_id=$2 AND document_id=$3 FOR SHARE`, versionID, tenantID, documentID).Scan(&contentID)
	} else {
		return nil, "frozen_content_unavailable", nil
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, "frozen_content_unavailable", nil
	}
	if err != nil {
		return nil, "", err
	}

	// The Human's lock keeps the principal stable; the Document lock above
	// keeps its status, and with it the Human's constant access, stable.
	var principalID string
	err = tx.QueryRow(ctx, `SELECT actor.id FROM actors actor
 WHERE actor.tenant_id=$1 AND actor.account_id=$2 AND actor.kind='human'
 FOR SHARE OF actor`, tenantID, accountID).Scan(&principalID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, "sharing_forbidden", nil
	}
	if err != nil {
		return nil, "", err
	}
	access, err := resolveAccessV2(ctx, tx, accountID, documentID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, "sharing_forbidden", nil
	}
	if err != nil {
		return nil, "", err
	}
	if !canManageCollaboratorsForAccess(access) {
		return nil, "sharing_forbidden", nil
	}
	return &RoomCreationArtifactReview{tx: tx, accountID: accountID, tenantID: tenantID, documentID: documentID, access: access}, "", nil
}

// BindToRoom performs the final expiry check and binding as one per-document
// classification boundary. Only authorization absence is skippable; SQL errors
// (including audit/event writes after insertion) abort the whole transaction.
func (review *RoomCreationArtifactReview) BindToRoom(ctx context.Context, input EnsureRoomBindingsInTransactionInput) (string, error) {
	if review == nil || review.tx == nil || input.AccountID != review.accountID || input.TenantID != review.tenantID {
		return "", ErrInvalidInput
	}
	input.DocumentIDs = []string{review.documentID}
	_, err := ensureRoomBindingsInTransaction(ctx, review.tx, input, review.access)
	if errors.Is(err, errRoomCreationSharingForbidden) {
		return "sharing_forbidden", nil
	}
	return "", err
}
